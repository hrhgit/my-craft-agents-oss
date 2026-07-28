import { describe, expect, it } from 'bun:test'
import type { WorkspaceInfo } from '../../../../shared/types'
import {
  buildWorkspaceLocationSettingsRows,
  createWorkspaceLocationId,
  createWorkspaceRemoteCredentialRef,
  createWorkspaceTopologyCommand,
  hasProjectedRemoteWorkspaceLocation,
  isWorkspaceLocationNameAvailable,
  WORKSPACE_LOCATION_SEMANTIC_IDS,
  workspaceLocationActionSemanticId,
  workspaceLocationConsequence,
} from '../workspace-location-settings-model'
import { resolveWorkspaceLocationSettingsApi } from '../workspace-location-settings-api'

function workspace(overrides: Partial<WorkspaceInfo> = {}): WorkspaceInfo {
  return {
    schemaVersion: 2,
    id: 'workspace-a',
    revision: 7,
    name: 'Product',
    nameSource: 'custom',
    slug: 'product',
    primaryLocationId: 'primary',
    locations: [
      { id: 'primary', name: 'Primary', rootName: 'primary', availability: { status: 'unknown', reason: 'not-observed' }, permissions: { read: true, write: true, search: true, runCommands: true }, endpoint: { kind: 'local' } },
      {
        id: 'docs/remote',
        name: 'Docs',
        rootName: 'remote-docs',
        availability: { status: 'unknown', reason: 'not-observed' },
        permissions: { read: true, write: true, search: true, runCommands: true },
        endpoint: {
          kind: 'remote',
          url: 'wss://agent.example.test',
          remoteWorkspaceId: 'remote-docs',
        },
      },
    ],
    ...overrides,
  }
}

describe('Workspace location Settings model', () => {
  it('projects primary, attached, endpoint kind, and honest availability state', () => {
    const rows = buildWorkspaceLocationSettingsRows(workspace())

    expect(rows.map(row => ({
      id: row.id,
      role: row.role,
      kind: row.kind,
      availability: row.availability,
    }))).toEqual([
      { id: 'primary', role: 'primary', kind: 'local', availability: 'unreported' },
      { id: 'docs/remote', role: 'attached', kind: 'remote', availability: 'unreported' },
    ])
    expect(rows[1]?.endpointLabel).toBe('wss://agent.example.test / remote-docs')
  })

  it('provides stable semantic identities for the section and every row action', () => {
    const rows = buildWorkspaceLocationSettingsRows(workspace())

    expect(WORKSPACE_LOCATION_SEMANTIC_IDS.section).toBe('settings.workspace.locations')
    expect(WORKSPACE_LOCATION_SEMANTIC_IDS.addLocal).toBe('settings.workspace.locations.add-local')
    expect(rows[1]?.semanticId).toBe('settings.workspace.location.docs%2Fremote')
    expect(rows[1]?.actionSemanticIds).toEqual({
      rename: 'settings.workspace.location.docs%2Fremote.rename',
      replace: 'settings.workspace.location.docs%2Fremote.replace',
      'set-primary': 'settings.workspace.location.docs%2Fremote.set-primary',
      detach: 'settings.workspace.location.docs%2Fremote.detach',
    })
    expect(workspaceLocationActionSemanticId('docs/remote', 'detach')).toBe(rows[1]?.actionSemanticIds.detach)
  })

  it('checks case-insensitive unique names while allowing the current location name', () => {
    const value = workspace()
    expect(isWorkspaceLocationNameAvailable(value, 'docs')).toBe(false)
    expect(isWorkspaceLocationNameAvailable(value, '  ')).toBe(false)
    expect(isWorkspaceLocationNameAvailable(value, 'Docs', 'docs/remote')).toBe(true)
    expect(isWorkspaceLocationNameAvailable(value, 'Assets')).toBe(true)
  })

  it('builds revision-checked commands without credential material', () => {
    const value = workspace()
    const operationId = 'op-123'
    const locationId = createWorkspaceLocationId(operationId)
    const credentialRef = createWorkspaceRemoteCredentialRef(operationId)
    const command = createWorkspaceTopologyCommand(value, operationId, {
      operation: 'attach-remote',
      locationId,
      name: 'Remote',
      url: 'wss://agent.example.test',
      remoteWorkspaceId: 'remote-workspace',
      credentialRef,
    })

    expect(command).toMatchObject({
      schemaVersion: 1,
      workspaceId: value.id,
      expectedRevision: value.revision,
      operationId,
      operation: 'attach-remote',
      locationId: 'location_op-123',
      credentialRef: 'workspace_remote_op-123',
    })
    expect(JSON.stringify(command)).not.toContain('token')
  })

  it('detects when a refreshed topology projects the attempted remote location', () => {
    const value = workspace()
    expect(hasProjectedRemoteWorkspaceLocation(value, 'docs/remote', 'remote-docs')).toBe(true)
    expect(hasProjectedRemoteWorkspaceLocation(value, 'docs/remote', 'different')).toBe(false)
    expect(hasProjectedRemoteWorkspaceLocation(value, 'primary', 'remote-docs')).toBe(false)
  })

  it('states interruption and no-auto-resume consequences before destructive actions', () => {
    expect(workspaceLocationConsequence('detach')).toContain('Unrelated work remains running')
    expect(workspaceLocationConsequence('replace')).toContain('will not resume automatically')
    expect(workspaceLocationConsequence('set-primary')).toContain('all running, queued, waiting, and resumable work')
  })
})

describe('Workspace location Settings API adapter', () => {
  it('stays unavailable until the complete native topology and credential surface is mounted', () => {
    expect(resolveWorkspaceLocationSettingsApi({} as never)).toBeNull()
  })

  it('binds only the frozen native API names', () => {
    const calls: string[] = []
    const electronApi = {
      getWorkspaceTopology: async () => { calls.push('get'); return workspace() },
      workspaceTopologyCommand: async () => { calls.push('command'); return { schemaVersion: 1, operationId: 'op', status: 'applied', workspace: workspace() } },
      onWorkspaceTopologyChanged: () => { calls.push('subscribe'); return () => {} },
      setWorkspaceRemoteCredential: async () => { calls.push('set-credential') },
      deleteWorkspaceRemoteCredential: async () => { calls.push('delete-credential') },
      testRemoteConnection: async () => ({ ok: true }),
    }

    const resolved = resolveWorkspaceLocationSettingsApi(electronApi as never)
    expect(resolved).not.toBeNull()
    resolved?.onWorkspaceTopologyChanged(() => {})
    expect(calls).toEqual(['subscribe'])
  })
})
