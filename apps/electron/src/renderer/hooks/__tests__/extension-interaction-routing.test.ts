import { describe, expect, it } from 'bun:test'
import type { ExtensionInteractionBridgeCancelV1, ExtensionInteractionBridgeRequestV1, ExtensionInteractionBridgeSettledV1 } from '@mortise/shared/protocol'
import {
  asExtensionInteractionCancel,
  asExtensionInteractionRequest,
  asExtensionInteractionSettled,
  extensionInteractionKey,
  takeNextExtensionInteractionForSession,
} from '../useExtensionInteractions'

function request(requestId: string, sessionId: string): ExtensionInteractionBridgeRequestV1 {
  return {
    type: 'extension_interaction_request',
    requestId,
    extensionId: 'ask-user',
    runtimeId: `runtime-${sessionId}`,
    sessionId,
    request: {
      schemaVersion: 1,
      title: requestId,
      fields: [{ id: 'confirm', kind: 'confirm', label: 'Continue?' }],
    },
  }
}

describe('extension interaction session routing', () => {
  it('keeps inactive-session requests queued and takes the active session in arrival order', () => {
    const queue = [request('a-1', 'session-a'), request('b-1', 'session-b'), request('a-2', 'session-a')]

    expect(takeNextExtensionInteractionForSession(queue, 'session-b')?.requestId).toBe('b-1')
    expect(queue.map(item => item.requestId)).toEqual(['a-1', 'a-2'])
    expect(takeNextExtensionInteractionForSession(queue, 'session-a')?.requestId).toBe('a-1')
    expect(takeNextExtensionInteractionForSession(queue, 'session-a')?.requestId).toBe('a-2')
  })

  it('strictly accepts interaction v1 requests and cancellation events', () => {
    const interaction = {
      type: 'extension_interaction_request',
      requestId: 'same-id',
      sessionId: 'session-a',
      runtimeId: 'runtime-a',
      extensionId: 'ask-user',
      request: {
        schemaVersion: 1,
        fields: [{ id: 'choice', kind: 'choice', label: 'Choose', options: [{ id: 'one', label: 'One' }] }],
      },
    } satisfies ExtensionInteractionBridgeRequestV1
    expect(asExtensionInteractionRequest(interaction)).toEqual(interaction)
    expect(asExtensionInteractionRequest({ ...interaction, forged: true })).toBeNull()
    expect(extensionInteractionKey(interaction)).not.toBe(extensionInteractionKey({ ...interaction, runtimeId: 'runtime-b' }))

    const cancellation = {
      type: 'extension_interaction_cancel',
      requestId: 'same-id',
      sessionId: 'session-a',
      runtimeId: 'runtime-a',
      extensionId: 'ask-user',
      schemaVersion: 1,
      reason: 'aborted',
    } satisfies ExtensionInteractionBridgeCancelV1
    expect(asExtensionInteractionCancel(cancellation)).toEqual(cancellation)
    expect(asExtensionInteractionCancel({ ...cancellation, reason: 'unknown' })).toBeNull()

    const settlement = {
      type: 'extension_interaction_settled',
      requestId: 'same-id',
      sessionId: 'session-a',
      runtimeId: 'runtime-a',
      extensionId: 'ask-user',
      schemaVersion: 1,
      outcome: 'submitted',
    } satisfies ExtensionInteractionBridgeSettledV1
    expect(asExtensionInteractionSettled(settlement)).toEqual(settlement)
    expect(asExtensionInteractionSettled({ ...settlement, outcome: 'unknown' })).toBeNull()
  })
})
