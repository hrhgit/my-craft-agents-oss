import { describe, expect, it } from 'bun:test'
import { SessionShareTransferService, type SessionShareTransferStore } from './session-share-transfer'

function fixture() {
  const record = {
    id: 'session-1', workspaceId: 'workspace-1', workspaceRootPath: 'C:/workspace',
    isProcessing: false, name: 'Original', sharedId: undefined as string | undefined,
    sharedUrl: undefined as string | undefined,
  }
  const events: unknown[] = []
  const asyncStates: boolean[] = []
  const calls: string[] = []
  const store: SessionShareTransferStore = {
    resolve: id => id === record.id ? record : null,
    loadStoredSession: () => ({ header: { id: record.id } }),
    setAsyncOperation: (_id, ongoing) => asyncStates.push(ongoing),
    updateShareMetadata: async (_id, metadata) => { Object.assign(record, metadata) },
    emitShareEvent: event => events.push(event),
    persistAndFlush: async () => { calls.push('persist') },
    summarize: async () => { calls.push('summarize'); return 'summary' },
    createImported: async (_workspaceId, payload) => { calls.push(`import:${payload.summary}`); return { sessionId: 'imported-1' } },
  }
  const logger = { debug() {}, info() {}, warn() {}, error() {} }
  return { record, events, asyncStates, calls, store, logger }
}

describe('SessionShareTransferService', () => {
  it('does not publish when no viewer service is configured', async () => {
    const f = fixture()
    const previous = process.env.MORTISE_VIEWER_URL
    delete process.env.MORTISE_VIEWER_URL
    try {
      const service = new SessionShareTransferService({ store: f.store, logger: f.logger })
      expect(service.isConfigured()).toBe(false)
      await expect(service.publish('session-1')).resolves.toEqual({
        success: false,
        error: 'Session sharing is not configured',
      })
      expect(f.asyncStates).toEqual([])
    } finally {
      if (previous === undefined) delete process.env.MORTISE_VIEWER_URL
      else process.env.MORTISE_VIEWER_URL = previous
    }
  })

  it('publishes, refreshes, and revokes through one host-owned implementation', async () => {
    const f = fixture()
    const requests: Array<{ method?: string }> = []
    let request = 0
    const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push({ method: init?.method })
      request++
      return request === 1
        ? { ok: true, json: async () => ({ id: 'share-1', url: 'https://viewer/s/share-1' }) } as Response
        : { ok: true } as Response
    }
    const service = new SessionShareTransferService({ store: f.store, logger: f.logger, fetch, viewerUrl: 'https://viewer' })

    await expect(service.publish('session-1')).resolves.toEqual({ success: true, url: 'https://viewer/s/share-1' })
    await expect(service.refresh('session-1')).resolves.toEqual({ success: true, url: 'https://viewer/s/share-1' })
    await expect(service.revoke('session-1')).resolves.toEqual({ success: true })
    expect(requests.map(call => call.method)).toEqual(['POST', 'PUT', 'DELETE'])
    expect(f.asyncStates).toEqual([true, false, true, false, true, false])
    expect(f.events).toEqual([
      { type: 'session_shared', sessionId: 'session-1', sharedUrl: 'https://viewer/s/share-1' },
      { type: 'session_unshared', sessionId: 'session-1' },
    ])
  })

  it('preserves transfer ownership, flush ordering, and trimmed imports', async () => {
    const f = fixture()
    const service = new SessionShareTransferService({ store: f.store, logger: f.logger, fetch: async () => ({ ok: true } as Response), viewerUrl: 'https://viewer' })
    await expect(service.exportSummary('session-1', 'other')).resolves.toBeNull()
    await expect(service.exportSummary('session-1', 'workspace-1')).resolves.toMatchObject({ sourceSessionId: 'session-1', summary: 'summary' })
    expect(f.calls.slice(0, 2)).toEqual(['persist', 'summarize'])
    await expect(service.importSummary('workspace-1', { sourceSessionId: 'source', summary: '  imported  ' })).resolves.toEqual({ sessionId: 'imported-1' })
    expect(f.calls).toContain('import:imported')
  })

  it('keeps legacy share failure messages and always clears async state', async () => {
    const f = fixture()
    const service = new SessionShareTransferService({
      store: f.store, logger: f.logger, viewerUrl: 'https://viewer', fetch: async () => ({ ok: false, status: 413 } as Response),
    })
    await expect(service.publish('session-1')).resolves.toEqual({ success: false, error: 'Session file is too large to share' })
    expect(f.asyncStates).toEqual([true, false])
  })
})
