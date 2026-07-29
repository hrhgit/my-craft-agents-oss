import { Actions, Model, type IJsonModel } from 'flexlayout-react'
import { describe, expect, it } from 'bun:test'
import { ContributionStore } from '@/components/extensions/extension-contribution-store'
import { isRestorableWorkspaceContentTab } from './saved-workspace-content'

function savedExtensionLayout(): IJsonModel {
  return {
    global: {},
    borders: [],
    layout: {
      type: 'row',
      children: [{
        type: 'tabset',
        id: 'main',
        children: [{
          type: 'tab',
          id: 'extension-tab',
          name: 'Inspector',
          component: 'workspace-content',
          config: {
            source: 'workspace-content',
            contentKind: 'extension',
            workspaceId: 'workspace',
            resourceId: 'extension:inspector:status:workspace:workspace',
          },
        }],
      }],
    },
  }
}

describe('Extension layout lifecycle boundary', () => {
  it('preserves an unavailable Extension tab as restorable workspace content', () => {
    const tab = savedExtensionLayout().layout.children?.[0]?.children?.[0]
    expect(isRestorableWorkspaceContentTab(tab ?? {}, 'workspace')).toBe(true)
  })

  it('does not unload a backend-owned contribution when its tab closes', () => {
    const store = new ContributionStore()
    store.apply({
      schemaVersion: 1,
      extensionId: 'inspector',
      sessionId: 'session',
      runtimeId: 'runtime',
      workspaceId: 'workspace',
      backendType: 'electron',
      revision: 1,
      operation: 'upsert',
      contribution: {
        schemaVersion: 1,
        id: 'status',
        surface: 'workspace.content',
        workspaceContent: { title: 'Inspector', icon: 'activity', scope: 'workspace' },
        content: { type: 'text', text: 'Ready' },
      },
    })
    const model = Model.fromJson(savedExtensionLayout())
    model.doAction(Actions.deleteTab('extension-tab'))

    expect(model.getNodeById('extension-tab')).toBeUndefined()
    expect(store.listWorkspaceContent('session', 'workspace')).toHaveLength(1)
  })
})
