import { describe, expect, it } from 'bun:test'
import { createInitialConversationRouteConsumer, resolveLivePanelRoute } from '../initial-conversation-route'
import type { PanelStackEntry } from '@/atoms/panel-stack'

describe('initial conversation route consumer', () => {
  it('consumes an initial new-conversation route only once', () => {
    const consumer = createInitialConversationRouteConsumer('?route=allSessions%2Fnew%2Fdraft-1')

    expect(consumer.consume()).toBe('allSessions/new/draft-1')
    expect(consumer.consume()).toBeNull()
  })

  it('ignores session and non-conversation routes', () => {
    expect(createInitialConversationRouteConsumer('?route=allSessions%2Fsession%2Fs1').consume()).toBeNull()
    expect(createInitialConversationRouteConsumer('?route=settings%2Fapp').consume()).toBeNull()
  })

  it('does not fall back to a stale conversation focus while a tool tab is active', () => {
    const panels: PanelStackEntry[] = [{
      id: 'conversation',
      route: 'allSessions/new/draft-1',
      proportion: 1,
      panelType: 'session' as const,
      laneId: 'main' as const,
    }]

    expect(resolveLivePanelRoute(panels, 'browser', 'conversation')).toBeNull()
    expect(resolveLivePanelRoute(panels, null, 'conversation')).toBe('allSessions/new/draft-1')
  })
})
