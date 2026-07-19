import type { RegisteredExtensionContribution } from '@/components/extensions/extension-contribution-store'
import { describe, expect, it } from 'bun:test'
import {
  browserInstanceContentId,
  browserRegistryWorkspaceSyncKey,
  parseBrowserInstanceContentId,
  extensionWorkspaceContentId,
} from './right-workbench-state'

function extensionItem(
  scope: 'session' | 'workspace' | 'global',
  sessionId: string,
  workspaceId: string,
  runtimeId = `runtime-${sessionId}`,
  instancePolicy: 'singleton' | 'multiple' = 'singleton',
): RegisteredExtensionContribution {
  return {
    extensionId: 'inspector',
    sessionId,
    runtimeId,
    workspaceId,
    revision: 1,
    contribution: {
      schemaVersion: 1,
      id: 'status',
      surface: 'workspace.content',
      workspaceContent: { title: 'Status', icon: 'activity', scope, instancePolicy },
      content: { type: 'text', text: sessionId },
    },
  }
}

describe('right workbench state', () => {
  it('gives singleton tools the identity of their declared scope', () => {
    expect(extensionWorkspaceContentId(extensionItem('session', 'session-a', 'workspace-a')))
      .not.toBe(extensionWorkspaceContentId(extensionItem('session', 'session-b', 'workspace-a')))
    expect(extensionWorkspaceContentId(extensionItem('workspace', 'session-a', 'workspace-a')))
      .toBe(extensionWorkspaceContentId(extensionItem('workspace', 'session-b', 'workspace-a')))
    expect(extensionWorkspaceContentId(extensionItem('workspace', 'session-a', 'workspace-a')))
      .not.toBe(extensionWorkspaceContentId(extensionItem('workspace', 'session-a', 'workspace-b')))
    expect(extensionWorkspaceContentId(extensionItem('global', 'session-a', 'workspace-a')))
      .toBe(extensionWorkspaceContentId(extensionItem('global', 'session-b', 'workspace-b')))
  })

  it('keeps multiple tools distinct across runtime owners', () => {
    expect(extensionWorkspaceContentId(extensionItem('workspace', 'session-a', 'workspace-a', 'runtime-a', 'multiple')))
      .not.toBe(extensionWorkspaceContentId(extensionItem('workspace', 'session-a', 'workspace-a', 'runtime-b', 'multiple')))
  })

  it('round-trips browser instance identities', () => {
    const browserId = browserInstanceContentId('browser:/instance 1')
    expect(parseBrowserInstanceContentId(browserId)).toBe('browser:/instance 1')
    expect(parseBrowserInstanceContentId('browser')).toBeNull()
    expect(parseBrowserInstanceContentId('browser-instance:%')).toBeNull()
  })

  it('changes the browser registry sync identity for local and remote workspace switches', () => {
    expect(browserRegistryWorkspaceSyncKey('workspace-a', null))
      .not.toBe(browserRegistryWorkspaceSyncKey('workspace-b', null))
    expect(browserRegistryWorkspaceSyncKey('workspace-a', 'remote-a'))
      .not.toBe(browserRegistryWorkspaceSyncKey('workspace-a', 'remote-b'))
    expect(browserRegistryWorkspaceSyncKey('workspace-a', 'remote-a'))
      .toBe(browserRegistryWorkspaceSyncKey('workspace-a', 'remote-a'))
  })
})
