import { describe, expect, it } from 'bun:test'
import type { WorkspaceInfo } from '../../../shared/types'
import {
  getPrimaryRemoteLocation,
  reconnectWorkspaceRemoteLocation,
  type WorkspaceRemoteReconnectApi,
} from './workspace-remote-reconnect'

function remoteWorkspace(overrides: Partial<WorkspaceInfo> = {}): WorkspaceInfo {
  return {
    schemaVersion: 2,
    id: 'workspace-1',
    revision: 4,
    name: 'Remote project',
    slug: 'remote-project',
    primaryLocationId: 'remote-primary',
    locations: [{
      id: 'remote-primary',
      name: 'Primary',
      endpoint: {
        kind: 'remote',
        url: 'wss://old.example.test',
        remoteWorkspaceId: 'remote-workspace-1',
      },
    }],
    ...overrides,
  }
}

function apiHarness(current = remoteWorkspace()) {
  const calls: Array<{ name: string; value: unknown }> = []
  const api: WorkspaceRemoteReconnectApi = {
    getWorkspaceTopology: async () => current,
    setWorkspaceRemoteCredential: async value => { calls.push({ name: 'set', value }) },
    deleteWorkspaceRemoteCredential: async value => { calls.push({ name: 'delete', value }) },
    workspaceTopologyCommand: async command => {
      calls.push({ name: 'command', value: command })
      return {
        schemaVersion: 1,
        operationId: command.operationId,
        status: 'applied',
        workspace: remoteWorkspace({ revision: current.revision + 1 }),
      }
    },
  }
  return { api, calls }
}

describe('Workspace remote reconnect', () => {
  it('projects only a remote primary location', () => {
    expect(getPrimaryRemoteLocation(remoteWorkspace())?.id).toBe('remote-primary')
    expect(getPrimaryRemoteLocation(remoteWorkspace({
      primaryLocationId: 'local-primary',
      locations: [{ id: 'local-primary', name: 'Primary', endpoint: { kind: 'local' } }],
    }))).toBeNull()
  })

  it('stores the token privately and submits only a credential reference', async () => {
    const { api, calls } = apiHarness()
    await reconnectWorkspaceRemoteLocation(api, {
      workspaceId: 'workspace-1',
      locationId: 'remote-primary',
      url: 'wss://next.example.test',
      token: 'secret-token',
      allowInsecureTls: true,
    }, () => 'operation-1')

    expect(calls[0]).toEqual({
      name: 'set',
      value: {
        workspaceId: 'workspace-1',
        credentialRef: 'workspace_remote_operation-1',
        token: 'secret-token',
      },
    })
    expect(calls[1]?.name).toBe('command')
    expect(JSON.stringify(calls[1]?.value)).not.toContain('secret-token')
    expect(calls[1]?.value).toMatchObject({
      schemaVersion: 1,
      operation: 'replace-endpoint',
      workspaceId: 'workspace-1',
      expectedRevision: 4,
      locationId: 'remote-primary',
      endpoint: {
        kind: 'remote',
        url: 'wss://next.example.test',
        remoteWorkspaceId: 'remote-workspace-1',
        credentialRef: 'workspace_remote_operation-1',
        allowInsecureTls: true,
      },
    })
  })

  it('deletes a newly stored credential when the command did not apply', async () => {
    const { api, calls } = apiHarness()
    api.workspaceTopologyCommand = async () => { throw new Error('stale revision') }

    await expect(reconnectWorkspaceRemoteLocation(api, {
      workspaceId: 'workspace-1',
      locationId: 'remote-primary',
      url: 'wss://next.example.test',
      token: 'secret-token',
    }, () => 'operation-2')).rejects.toThrow('stale revision')

    expect(calls.at(-1)).toEqual({
      name: 'delete',
      value: {
        workspaceId: 'workspace-1',
        credentialRef: 'workspace_remote_operation-2',
      },
    })
  })

  it('preserves the credential when the authoritative projection matches the attempted endpoint', async () => {
    const { api, calls } = apiHarness()
    let reads = 0
    api.getWorkspaceTopology = async () => {
      reads += 1
      return reads === 1 ? remoteWorkspace() : remoteWorkspace({
        revision: 5,
        locations: [{
          id: 'remote-primary',
          name: 'Primary',
          endpoint: {
            kind: 'remote',
            url: 'wss://next.example.test',
            remoteWorkspaceId: 'remote-workspace-1',
          },
        }],
      })
    }
    api.workspaceTopologyCommand = async () => { throw new Error('response lost') }

    await expect(reconnectWorkspaceRemoteLocation(api, {
      workspaceId: 'workspace-1',
      locationId: 'remote-primary',
      url: 'wss://next.example.test',
      token: 'secret-token',
    }, () => 'operation-3')).rejects.toThrow('response lost')

    expect(calls.some(call => call.name === 'delete')).toBe(false)
  })

  it('rejects a stale location identity before storing credentials', async () => {
    const { api, calls } = apiHarness(remoteWorkspace({
      primaryLocationId: 'local-primary',
      locations: [{ id: 'local-primary', name: 'Primary', endpoint: { kind: 'local' } }],
    }))

    await expect(reconnectWorkspaceRemoteLocation(api, {
      workspaceId: 'workspace-1',
      locationId: 'remote-primary',
      url: 'wss://next.example.test',
      token: 'secret-token',
    }, () => 'operation-4')).rejects.toThrow('no longer available')
    expect(calls).toHaveLength(0)
  })
})
