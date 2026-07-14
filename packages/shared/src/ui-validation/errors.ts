import type { UiValidationErrorCode, UiValidationErrorPayload } from './types.ts'

export class UiValidationError extends Error {
  readonly code: UiValidationErrorCode
  readonly details?: Record<string, unknown>
  readonly retryable: boolean

  constructor(code: UiValidationErrorCode, message: string, options: {
    details?: Record<string, unknown>
    retryable?: boolean
    cause?: unknown
  } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'UiValidationError'
    this.code = code
    this.details = options.details
    this.retryable = options.retryable ?? false
  }

  toPayload(): UiValidationErrorPayload {
    return {
      code: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
      ...(this.retryable ? { retryable: true } : {}),
    }
  }
}

export function toUiValidationError(error: unknown): UiValidationError {
  if (error instanceof UiValidationError) return error
  return new UiValidationError(
    'INTERNAL_ERROR',
    error instanceof Error ? error.message : String(error),
    { cause: error },
  )
}
