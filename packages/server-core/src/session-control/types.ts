export type SessionTurnControlState = 'starting' | 'running' | 'stopping'

export type SessionControlAcquireFailure = 'conflict' | 'coordinator-recovering' | 'coordinator-unavailable'

export class SessionControlAcquireError extends Error {
  readonly code = 'SESSION_CONTROL_NOT_ACQUIRED' as const
  readonly accepted = false
  readonly retryable = false

  constructor(
    readonly sessionId: string,
    readonly reason: SessionControlAcquireFailure,
  ) {
    super(reason === 'conflict'
      ? `Session ${sessionId} is already controlled by another backend`
      : reason === 'coordinator-recovering'
        ? 'The local Session coordinator is recovering; send the request again after recovery completes'
        : 'The local Session coordinator is unavailable')
    this.name = 'SessionControlAcquireError'
  }
}

export interface SessionTurnControlHandle {
  readonly sessionId: string
  readonly backendId: string
  readonly handleId: string
  readonly attemptId: string
  readonly acquiredAt: number
  readonly valid: boolean
  assertValid(): void
  setState(state: SessionTurnControlState): Promise<void>
  release(): Promise<void>
}

export interface SessionTurnControl {
  readonly backendId: string
  acquire(sessionId: string): Promise<SessionTurnControlHandle>
  close(options?: { graceMs?: number }): Promise<void>
}

export interface SessionControlCoordinatorSnapshot {
  recovering: boolean
  controls: Array<{
    sessionId: string
    backendId: string
    handleId: string
    attemptId: string
    state: SessionTurnControlState
  }>
}
