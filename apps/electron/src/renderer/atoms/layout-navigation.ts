import { atom } from 'jotai'
import type { ConversationNavigationIntent } from '../../shared/app-layout'
import type { ViewRoute } from '../../shared/routes'

export interface ConversationNavigationRequest {
  requestId: number
  workspaceId: string
  route: ViewRoute
  intent: ConversationNavigationIntent
  targetTabId?: string
  expectedRoute?: ViewRoute
  newTabId?: string
}

type ConversationNavigationInput = Omit<ConversationNavigationRequest, 'requestId' | 'newTabId'>

let nextConversationNavigationRequestId = 0
let nextConversationTabId = 0

export const conversationNavigationRequestsAtom = atom<ConversationNavigationRequest[]>([])

export const requestConversationNavigationAtom = atom(
  null,
  (_get, set, input: ConversationNavigationInput) => {
    const requestId = ++nextConversationNavigationRequestId
    const request: ConversationNavigationRequest = {
      ...input,
      requestId,
      ...(input.intent === 'open-new'
        ? { newTabId: `content:conversation-${Date.now()}-${++nextConversationTabId}` }
        : {}),
    }
    set(conversationNavigationRequestsAtom, current => [...current, request])
    return requestId
  },
)

export const acknowledgeConversationNavigationAtom = atom(
  null,
  (_get, set, requestId: number) => {
    set(conversationNavigationRequestsAtom, current => current.filter(request => request.requestId !== requestId))
  },
)
