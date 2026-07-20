import { describe, expect, it } from 'bun:test'
import {
  canReplaceContentTab,
  createDefaultAppLayout,
  focusConversationRoute,
  detachContentTab,
  detachPanelGroup,
  moveContentTab,
  openContentTab,
  redockLayoutWindow,
  restoreLayoutForStartup,
  sanitizeAppLayout,
  type ContentTab,
  type AppLayout,
} from '../app-layout'

function tab(id: string, groupId = 'group:main'): ContentTab {
  return {
    id,
    title: id,
    groupId,
    ref: {
      kind: 'conversation',
      serverId: 'server-a',
      workspaceId: id.includes('b') ? 'ws-b' : 'ws-a',
      sessionId: id,
    },
    protection: { pinned: false, dirty: false, running: false, awaitingInput: false },
    instancePolicy: 'multiple',
    allowDetach: true,
  }
}

function withRightGroup(layout: AppLayout): AppLayout {
  return {
    ...layout,
    groups: {
      ...layout.groups,
      'group:right': {
        id: 'group:right',
        windowId: 'primary',
        tabIds: [],
        activeTabId: null,
        defaultLocation: 'right',
      },
    },
    windows: {
      ...layout.windows,
      primary: { ...layout.windows.primary, groupIds: ['group:main', 'group:right'] },
    },
  }
}

