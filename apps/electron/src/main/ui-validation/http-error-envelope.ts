import type { UiVerificationLevel } from './electron-surface-driver'

export interface UiTestHostHttpErrorEnvelopeOptions {
  requestId: string
  runId: string
  seq: number
  revision: number
  verificationLevel: UiVerificationLevel
  code: string
  message: string
}

export function uiTestHostHttpErrorEnvelope(options: UiTestHostHttpErrorEnvelopeOptions) {
  return {
    v: 1 as const,
    kind: 'response' as const,
    id: options.requestId,
    requestId: options.requestId,
    runId: options.runId,
    seq: options.seq,
    revision: options.revision,
    verificationLevel: options.verificationLevel,
    ok: false as const,
    error: { code: options.code, message: options.message },
  }
}
