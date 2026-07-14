import { afterEach, describe, expect, it, mock } from 'bun:test'
import { extensionValidationStore } from '../extension-validation-store'
import { createExtensionValidationTestBridge } from '../extension-validation-test-bridge'

const route = { schemaVersion: 1 as const, extensionId: 'sandbox-route', sessionId: 'validation-test-session', runtimeId: 'runtime', revision: 1 }

afterEach(() => extensionValidationStore.resetRuntime(route.sessionId, route.runtimeId))

describe('extension validation Test Host bridge', () => {
  it('blocks actions until ready and invokes only the declared command with trusted ownership', async () => {
    extensionValidationStore.apply({
      ...route,
      operation: 'upsert',
      definition: {
        schemaVersion: 1, id: 'panel', contributionId: 'panel', verificationLevel: 'semantic',
        readyWhen: ['loaded'], signals: [{ id: 'loaded', label: 'Loaded', status: 'busy' }],
        actions: [{ id: 'refresh', label: 'Refresh', command: 'owner:refresh', inputSchema: { type: 'object', additionalProperties: false } }],
      },
    }, { commandOwnerExtensionId: 'trusted-owner' })
    const invoke = mock(async (_sessionId: string, _command: string, _args: Record<string, unknown> | undefined, _owner: string) => ({ invoked: true }))
    const bridge = createExtensionValidationTestBridge(invoke)
    await expect(bridge.execute({ ...route, definitionId: 'panel', kind: 'action', id: 'refresh' })).rejects.toMatchObject({ code: 'NOT_READY' })

    expect(extensionValidationStore.updateState({
      ...route, commandOwnerExtensionId: 'trusted-owner',
    }, 'panel', 2, { readyWhen: ['loaded'], signals: [{ id: 'loaded', label: 'Loaded', status: 'ready' }] })).toBe(true)
    await bridge.execute({ ...route, definitionId: 'panel', kind: 'action', id: 'refresh', input: {} })
    expect(invoke).toHaveBeenCalledWith(route.sessionId, 'owner:refresh', {}, 'trusted-owner')
  })

  it('executes declared scenario setup and teardown but rejects undeclared input', async () => {
    extensionValidationStore.apply({
      ...route,
      operation: 'upsert',
      definition: {
        schemaVersion: 1, id: 'panel', contributionId: 'panel', verificationLevel: 'semantic',
        scenarios: [{
          id: 'failed', label: 'Failed', command: 'owner:setup', teardownCommand: 'owner:reset',
          inputSchema: { type: 'object', required: ['message'], properties: { message: { type: 'string', maxLength: 20 } }, additionalProperties: false },
        }],
      },
    }, { commandOwnerExtensionId: 'trusted-owner' })
    const invoke = mock(async (_sessionId: string, _command: string, _args: Record<string, unknown> | undefined, _owner: string) => ({ invoked: true }))
    const bridge = createExtensionValidationTestBridge(invoke)
    await expect(bridge.execute({ ...route, definitionId: 'panel', kind: 'scenario', id: 'failed', input: { arbitrary: true } })).rejects.toMatchObject({ code: 'UNSUPPORTED' })
    await bridge.execute({ ...route, definitionId: 'panel', kind: 'scenario', id: 'failed', input: { message: 'boom' } })
    await bridge.execute({ ...route, definitionId: 'panel', kind: 'scenario', id: 'failed', phase: 'teardown' })
    expect(invoke.mock.calls.map(call => call[1])).toEqual(['owner:setup', 'owner:reset'])
  })

  it('returns bounded semantic declarations with computed readiness', () => {
    extensionValidationStore.apply({
      ...route,
      operation: 'upsert',
      definition: { schemaVersion: 1, id: 'panel', contributionId: 'panel', verificationLevel: 'physical' },
    })
    const snapshot = createExtensionValidationTestBridge(async () => ({ invoked: true })).snapshot({ sessionId: route.sessionId })
    expect(snapshot).toHaveLength(1)
    expect(snapshot[0]?.readiness).toEqual({ ready: true, phase: 'ready', waitingFor: [], errors: [] })
  })
})
