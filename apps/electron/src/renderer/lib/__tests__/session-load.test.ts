import { describe, expect, it } from 'bun:test'
import type { Session, TransportConnectionState } from '../../../shared/types'
import { deriveSessionMessagesLoadState, formatSessionLoadFailure, shouldTreatSessionLoadFailureAsTransportFallback } from '../session-load'

function createState(overrides?: Partial<TransportConnectionState>): TransportConnectionState {
  return {
    mode: 'remote',
    status: 'connected',
    url: 'wss://remote.example.test',
    attempt: 0,
    updatedAt: Date.now(),
    ...overrides,
  }
}

function createSession(overrides?: Partial<Session>): Session {
  return {
    id: 'session-1',
    workspaceId: 'workspace-1',
    workspaceName: 'Workspace',
    lastMessageAt: Date.now(),
    messages: [],
    isProcessing: false,
    ...overrides,
  }
}

describe('deriveSessionMessagesLoadState', () => {
  it('waits for the projection snapshot when metadata says history exists', () => {
    const state = deriveSessionMessagesLoadState({
      session: createSession({ messageCount: 2 }),
      sessionMeta: { messageCount: 2 },
      projectionSyncState: 'empty',
      projectionEntityCount: 0,
    })

    expect(state.messagesReady).toBe(false)
    expect(state.messagesLoading).toBe(true)
  })

  it('does not treat Craft overlay messages as canonical transcript readiness', () => {
    const state = deriveSessionMessagesLoadState({
      session: createSession({
        messages: [{ id: 'm1', role: 'user', content: 'hello', timestamp: Date.now() }],
        messageCount: 1,
      }),
      sessionMeta: { messageCount: 1 },
      projectionSyncState: 'empty',
      projectionEntityCount: 0,
    })

    expect(state.hasProjectionData).toBe(false)
    expect(state.messagesReady).toBe(false)
    expect(state.messagesLoading).toBe(true)
  })

  it('treats a projection-empty new session as ready', () => {
    const state = deriveSessionMessagesLoadState({
      session: createSession({ messageCount: 0 }),
      sessionMeta: { messageCount: 0 },
      projectionSyncState: 'empty',
      projectionEntityCount: 0,
    })

    expect(state.isKnownEmptySession).toBe(true)
    expect(state.messagesReady).toBe(true)
    expect(state.messagesLoading).toBe(false)
  })

  it('treats a synced projection as ready even when the Craft overlay is empty', () => {
    const state = deriveSessionMessagesLoadState({
      session: createSession({ messageCount: 2 }),
      sessionMeta: { messageCount: 2 },
      projectionSyncState: 'synced',
      projectionEntityCount: 4,
    })

    expect(state.hasProjectionData).toBe(true)
    expect(state.projectionReady).toBe(true)
    expect(state.messagesReady).toBe(true)
    expect(state.messagesLoading).toBe(false)
  })

  it('keeps available projection data visible while snapshot recovery is desynced', () => {
    const state = deriveSessionMessagesLoadState({
      session: createSession({ messageCount: 2 }),
      sessionMeta: { messageCount: 2 },
      projectionSyncState: 'desynced',
      projectionEntityCount: 2,
    })

    expect(state.projectionReady).toBe(true)
    expect(state.messagesReady).toBe(true)
    expect(state.messagesLoading).toBe(false)
  })

  it('waits for snapshot recovery when a desynced projection has no local entities', () => {
    const state = deriveSessionMessagesLoadState({
      session: createSession({ messageCount: 2 }),
      sessionMeta: { messageCount: 2 },
      projectionSyncState: 'desynced',
      projectionEntityCount: 0,
    })

    expect(state.projectionReady).toBe(false)
    expect(state.messagesReady).toBe(false)
    expect(state.messagesLoading).toBe(true)
  })

  it('treats optimistic projection entities as ready before the first snapshot', () => {
    const state = deriveSessionMessagesLoadState({
      session: createSession({ messageCount: 0 }),
      sessionMeta: { messageCount: 0 },
      projectionSyncState: 'empty',
      projectionEntityCount: 1,
    })

    expect(state.hasProjectionData).toBe(true)
    expect(state.messagesReady).toBe(true)
    expect(state.messagesLoading).toBe(false)
  })
})

describe('shouldTreatSessionLoadFailureAsTransportFallback', () => {
  it('returns true for remote reconnecting state', () => {
    expect(shouldTreatSessionLoadFailureAsTransportFallback(
      createState({ status: 'reconnecting' }),
    )).toBe(true)
  })

  it('returns true for remote auth/network/timeout failures', () => {
    expect(shouldTreatSessionLoadFailureAsTransportFallback(
      createState({
        status: 'connected',
        lastError: { kind: 'auth', message: 'Bad token' },
      }),
    )).toBe(true)
  })

  it('returns false for remote connected state without transport errors', () => {
    expect(shouldTreatSessionLoadFailureAsTransportFallback(
      createState({ status: 'connected' }),
    )).toBe(false)
  })

  it('returns false for local transport state', () => {
    expect(shouldTreatSessionLoadFailureAsTransportFallback(
      createState({ mode: 'local', status: 'failed' }),
    )).toBe(false)
  })
})

describe('formatSessionLoadFailure', () => {
  it('prefers Error.message', () => {
    expect(formatSessionLoadFailure(new Error('boom'))).toBe('boom')
  })

  it('falls back to a generic message', () => {
    expect(formatSessionLoadFailure(null)).toBe('Unknown error')
  })
})
