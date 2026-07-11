import { describe, expect, it, mock } from 'bun:test'
import { CapabilityRouter } from '../router.ts'
import { createBrowserOperationsProvider, type BrowserOperationAdapter } from '../providers/browser-operations.ts'
import type { CapabilityRequestV1 } from '../types.ts'

function request(operation: string, input: unknown): CapabilityRequestV1 {
  return { version: 1, requestId: operation, capability: 'browser.operate', sessionId: 'session-1', runtimeId: 'runtime-1', extensionId: 'browser-ext', operation, input }
}

function declare(router: CapabilityRouter): void {
  router.declare({ version: 1, sessionId: 'session-1', runtimeId: 'runtime-1', extensionId: 'browser-ext', declarations: [{ capability: 'browser.operate', operations: ['click', 'fill', 'resize', 'evaluate'] }] })
}

describe('browser operations capability', () => {
  it('routes validated operations with Host session identity', async () => {
    const adapter: BrowserOperationAdapter = async (_operation, _input, route) => ({ completed: true, sessionId: route.sessionId })
    const router = new CapabilityRouter({ authorize: () => ({ allowed: true }) })
    router.register(createBrowserOperationsProvider(adapter))
    declare(router)
    expect(await router.invoke(request('click', { instanceId: 'browser-1', ref: 'e4', waitFor: 'navigation' })))
      .toMatchObject({ status: 'success', output: { completed: true, sessionId: 'session-1' } })
  })

  it('rejects executable and unbounded operations', async () => {
    const adapter = mock(async () => ({}))
    const router = new CapabilityRouter({ authorize: () => ({ allowed: true }) })
    router.register(createBrowserOperationsProvider(adapter))
    declare(router)
    expect(await router.invoke(request('evaluate', { instanceId: 'browser-1', expression: 'document.cookie' }))).toMatchObject({ status: 'failed' })
    expect(await router.invoke(request('fill', { instanceId: 'browser-1', ref: 'e1', value: 'x', script: 'bad' }))).toMatchObject({ status: 'failed' })
    expect(await router.invoke(request('resize', { instanceId: 'browser-1', width: 1, height: 1 }))).toMatchObject({ status: 'failed' })
    expect(adapter).not.toHaveBeenCalled()
  })
})
