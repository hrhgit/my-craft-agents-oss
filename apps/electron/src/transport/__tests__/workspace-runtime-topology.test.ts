import { describe, expect, it } from 'bun:test'
import type { WorkspaceInfo } from '@mortise/core/types'
import {
  WORKSPACE_TOPOLOGY_CHANGE_SCHEMA_VERSION,
  type WorkspaceTopologyChangedV1,
} from '@mortise/shared/protocol'
import { WorkspaceRuntimeTopologyState } from '../workspace-runtime-topology'

function workspace(revision: number, primaryLocationId = 'local'): WorkspaceInfo {
  return {
    schemaVersion: 2,
    id: 'workspace-a',
    revision,
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
        endpoint: { kind: 'remote', url: 'wss://remote.example', remoteWorkspaceId: 'remote-a' },
        availability: { status: 'available', observedAt: 1 },
        permissions: { read: true, write: true, search: true, runCommands: true },
      },
    ],
  }
}

function change(previousRevision: number, revision: number, primaryLocationId = 'remote'): WorkspaceTopologyChangedV1 {
  return {
    schemaVersion: WORKSPACE_TOPOLOGY_CHANGE_SCHEMA_VERSION,
    workspaceId: 'workspace-a',
    operationId: `operation-${revision}`,
    operation: 'set-primary',
    previousRevision,
    revision,
    changedLocationIds: [primaryLocationId],
    workspace: workspace(revision, primaryLocationId),
  }
}

describe('WorkspaceRuntimeTopologyState', () => {
  it('resolves omitted location identity to the current primary', () => {
    const state = new WorkspaceRuntimeTopologyState()
    state.set(workspace(1))
    expect(state.resolveRoute({ workspaceId: 'workspace-a' })).toEqual({
      workspaceId: 'workspace-a', locationId: 'local',
    })

    expect(state.apply(change(1, 2))).toMatchObject({ status: 'applied' })
    expect(state.resolveRoute({ workspaceId: 'workspace-a' })).toEqual({
      workspaceId: 'workspace-a', locationId: 'remote',
    })
  })

  it('keeps explicit locations stable across primary changes', () => {
    const state = new WorkspaceRuntimeTopologyState()
    state.set(workspace(1))
    state.apply(change(1, 2))
    expect(state.resolveRoute({ workspaceId: 'workspace-a', locationId: 'local' }).locationId).toBe('local')
  })

  it('ignores stale events and requires a host resync for revision gaps', () => {
    const state = new WorkspaceRuntimeTopologyState()
    state.set(workspace(3, 'remote'))
    expect(state.apply(change(1, 2)).status).toBe('ignored')
    expect(state.apply(change(4, 5))).toEqual({ status: 'resync', workspaceId: 'workspace-a' })
    expect(state.get('workspace-a')?.revision).toBe(3)
  })

  it('never stores endpoint credentials in the redacted topology cache', () => {
    const state = new WorkspaceRuntimeTopologyState()
    state.set(workspace(1))
    const json = JSON.stringify(state.get('workspace-a'))
    expect(json).not.toContain('credentialRef')
    expect(json).not.toContain('token')
  })
})
