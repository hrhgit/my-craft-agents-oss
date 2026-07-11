import { describe, expect, it } from 'bun:test'
import { isPiNativeConversation, shouldSuppressLegacyTranscriptEvent } from '../projection-migration'

describe('projection migration policy', () => {
  it('requires an explicit Pi-first ownership marker', () => {
    expect(isPiNativeConversation(undefined)).toBe(false)
    expect(isPiNativeConversation({})).toBe(false)
    expect(isPiNativeConversation({ conversationFormat: 'legacy-craft' })).toBe(false)
    expect(isPiNativeConversation({ conversationFormat: 'pi-projection-v1' })).toBe(true)
  })

  it('suppresses Pi-owned slices from the first event of a marked conversation', () => {
    for (const type of [
      'text_delta', 'text_complete', 'tool_start', 'tool_result', 'error', 'typed_error', 'complete',
      'user_message', 'permission_request', 'plan_submitted', 'plan_artifact_changed', 'plan_mode_state_changed',
      'auth_request', 'auth_completed',
    ]) {
      expect(shouldSuppressLegacyTranscriptEvent(true, type)).toBe(true)
      expect(shouldSuppressLegacyTranscriptEvent(false, type)).toBe(false)
    }
  })

  it('retains Host business events', () => {
    for (const type of ['credential_request', 'labels_changed', 'background_task']) {
      expect(shouldSuppressLegacyTranscriptEvent(true, type)).toBe(false)
    }
  })
})
