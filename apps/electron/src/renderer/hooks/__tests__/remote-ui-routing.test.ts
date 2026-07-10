import { describe, expect, it } from 'bun:test'
import type { RemoteUIRequest } from '../../components/extensions/RemoteUIModal'
import { asRemoteUIRequest, takeNextRemoteUIRequestForSession } from '../useRemoteUIRequests'

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
})