describe('app layout domain', () => {
  it('focuses a new conversation while preserving other workspace content', () => {
    const initial = withRightGroup(createDefaultAppLayout({
      serverId: 'local',
      workspaceId: 'ws-a',
      sessionId: 'old-session',
      route: 'allSessions/session/old-session',
    }))
    const focused = focusConversationRoute(initial, 'allSessions/new/default')

    expect(Object.keys(focused.tabs)).toHaveLength(Object.keys(initial.tabs).length)
    expect(focused.tabs['content:main']?.ref).toEqual({
      kind: 'conversation',
      serverId: 'local',
      workspaceId: 'ws-a',
      resourceId: 'allSessions/new/default',
    })
    expect(focused.focusedTabId).toBe('content:main')
  })

  it('opens a separate draft instead of replacing a protected conversation', () => {
    const initial = createDefaultAppLayout({
      serverId: 'local',
      workspaceId: 'ws-a',
      sessionId: 'running-session',
      route: 'allSessions/session/running-session',
    })
    initial.tabs['content:main'] = {
      ...initial.tabs['content:main'],
      protection: { ...initial.tabs['content:main'].protection, pinned: true, running: true },
    }

    const focused = focusConversationRoute(initial, 'allSessions/new/default')

    expect(focused.tabs['content:main'].ref.sessionId).toBe('running-session')
    expect(focused.tabs['content:main'].protection).toMatchObject({ pinned: true, running: true })
    expect(focused.focusedTabId).not.toBe('content:main')
    expect(focused.tabs[focused.focusedTabId!].ref.resourceId).toBe('allSessions/new/default')
  })

  it('creates one main group and defers extra splits until content is opened', () => {
    const layout = createDefaultAppLayout({ serverId: 'local', workspaceId: 'ws-a', sessionId: 's1' })
    expect(layout.windows.primary.groupIds).toEqual(['group:main'])
    expect(layout.groups['group:right']).toBeUndefined()
    expect(layout.tabs['content:main'].ref.sessionId).toBe('s1')
  })

  it('protects pinned, dirty, running, and input-blocked tabs from replacement', () => {
    const base = tab('a')
    expect(canReplaceContentTab(base)).toBe(true)
    for (const key of ['pinned', 'dirty', 'running', 'awaitingInput'] as const) {
      expect(canReplaceContentTab({ ...base, protection: { ...base.protection, [key]: true } })).toBe(false)
    }
  })

  it('replaces a safe active tab and opens a new tab when protected', () => {
    const initial = createDefaultAppLayout({ serverId: 'local', workspaceId: 'ws-a' })
    const replaced = openContentTab(initial, tab('next'), { replaceTabId: 'content:main' })
    expect(replaced.tabs['content:main']).toBeUndefined()
    expect(replaced.groups['group:main'].tabIds).toEqual(['next'])

    const protectedLayout = {
      ...replaced,
      tabs: {
        ...replaced.tabs,
        next: { ...replaced.tabs.next, protection: { ...replaced.tabs.next.protection, running: true } },
      },
    }
    const appended = openContentTab(protectedLayout, tab('next-2'), { replaceTabId: 'next' })
    expect(appended.groups['group:main'].tabIds).toEqual(['next', 'next-2'])
  })

  it('rejects content from another workspace before it enters the layout', () => {
    let layout = withRightGroup(createDefaultAppLayout({ serverId: 'local', workspaceId: 'ws-a' }))
    layout = openContentTab(layout, tab('b-session'), { forceNew: true })
    expect(layout.tabs['b-session']).toBeUndefined()
    expect(moveContentTab(layout, 'b-session', 'group:right', 0)).toBe(layout)
  })

  it('detaches a group, redocks it on close, and redocks all auxiliaries on restart', () => {
    const initial = openContentTab(
      withRightGroup(createDefaultAppLayout({ serverId: 'local', workspaceId: 'ws-a' })),
      tab('right-one', 'group:right'),
      { forceNew: true },
    )
    const detached = detachPanelGroup(initial, 'group:right', 'aux-1', { x: 10, y: 20, width: 800, height: 600 })
    expect(detached.windows['aux-1'].groupIds).toEqual(['group:right'])
    expect(detached.groups['group:right'].windowId).toBe('aux-1')

    const redocked = redockLayoutWindow(detached, 'aux-1')
    expect(redocked.windows['aux-1']).toBeUndefined()
    expect(redocked.windows.primary.groupIds).toEqual(['group:main', 'group:right'])

    const restarted = restoreLayoutForStartup(detached)
    expect(restarted.windows['aux-1']).toBeUndefined()
    expect(restarted.groups['group:right'].windowId).toBe('primary')
  })

  it('detaches one tab from its group and restores it at the original index', () => {
    let initial = createDefaultAppLayout({ serverId: 'local', workspaceId: 'ws-a' })
    initial = openContentTab(initial, tab('middle'), { forceNew: true })
    initial = openContentTab(initial, tab('last'), { forceNew: true })

    const detached = detachContentTab(initial, 'middle', 'aux-tab', { x: 40, y: 50, width: 900, height: 700 })
    const auxiliaryGroupId = detached.windows['aux-tab'].groupIds[0]
    expect(detached.groups['group:main'].tabIds).toEqual(['content:main', 'last'])
    expect(detached.groups[auxiliaryGroupId].tabIds).toEqual(['middle'])
    expect(detached.tabs.middle.groupId).toBe(auxiliaryGroupId)
    expect(detached.windows['aux-tab'].sourceTabIndex).toBe(1)

    const redocked = redockLayoutWindow(detached, 'aux-tab')
    expect(redocked.windows['aux-tab']).toBeUndefined()
    expect(redocked.groups[auxiliaryGroupId]).toBeUndefined()
    expect(redocked.groups['group:main'].tabIds).toEqual(['content:main', 'middle', 'last'])
    expect(redocked.tabs.middle.groupId).toBe('group:main')
  })

  it('locally reinserts a detached tab without replacing the latest primary geometry', () => {
    let initial = createDefaultAppLayout({ serverId: 'local', workspaceId: 'ws-a' })
    initial = openContentTab(initial, tab('detached'), { forceNew: true })
    initial.geometry = {
      marker: 'before-detach',
      layout: {
        type: 'row', id: 'root', children: [{
          type: 'row', id: 'nested', weight: 70, children: [{
            type: 'tabset', id: 'group:main', weight: 60, children: [
              { type: 'tab', id: 'content:main' },
              { type: 'tab', id: 'detached' },
            ],
          }, { type: 'tabset', id: 'stable', weight: 40, children: [{ type: 'tab', id: 'stable-tab' }] }],
        }, { type: 'tabset', id: 'other', weight: 30, children: [{ type: 'tab', id: 'other-tab' }] }],
      },
    }

    const detached = detachContentTab(initial, 'detached', 'aux-tab')
    const latestPrimaryGeometry = {
      marker: 'resized-while-detached',
      layout: {
        type: 'row', id: 'root', children: [{
          type: 'row', id: 'nested', weight: 82, children: [{
            type: 'tabset', id: 'group:main', weight: 73, children: [{ type: 'tab', id: 'content:main' }],
          }, { type: 'tabset', id: 'stable', weight: 27, children: [{ type: 'tab', id: 'stable-tab' }] }],
        }, { type: 'tabset', id: 'other', weight: 18, children: [{ type: 'tab', id: 'other-tab' }] }],
      },
    }
    detached.geometry = latestPrimaryGeometry
    detached.windows.primary.geometry = latestPrimaryGeometry
    detached.windows['aux-tab'].geometry = {
      marker: 'auxiliary-must-not-replace-primary',
      layout: {
        type: 'row', children: [{
          type: 'tabset', id: detached.windows['aux-tab'].groupIds[0],
          children: [{ type: 'tab', id: 'detached', name: 'Detached' }],
        }],
      },
    }
    const redocked = redockLayoutWindow(detached, 'aux-tab')

    expect(redocked.groups['group:main'].tabIds).toEqual(['content:main', 'detached'])
    expect((redocked.geometry as any).marker).toBe('resized-while-detached')
    expect((redocked.geometry as any).layout.children[0].weight).toBe(82)
    expect((redocked.geometry as any).layout.children[0].children[0].weight).toBe(73)
    expect((redocked.geometry as any).layout.children[0].children[1].weight).toBe(27)
    expect((redocked.geometry as any).layout.children[0].children[0].children.map((item: any) => item.id))
      .toEqual(['content:main', 'detached'])
    expect((redocked.windows.primary.geometry as any).marker).toBe('resized-while-detached')
  })

  it('returns a detached group to its nested anchor without changing current sibling ratios', () => {
    let initial = withRightGroup(createDefaultAppLayout({ serverId: 'local', workspaceId: 'ws-a' }))
    initial = openContentTab(initial, tab('right-one', 'group:right'), { forceNew: true })
    initial.groups.bottom = {
      id: 'bottom', windowId: 'primary', tabIds: [], activeTabId: null, defaultLocation: 'bottom',
    }
    initial.windows.primary.groupIds.push('bottom')
    initial.geometry = {
      layout: {
        type: 'row', id: 'root', children: [{
          type: 'row', id: 'nested', weight: 80, children: [
            { type: 'tabset', id: 'group:main', weight: 50, children: [{ type: 'tab', id: 'content:main' }] },
            { type: 'tabset', id: 'group:right', weight: 25, children: [{ type: 'tab', id: 'right-one' }] },
            { type: 'tabset', id: 'bottom', weight: 25, children: [{ type: 'tab', id: 'bottom-tab' }] },
          ],
        }, { type: 'tabset', id: 'outside', weight: 20, children: [{ type: 'tab', id: 'outside-tab' }] }],
      },
    }
    const detached = detachPanelGroup(initial, 'group:right', 'aux-right')
    detached.geometry = {
      marker: 'latest-primary',
      layout: {
        type: 'row', id: 'root', children: [{
          type: 'row', id: 'nested', weight: 88, children: [
            { type: 'tabset', id: 'group:main', weight: 64, children: [{ type: 'tab', id: 'content:main' }] },
            { type: 'tabset', id: 'bottom', weight: 36, children: [{ type: 'tab', id: 'bottom-tab' }] },
          ],
        }, { type: 'tabset', id: 'outside', weight: 12, children: [{ type: 'tab', id: 'outside-tab' }] }],
      },
    }
    detached.windows['aux-right'].geometry = {
      marker: 'auxiliary',
      layout: {
        type: 'row', children: [{
          type: 'tabset', id: 'group:right', children: [{ type: 'tab', id: 'right-one' }],
        }],
      },
    }

    const recoveredDetached = sanitizeAppLayout(JSON.parse(JSON.stringify(detached)))
    const redocked = redockLayoutWindow(recoveredDetached, 'aux-right')
    const nested = (redocked.geometry as any).layout.children[0]
    expect((redocked.geometry as any).marker).toBe('latest-primary')
    expect(nested.weight).toBe(88)
    expect(nested.children.map((item: any) => item.id)).toEqual(['group:main', 'group:right', 'bottom'])
    expect(nested.children.map((item: any) => item.weight)).toEqual([64, 25, 36])
  })

  it('redocks multiple detached tabs in source order regardless of close order', () => {
    let initial = createDefaultAppLayout({ serverId: 'local', workspaceId: 'ws-a' })
    initial = openContentTab(initial, tab('one'), { forceNew: true })
    initial = openContentTab(initial, tab('two'), { forceNew: true })
    initial = openContentTab(initial, tab('three'), { forceNew: true })

    const detachedOne = detachContentTab(initial, 'one', 'aux-one')
    const detachedBoth = detachContentTab(detachedOne, 'two', 'aux-two')
    expect(detachedBoth.windows['aux-one'].sourceTabIndex).toBe(1)
    expect(detachedBoth.windows['aux-two'].sourceTabIndex).toBe(2)

    const forward = redockLayoutWindow(redockLayoutWindow(detachedBoth, 'aux-one'), 'aux-two')
    const reverse = redockLayoutWindow(redockLayoutWindow(detachedBoth, 'aux-two'), 'aux-one')
    const expected = ['content:main', 'one', 'two', 'three']
    expect(forward.groups['group:main'].tabIds).toEqual(expected)
    expect(reverse.groups['group:main'].tabIds).toEqual(expected)

    const auxOneGroupId = detachedBoth.windows['aux-one'].groupIds[0]
    let expanded = openContentTab(detachedBoth, tab('added', auxOneGroupId), { forceNew: true })
    expanded = moveContentTab(expanded, 'added', auxOneGroupId, 0)
    const expandedForward = redockLayoutWindow(redockLayoutWindow(expanded, 'aux-one'), 'aux-two')
    const expandedReverse = redockLayoutWindow(redockLayoutWindow(expanded, 'aux-two'), 'aux-one')
    const expandedExpected = ['content:main', 'added', 'one', 'two', 'three']
    expect(expandedForward.groups['group:main'].tabIds).toEqual(expandedExpected)
    expect(expandedReverse.groups['group:main'].tabIds).toEqual(expandedExpected)
  })

  it('uses the auxiliary leaf anchor when the original detached tab was closed', () => {
    let initial = createDefaultAppLayout({ serverId: 'local', workspaceId: 'ws-a' })
    initial = openContentTab(initial, tab('detached'), { forceNew: true })
    const groupTabs = new Map([
      ['before-one', 'lead-one'],
      ['before-two', 'lead-two'],
      ['tail', 'tail-one'],
    ])
    for (const [groupId, tabId] of groupTabs) {
      initial.groups[groupId] = {
        id: groupId, windowId: 'primary', tabIds: [], activeTabId: null,
      }
      initial.windows.primary.groupIds.push(groupId)
      initial = openContentTab(initial, tab(tabId, groupId), { forceNew: true })
    }
    initial.windows.primary.groupIds = ['before-one', 'before-two', 'group:main', 'tail']
    initial.geometry = {
      layout: {
        type: 'row', id: 'primary-root', children: [
          { type: 'tabset', id: 'before-one', weight: 10, children: [{ type: 'tab', id: 'lead-one' }] },
          { type: 'tabset', id: 'before-two', weight: 20, children: [{ type: 'tab', id: 'lead-two' }] },
          { type: 'tabset', id: 'group:main', weight: 40, children: [
            { type: 'tab', id: 'content:main' }, { type: 'tab', id: 'detached' },
          ] },
          { type: 'tabset', id: 'tail', weight: 30, children: [{ type: 'tab', id: 'tail-one' }] },
        ],
      },
    }
    const detached = detachContentTab(initial, 'detached', 'aux-closed')
    expect(detached.windows['aux-closed'].sourceIndex).toBe(2)
    const originalAuxGroupId = detached.windows['aux-closed'].groupIds[0]
    delete detached.tabs.detached
    delete detached.groups[originalAuxGroupId]
    detached.groups['aux-one'] = {
      id: 'aux-one', windowId: 'aux-closed', tabIds: ['extra-one'], activeTabId: 'extra-one',
    }
    detached.groups['aux-two'] = {
      id: 'aux-two', windowId: 'aux-closed', tabIds: ['extra-two'], activeTabId: 'extra-two',
    }
    detached.tabs['extra-one'] = tab('extra-one', 'aux-one')
    detached.tabs['extra-two'] = tab('extra-two', 'aux-two')
    detached.windows['aux-closed'].groupIds = ['aux-one', 'aux-two']
    detached.windows['aux-closed'].geometry = {
      layout: {
        type: 'row', id: 'aux-root', children: [{
          type: 'row', id: 'aux-nested', weight: 100, children: [
            { type: 'tabset', id: 'aux-one', weight: 30, children: [{ type: 'tab', id: 'extra-one' }] },
            { type: 'tabset', id: 'aux-two', weight: 70, children: [{ type: 'tab', id: 'extra-two' }] },
          ],
        }],
      },
    }
    detached.geometry = {
      marker: 'latest-primary',
      layout: {
        type: 'row', id: 'primary-root', children: [
          { type: 'tabset', id: 'before-one', weight: 10, children: [{ type: 'tab', id: 'lead-one' }] },
          { type: 'tabset', id: 'before-two', weight: 20, children: [{ type: 'tab', id: 'lead-two' }] },
          { type: 'tabset', id: 'group:main', weight: 40, children: [{ type: 'tab', id: 'content:main' }] },
          { type: 'tabset', id: 'tail', weight: 30, children: [{ type: 'tab', id: 'tail-one' }] },
        ],
      },
    }

    const redocked = redockLayoutWindow(detached, 'aux-closed')
    const traversal: string[] = []
    const visit = (node: any) => {
      for (const child of node.children ?? []) {
        if (child.type === 'tabset') traversal.push(child.id)
        else if (child.type === 'row') visit(child)
      }
    }
    visit((redocked.geometry as any).layout)

    expect(redocked.windows.primary.groupIds).toEqual([
      'before-one', 'before-two', 'group:main', 'aux-one', 'aux-two', 'tail',
    ])
    expect(traversal).toEqual(redocked.windows.primary.groupIds)
    const nested = (redocked.geometry as any).layout.children[2]
    expect(nested.type).toBe('row')
    expect(nested.weight).toBe(40)
    expect(nested.children.map((node: any) => [node.id, node.weight])).toEqual([
      ['group:main', 40],
      ['aux-one', 30],
      ['aux-two', 70],
    ])
    expect((redocked.geometry as any).layout.children[0].weight).toBe(10)
    expect((redocked.geometry as any).layout.children[1].weight).toBe(20)
    expect((redocked.geometry as any).layout.children[3].weight).toBe(30)
  })

  it('redocks multiple detached groups in source order regardless of close order', () => {
    const initial = withRightGroup(createDefaultAppLayout({ serverId: 'local', workspaceId: 'ws-a' }))
    initial.groups['group:bottom'] = {
      id: 'group:bottom', windowId: 'primary', tabIds: [], activeTabId: null, defaultLocation: 'bottom',
    }
    initial.groups['group:left'] = {
      id: 'group:left', windowId: 'primary', tabIds: [], activeTabId: null, defaultLocation: 'left',
    }
    initial.windows.primary.groupIds = ['group:main', 'group:right', 'group:bottom', 'group:left']

    const detachedRight = detachPanelGroup(initial, 'group:right', 'aux-right')
    const detachedBottom = detachPanelGroup(detachedRight, 'group:bottom', 'aux-bottom')
    expect(detachedBottom.windows['aux-right'].sourceIndex).toBe(1)
    expect(detachedBottom.windows['aux-bottom'].sourceIndex).toBe(2)

    const forward = redockLayoutWindow(redockLayoutWindow(detachedBottom, 'aux-right'), 'aux-bottom')
    const reverse = redockLayoutWindow(redockLayoutWindow(detachedBottom, 'aux-bottom'), 'aux-right')
    const expected = ['group:main', 'group:right', 'group:bottom', 'group:left']
    expect(forward.windows.primary.groupIds).toEqual(expected)
    expect(reverse.windows.primary.groupIds).toEqual(expected)

    const expanded = structuredClone(detachedBottom)
    expanded.groups['group:aux-extra'] = {
      id: 'group:aux-extra', windowId: 'aux-right', tabIds: [], activeTabId: null,
    }
    expanded.windows['aux-right'].groupIds = ['group:aux-extra', 'group:right']
    const expandedForward = redockLayoutWindow(redockLayoutWindow(expanded, 'aux-right'), 'aux-bottom')
    const expandedReverse = redockLayoutWindow(redockLayoutWindow(expanded, 'aux-bottom'), 'aux-right')
    const expandedExpected = ['group:main', 'group:aux-extra', 'group:right', 'group:bottom', 'group:left']
    expect(expandedForward.windows.primary.groupIds).toEqual(expandedExpected)
    expect(expandedReverse.windows.primary.groupIds).toEqual(expandedExpected)
  })

  it('does not detach a group while it owns an outstanding detached tab', () => {
    let initial = withRightGroup(createDefaultAppLayout({ serverId: 'local', workspaceId: 'ws-a' }))
    initial = openContentTab(initial, tab('one'), { forceNew: true })
    const detached = detachContentTab(initial, 'one', 'aux-tab')
    expect(detachPanelGroup(detached, 'group:main', 'aux-group')).toBe(detached)
  })

  it('allows the only primary tab to detach while preserving an empty redock target', () => {
    const initial = createDefaultAppLayout({ serverId: 'local', workspaceId: 'ws-a' })
    const detached = detachContentTab(initial, 'content:main', 'aux-only')
    expect(detached.groups['group:main'].tabIds).toEqual([])
    expect(detached.windows.primary.groupIds).toEqual(['group:main'])

    const restarted = restoreLayoutForStartup(detached)
    expect(restarted.groups['group:main'].tabIds).toEqual(['content:main'])
    expect(restarted.windows['aux-only']).toBeUndefined()
  })

  it('restores auxiliary content after the final primary tab was closed', () => {
    let initial = withRightGroup(createDefaultAppLayout({ serverId: 'local', workspaceId: 'ws-a' }))
    initial = openContentTab(initial, tab('aux-one', 'group:right'), { forceNew: true })
    const detached = detachPanelGroup(initial, 'group:right', 'aux-only')
    const persisted = {
      ...detached,
      tabs: { 'aux-one': detached.tabs['aux-one'] },
      groups: { 'group:right': detached.groups['group:right'] },
      windows: {
        ...detached.windows,
        primary: { ...detached.windows.primary, groupIds: [] },
      },
      focusedTabId: 'aux-one',
    }

    const sanitized = sanitizeAppLayout(persisted)
    expect(sanitized.windows.primary.groupIds).toEqual([])
    expect(sanitized.windows['aux-only'].groupIds).toEqual(['group:right'])
    expect(sanitized.groups['group:right'].tabIds).toEqual(['aux-one'])
    expect(sanitized.tabs['aux-one']).toBeDefined()

    const restarted = restoreLayoutForStartup(sanitized)
    expect(restarted.windows.primary.groupIds).toEqual(['group:right'])
    expect(restarted.windows['aux-only']).toBeUndefined()
    expect(restarted.groups['group:right']).toMatchObject({
      windowId: 'primary',
      tabIds: ['aux-one'],
      activeTabId: 'aux-one',
    })
    expect(restarted.tabs['aux-one'].groupId).toBe('group:right')
  })

  it('drops full browser URLs and retired side-task tabs during persistence recovery', () => {
    const layout = createDefaultAppLayout({ serverId: 'local', workspaceId: 'ws-a' })
    const unsafe = {
      ...layout,
      tabs: {
        ...layout.tabs,
        browser: {
          ...tab('browser'),
          ref: {
            kind: 'browser',
            serverId: 'local',
            workspaceId: 'ws-a',
            resourceId: 'https://example.test/path?token=secret',
          },
        },
        sideTasks: {
          ...tab('sideTasks'),
          ref: {
            kind: 'side-task',
            serverId: 'local',
            workspaceId: 'ws-a',
            sessionId: 'parent-session',
            resourceId: 'side-tasks:parent-session',
          },
        },
      },
      groups: {
        ...layout.groups,
        'group:main': {
          ...layout.groups['group:main'],
          tabIds: [...layout.groups['group:main'].tabIds, 'browser', 'sideTasks'],
        },
      },
    }
    const recovered = sanitizeAppLayout(unsafe)
    expect(recovered.tabs.browser.ref.resourceId).toBeUndefined()
    expect(recovered.tabs.sideTasks).toBeUndefined()
    expect(recovered.groups['group:main'].tabIds).not.toContain('sideTasks')
  })

  it('drops retired Sources navigation tabs during persistence recovery', () => {
    const layout = createDefaultAppLayout({ serverId: 'local', workspaceId: 'ws-a' })
    const persisted = {
      ...layout,
      tabs: {
        ...layout.tabs,
        sources: {
          ...tab('sources'),
          ref: {
            kind: 'navigation',
            serverId: 'local',
            workspaceId: 'ws-a',
            resourceId: 'sources/api/source/github',
          },
        },
      },
      groups: {
        ...layout.groups,
        'group:main': {
          ...layout.groups['group:main'],
          tabIds: [...layout.groups['group:main'].tabIds, 'sources'],
        },
      },
    }

    const recovered = sanitizeAppLayout(persisted)
    expect(recovered.tabs.sources).toBeUndefined()
    expect(recovered.groups['group:main'].tabIds).not.toContain('sources')
  })

  it('preserves non-detachable content through persisted layout sanitization', () => {
    const layout = createDefaultAppLayout({ serverId: 'local', workspaceId: 'ws-a' })
    layout.tabs['content:main'].allowDetach = false

    const recovered = sanitizeAppLayout(JSON.parse(JSON.stringify(layout)))
    expect(recovered.tabs['content:main'].allowDetach).toBe(false)
    expect(detachContentTab(recovered, 'content:main', 'aux-tab')).toBe(recovered)
  })

  it('repairs duplicate tab membership and removes unreferenced empty groups', () => {
    const layout = withRightGroup(createDefaultAppLayout({ serverId: 'local', workspaceId: 'ws-a' }))
    const corrupted = {
      ...layout,
      tabs: {
        ...layout.tabs,
        one: { ...tab('one'), groupId: 'group:right' },
      },
      groups: {
        ...layout.groups,
        'group:main': {
          ...layout.groups['group:main'],
          tabIds: ['content:main', 'one', 'one'],
        },
        'group:right': {
          ...layout.groups['group:right'],
          tabIds: ['one', 'one'],
        },
        'group:empty': {
          id: 'group:empty', windowId: 'primary', tabIds: [], activeTabId: null,
        },
      },
      windows: {
        primary: {
          ...layout.windows.primary,
          groupIds: ['group:main', 'group:right', 'group:right', 'group:empty'],
        },
      },
    }

    const recovered = sanitizeAppLayout(corrupted)
    expect(recovered.groups['group:main'].tabIds).toEqual(['content:main'])
    expect(recovered.groups['group:right'].tabIds).toEqual(['one'])
    expect(recovered.tabs.one.groupId).toBe('group:right')
    expect(recovered.groups['group:empty']).toBeUndefined()
    expect(recovered.windows.primary.groupIds).toEqual(['group:main', 'group:right'])
  })
})
