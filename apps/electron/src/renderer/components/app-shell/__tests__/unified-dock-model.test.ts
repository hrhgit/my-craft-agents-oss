import { describe, expect, it } from 'bun:test'
import { Actions, DockLocation, Model, TabNode, TabSetNode } from 'flexlayout-react'
import {
  countCanvasPanelGroups,
  flexLayoutTabButtonId,
  isPointOutsideBounds,
  matchSavedPanelEntry,
  resolveCanvasFocusTarget,
  resolveDockTabCloseAction,
  resolveDockTabProtection,
  resolveFlexLayoutTabId,
  resolveInitialWorkspaceContentDockLocation,
  retargetWorkspaceTabs,
} from '../unified-dock-model'
import type { PanelStackEntry } from '@/atoms/panel-stack'

function createModel(): Model {
  return Model.fromJson({
    global: {
      tabEnablePopout: false,
      tabEnablePopoutIcon: false,
      tabSetEnableDivide: true,
    },
    layout: {
      type: 'row',
      children: [{
        type: 'tabset',
        id: 'main',
        children: [
          { type: 'tab', id: 'a', name: 'A', component: 'craft-content' },
          { type: 'tab', id: 'b', name: 'B', component: 'craft-content' },
        ],
      }],
    },
  })
}

function tabsets(model: Model): TabSetNode[] {
  const result: TabSetNode[] = []
  model.visitNodes(node => {
    if (node instanceof TabSetNode) result.push(node)
  })
  return result
}

