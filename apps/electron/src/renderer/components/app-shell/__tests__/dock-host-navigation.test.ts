import { describe, expect, it, mock } from 'bun:test'
import { Model } from 'flexlayout-react'
import { handleBrowserHostDockNavigation } from '../dock-host-navigation'

function modelWithTwoGroups(): Model {
  return Model.fromJson({
    global: {},
    borders: [],
    layout: {
      type: 'row',
      children: [
        { type: 'tabset', id: 'left', selected: 0, active: true, children: [{ type: 'tab', id: 'left-tab', name: 'Left', component: 'content' }] },
        { type: 'tabset', id: 'right', selected: 0, children: [{ type: 'tab', id: 'right-tab', name: 'Right', component: 'content' }] },
      ],
    },
  })
}

describe('browser host dock navigation', () => {
  it('focuses the active tab header for F6', () => {
    const model = modelWithTwoGroups()
    const focus = mock(() => {})
    const document = { getElementById: (id: string) => id === 'flexlayout-tabbutton-left-tab' ? { focus } : null } as unknown as Document

    expect(handleBrowserHostDockNavigation(model, 'focus-active-tab', document)).toBe(true)
    expect(focus).toHaveBeenCalledTimes(1)
  })

  it('cycles active groups without accepting arbitrary commands', () => {
    const model = modelWithTwoGroups()
    const focused: string[] = []
    const document = {
      getElementById: (id: string) => ({ focus: () => focused.push(id) }),
    } as unknown as Document

    expect(handleBrowserHostDockNavigation(model, 'focus-next-group', document)).toBe(true)
    expect(model.getActiveTabset()?.getId()).toBe('right')
    expect(handleBrowserHostDockNavigation(model, 'focus-previous-group', document)).toBe(true)
    expect(model.getActiveTabset()?.getId()).toBe('left')
    expect(focused).toEqual(['flexlayout-tabbutton-right-tab', 'flexlayout-tabbutton-left-tab'])
  })
})
