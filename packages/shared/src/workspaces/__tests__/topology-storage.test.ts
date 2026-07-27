import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WORKSPACE_SCHEMA_VERSION, type Workspace } from '@mortise/core/types'
import {
  WORKSPACE_MARKER_KIND,
  WORKSPACE_MARKER_SCHEMA_VERSION,
  type WorkspaceTopologyCommandV1,
} from '../../protocol/workspace-topology.ts'
import { getWorkspaceMarkerPath, readWorkspaceMarker } from '../marker.ts'
import { getWorkspaceTopologyRecordIdentity } from '../state-contract.ts'
import { WorkspaceTopologyStore } from '../topology-storage.ts'

const cleanup: string[] = []

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true })
})

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'mortise-topology-'))
  cleanup.push(root)
  const store = new WorkspaceTopologyStore({
    databasePath: join(root, 'state.sqlite'),
    writerId: `test-${Math.random()}`,
  })
  return { root, store }
}

function localWorkspace(workspaceRoot: string, id = 'workspace-1'): Workspace {
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    id,
    revision: 0,
    name: 'Workspace',
    slug: 'workspace',
    primaryLocationId: 'primary',
    locations: [{ id: 'primary', name: 'Primary', endpoint: { kind: 'local', rootPath: workspaceRoot } }],
    createdAt: 1,
  }
}

function writeFixture(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content, 'utf8')
}

function command(
  value: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): WorkspaceTopologyCommandV1 {
  return {
    schemaVersion: 1,
    workspaceId: 'workspace-1',
    operationId: `operation-${Math.random()}`,
    expectedRevision: 0,
    ...value,
    ...overrides,
  } as WorkspaceTopologyCommandV1
}

