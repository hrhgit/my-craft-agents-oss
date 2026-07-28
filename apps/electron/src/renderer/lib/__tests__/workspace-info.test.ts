import { describe, expect, it } from 'bun:test'
import type { WorkspaceInfo } from '@mortise/core/types'
import {
  getPrimaryRemoteWorkspaceId,
  getPrimaryWorkspaceLocationInfo,
  getPrimaryWorkspaceRoute,
  isPrimaryWorkspaceLocal,
  isPrimaryWorkspaceRemote,
} from '../workspace-info'

function workspace(
  locations: Array<Pick<WorkspaceInfo['locations'][number], 'id' | 'name' | 'endpoint'> & Partial<WorkspaceInfo['locations'][number]>>,
  primaryLocationId: string,
): WorkspaceInfo {
  return {
    schemaVersion: 2,
    id: 'workspace-a',
    revision: 3,
    primaryLocationId,
    locations: locations.map(location => ({
      rootName: location.rootName ?? location.name.toLowerCase(),
      availability: location.availability ?? { status: 'unknown', reason: 'not-observed' },
      permissions: location.permissions ?? { read: true, write: true, search: true, runCommands: true },
      ...location,
    })) as WorkspaceInfo['locations'],
    name: 'Workspace A',
    nameSource: 'custom',
    slug: 'workspace-a',
  }
}

describe('workspace info routing', () => {
  it('routes through the primary local location without exposing a path', () => {
    const value = workspace([
      { id: 'local-a', name: 'Local', endpoint: { kind: 'local' } },
      { id: 'remote-a', name: 'Remote', endpoint: { kind: 'remote', url: 'https://remote.test', remoteWorkspaceId: 'remote-workspace-a' } },
    ], 'local-a')

    expect(getPrimaryWorkspaceLocationInfo(value).id).toBe('local-a')
    expect(getPrimaryWorkspaceRoute(value)).toEqual({
      workspaceId: 'workspace-a',
      locationId: 'local-a',
    })
    expect(getPrimaryRemoteWorkspaceId(value)).toBeUndefined()
    expect(isPrimaryWorkspaceLocal(value)).toBe(true)
    expect(isPrimaryWorkspaceRemote(value)).toBe(false)
  })

  it('routes through the primary remote location with its canonical identity', () => {
    const value = workspace([
      { id: 'remote-a', name: 'Remote', endpoint: { kind: 'remote', url: 'https://remote.test', remoteWorkspaceId: 'remote-workspace-a' } },
    ], 'remote-a')

    expect(getPrimaryWorkspaceRoute(value)).toEqual({
      workspaceId: 'workspace-a',
      locationId: 'remote-a',
    })
    expect(getPrimaryRemoteWorkspaceId(value)).toBe('remote-workspace-a')
    expect(isPrimaryWorkspaceRemote(value)).toBe(true)
  })

  it('rejects a topology whose primary location is missing', () => {
    const value = workspace([
      { id: 'local-a', name: 'Local', endpoint: { kind: 'local' } },
    ], 'missing')

    expect(() => getPrimaryWorkspaceRoute(value)).toThrow('has no primary location missing')
  })
})
