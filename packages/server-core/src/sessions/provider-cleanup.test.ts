import { describe, expect, it, jest } from 'bun:test'
import { SessionManager } from './SessionManager.ts'

type ManagedSessionStub = {
  id: string
  provider?: string
  agent: null
  workspace: { id: string }
}

describe('clearDeletedProviderReferences', () => {
  it('clears and persists only sessions that reference the deleted provider', async () => {
    const affected: ManagedSessionStub = {
      id: 'affected',
      provider: 'deleted-provider',
      agent: null,
      workspace: { id: 'workspace-a' },
    }
    const unaffected: ManagedSessionStub = {
      id: 'unaffected',
      provider: 'remaining-provider',
      agent: null,
      workspace: { id: 'workspace-a' },
    }
    const manager = Object.create(SessionManager.prototype) as SessionManager
    const internals = manager as unknown as {
      sessions: Map<string, ManagedSessionStub>
      setMetadataWriteGuard: jest.Mock
      persistSession: jest.Mock
      flushSession: jest.Mock
      sendEvent: jest.Mock
    }
    internals.sessions = new Map([
      [affected.id, affected],
      [unaffected.id, unaffected],
    ])
    internals.setMetadataWriteGuard = jest.fn()
    internals.persistSession = jest.fn()
    internals.flushSession = jest.fn(async () => {})
    internals.sendEvent = jest.fn()

    await manager.clearDeletedProviderReferences('deleted-provider')

    expect(affected.provider).toBeUndefined()
    expect(unaffected.provider).toBe('remaining-provider')
    expect(internals.persistSession).toHaveBeenCalledTimes(1)
    expect(internals.persistSession).toHaveBeenCalledWith(affected)
    expect(internals.flushSession).toHaveBeenCalledWith('affected')
    expect(internals.sendEvent).toHaveBeenCalledWith({
      type: 'provider_changed',
      sessionId: 'affected',
      provider: undefined,
      supportsBranching: true,
    }, 'workspace-a')
  })
})