describe('WorkspaceTopologyStore', () => {
  it('stores topology by Workspace identity and adopts the local root with a strict marker', () => {
    const { root, store } = harness()
    const workspaceRoot = join(root, 'project')
    writeFixture(join(workspaceRoot, 'keep.txt'), 'user data')
    const created = store.create(localWorkspace(workspaceRoot))

    expect(getWorkspaceTopologyRecordIdentity(created.id)).toEqual({
      namespace: 'workspace-topology',
      key: created.id,
    })
    expect(store.get(created.id)).toEqual(created)
    expect(store.get(workspaceRoot)).toBeNull()
    expect(readWorkspaceMarker(workspaceRoot, created.id)).toEqual({
      schemaVersion: WORKSPACE_MARKER_SCHEMA_VERSION,
      kind: WORKSPACE_MARKER_KIND,
      workspaceId: created.id,
    })
    expect(readFileSync(join(workspaceRoot, 'keep.txt'), 'utf8')).toBe('user data')
    store.close()
  })

  it('rejects an invalid or mismatched marker without replacing it', () => {
    const { root, store } = harness()
    const workspaceRoot = join(root, 'project')
    const markerPath = getWorkspaceMarkerPath(workspaceRoot)
    writeFixture(markerPath, JSON.stringify({
      schemaVersion: WORKSPACE_MARKER_SCHEMA_VERSION,
      kind: WORKSPACE_MARKER_KIND,
      workspaceId: 'another-workspace',
    }))

    expect(() => store.create(localWorkspace(workspaceRoot))).toThrow('belongs to another-workspace')
    expect(JSON.parse(readFileSync(markerPath, 'utf8')).workspaceId).toBe('another-workspace')

    writeFileSync(markerPath, '{ invalid marker', 'utf8')
    expect(() => store.create(localWorkspace(workspaceRoot))).toThrow('marker is invalid')
    expect(readFileSync(markerPath, 'utf8')).toBe('{ invalid marker')
    store.close()
  })

  it('performs one-time local and remote legacy migrations without a read fallback', () => {
    const { root, store } = harness()
    const localRoot = join(root, 'local')
    writeFixture(join(localRoot, 'file.txt'), 'content')
    const local = store.migrateLegacy({
      id: 'legacy-local', name: 'Legacy Local', slug: 'legacy-local', rootPath: localRoot, createdAt: 2,
    })
    const localAgain = store.migrateLegacy({
      id: 'legacy-local', name: 'Ignored Legacy Change', rootPath: join(root, 'missing'),
    })
    expect(localAgain).toEqual(local)
    expect(local.locations[0].endpoint).toMatchObject({ kind: 'local' })
    expect(readWorkspaceMarker(localRoot, 'legacy-local').workspaceId).toBe('legacy-local')

    const shadowRoot = join(root, 'remote-shadow')
    writeFixture(join(shadowRoot, 'keep.txt'), 'shadow')
    const remote = store.migrateLegacy({
      id: 'legacy-remote', name: 'Legacy Remote', rootPath: shadowRoot,
      remoteServer: { url: 'wss://agent.example.test/', remoteWorkspaceId: 'remote-1' },
    })
    expect(remote.locations).toEqual([{
      id: 'primary',
      name: 'Primary',
      endpoint: {
        kind: 'remote',
        url: 'wss://agent.example.test',
        remoteWorkspaceId: 'remote-1',
        credentialRef: 'workspace:legacy-remote:primary',
      },
    }])
    expect(existsSync(getWorkspaceMarkerPath(shadowRoot))).toBe(false)
    expect(store.get('missing-workspace')).toBeNull()
    store.close()
  })

  it('applies and replays topology commands with stable historical receipts', () => {
    const { root, store } = harness()
    const primaryRoot = join(root, 'primary')
    const attachedRoot = join(root, 'attached')
    writeFixture(join(primaryRoot, 'one.txt'), 'one')
    writeFixture(join(attachedRoot, 'two.txt'), 'two')
    store.create(localWorkspace(primaryRoot))

    const attach = command({
      operation: 'attach-local', locationId: 'assets', name: 'Assets', rootPath: attachedRoot,
    }, { operationId: 'attach-assets' })
    const first = store.apply(attach)
    expect(first.status).toBe('applied')
    expect(first.workspace.revision).toBe(1)

    const rename = command({
      operation: 'rename', locationId: 'assets', name: 'Reference',
    }, { operationId: 'rename-assets', expectedRevision: 1 })
    expect(store.apply(rename).workspace.revision).toBe(2)

    const replay = store.apply(attach)
    expect(replay.status).toBe('duplicate')
    expect(replay.workspace.revision).toBe(1)
    expect(store.get('workspace-1')?.revision).toBe(2)

    expect(() => store.apply({ ...attach, name: 'Different' })).toThrow('already used for a different')
    store.close()
  })

  it('rejects stale revisions, duplicate endpoint identities, IDs, and names', () => {
    const { root, store } = harness()
    const primaryRoot = join(root, 'primary')
    const attachedRoot = join(root, 'attached')
    writeFixture(join(primaryRoot, 'one.txt'), 'one')
    writeFixture(join(attachedRoot, 'two.txt'), 'two')
    store.create(localWorkspace(primaryRoot))

    expect(() => store.apply(command({
      operation: 'rename', locationId: 'primary', name: 'Renamed',
    }, { expectedRevision: 9 }))).toThrow('expected 9')

    expect(() => store.apply(command({
      operation: 'attach-local', locationId: 'duplicate-root', name: 'Other', rootPath: primaryRoot,
    }))).toThrow('duplicate endpoint')

    store.apply(command({
      operation: 'attach-local', locationId: 'assets', name: 'Assets', rootPath: attachedRoot,
    }, { operationId: 'attach-assets' }))

    expect(() => store.apply(command({
      operation: 'attach-remote', locationId: 'assets', name: 'Remote', url: 'wss://host.test',
      remoteWorkspaceId: 'remote', credentialRef: 'credential',
    }, { expectedRevision: 1 }))).toThrow('ID already exists')
    expect(() => store.apply(command({
      operation: 'attach-remote', locationId: 'remote', name: 'assets', url: 'wss://host.test',
      remoteWorkspaceId: 'remote', credentialRef: 'credential',
    }, { expectedRevision: 1 }))).toThrow('name already exists')
    store.close()
  })

  it('supports replace, set-primary, rename, and detach without deleting marker or user data', () => {
    const { root, store } = harness()
    const primaryRoot = join(root, 'primary')
    const attachedRoot = join(root, 'attached')
    const replacementRoot = join(root, 'replacement')
    writeFixture(join(primaryRoot, 'primary.txt'), 'primary')
    writeFixture(join(attachedRoot, 'attached.txt'), 'attached')
    writeFixture(join(replacementRoot, 'replacement.txt'), 'replacement')
    store.create(localWorkspace(primaryRoot))
    store.apply(command({
      operation: 'attach-local', locationId: 'assets', name: 'Assets', rootPath: attachedRoot,
    }, { operationId: 'attach', expectedRevision: 0 }))
    store.apply(command({
      operation: 'replace-endpoint', locationId: 'assets', endpoint: { kind: 'local', rootPath: replacementRoot },
    }, { operationId: 'replace', expectedRevision: 1 }))
    store.apply(command({
      operation: 'rename', locationId: 'assets', name: 'Reference',
    }, { operationId: 'rename', expectedRevision: 2 }))
    store.apply(command({
      operation: 'set-primary', locationId: 'assets',
    }, { operationId: 'primary', expectedRevision: 3 }))
    const detached = store.apply(command({
      operation: 'detach', locationId: 'primary',
    }, { operationId: 'detach', expectedRevision: 4 }))

    expect(detached.workspace.primaryLocationId).toBe('assets')
    expect(detached.workspace.locations.map(location => location.id)).toEqual(['assets'])
    expect(existsSync(join(primaryRoot, 'primary.txt'))).toBe(true)
    expect(existsSync(getWorkspaceMarkerPath(primaryRoot))).toBe(true)
    expect(existsSync(join(attachedRoot, 'attached.txt'))).toBe(true)
    expect(existsSync(getWorkspaceMarkerPath(attachedRoot))).toBe(true)
    expect(existsSync(join(replacementRoot, 'replacement.txt'))).toBe(true)
    expect(existsSync(getWorkspaceMarkerPath(replacementRoot))).toBe(true)
    store.close()
  })
})
