import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { WORKSPACE_SCHEMA_VERSION, type Workspace } from '@mortise/core/types'
import {
  WORKSPACE_MARKER_KIND,
  WORKSPACE_MARKER_SCHEMA_VERSION,
  type WorkspaceLocationProjectionV1,
  type WorkspaceTopologyCommandV1,
} from '../../protocol/workspace-topology.ts'
import { getWorkspaceMarkerPath, readWorkspaceMarker } from '../marker.ts'
import { getWorkspaceTopologyRecordIdentity } from '../state-contract.ts'
import { WorkspaceTopologyStore } from '../topology-storage.ts'

const cleanup: string[] = []
const stores: WorkspaceTopologyStore[] = []

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true })
})

function harness(projectionProvider?: (workspace: Workspace) => readonly WorkspaceLocationProjectionV1[]) {
  const root = mkdtempSync(join(tmpdir(), 'mortise-topology-'))
  cleanup.push(root)
  const store = new WorkspaceTopologyStore({
    databasePath: join(root, 'state.sqlite'),
    writerId: `test-${Math.random()}`,
    ...(projectionProvider ? { projectionProvider } : {}),
  })
  stores.push(store)
  return { root, store }
}

function localWorkspace(
  workspaceRoot: string,
  id = 'workspace-1',
  display: Pick<Workspace, 'name' | 'nameSource'> = { name: 'Ignored derived name', nameSource: 'derived' },
): Workspace {
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    id,
    revision: 0,
    name: display.name,
    nameSource: display.nameSource,
    slug: 'workspace',
    primaryLocationId: 'primary',
    locations: [{
      id: 'primary',
      name: 'Primary',
      rootName: basename(workspaceRoot),
      endpoint: { kind: 'local', rootPath: workspaceRoot },
    }],
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
    expect(created.name).toBe('project')
    expect(store.get(created.id)).toEqual(created)
    expect(store.get(workspaceRoot)).toBeNull()
    expect(readWorkspaceMarker(workspaceRoot, created.id)).toEqual({
      schemaVersion: WORKSPACE_MARKER_SCHEMA_VERSION,
      kind: WORKSPACE_MARKER_KIND,
      workspaceId: created.id,
    })
    expect(readFileSync(join(workspaceRoot, 'keep.txt'), 'utf8')).toBe('user data')
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
    expect(local.nameSource).toBe('custom')
    expect(local.locations[0].rootName).toBe('local')
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
      rootName: 'Legacy Remote',
      endpoint: {
        kind: 'remote',
        url: 'wss://agent.example.test',
        remoteWorkspaceId: 'remote-1',
        credentialRef: 'workspace:legacy-remote:primary',
      },
    }])
    expect(existsSync(getWorkspaceMarkerPath(shadowRoot))).toBe(false)
    expect(store.get('missing-workspace')).toBeNull()
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
      rootName: 'remote-root', remoteWorkspaceId: 'remote', credentialRef: 'credential',
    }, { expectedRevision: 1 }))).toThrow('ID already exists')
    expect(() => store.apply(command({
      operation: 'attach-remote', locationId: 'remote', name: 'assets', url: 'wss://host.test',
      rootName: 'remote-root', remoteWorkspaceId: 'remote', credentialRef: 'credential',
    }, { expectedRevision: 1 }))).toThrow('name already exists')
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
      operation: 'replace-endpoint', locationId: 'assets', rootName: 'ignored-for-local',
      endpoint: { kind: 'local', rootPath: replacementRoot },
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
    expect(detached.workspace.name).toBe('replacement')
    expect(detached.workspace.nameSource).toBe('derived')
    expect(detached.workspace.locations[0].rootName).toBe('replacement')
    expect(detached.workspace.locations.map(location => location.id)).toEqual(['assets'])
    expect(existsSync(join(primaryRoot, 'primary.txt'))).toBe(true)
    expect(existsSync(getWorkspaceMarkerPath(primaryRoot))).toBe(true)
    expect(existsSync(join(attachedRoot, 'attached.txt'))).toBe(true)
    expect(existsSync(getWorkspaceMarkerPath(attachedRoot))).toBe(true)
    expect(existsSync(join(replacementRoot, 'replacement.txt'))).toBe(true)
    expect(existsSync(getWorkspaceMarkerPath(replacementRoot))).toBe(true)
  })

  it('keeps a custom Workspace name stable when the primary location changes', () => {
    const { root, store } = harness()
    const primaryRoot = join(root, 'primary')
    const attachedRoot = join(root, 'attached')
    mkdirSync(primaryRoot)
    mkdirSync(attachedRoot)
    const created = store.create(localWorkspace(primaryRoot, 'workspace-1', {
      name: 'My custom label',
      nameSource: 'custom',
    }))
    expect(created.name).toBe('My custom label')

    store.apply(command({
      operation: 'attach-local', locationId: 'attached', name: 'Attached', rootPath: attachedRoot,
    }, { operationId: 'attach-custom' }))
    const changed = store.apply(command({
      operation: 'set-primary', locationId: 'attached',
    }, { operationId: 'primary-custom', expectedRevision: 1 }))

    expect(changed.workspace.name).toBe('My custom label')
    expect(changed.workspace.nameSource).toBe('custom')
  })

  it('projects observed local marker state and fails closed when membership disappears', () => {
    const { root, store } = harness()
    const workspaceRoot = join(root, 'project')
    mkdirSync(workspaceRoot)
    store.create(localWorkspace(workspaceRoot))

    const available = store.getInfo('workspace-1')!
    expect(available.locations[0].availability.status).toBe('available')
    expect(available.locations[0].permissions).toEqual({
      read: true,
      write: true,
      search: true,
      runCommands: true,
    })

    rmSync(getWorkspaceMarkerPath(workspaceRoot))
    const unavailable = store.getInfo('workspace-1')!
    expect(unavailable.locations[0].availability).toMatchObject({
      status: 'unavailable',
      reason: 'marker-missing',
    })
    expect(unavailable.locations[0].permissions).toEqual({
      read: false,
      write: false,
      search: false,
      runCommands: false,
    })
  })

  it('defaults unobserved remote locations to unknown with no fabricated permissions', () => {
    const { store } = harness()
    store.create({
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      id: 'workspace-1',
      revision: 0,
      name: 'Ignored derived name',
      nameSource: 'derived',
      slug: 'remote',
      primaryLocationId: 'primary',
      locations: [{
        id: 'primary',
        name: 'Primary',
        rootName: 'verified-remote-root',
        endpoint: {
          kind: 'remote',
          url: 'wss://agent.example.test/path?transient=value',
          remoteWorkspaceId: 'remote-1',
          credentialRef: 'secret-credential-ref',
        },
      }],
      createdAt: 1,
    })

    const info = store.getInfo('workspace-1')!
    expect(info.name).toBe('verified-remote-root')
    expect(info.locations[0].availability).toEqual({ status: 'unknown', reason: 'not-observed' })
    expect(info.locations[0].permissions).toEqual({
      read: false,
      write: false,
      search: false,
      runCommands: false,
    })
    expect(info.locations[0].endpoint).toEqual({
      kind: 'remote',
      url: 'wss://agent.example.test/path',
      remoteWorkspaceId: 'remote-1',
    })
  })

  it('reprojects stored topology and historical receipts without leaking authority fields', () => {
    const projectedRevisions: number[] = []
    const { root, store } = harness(workspace => {
      projectedRevisions.push(workspace.revision)
      return workspace.locations.map(location => ({
        schemaVersion: 1,
        locationId: location.id,
        availability: { status: 'unknown', reason: 'checking' },
        permissions: { read: false, write: false, search: false, runCommands: false },
      }))
    })
    const primaryRoot = join(root, 'primary-secret-path')
    mkdirSync(primaryRoot)
    store.create(localWorkspace(primaryRoot))

    const attach = command({
      operation: 'attach-remote',
      locationId: 'remote',
      name: 'Remote',
      rootName: 'remote-root',
      url: 'wss://agent.example.test',
      remoteWorkspaceId: 'remote-1',
      credentialRef: 'secret-credential-ref',
    }, { operationId: 'attach-remote' })
    const first = store.apply(attach)
    store.setProjectionProvider(workspace => workspace.locations.map(location => ({
      schemaVersion: 1,
      locationId: location.id,
      availability: { status: 'unavailable', observedAt: 42, reason: 'offline' },
      permissions: { read: true, write: false, search: true, runCommands: false },
    })))
    const replay = store.apply(attach)

    expect(first.workspace.locations.every(location => location.availability.status === 'unknown')).toBe(true)
    expect(projectedRevisions).toEqual([1])
    expect(replay.status).toBe('duplicate')
    expect(replay.workspace.revision).toBe(1)
    expect(replay.workspace.locations.every(location => location.availability.status === 'unavailable')).toBe(true)

    const clientJson = JSON.stringify(replay.workspace)
    const storedJson = JSON.stringify(store.get('workspace-1'))
    expect(clientJson).not.toContain(primaryRoot)
    expect(clientJson).not.toContain('secret-credential-ref')
    expect(clientJson).not.toContain('rootPath')
    expect(clientJson).not.toContain('credentialRef')
    expect(storedJson).not.toContain('availability')
    expect(storedJson).not.toContain('permissions')
  })
})
