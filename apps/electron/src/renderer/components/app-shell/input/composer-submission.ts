import type { MidStreamSendIntent } from '@mortise/shared/protocol'
import type { FileAttachment } from '../../../../shared/types'

export interface ComposerSubmissionAttempt {
  attemptId: string
  /** Exact editable text before submit-time normalization. */
  composerText: string
  /** Exact text delivered to the Session transport. */
  message: string
  attachments?: FileAttachment[]
  skillSlugs?: string[]
  midStreamSendIntent: MidStreamSendIntent
}

export interface UnacceptedSessionFailure {
  retryable: boolean
  terminal: true
  outcome: 'unaccepted'
}

export function shouldRestoreComposerSubmission(input: {
  clearedRevision: number
  currentRevision: number
  currentText: string
  currentAttachmentCount: number
}): boolean {
  return input.clearedRevision === input.currentRevision
    && input.currentText === ''
    && input.currentAttachmentCount === 0
}

export function snapshotComposerSubmission(input: {
  attemptId?: string
  composerText: string
  message: string
  attachments?: FileAttachment[]
  skillSlugs?: string[]
  midStreamSendIntent?: MidStreamSendIntent
}): ComposerSubmissionAttempt {
  return {
    attemptId: input.attemptId ?? crypto.randomUUID(),
    composerText: input.composerText,
    message: input.message,
    ...(input.attachments?.length
      ? { attachments: input.attachments.map(attachment => ({ ...attachment })) }
      : {}),
    ...(input.skillSlugs?.length ? { skillSlugs: [...input.skillSlugs] } : {}),
    midStreamSendIntent: input.midStreamSendIntent ?? 'default',
  }
}

export function parseUnacceptedSessionFailure(error: unknown): UnacceptedSessionFailure | null {
  if (!error || typeof error !== 'object') return null
  const candidate = error as { code?: unknown; data?: unknown }
  if (candidate.code !== 'SESSION_PERSISTENCE_FAILED') return null
  if (!candidate.data || typeof candidate.data !== 'object') return null
  const data = candidate.data as {
    retryable?: unknown
    terminal?: unknown
    outcome?: unknown
  }
  if (
    typeof data.retryable !== 'boolean'
    || data.terminal !== true
    || data.outcome !== 'unaccepted'
  ) {
    return null
  }
  return {
    retryable: data.retryable,
    terminal: true,
    outcome: 'unaccepted',
  }
}
