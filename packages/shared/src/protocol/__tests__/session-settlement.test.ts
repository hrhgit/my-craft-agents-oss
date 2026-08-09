import { describe, expect, it } from 'bun:test'
import {
  SESSION_SETTLEMENT_ERROR_CODE,
  isSessionSettlementFailure,
  isSessionPublicationFailure,
  isTransportErrorCode,
  type SessionCommand,
  type SessionEvent,
  type SessionSettlementFailure,
  type SessionPublicationFailure,
} from '../index'

const failure = {
  code: SESSION_SETTLEMENT_ERROR_CODE,
  message: 'The accepted turn is waiting for durable settlement.',
  data: {
    sessionId: 'session-a',
    stage: 'turn-settlement',
    retryable: true,
    terminal: false,
    outcome: 'accepted-pending-settlement',
  },
} as const satisfies SessionSettlementFailure

describe('Session settlement protocol', () => {
  it('exposes the accepted-pending-settlement failure as a transport and Session event contract', () => {
    const event = {
      type: 'session_failure',
      sessionId: failure.data.sessionId,
      error: failure,
    } satisfies SessionEvent

    expect(isTransportErrorCode(failure.code)).toBe(true)
    expect(isSessionSettlementFailure(event.error)).toBe(true)
    expect(event.error.data).toEqual({
      sessionId: 'session-a',
      stage: 'turn-settlement',
      retryable: true,
      terminal: false,
      outcome: 'accepted-pending-settlement',
    })
  })

  it('rejects nearby shapes that could permit an unsafe resend or terminal cleanup', () => {
    expect(isSessionSettlementFailure({
      ...failure,
      data: { ...failure.data, outcome: 'unaccepted' },
    })).toBe(false)
    expect(isSessionSettlementFailure({
      ...failure,
      data: { ...failure.data, terminal: true },
    })).toBe(false)
    expect(isSessionSettlementFailure({
      ...failure,
      data: { ...failure.data, retryable: false },
    })).toBe(false)
  })

  it('defines retry settlement as a payload-free Session-scoped command', () => {
    const command = { type: 'retrySettlement' } satisfies SessionCommand

    expect(command).toEqual({ type: 'retrySettlement' })
    expect(Object.keys(command)).toEqual(['type'])
  })

  it('defines unpublished first-turn failures as retryable without permitting a new payload', () => {
    const publicationFailure = {
      code: 'SESSION_PUBLICATION_DURABILITY_FAILED',
      message: 'The provisional Session could not be published.',
      data: {
        sessionId: 'session-pending',
        stage: 'projection',
        retryable: true,
        terminal: true,
        outcome: 'unpublished',
      },
    } as const satisfies SessionPublicationFailure
    const event = {
      type: 'session_failure',
      sessionId: publicationFailure.data.sessionId,
      error: publicationFailure,
    } satisfies SessionEvent
    const command = { type: 'retryAcceptedMessage' } satisfies SessionCommand

    expect(isSessionPublicationFailure(event.error)).toBe(true)
    expect(command).toEqual({ type: 'retryAcceptedMessage' })
    expect(Object.keys(command)).toEqual(['type'])
    expect(isSessionPublicationFailure({ ...publicationFailure, data: { ...publicationFailure.data, stage: 'turn-settlement' } })).toBe(false)
  })
})
