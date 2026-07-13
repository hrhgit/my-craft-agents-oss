import { describe, expect, it } from 'bun:test'
import { handleProviderChanged } from '../session'
import type { SessionState } from '../../types'

describe('handleProviderChanged', () => {
  it('clears the renderer override when a deleted provider is removed', () => {
    const state = {
      session: {
        id: 'session-1',
        provider: 'deleted-provider',
        messages: [],
        isProcessing: false,
        lastMessageAt: 0,
      },
      streaming: null,
    } as unknown as SessionState

    const result = handleProviderChanged(state, {
      type: 'provider_changed',
      sessionId: 'session-1',
    })

    expect(result.state.session.provider).toBeUndefined()
  })
})