describe('unified dock FlexLayout adapter', () => {
  it('rebinds restored panel tabs by stable route when runtime ids change', () => {
    const entries: PanelStackEntry[] = [{
      id: 'panel-new',
      route: 'allSessions/session/session-a',
      proportion: 1,
      panelType: 'session',
      laneId: 'main',
    }]
    const claimed = new Set<string>()
    const matched = matchSavedPanelEntry(
      'panel-old',
      'allSessions/session/session-a',
      entries,
      claimed,
    )
    expect(matched?.id).toBe('panel-new')
  })

  it('splits a dragged tab into a new panel group and preserves it through JSON recovery', () => {
    const model = createModel()
    model.doAction(Actions.moveNode('b', 'main', DockLocation.RIGHT, -1, true))

    const splitGroups = tabsets(model)
    expect(splitGroups).toHaveLength(2)
    expect(splitGroups.map(group => group.getChildren().map(tab => tab.getId()))).toEqual([['a'], ['b']])

    const recovered = Model.fromJson(model.toJson())
    expect(tabsets(recovered).map(group => group.getChildren().map(tab => tab.getId()))).toEqual([['a'], ['b']])
  })

  it('keeps browser Portal popout disabled in the persisted model', () => {
    const model = createModel()
    expect((model.getNodeById('a') as TabNode).isEnablePopout()).toBe(false)
    const recovered = Model.fromJson(model.toJson())
    expect((recovered.getNodeById('a') as TabNode).isEnablePopout()).toBe(false)
  })

  it('retargets every tab in the reconnected workspace to its refreshed server URL', () => {
    const model = Model.fromJson({
      global: {},
      layout: {
        type: 'row',
        children: [{
          type: 'tabset',
          children: [{
            type: 'tab',
            id: 'conversation',
            name: 'Conversation',
            component: 'craft-content',
            config: { workspaceId: 'workspace-a', serverId: 'wss://old.example.test' },
          }, {
            type: 'tab',
            id: 'files',
            name: 'Files',
            component: 'craft-content',
            config: { workspaceId: 'workspace-a', serverId: 'wss://old.example.test' },
          }, {
            type: 'tab',
            id: 'other-workspace',
            name: 'Other',
            component: 'craft-content',
            config: { workspaceId: 'workspace-b', serverId: 'wss://other.example.test' },
          }],
        }],
      },
    })

    expect(retargetWorkspaceTabs(model, 'workspace-a', 'wss://new.example.test')).toBe(2)
    expect((model.getNodeById('conversation') as TabNode).getConfig()).toMatchObject({
      serverId: 'wss://new.example.test',
    })
    expect((model.getNodeById('files') as TabNode).getConfig()).toMatchObject({
      serverId: 'wss://new.example.test',
    })
    expect((model.getNodeById('other-workspace') as TabNode).getConfig()).toMatchObject({
      serverId: 'wss://other.example.test',
    })
  })

  it('treats files as ordinary content tabs in a regular split group', () => {
    const model = createModel()
    model.doAction(Actions.addTab({
      type: 'tab',
      id: 'files',
      name: 'Files',
      component: 'craft-content',
      config: { source: 'workspace-content', contentKind: 'file', resourceId: 'files' },
      enablePopout: false,
    }, 'main', DockLocation.RIGHT, -1, true))

    expect(tabsets(model).map(group => group.getChildren().map(tab => tab.getId())))
      .toEqual([['a', 'b'], ['files']])
    expect((model.getNodeById('files') as TabNode).getComponent()).toBe('craft-content')
    expect(model.toJson().borders).toEqual([])

    const toolGroup = tabsets(model).find(group => group.getChildren().some(tab => tab.getId() === 'files'))
    model.doAction(Actions.moveNode('a', toolGroup!.getId(), DockLocation.CENTER, -1, true))
    expect(toolGroup!.getChildren().map(tab => tab.getId())).toEqual(['files', 'a'])
  })

  it('resolves close actions without bypassing dock tab protection', () => {
    const model = createModel()
    const unprotected = {
      pinned: false,
      dirty: false,
      running: false,
      awaitingInput: false,
    }
    expect(resolveDockTabCloseAction(model, 'a', { a: unprotected })?.type).toBe(Actions.DELETE_TAB)
    expect(resolveDockTabCloseAction(model, 'a', {
      a: { ...unprotected, dirty: true },
    })).toBeUndefined()
    expect(resolveDockTabCloseAction(model, 'b', {
      b: { ...unprotected, running: true },
    })).toBeUndefined()

    model.doAction(Actions.moveNode('b', 'main', DockLocation.RIGHT, -1, true))
    const action = resolveDockTabCloseAction(model, 'b', { b: unprotected })
    expect(action?.type).toBe(Actions.DELETE_TABSET)
  })

  it('keeps persisted protection until runtime hydration explicitly replaces it', () => {
    const persisted = {
      pinned: false,
      dirty: true,
      running: false,
      awaitingInput: true,
    }
    const model = Model.fromJson({
      global: {},
      layout: {
        type: 'row',
        children: [{
          type: 'tabset',
          children: [{
            type: 'tab',
            id: 'files',
            name: 'Files',
            component: 'craft-content',
            config: { protection: persisted },
            enableClose: false,
          }],
        }],
      },
    })
    const recovered = Model.fromJson(model.toJson())
    const config = (recovered.getNodeById('files') as TabNode).getConfig() as {
      protection?: typeof persisted
    }

    expect(resolveDockTabProtection({
      persisted: config.protection,
      pinned: false,
    })).toEqual(persisted)
    expect(resolveDockTabProtection({
      persisted: config.protection,
      dynamic: { dirty: false, awaitingInput: false },
      pinned: false,
    })).toEqual({
      ...persisted,
      dirty: false,
      awaitingInput: false,
    })
  })

  it('preserves non-detachable metadata through FlexLayout JSON recovery', () => {
    const model = Model.fromJson({
      global: {},
      layout: {
        type: 'row',
        children: [{
          type: 'tabset',
          children: [{
            type: 'tab',
            id: 'fixed',
            name: 'Fixed',
            component: 'craft-content',
            config: { allowDetach: false },
          }],
        }],
      },
    })

    const recovered = Model.fromJson(model.toJson())
    expect((recovered.getNodeById('fixed') as TabNode).getConfig()).toMatchObject({
      allowDetach: false,
    })
  })

  it('focuses a conversation panel ahead of the active tool panel and restores the layout', () => {
    const model = Model.fromJson({
      global: {},
      layout: {
        type: 'row',
        children: [{
          type: 'tabset',
          id: 'conversation-group',
          children: [{
            type: 'tab',
            id: 'conversation',
            name: 'Conversation',
            component: 'craft-content',
            config: { contentKind: 'conversation' },
          }],
        }, {
          type: 'tabset',
          id: 'tool-group',
          active: true,
          children: [{
            type: 'tab',
            id: 'browser',
            name: 'Browser',
            component: 'craft-content',
            config: { contentKind: 'browser' },
          }],
        }],
      },
    })

    expect(countCanvasPanelGroups(model)).toBe(2)
    const target = resolveCanvasFocusTarget(model)
    expect(target).toEqual({ tabsetId: 'conversation-group', tabId: 'conversation' })

    model.doAction(Actions.selectTab(target!.tabId!))
    model.doAction(Actions.maximizeToggle(target!.tabsetId))
    expect(model.getMaximizedTabset()?.getId()).toBe('conversation-group')
    expect(tabsets(model)).toHaveLength(2)

    model.doAction(Actions.maximizeToggle(target!.tabsetId))
    expect(model.getMaximizedTabset()).toBeUndefined()
    expect(tabsets(model).map(group => group.getChildren().map(tab => tab.getId())))
      .toEqual([['conversation'], ['browser']])
  })

  it('treats workspace content placement as an initial group preference, not a fixed side', () => {
    expect(resolveInitialWorkspaceContentDockLocation(undefined, false)).toBe(DockLocation.CENTER)
    expect(resolveInitialWorkspaceContentDockLocation('active', false)).toBe(DockLocation.CENTER)
    expect(resolveInitialWorkspaceContentDockLocation('adjacent', false)).toBe(DockLocation.RIGHT)
    expect(resolveInitialWorkspaceContentDockLocation('adjacent', true)).toBe(DockLocation.CENTER)
  })

  it('falls back to the active panel when the canvas has no conversation', () => {
    const model = Model.fromJson({
      global: {},
      layout: {
        type: 'row',
        children: [{
          type: 'tabset',
          id: 'files-group',
          children: [{ type: 'tab', id: 'files', name: 'Files', component: 'craft-content' }],
        }, {
          type: 'tabset',
          id: 'browser-group',
          active: true,
          children: [{ type: 'tab', id: 'browser', name: 'Browser', component: 'craft-content' }],
        }],
      },
    })
    expect(resolveCanvasFocusTarget(model)).toEqual({ tabsetId: 'browser-group', tabId: 'browser' })
  })

  it('recognizes persisted conversation tabs created before content-kind metadata existed', () => {
    const model = Model.fromJson({
      global: {},
      layout: {
        type: 'row',
        children: [{
          type: 'tabset',
          id: 'conversation-group',
          children: [{
            type: 'tab',
            id: 'conversation',
            name: 'Conversation',
            component: 'craft-content',
            config: { route: 'allSessions/session/release-readiness' },
          }],
        }, {
          type: 'tabset',
          id: 'tool-group',
          active: true,
          children: [{ type: 'tab', id: 'files', name: 'Files', component: 'craft-content' }],
        }],
      },
    })

    expect(resolveCanvasFocusTarget(model)).toEqual({
      tabsetId: 'conversation-group',
      tabId: 'conversation',
    })
  })

  it('leaves temporary focus mode when the user adjusts the layout', () => {
    const model = createModel()
    model.doAction(Actions.moveNode('b', 'main', DockLocation.RIGHT, -1, true))
    model.doAction(Actions.maximizeToggle('main'))
    expect(model.getMaximizedTabset()?.getId()).toBe('main')

    model.doAction(Actions.moveNode('a', 'main', DockLocation.BOTTOM, -1, true))
    expect(model.getMaximizedTabset()).toBeUndefined()
  })

  it('resolves dragged FlexLayout tabs without depending on their display names', () => {
    expect(flexLayoutTabButtonId('session tab')).toBe('flexlayout-tabbutton-session_tab')
    expect(resolveFlexLayoutTabId('flexlayout-tabbutton-session_tab', ['other', 'session tab']))
      .toBe('session tab')
  })

  it('treats every side beyond the unified dock canvas as a detach gesture', () => {
    const canvasBounds = { x: 260, y: 48, width: 1_000, height: 700 }
    expect(isPointOutsideBounds({ x: 260, y: 48 }, canvasBounds)).toBe(false)
    expect(isPointOutsideBounds({ x: 1_259, y: 747 }, canvasBounds)).toBe(false)
    expect(isPointOutsideBounds({ x: 259, y: 400 }, canvasBounds)).toBe(true)
    expect(isPointOutsideBounds({ x: 1_260, y: 400 }, canvasBounds)).toBe(true)
    expect(isPointOutsideBounds({ x: 800, y: 47 }, canvasBounds)).toBe(true)
    expect(isPointOutsideBounds({ x: 800, y: 748 }, canvasBounds)).toBe(true)
  })
})
