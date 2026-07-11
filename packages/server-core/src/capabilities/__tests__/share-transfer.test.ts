import { describe, expect, it, mock } from 'bun:test'
import { CapabilityRouter } from '../router.ts'
import {
  createSessionShareCapabilityProvider,
  createSessionTransferCapabilityProvider,
  TRANSFER_SUMMARY_MAX_LENGTH,
} from '../providers/share-transfer.ts'
import type { CapabilityRequestV1 } from '../types.ts'

function request(capability: string, operation: string, input: unknown = {}): CapabilityRequestV1 {
  return {
    version: 1,
    requestId: `${capability}-${operation}`,
    capability,
    operation,
    input,
    sessionId: 'session-1',
    runtimeId: 'runtime-1',
    extensionId: 'extension-1',
  }
}

describe('session share capability', () => {
  it('always routes operations to the requesting session', async () => {
    const status = mock(async () => ({ published: true, url: 'https://viewer.test/s/1' }))
    const publish = mock(async () => ({ success: true, url: 'https://viewer.test/s/1' }))
    const router = new CapabilityRouter()
    router.register(createSessionShareCapabilityProvider({
      status,
      publish,
      refresh: async () => ({ success: true }),
      revoke: async () => ({ success: true }),
    }))

    expect(await router.invoke(request('session.share', 'status'))).toMatchObject({
      status: 'success', output: { published: true, url: 'https://viewer.test/s/1' },
    })
    expect(await router.invoke(request('session.share', 'publish'))).toMatchObject({ status: 'success' })
    expect(status).toHaveBeenCalledWith('session-1')
    expect(publish).toHaveBeenCalledWith('session-1')
  })

  it('does not accept arbitrary share input', async () => {
    const router = new CapabilityRouter()
    router.register(createSessionShareCapabilityProvider({
      status: async () => ({ published: false }),
      publish: async () => ({ success: true }),
      refresh: async () => ({ success: true }),
      revoke: async () => ({ success: true }),
    }))
    expect(await router.invoke(request('session.share', 'publish', { sessionId: 'other' })))
      .toMatchObject({ status: 'failed' })
  })
})

describe('session transfer capability', () => {
  it('exports and imports only summary payloads through the requesting session', async () => {
    const exportSummary = mock(async () => ({ sourceSessionId: 'session-1', summary: 'Summary' }))
    const importSummary = mock(async () => ({ sessionId: 'created-session' }))
    const progress: unknown[] = []
    const router = new CapabilityRouter({ onProgress: event => progress.push(event.progress) })
    router.register(createSessionTransferCapabilityProvider({ exportSummary, importSummary }))

    expect(await router.invoke(request('session.transfer', 'export-summary'))).toMatchObject({
      status: 'success', output: { sourceSessionId: 'session-1', summary: 'Summary' },
    })
    expect(await router.invoke(request('session.transfer', 'import-summary', {
      sourceSessionId: 'remote-session', summary: 'Safe summary', labels: ['imported'],
    }))).toMatchObject({ status: 'success', output: { sessionId: 'created-session' } })
    expect(exportSummary).toHaveBeenCalledWith('session-1')
    expect(importSummary).toHaveBeenCalledWith('session-1', {
      sourceSessionId: 'remote-session', summary: 'Safe summary', labels: ['imported'],
    })
    expect(progress).toContainEqual({ phase: 'summarizing' })
    expect(progress).toContainEqual({ phase: 'importing' })
  })

  it('rejects bundle fields and oversized summaries before invoking Host services', async () => {
    const importSummary = mock(async () => ({ sessionId: 'created-session' }))
    const router = new CapabilityRouter()
    router.register(createSessionTransferCapabilityProvider({
      exportSummary: async () => null,
      importSummary,
    }))

    expect(await router.invoke(request('session.transfer', 'import-summary', {
      sourceSessionId: 'remote', summary: 'ok', files: [{ path: 'secret' }],
    }))).toMatchObject({ status: 'failed' })
    expect(await router.invoke({
      ...request('session.transfer', 'import-summary', {
        sourceSessionId: 'remote', summary: 'x'.repeat(TRANSFER_SUMMARY_MAX_LENGTH + 1),
      }),
      requestId: 'oversized',
    })).toMatchObject({ status: 'failed' })
    expect(importSummary).not.toHaveBeenCalled()
  })
})
