import { describe, expect, it } from 'bun:test'

import {
  getConversationScrollMetrics,
  reduceConversationFollowState,
  type ConversationFollowState,
} from '../../../hooks/useConversationScrollController'

describe('conversation scroll follow policy', () => {
  it('treats a viewport within the threshold as being at the bottom', () => {
    expect(getConversationScrollMetrics({ scrollTop: 376, scrollHeight: 500, clientHeight: 100 })).toEqual({
      scrollTop: 376,
      scrollHeight: 500,
      clientHeight: 100,
      distanceFromBottom: 24,
      atBottom: true,
    })
  })

  it('detaches only for an upward user gesture', () => {
    const state: ConversationFollowState = { following: true, hasNewContent: false }

    expect(reduceConversationFollowState(state, {
      userInitiated: true,
      movedUp: true,
      atBottom: false,
    })).toEqual({ following: false, hasNewContent: false })

    expect(reduceConversationFollowState(state, {
      userInitiated: false,
      movedUp: true,
      atBottom: false,
    })).toEqual(state)
  })

  it('marks unseen content without moving a detached viewport', () => {
    expect(reduceConversationFollowState(
      { following: false, hasNewContent: false },
      { userInitiated: false, movedUp: false, atBottom: false, contentChanged: true },
    )).toEqual({ following: false, hasNewContent: true })
  })

  it('resumes when a user scrolls back to the bottom', () => {
    expect(reduceConversationFollowState(
      { following: false, hasNewContent: true },
      { userInitiated: true, movedUp: false, atBottom: true },
    )).toEqual({ following: true, hasNewContent: false })
  })
})
