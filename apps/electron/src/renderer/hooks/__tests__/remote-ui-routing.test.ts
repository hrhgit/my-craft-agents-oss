import { describe, expect, it } from 'bun:test'
import type { ExtensionInteractionBridgeCancelV1, ExtensionInteractionBridgeRequestV1 } from '@craft-agent/shared/protocol'
import type { RemoteUIRequest } from '../../components/extensions/RemoteUIModal'
import {
  asExtensionInteractionCancel,
  asExtensionInteractionRequest,
  asRemoteUIRequest,
  extensionUIRequestKey,
  takeNextRemoteUIRequestForSession,
} from '../useRemoteUIRequests'

function request(requestId: string, sessionId: string): RemoteUIRequest {
  return {
    type: 'remoteui_request',
    requestId,
    kind: 'confirm',
    title: requestId,
    message: 'Continue?',
    source: 'ask-user',
    extensionId: 'ask-user',
    runtimeId: `runtime-${sessionId}`,
    sessionId,
  }
}

describe('remote UI session routing', () => {
  it('keeps inactive-session requests queued and takes the active session in arrival order', () => {
    const queue = [request('a-1', 'session-a'), request('b-1', 'session-b'), request('a-2', 'session-a')]

    expect(takeNextRemoteUIRequestForSession(queue, 'session-b')?.requestId).toBe('b-1')
    expect(queue.map(item => item.requestId)).toEqual(['a-1', 'a-2'])
    expect(takeNextRemoteUIRequestForSession(queue, 'session-a')?.requestId).toBe('a-1')
    expect(takeNextRemoteUIRequestForSession(queue, 'session-a')?.requestId).toBe('a-2')
  })

  it('accepts select, confirm and editor events and rejects unsupported kinds', () => {
    expect(asRemoteUIRequest(request('confirm', 'session-a'))?.kind).toBe('confirm')
    expect(asRemoteUIRequest({ ...request('select', 'session-a'), kind: 'select', options: [] })?.kind).toBe('select')
    expect(asRemoteUIRequest({ ...request('editor', 'session-a'), kind: 'editor' })?.kind).toBe('editor')
    expect(asRemoteUIRequest({ ...request('bad', 'session-a'), kind: 'custom' })).toBeNull()
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
    expect(extensionUIRequestKey(interaction)).not.toBe(extensionUIRequestKey({ ...interaction, runtimeId: 'runtime-b' }))

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
  })
})
