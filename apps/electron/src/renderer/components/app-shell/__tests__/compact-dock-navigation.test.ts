import { describe, expect, it } from 'bun:test'
import { Actions, Model } from 'flexlayout-react'
import {
  actionEntersCompactDockDetail,
  compactDockIntentAfterRouteChange,
  resolveCompactDockDetailActive,
} from '../compact-dock-navigation'

function createModel(): Model {
  return Model.fromJson({
    global: {},
    layout: {
      type: 'row',
      children: [{
        type: 'tabset',
        id: 'main',
        children: [
          { type: 'tab', id: 'session', name: 'Session', component: 'craft-content' },
          { type: 'tab', id: 'files', name: 'Files', component: 'craft-content' },
        ],
      }],
    },
  })
}

describe('compact dock drill-in navigation', () => {
  it('lets explicit navigator/detail intent override the focused route', () => {
    expect(resolveCompactDockDetailActive({ isCompact: true, routeHasDetail: false, intent: null })).toBe(false)
    expect(resolveCompactDockDetailActive({ isCompact: true, routeHasDetail: true, intent: null })).toBe(true)
    expect(resolveCompactDockDetailActive({ isCompact: true, routeHasDetail: false, intent: 'detail' })).toBe(true)
    expect(resolveCompactDockDetailActive({ isCompact: true, routeHasDetail: true, intent: 'navigator' })).toBe(false)
    expect(resolveCompactDockDetailActive({ isCompact: false, routeHasDetail: true, intent: 'detail' })).toBe(false)
  })

  it('turns route-to-list into an explicit navigator intent', () => {
    expect(compactDockIntentAfterRouteChange(false)).toBe('navigator')
    expect(compactDockIntentAfterRouteChange(true)).toBeNull()
  })

  it('enters detail for a direct FlexLayout tab selection, not unrelated model changes', () => {
    const model = createModel()
    expect(actionEntersCompactDockDetail(model, Actions.selectTab('files'))).toBe(true)
    expect(actionEntersCompactDockDetail(model, Actions.adjustWeights('main', [50, 50]))).toBe(false)
    expect(actionEntersCompactDockDetail(model, Actions.selectTab('missing'))).toBe(false)
  })
})
