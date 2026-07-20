import { describe, expect, it } from 'bun:test'
import {
  createNewConversationDraftId,
  getNewConversationDraftStorageKey,
  getNewConversationOptionsStorageScope,
} from '../new-conversation'

describe('new conversation draft identity', () => {
  it('creates a distinct identity for each new panel', () => {
    expect(createNewConversationDraftId()).not.toBe(createNewConversationDraftId())
  })

  it('isolates drafts by workspace and panel draft id', () => {
    expect(getNewConversationDraftStorageKey('ws-a', 'default'))
      .toBe('mortise.new-conversation.workspace_ws-a.draft_default.v1')
    expect(getNewConversationDraftStorageKey('ws-b', 'default'))
      .not.toBe(getNewConversationDraftStorageKey('ws-a', 'default'))
    expect(getNewConversationOptionsStorageScope('ws-a', 'panel-2'))
      .toBe('workspace_ws-a.draft_panel-2')
  })
})
