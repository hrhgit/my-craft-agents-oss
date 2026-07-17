import { describe, expect, it } from 'bun:test'
import { createExtensionEventForwarder } from './pi-extension-bridge'
import type { ExtensionBridgeEvent } from '@craft-agent/shared/agent/backend/types'
import type { EventSink } from '@craft-agent/server-core/transport'

const route = { extensionId: 'example', runtimeId: 'runtime', sessionId: 'session' }

describe('Pi extension contribution bridge', () => {
  it('validates extension UI contracts and replaces untrusted route identity', () => {
    const payloads: unknown[] = []
    const sink = ((...args: Parameters<EventSink>) => { payloads.push(args[2]) }) as EventSink
    const forward = createExtensionEventForwarder(sink, 'workspace', 'trusted-session')
    forward({
      type: 'extension_ui_validation', ...route,
      delta: {
        schemaVersion: 1, extensionId: 'spoofed', sessionId: 'spoofed', runtimeId: 'spoofed', revision: 1,
        operation: 'upsert', definition: {
          schemaVersion: 1, id: 'status.contract', contributionId: 'status', verificationLevel: 'semantic',
          signals: [{ id: 'ready', label: 'Ready', status: 'ready' }], readyWhen: ['ready'],
        },
      },
    })
    expect(payloads[0]).toMatchObject({
      type: 'extension_ui_validation', sessionId: 'trusted-session',
      delta: { extensionId: 'example', runtimeId: 'runtime', sessionId: 'trusted-session' },
    })

    forward({
      type: 'extension_ui_validation', ...route,
      delta: {
        schemaVersion: 1, ...route, revision: 2, operation: 'upsert',
        definition: { schemaVersion: 1, id: '', contributionId: 'status', verificationLevel: 'semantic' },
      },
    } as ExtensionBridgeEvent)
    expect(payloads).toHaveLength(1)
  })

  it('forwards valid native deltas and rejects invalid payloads', () => {
    const calls: Parameters<EventSink>[] = []
    const sink = ((...args: Parameters<EventSink>) => { calls.push(args) }) as EventSink
    const forward = createExtensionEventForwarder(sink, 'workspace', 'session')
    forward({
      type: 'extension_contribution', ...route, sessionId: 'untrusted-outer-session',
      delta: {
        schemaVersion: 1,
        extensionId: 'spoofed-extension',
        runtimeId: 'spoofed-runtime',
        sessionId: 'spoofed-session',
        workspaceId: 'spoofed-workspace',
        revision: 1,
        operation: 'upsert',
        contribution: { schemaVersion: 1, id: 'status', surface: 'composer.status', content: { type: 'text', text: 'Ready' } },
      },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.[1]).toEqual({ to: 'workspace', workspaceId: 'workspace' })
    expect(calls[0]?.[2]).toMatchObject({
      extensionId: 'example',
      runtimeId: 'runtime',
      sessionId: 'session',
      delta: {
        extensionId: 'example',
        runtimeId: 'runtime',
        sessionId: 'session',
        workspaceId: 'workspace',
      },
    })

    forward({
      type: 'extension_contribution', ...route,
      delta: {
        schemaVersion: 1, ...route, revision: 2, operation: 'upsert',
        contribution: { schemaVersion: 1, id: 'bad', surface: 'composer.status', content: { type: 'text', text: '' } },
      },
    } as ExtensionBridgeEvent)
    expect(calls).toHaveLength(1)
  })

  it('routes runtime resets to their workspace and injects reset ownership', () => {
    const calls: Parameters<EventSink>[] = []
    const sink = ((...args: Parameters<EventSink>) => { calls.push(args) }) as EventSink
    createExtensionEventForwarder(sink, 'workspace', 'trusted-session')({
      type: 'extension_contributions_runtime_reset',
      ...route,
      sessionId: 'untrusted-session',
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.[1]).toEqual({ to: 'workspace', workspaceId: 'workspace' })
    expect(calls[0]?.[2]).toMatchObject({
      type: 'extension_contributions_runtime_reset',
      sessionId: 'trusted-session',
      runtimeId: 'runtime',
      workspaceId: 'workspace',
    })
  })

  it('normalizes legacy widgets into revisioned contributions', () => {
    const payloads: unknown[] = []
    const sink = ((...args: Parameters<EventSink>) => { payloads.push(args[2]) }) as EventSink
    const forward = createExtensionEventForwarder(sink, 'workspace', 'session')
    forward({ type: 'extension_widget', ...route, key: 'legacy', content: ['one', 'two'], placement: 'belowEditor' })
    const payload = payloads[0] as { type: string; delta: { operation: string; revision: number; contribution: { id: string } } }
    expect(payload.type).toBe('extension_contribution')
    expect(payload.delta).toMatchObject({ operation: 'upsert', revision: 1, contribution: { id: 'legacy-widget:legacy' } })
  })

  it('preserves Pi default placement above the composer', () => {
    const payloads: unknown[] = []
    const sink = ((...args: Parameters<EventSink>) => { payloads.push(args[2]) }) as EventSink
    createExtensionEventForwarder(sink, 'workspace', 'session')({ type: 'extension_widget', ...route, key: 'default', content: ['one'] })
    expect(payloads[0]).toMatchObject({ delta: { contribution: { surface: 'composer.above' } } })
  })

  it('removes a legacy widget when Pi sends an empty content array', () => {
    const payloads: unknown[] = []
    const sink = ((...args: Parameters<EventSink>) => { payloads.push(args[2]) }) as EventSink
    const forward = createExtensionEventForwarder(sink, 'workspace', 'session')
    forward({ type: 'extension_widget', ...route, key: 'legacy', content: ['visible'] })
    forward({ type: 'extension_widget', ...route, key: 'legacy', content: [] })

    expect(payloads[1]).toMatchObject({
      type: 'extension_contribution',
      delta: { operation: 'remove', contributionId: 'legacy-widget:legacy', revision: 2 },
    })
  })

  it('overrides temporary interaction routing with the trusted host session', () => {
    const payloads: unknown[] = []
    const sink = ((...args: Parameters<EventSink>) => { payloads.push(args[2]) }) as EventSink
    const forward = createExtensionEventForwarder(sink, 'workspace', 'trusted-session')
    forward({
      type: 'extension_interaction_request',
      ...route,
      sessionId: 'untrusted-session',
      requestId: 'interaction-1',
      request: { schemaVersion: 1, fields: [{ id: 'confirm', kind: 'confirm', label: 'Continue?' }] },
    })
    forward({
      type: 'extension_interaction_cancel',
      ...route,
      sessionId: 'untrusted-session',
      requestId: 'interaction-1',
      schemaVersion: 1,
      reason: 'aborted',
    })
    forward({
      type: 'extension_interaction_settled',
      ...route,
      sessionId: 'untrusted-session',
      requestId: 'interaction-2',
      schemaVersion: 1,
      outcome: 'submitted',
    })

    expect(payloads).toEqual([
      expect.objectContaining({ type: 'extension_interaction_request', sessionId: 'trusted-session' }),
      expect.objectContaining({ type: 'extension_interaction_cancel', sessionId: 'trusted-session' }),
      expect.objectContaining({ type: 'extension_interaction_settled', sessionId: 'trusted-session' }),
    ])
  })
})
