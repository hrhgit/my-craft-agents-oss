import { describe, expect, it } from 'bun:test'
import type { WorkspaceInfo } from '@mortise/core/types'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  getPrimaryRemoteWorkspaceEndpoint,
  getPrimaryRemoteWorkspaceId,
  getPrimaryWorkspaceLocationInfo,
  RemoteConnectionPanel,
} from '../../RemoteConnectionPanel'

function workspace(primaryLocationId: string): WorkspaceInfo {
  return {
    schemaVersion: 2,
    id: 'workspace-a',
    revision: 4,
    name: 'Workspace',
    nameSource: 'custom',
    slug: 'workspace',
    primaryLocationId,
    locations: [
      {
        id: 'local',
        name: 'Local',
        rootName: 'workspace',
        endpoint: { kind: 'local' },
        availability: { status: 'available', observedAt: 1 },
        permissions: { read: true, write: true, search: true, runCommands: true },
      },
      {
        id: 'remote',
        name: 'Remote',
        rootName: 'remote-workspace',
        endpoint: {
          kind: 'remote',
          url: 'wss://remote.example',
          remoteWorkspaceId: 'remote-workspace-a',
        },
        availability: { status: 'available', observedAt: 1 },
        permissions: { read: true, write: true, search: true, runCommands: true },
      },
    ],
  }
}

describe('Workspace primary location presentation', () => {
  it('does not classify a Workspace as remote because it has an attached remote location', () => {
    const value = workspace('local')
    expect(getPrimaryWorkspaceLocationInfo(value)?.id).toBe('local')
    expect(getPrimaryRemoteWorkspaceEndpoint(value)).toBeNull()
    expect(getPrimaryRemoteWorkspaceId(value)).toBeNull()
    expect(renderToStaticMarkup(RemoteConnectionPanel({
      workspace: value,
      isDisconnected: false,
      disconnectLabel: 'Disconnected',
    }))).toBe('')
  })

  it('projects only redacted endpoint metadata from a remote primary location', () => {
    const value = workspace('remote')
    expect(getPrimaryRemoteWorkspaceEndpoint(value)).toEqual({
      kind: 'remote',
      url: 'wss://remote.example',
      remoteWorkspaceId: 'remote-workspace-a',
    })
    expect(getPrimaryRemoteWorkspaceId(value)).toBe('remote-workspace-a')
    expect(JSON.stringify(getPrimaryRemoteWorkspaceEndpoint(value))).not.toContain('token')
    expect(JSON.stringify(getPrimaryRemoteWorkspaceEndpoint(value))).not.toContain('credentialRef')
    const markup = renderToStaticMarkup(RemoteConnectionPanel({
      workspace: value,
      isDisconnected: false,
      disconnectLabel: 'Disconnected',
    }))
    expect(markup).toContain('wss://remote.example')
    expect(markup).not.toContain('remote-workspace-a')
  })

  it('fails closed when a malformed projection does not contain its declared primary', () => {
    const value = workspace('missing')
    expect(getPrimaryWorkspaceLocationInfo(value)).toBeNull()
    expect(getPrimaryRemoteWorkspaceId(value)).toBeNull()
  })
})
