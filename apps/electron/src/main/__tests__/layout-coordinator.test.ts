import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDefaultAppLayout, openContentTab, type AppLayout, type ContentTab } from '../../shared/app-layout'
import { LayoutCoordinator } from '../layout-coordinator'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function pathForTest(): string {
  const root = mkdtempSync(join(tmpdir(), 'mortise-layout-'))
  roots.push(root)
  return join(root, 'layout.json')
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

function tab(id: string, groupId = 'group:main'): ContentTab {
  return {
    id,
    title: id,
    groupId,
    ref: { kind: 'conversation', serverId: 'local', workspaceId: 'ws-a', sessionId: id },
    protection: { pinned: false, dirty: false, running: false, awaitingInput: false },
    instancePolicy: 'multiple',
    allowDetach: true,
  }
}

describe('LayoutCoordinator', () => {
  it('atomically persists versioned layouts per workspace', () => {
    const storagePath = pathForTest()
    const coordinator = new LayoutCoordinator({ storagePath })
    const next = createDefaultAppLayout({ serverId: 'local', workspaceId: 'ws-a', sessionId: 's1' })
    const saved = coordinator.saveSnapshot(next, coordinator.getSnapshot('ws-a').revision)
    expect(saved.revision).toBeGreaterThan(next.revision)
    expect(JSON.parse(readFileSync(storagePath, 'utf8')).layouts['ws-a'].tabs['content:main'].ref.sessionId).toBe('s1')
  })

  it('rejects stale writers and unauthorized workspace routes', () => {
    const coordinator = new LayoutCoordinator({
      storagePath: pathForTest(),
      authorizeContentRef: ref => ref.serverId === 'local' && ref.workspaceId !== 'blocked',
    })
    const snapshot = coordinator.getSnapshot('allowed')
    const allowed = createDefaultAppLayout({ serverId: 'local', workspaceId: 'allowed' })
    coordinator.saveSnapshot(allowed, snapshot.revision)
    expect(() => coordinator.saveSnapshot(allowed, snapshot.revision)).toThrow('revision conflict')

    const blocked = createDefaultAppLayout({ serverId: 'local', workspaceId: 'blocked' })
    expect(() => coordinator.saveSnapshot(blocked)).toThrow('Unauthorized content route')
  })

  it('redocks detached groups when the app restarts', () => {
    const storagePath = pathForTest()
    const coordinator = new LayoutCoordinator({ storagePath })
    coordinator.saveSnapshot(openContentTab(
      withRightGroup(createDefaultAppLayout({ serverId: 'local', workspaceId: 'ws-a' })),
      tab('right-one', 'group:right'),
      { forceNew: true },
    ))
    coordinator.detachGroup('ws-a', 'group:right', 'aux-1')
    expect(coordinator.getSnapshot('ws-a').windows['aux-1']).toBeDefined()

    const restarted = new LayoutCoordinator({ storagePath })
    expect(restarted.getSnapshot('ws-a').windows['aux-1']).toBeUndefined()
    expect(restarted.getSnapshot('ws-a').groups['group:right'].windowId).toBe('primary')
  })

  it('persists a detached tab and redocks it into its source group after restart', () => {
    const storagePath = pathForTest()
    const coordinator = new LayoutCoordinator({ storagePath })
    const layout = createDefaultAppLayout({ serverId: 'local', workspaceId: 'ws-a', sessionId: 's1' })
    coordinator.saveSnapshot(layout)
    coordinator.detachTab('ws-a', 'content:main', 'aux-tab')
    expect(coordinator.getSnapshot('ws-a').windows['aux-tab'].sourceTabIndex).toBe(0)

    const restarted = new LayoutCoordinator({ storagePath })
    expect(restarted.getSnapshot('ws-a').windows['aux-tab']).toBeUndefined()
    expect(restarted.getSnapshot('ws-a').groups['group:main'].tabIds).toEqual(['content:main'])
  })

  it('keeps workspace layouts independent and rejects mixed tabs', () => {
    const coordinator = new LayoutCoordinator({ storagePath: pathForTest() })
    coordinator.saveSnapshot(createDefaultAppLayout({ serverId: 'local', workspaceId: 'ws-a', sessionId: 'a' }))
    coordinator.saveSnapshot(createDefaultAppLayout({ serverId: 'local', workspaceId: 'ws-b', sessionId: 'b' }))

    expect(coordinator.getSnapshot('ws-a').tabs['content:main'].ref.sessionId).toBe('a')
    expect(coordinator.getSnapshot('ws-b').tabs['content:main'].ref.sessionId).toBe('b')

    const mixed = createDefaultAppLayout({ serverId: 'local', workspaceId: 'ws-a' })
    mixed.tabs['content:main'].ref.workspaceId = 'ws-b'
    expect(() => coordinator.saveSnapshot(mixed)).toThrow('Layout cannot mix workspaces')
  })

  it('loads valid workspaces after a deleted or unauthorized persisted candidate', () => {
    const storagePath = pathForTest()
    const deleted = createDefaultAppLayout({ serverId: 'local', workspaceId: 'deleted' })
    const valid = createDefaultAppLayout({ serverId: 'local', workspaceId: 'valid', sessionId: 'kept' })
    writeFileSync(storagePath, JSON.stringify({ version: 1, layouts: { deleted, valid } }))

    const coordinator = new LayoutCoordinator({
      storagePath,
      authorizeContentRef: ref => ref.workspaceId !== 'deleted',
    })
    expect(coordinator.getSnapshot('valid').tabs['content:main'].ref.sessionId).toBe('kept')
  })

  it('rebinds stale persisted server routes and window geometry to the requested server', () => {
    const storagePath = pathForTest()
    const layout = createDefaultAppLayout({ serverId: 'https://old.example', workspaceId: 'ws-a' })
    layout.geometry = { config: { serverId: 'https://old.example' } }
    new LayoutCoordinator({ storagePath }).saveSnapshot(layout)

    const coordinator = new LayoutCoordinator({
      storagePath,
      resolveServerId: workspaceId => workspaceId === 'ws-a' ? 'https://new.example' : undefined,
    })

    const rebound = coordinator.getSnapshot('ws-a', 'https://new.example')
    expect(rebound.tabs['content:main'].ref.serverId).toBe('https://new.example')
    expect((rebound.geometry as any).config.serverId).toBe('https://new.example')
    expect(rebound.revision).toBeGreaterThan(layout.revision)
    expect(JSON.parse(readFileSync(storagePath, 'utf8')).layouts['ws-a'].tabs['content:main'].ref.serverId)
      .toBe('https://new.example')

    const staleWriter = structuredClone(rebound)
    staleWriter.tabs['content:main'].ref.serverId = 'https://old.example'
    const repairedSave = coordinator.saveSnapshot(staleWriter, rebound.revision)
    expect(repairedSave.tabs['content:main'].ref.serverId).toBe('https://new.example')
    expect(() => coordinator.getSnapshot('ws-a', 'https://old.example')).toThrow('server mismatch')
  })

  it('merges primary and auxiliary window views without replacing sibling content', () => {
    const coordinator = new LayoutCoordinator({ storagePath: pathForTest() })
    let layout = createDefaultAppLayout({ serverId: 'local', workspaceId: 'ws-a' })
    layout = openContentTab(layout, tab('detached'), { forceNew: true })
    layout.groups['primary-side'] = {
      id: 'primary-side', windowId: 'primary', tabIds: [], activeTabId: null,
    }
    layout.groups.outside = {
      id: 'outside', windowId: 'primary', tabIds: [], activeTabId: null,
    }
    layout.windows.primary.groupIds.push('primary-side', 'outside')
    layout = openContentTab(layout, tab('primary-side-tab', 'primary-side'), { forceNew: true })
    layout = openContentTab(layout, tab('outside-tab', 'outside'), { forceNew: true })
    layout.geometry = {
      marker: 'before-detach',
      layout: {
        type: 'row', id: 'root', children: [{
          type: 'row', id: 'primary-nested', weight: 80, children: [{
            type: 'tabset', id: 'group:main', weight: 70, children: [
              { type: 'tab', id: 'content:main' },
              { type: 'tab', id: 'detached' },
            ],
          }, {
            type: 'tabset', id: 'primary-side', weight: 30,
            children: [{ type: 'tab', id: 'primary-side-tab' }],
          }],
        }, {
          type: 'tabset', id: 'outside', weight: 20,
          children: [{ type: 'tab', id: 'outside-tab' }],
        }],
      },
    }
    coordinator.saveSnapshot(layout)
    const detached = coordinator.detachTab('ws-a', 'detached', 'aux-tab')
    const auxiliaryGroupId = detached.windows['aux-tab'].groupIds[0]

    const primaryView: AppLayout = {
      ...createDefaultAppLayout({ serverId: 'local', workspaceId: 'ws-a' }),
      revision: detached.revision,
      geometry: {
        marker: 'latest-primary',
        layout: {
          type: 'row', id: 'root', children: [{
            type: 'row', id: 'primary-nested', weight: 86, children: [{
              type: 'tabset', id: 'group:main', weight: 62,
              children: [{ type: 'tab', id: 'content:main' }],
            }, {
              type: 'tabset', id: 'primary-side', weight: 38,
              children: [{ type: 'tab', id: 'primary-side-tab' }],
            }],
          }, {
            type: 'tabset', id: 'outside', weight: 14,
            children: [{ type: 'tab', id: 'outside-tab' }],
          }],
        },
      },
      tabs: {
        'content:main': detached.tabs['content:main'],
        'primary-side-tab': detached.tabs['primary-side-tab'],
        'outside-tab': detached.tabs['outside-tab'],
      },
      groups: {
        'group:main': detached.groups['group:main'],
        'primary-side': detached.groups['primary-side'],
        outside: detached.groups.outside,
      },
      windows: {
        primary: { id: 'primary', kind: 'primary', groupIds: ['group:main', 'primary-side', 'outside'] },
      },
      focusedTabId: 'content:main',
    }
    primaryView.tabs['content:main'].title = 'Primary changed'
    const primarySaved = coordinator.saveWindowSnapshot('primary', primaryView, detached.revision)
    expect(primarySaved.tabs.detached).toBeDefined()
    expect(primarySaved.windows['aux-tab'].groupIds).toEqual([auxiliaryGroupId])

    const auxiliaryTab = { ...primarySaved.tabs.detached, title: 'Aux changed', groupId: 'aux-split' }
    const auxiliarySecond = tab('aux-second', auxiliaryGroupId)
    const splitTab = tab('split-tab', 'aux-split')
    const deepTab = tab('deep-tab', 'aux-deep')
    const auxiliaryView: AppLayout = {
      ...createDefaultAppLayout({ serverId: 'local', workspaceId: 'ws-a' }),
      revision: primarySaved.revision,
      geometry: {
        marker: 'auxiliary-subtree',
        layout: {
          type: 'row', id: 'aux-root', children: [{
            type: 'tabset', id: auxiliaryGroupId, weight: 35,
            children: [{ type: 'tab', id: 'aux-second' }],
          }, {
            type: 'row', id: 'aux-nested', weight: 65, children: [{
              type: 'tabset', id: 'aux-split', weight: 40,
              children: [{ type: 'tab', id: 'split-tab' }, { type: 'tab', id: 'detached' }],
            }, {
              type: 'tabset', id: 'aux-deep', weight: 60,
              children: [{ type: 'tab', id: 'deep-tab' }],
            }],
          }],
        },
      },
      tabs: { detached: auxiliaryTab, 'aux-second': auxiliarySecond, 'split-tab': splitTab, 'deep-tab': deepTab },
      groups: {
        [auxiliaryGroupId]: {
          id: auxiliaryGroupId,
          windowId: 'primary',
          tabIds: ['aux-second'],
          activeTabId: 'aux-second',
        },
        'aux-split': {
          id: 'aux-split',
          windowId: 'primary',
          tabIds: ['split-tab', 'detached'],
          activeTabId: 'detached',
        },
        'aux-deep': {
          id: 'aux-deep', windowId: 'primary', tabIds: ['deep-tab'], activeTabId: 'deep-tab',
        },
      },
      windows: { primary: { id: 'primary', kind: 'primary', groupIds: [auxiliaryGroupId, 'aux-split', 'aux-deep'] } },
      focusedTabId: 'detached',
    }
    const auxiliarySaved = coordinator.saveWindowSnapshot('aux-tab', auxiliaryView, primarySaved.revision)
    expect(auxiliarySaved.tabs['content:main'].title).toBe('Primary changed')
    expect(auxiliarySaved.tabs.detached.title).toBe('Aux changed')
    expect(auxiliarySaved.windows['aux-tab'].groupIds).toEqual([auxiliaryGroupId, 'aux-split', 'aux-deep'])
    expect(auxiliarySaved.groups[auxiliaryGroupId].tabIds).toEqual(['aux-second'])
    expect((auxiliarySaved.windows.primary.geometry as any).marker).toBe('latest-primary')
    expect((auxiliarySaved.windows['aux-tab'].geometry as any).marker).toBe('auxiliary-subtree')
    expect(auxiliarySaved.focusedTabId).toBe('content:main')

    const redocked = coordinator.redockWindow('aux-tab', 'ws-a')!
    expect(redocked.windows['aux-tab']).toBeUndefined()
    expect(redocked.groups['group:main'].tabIds).toEqual(['content:main', 'split-tab', 'detached'])
    expect(redocked.groups[auxiliaryGroupId].tabIds).toEqual(['aux-second'])
    expect(redocked.groups['aux-split']).toBeUndefined()
    expect(redocked.groups['aux-deep'].tabIds).toEqual(['deep-tab'])
    expect(redocked.windows.primary.groupIds).toEqual([
      auxiliaryGroupId, 'group:main', 'aux-deep', 'primary-side', 'outside',
    ])
    const geometry = redocked.geometry as any
    expect(geometry.marker).toBe('latest-primary')
    expect(geometry.layout.children.map((node: any) => node.weight)).toEqual([86, 14])
    const primaryNested = geometry.layout.children[0]
    expect(primaryNested.children[1].id).toBe('primary-side')
    expect(primaryNested.children[1].weight).toBe(38)
    const graft = primaryNested.children[0]
    expect(graft.type).toBe('row')
    expect(graft.weight).toBe(62)
    expect(graft.children.map((node: any) => [node.id, node.weight])).toEqual([
      [auxiliaryGroupId, 35],
      ['aux-nested', 65],
    ])
    expect(graft.children[0].children.map((node: any) => node.id)).toEqual([
      'aux-second',
    ])
    expect(graft.children[1].children.map((node: any) => [node.id, node.weight])).toEqual([
      ['group:main', 40],
      ['aux-deep', 60],
    ])
    expect(graft.children[1].children[0].children.map((node: any) => node.id)).toEqual([
      'content:main', 'split-tab', 'detached',
    ])
  })

  it('preserves the latest primary geometry when an auxiliary tab redocks and survives the next save', () => {
    const storagePath = pathForTest()
    const coordinator = new LayoutCoordinator({ storagePath })
    let layout = createDefaultAppLayout({ serverId: 'local', workspaceId: 'ws-a' })
    layout = openContentTab(layout, {
      ...tab('files'),
      ref: {
        kind: 'file',
        serverId: 'local',
        workspaceId: 'ws-a',
        resourceId: 'files',
      },
      instancePolicy: 'singleton',
    }, { forceNew: true })
    coordinator.saveSnapshot(layout)
    const detached = coordinator.detachTab('ws-a', 'files', 'aux-files')

    const primaryView = createDefaultAppLayout({ serverId: 'local', workspaceId: 'ws-a' })
    primaryView.revision = detached.revision
    primaryView.geometry = { tabs: ['content:main'] }
    primaryView.windows.primary.geometry = { tabs: ['content:main'] }
    const primarySaved = coordinator.saveWindowSnapshot('primary', primaryView, detached.revision)
    expect(primarySaved.tabs.files).toBeDefined()
    expect(primarySaved.geometry).toEqual({ tabs: ['content:main'] })

    const redocked = coordinator.redockWindow('aux-files', 'ws-a')!
    expect(redocked.groups['group:main'].tabIds).toEqual(['content:main', 'files'])
    expect(redocked.geometry).toEqual({ tabs: ['content:main'] })
    expect(redocked.windows.primary.geometry).toEqual({ tabs: ['content:main'] })

    const restarted = new LayoutCoordinator({ storagePath })
    const restored = restarted.getSnapshot('ws-a')
    expect(restored.tabs.files).toBeDefined()
    expect(restored.geometry).toEqual({ tabs: ['content:main'] })

    const rebuiltView = structuredClone(restored)
    rebuiltView.geometry = { tabs: ['content:main', 'files'] }
    const savedAgain = restarted.saveWindowSnapshot('primary', rebuiltView, restored.revision)
    expect(savedAgain.groups['group:main'].tabIds).toEqual(['content:main', 'files'])
    expect(savedAgain.tabs.files.ref.kind).toBe('file')

    const restartedAgain = new LayoutCoordinator({ storagePath })
    expect(restartedAgain.getSnapshot('ws-a').tabs.files).toBeDefined()
  })

  it('keeps primary focus when an auxiliary window saves its local selection', () => {
    const coordinator = new LayoutCoordinator({ storagePath: pathForTest() })
    let layout = createDefaultAppLayout({ serverId: 'local', workspaceId: 'ws-a' })
    layout = openContentTab(layout, tab('detached'), { forceNew: true })
    coordinator.saveSnapshot(layout)
    const detached = coordinator.detachTab('ws-a', 'detached', 'aux-tab')
    const auxiliaryGroupId = detached.windows['aux-tab'].groupIds[0]

    const primaryView = createDefaultAppLayout({ serverId: 'local', workspaceId: 'ws-a' })
    primaryView.revision = detached.revision
    primaryView.focusedTabId = 'content:main'
    const primarySaved = coordinator.saveWindowSnapshot('primary', primaryView, detached.revision)

    const auxiliaryView: AppLayout = {
      ...createDefaultAppLayout({ serverId: 'local', workspaceId: 'ws-a' }),
      revision: primarySaved.revision,
      tabs: {
        detached: { ...primarySaved.tabs.detached, groupId: auxiliaryGroupId },
      },
      groups: {
        [auxiliaryGroupId]: {
          id: auxiliaryGroupId,
          windowId: 'primary',
          tabIds: ['detached'],
          activeTabId: 'detached',
        },
      },
      windows: {
        primary: { id: 'primary', kind: 'primary', groupIds: [auxiliaryGroupId] },
      },
      focusedTabId: 'detached',
    }

    const auxiliarySaved = coordinator.saveWindowSnapshot('aux-tab', auxiliaryView, primarySaved.revision)
    expect(auxiliarySaved.focusedTabId).toBe('content:main')
    expect(auxiliarySaved.windows['aux-tab'].geometry).toEqual(auxiliaryView.geometry)
  })

  it('merges closing the last auxiliary tab without deleting primary content', () => {
    const coordinator = new LayoutCoordinator({ storagePath: pathForTest() })
    let layout = createDefaultAppLayout({ serverId: 'local', workspaceId: 'ws-a' })
    layout = openContentTab(layout, tab('detached'), { forceNew: true })
    layout.geometry = { owner: 'primary' }
    layout.windows.primary.geometry = { owner: 'primary' }
    coordinator.saveSnapshot(layout)
    const detached = coordinator.detachTab('ws-a', 'detached', 'aux-tab')
    const primaryView = createDefaultAppLayout({ serverId: 'local', workspaceId: 'ws-a' })
    primaryView.revision = detached.revision
    primaryView.geometry = { owner: 'primary' }
    const primarySaved = coordinator.saveWindowSnapshot('primary', primaryView, detached.revision)
    const emptyView: AppLayout = {
      ...createDefaultAppLayout({ serverId: 'local', workspaceId: 'ws-a' }),
      revision: primarySaved.revision,
      tabs: {},
      groups: {},
      windows: { primary: { id: 'primary', kind: 'primary', groupIds: [] } },
      focusedTabId: null,
    }

    const saved = coordinator.saveWindowSnapshot('aux-tab', emptyView, primarySaved.revision)
    expect(saved.tabs['content:main']).toBeDefined()
    expect(saved.tabs.detached).toBeUndefined()
    expect(saved.windows['aux-tab'].groupIds).toEqual([])
    const redocked = coordinator.redockWindow('aux-tab', 'ws-a')!
    expect(redocked.windows['aux-tab']).toBeUndefined()
    expect(redocked.groups['group:main'].tabIds).toEqual(['content:main'])
    expect(redocked.geometry).toEqual({ owner: 'primary' })
    expect(redocked.windows.primary.geometry).toEqual({ owner: 'primary' })
  })
})
