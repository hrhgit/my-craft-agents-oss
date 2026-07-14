import { describe, expect, it } from 'bun:test'
import { uiTestHostHttpErrorEnvelope } from '../http-error-envelope'

describe('Electron Test Host HTTP error envelope', () => {
  it.each([
    [401, 'UNSUPPORTED', 'Authentication required.'],
    [404, 'TARGET_NOT_FOUND', 'Unknown endpoint.'],
  ])('returns a complete V1 response for HTTP %s', (_status, code, message) => {
    const envelope = uiTestHostHttpErrorEnvelope({
      requestId: 'bounded-request-id',
      runId: 'run-1',
      seq: 3,
      revision: 7,
      verificationLevel: 'scenario-verified',
      code,
      message,
    })

    expect(envelope).toEqual({
      v: 1,
      kind: 'response',
      id: 'bounded-request-id',
      requestId: 'bounded-request-id',
      runId: 'run-1',
      seq: 3,
      revision: 7,
      verificationLevel: 'scenario-verified',
      ok: false,
      error: { code, message },
    })
  })
})
