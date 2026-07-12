import type { Session, TransportConnectionState } from '../../shared/types'
import type { PiProjectionSyncState } from '../atoms/pi-projection'

interface MessageLoadMeta {
  messageCount?: number
  lastFinalMessageId?: string
}

export interface SessionMessagesLoadStateInput {
  session: Pick<Session, 'messageCount' | 'lastFinalMessageId'> | null | undefined
  sessionMeta: MessageLoadMeta | null | undefined
  projectionSyncState: PiProjectionSyncState
  projectionEntityCount: number
}

export interface SessionMessagesLoadState {
  hasProjectionData: boolean
  projectionReady: boolean
  isKnownEmptySession: boolean
  hasExpectedPersistedMessages: boolean
  messagesReady: boolean
  messagesLoading: boolean
}

/**
 * Derive transcript readiness from Pi projection state. `session.messages` is a
 * Craft-owned UI overlay and must not be compared with projection-derived
 * message counts to decide whether canonical history is present.
 */
export function deriveSessionMessagesLoadState({
  session,
  sessionMeta,
  projectionSyncState,
  projectionEntityCount,
}: SessionMessagesLoadStateInput): SessionMessagesLoadState {
  const messageCount = session?.messageCount ?? sessionMeta?.messageCount
  const hasExpectedPersistedMessages = (messageCount ?? 0) > 0
    || !!session?.lastFinalMessageId
    || !!sessionMeta?.lastFinalMessageId
  const hasProjectionData = projectionEntityCount > 0
  const projectionReady = projectionSyncState === 'synced' || hasProjectionData
  const isKnownEmptySession = !!(session || sessionMeta)
    && projectionSyncState === 'empty'
    && !hasExpectedPersistedMessages
  const messagesReady = projectionReady || isKnownEmptySession

  return {
    hasProjectionData,
    projectionReady,
    isKnownEmptySession,
    hasExpectedPersistedMessages,
    messagesReady,
    messagesLoading: !messagesReady,
  }
}

export function shouldTreatSessionLoadFailureAsTransportFallback(
  state: TransportConnectionState | null | undefined,
): boolean {
  if (!state || state.mode !== 'remote') return false

  if (state.lastError && ['auth', 'network', 'timeout'].includes(state.lastError.kind)) {
    return true
  }

  return state.status === 'connecting'
    || state.status === 'reconnecting'
    || state.status === 'failed'
    || state.status === 'disconnected'
}

export function formatSessionLoadFailure(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  if (typeof error === 'string' && error.trim()) return error
  return 'Unknown error'
}
