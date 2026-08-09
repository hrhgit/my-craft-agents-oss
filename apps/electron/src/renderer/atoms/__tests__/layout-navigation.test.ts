import { describe, expect, it } from 'bun:test'
import { createStore } from 'jotai'
import {
  acknowledgeConversationNavigationAtom,
  conversationNavigationRequestsAtom,
  requestConversationNavigationAtom,
} from '../layout-navigation'

describe('layout navigation intent queue', () => {
  it('preserves ordered replace and explicit open intents until acknowledged', () => {
    const store = createStore()
    store.set(requestConversationNavigationAtom, {
      workspaceId: 'ws-a',
      route: 'allSessions/session/s1',
      intent: 'replace-current',
    })
    store.set(requestConversationNavigationAtom, {
      workspaceId: 'ws-a',
      route: 'allSessions/session/s2',
      intent: 'open-new',
    })

    const requests = store.get(conversationNavigationRequestsAtom)
    expect(requests.map(request => request.intent)).toEqual(['replace-current', 'open-new'])
    expect(requests[0].newTabId).toBeUndefined()
    expect(requests[1].newTabId).toStartWith('content:conversation-')

    store.set(acknowledgeConversationNavigationAtom, requests[0].requestId)
    expect(store.get(conversationNavigationRequestsAtom)).toEqual([requests[1]])
  })

  it('keeps conditional publication identity in the request contract', () => {
    const store = createStore()
    store.set(requestConversationNavigationAtom, {
      workspaceId: 'ws-a',
      route: 'allSessions/session/published',
      intent: 'replace-current',
      targetTabId: 'conversation-tab',
      expectedRoute: 'allSessions/new/default',
    })

    expect(store.get(conversationNavigationRequestsAtom)[0]).toMatchObject({
      targetTabId: 'conversation-tab',
      expectedRoute: 'allSessions/new/default',
    })
  })
})
