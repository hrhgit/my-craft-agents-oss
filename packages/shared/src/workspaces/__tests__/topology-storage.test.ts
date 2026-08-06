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
  type WorkspaceTransferRequestV1,
} from '../../protocol/workspace-topology.ts'
import { getWorkspaceMarkerPath, readWorkspaceMarker } from '../marker.ts'
import { MultiWriterStore } from '../../storage/multi-writer-store.ts'
import {
  getWorkspaceTopologyRecordIdentity,
  getWorkspaceTopologyRegistryIdentity,
  getWorkspaceTransferOperationIdentity,
  getWorkspaceTransferDestinationIdentity,
} from '../state-contract.ts'
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
  it('keeps destination reservation namespaces collision-free for slash-bearing identities', () => {
    expect(getWorkspaceTransferDestinationIdentity('a/b', 'c', 'file.txt')).not.toEqual(
      getWorkspaceTransferDestinationIdentity('a', 'b/c', 'file.txt'),
    )
  })
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

  it('atomically maintains the canonical Workspace registry across create and remove', () => {
    const { root, store } = harness()
    const firstRoot = join(root, 'first')
    const secondRoot = join(root, 'second')
    writeFixture(join(firstRoot, 'keep.txt'), 'first')
    writeFixture(join(secondRoot, 'keep.txt'), 'second')

    const first = store.create(localWorkspace(firstRoot, 'workspace-1'))
    const second = store.create(localWorkspace(secondRoot, 'workspace-2'))

    expect(store.list().map(workspace => workspace.id)).toEqual([first.id, second.id])
    expect(store.listInfo().map(workspace => workspace.id)).toEqual([first.id, second.id])
    expect(store.remove(first.id, 'remove-first')).toBeTrue()
    expect(store.get(first.id)).toBeNull()
    expect(store.list().map(workspace => workspace.id)).toEqual([second.id])
    expect(store.remove(first.id, 'remove-first-again')).toBeFalse()
    expect(() => store.create(first, 'recreate-first')).toThrow('already exists')
    expect(store.restore(first.id, 'restore-first')).toEqual(first)
    expect(store.get(first.id)).toEqual(first)
    expect(store.list().map(workspace => workspace.id)).toEqual([second.id, first.id])
    expect(store.restore(first.id, 'restore-first-again')).toEqual(first)
    expect(store.remove(first.id, 'remove-restored-first')).toBeTrue()
    expect(() => store.apply(command({
      operation: 'rename',
      locationId: 'primary',
      name: 'Removed',
    }))).toThrow('not found')
    expect(readFileSync(join(firstRoot, 'keep.txt'), 'utf8')).toBe('first')
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
    expect(store.list()).toEqual([])
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

  it('supports replace, set-primary, rename, and marker-only detach without deleting user data', () => {
    const { root, store } = harness()
    const primaryRoot = join(root, 'primary')
    const attachedRoot = join(root, 'attached')
    const replacementRoot = join(root, 'replacement')
    writeFixture(join(primaryRoot, 'primary.txt'), 'primary')
    writeFixture(join(primaryRoot, '.mortise', 'preserved.txt'), 'preserved')
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
    expect(existsSync(getWorkspaceMarkerPath(primaryRoot))).toBe(false)
    expect(existsSync(join(primaryRoot, '.mortise', 'preserved.txt'))).toBe(true)
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

  it('renames the canonical Workspace without changing its locations', () => {
    const { root, store } = harness()
    const primaryRoot = join(root, 'primary')
    mkdirSync(primaryRoot)
    const created = store.create(localWorkspace(primaryRoot))

    const changed = store.apply(command({
      operation: 'rename-workspace', name: 'Renamed Workspace',
    }, { operationId: 'rename-workspace', expectedRevision: created.revision }))

    expect(changed.workspace).toMatchObject({
      name: 'Renamed Workspace',
      nameSource: 'custom',
      revision: created.revision + 1,
      primaryLocationId: created.primaryLocationId,
    })
    expect(changed.workspace.locations.map(({ id, name, rootName }) => ({ id, name, rootName }))).toEqual(
      created.locations.map(({ id, name, rootName }) => ({ id, name, rootName })),
    )
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

  it('serializes destination ownership and source outcome across concurrent writers', () => {
    const { root, store } = harness()
    const primaryRoot = join(root, 'primary')
    const attachedRoot = join(root, 'attached')
    mkdirSync(primaryRoot)
    mkdirSync(attachedRoot)
    store.create({
      ...localWorkspace(primaryRoot),
      locations: [
        ...localWorkspace(primaryRoot).locations,
        { id: 'attached', name: 'Attached', rootName: 'attached', endpoint: { kind: 'local', rootPath: attachedRoot } },
      ],
    })
    const second = new WorkspaceTopologyStore({ databasePath: join(root, 'state.sqlite'), writerId: 'concurrent-writer' })
    stores.push(second)
    const request = (operationId: string): WorkspaceTransferRequestV1 => ({
      schemaVersion: 1, operationId, workspaceId: 'workspace-1', expectedRevision: 0, mode: 'move',
      source: { schemaVersion: 1, workspaceId: 'workspace-1', locationId: 'primary', relativePath: `${operationId}.txt` },
      destination: { schemaVersion: 1, workspaceId: 'workspace-1', locationId: 'attached', relativePath: 'shared.txt' },
    })
    const sha256 = 'a'.repeat(64)
    const first = request('first')
    const competing = request('competing')
    store.prepareTransfer(first, { bytes: 1, sha256 })
    expect(() => second.prepareTransfer(competing, { bytes: 1, sha256 })).toThrow('already reserved')
    expect(() => store.recordTransferResult(first, {
      schemaVersion: 1, operationId: first.operationId, status: 'applied', workspaceId: first.workspaceId,
      sourceLocationId: 'primary', destinationLocationId: 'attached', revision: 0, mode: 'move',
      sha256, bytes: 1, sourceRemoved: true,
    })).toThrow('source outcome is not resolved')

    store.markTransferDestinationPublished(first)
    store.markTransferSourceResolved(first, true)
    expect(() => second.markTransferSourceResolved(first, false)).toThrow('source outcome conflicted')
    store.recordTransferResult(first, {
      schemaVersion: 1, operationId: first.operationId, status: 'applied', workspaceId: first.workspaceId,
      sourceLocationId: 'primary', destinationLocationId: 'attached', revision: 0, mode: 'move',
      sha256, bytes: 1, sourceRemoved: true,
    })
    expect(store.listPendingTransferCleanup('workspace-1')).toEqual([first])
    store.markTransferCleanupComplete(first)
    expect(store.listPendingTransferCleanup('workspace-1')).toEqual([])
    expect(second.prepareTransfer(competing, { bytes: 1, sha256 }).phase).toBe('prepared')
  })

  it('rejects a conflicting source outcome that wins during the journal CAS', () => {
    const { root, store } = harness()
    const primaryRoot = join(root, 'primary')
    const attachedRoot = join(root, 'attached')
    mkdirSync(primaryRoot)
    mkdirSync(attachedRoot)
    store.create({
      ...localWorkspace(primaryRoot),
      locations: [
        ...localWorkspace(primaryRoot).locations,
        { id: 'attached', name: 'Attached', rootName: 'attached', endpoint: { kind: 'local', rootPath: attachedRoot } },
      ],
    })
    const second = new WorkspaceTopologyStore({ databasePath: join(root, 'state.sqlite'), writerId: 'cas-winner' })
    stores.push(second)
    const request: WorkspaceTransferRequestV1 = {
      schemaVersion: 1, operationId: 'source-cas-race', workspaceId: 'workspace-1', expectedRevision: 0, mode: 'move',
      source: { schemaVersion: 1, workspaceId: 'workspace-1', locationId: 'primary', relativePath: 'source.txt' },
      destination: { schemaVersion: 1, workspaceId: 'workspace-1', locationId: 'attached', relativePath: 'destination.txt' },
    }
    store.prepareTransfer(request, { bytes: 1, sha256: 'a'.repeat(64) })
    store.markTransferDestinationPublished(request)

    const internalStore = (store as unknown as { store: { mutateRecord: (...args: unknown[]) => unknown } }).store
    const originalMutateRecord = internalStore.mutateRecord.bind(internalStore)
    let interleaved = false
    internalStore.mutateRecord = (...args: unknown[]) => {
      if (!interleaved) {
        interleaved = true
        second.markTransferSourceResolved(request, false)
      }
      return originalMutateRecord(...args)
    }

    expect(() => store.markTransferSourceResolved(request, true)).toThrow('already used with a different payload')
    expect(store.getTransferJournal(request)).toMatchObject({ phase: 'source-resolved', sourceRemoved: false })
  })

  it('migrates a v1 transfer receipt to the v2 journal without a read fallback', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-transfer-migration-'))
    cleanup.push(root)
    const databasePath = join(root, 'state.sqlite')
    const workspaceRoot = join(root, 'workspace')
    mkdirSync(workspaceRoot)
    const workspace = localWorkspace(workspaceRoot)
    const request: WorkspaceTransferRequestV1 = {
      schemaVersion: 1, operationId: 'historical-transfer', workspaceId: workspace.id, expectedRevision: 0, mode: 'copy',
      source: { schemaVersion: 1, workspaceId: workspace.id, locationId: 'primary', relativePath: 'source.txt' },
      destination: { schemaVersion: 1, workspaceId: workspace.id, locationId: 'primary', relativePath: 'destination.txt' },
    }
    const result = {
      schemaVersion: 1 as const, operationId: request.operationId, status: 'applied' as const, workspaceId: workspace.id,
      sourceLocationId: 'primary', destinationLocationId: 'primary', revision: 0, mode: 'copy' as const,
      sha256: 'b'.repeat(64), bytes: 7, sourceRemoved: false,
    }
    const journalRequest = { ...request, operationId: 'historical-completed-journal' }
    const journalResult = { ...result, operationId: journalRequest.operationId }
    const raw = MultiWriterStore.openSync({
      databasePath, writerId: 'legacy-writer', writerVersion: 1,
      capabilities: {
        'workspace.topology': { minWriteVersion: 1, maxWriteVersion: 1 },
        'workspace.transfer': { minWriteVersion: 1, maxWriteVersion: 1 },
      },
    })
    const topologyIdentity = getWorkspaceTopologyRecordIdentity(workspace.id)
    const registryIdentity = getWorkspaceTopologyRegistryIdentity()
    const transferIdentity = getWorkspaceTransferOperationIdentity(workspace.id, request.operationId)
    raw.mutateRecord({ capability: 'workspace.topology', ...topologyIdentity, value: workspace as any, expectedVersion: null, operationId: 'legacy-topology' })
    raw.mutateRecord({ capability: 'workspace.topology', ...registryIdentity, value: { schemaVersion: 1, workspaceIds: [workspace.id] }, expectedVersion: null, operationId: 'legacy-registry' })
    raw.mutateRecord({ capability: 'workspace.transfer', ...transferIdentity, value: { request, result } as any, expectedVersion: null, operationId: 'legacy-transfer' })
    raw.mutateRecord({
      capability: 'workspace.transfer',
      ...getWorkspaceTransferOperationIdentity(workspace.id, journalRequest.operationId),
      value: {
        schemaVersion: 1, operationId: journalRequest.operationId, workspaceId: workspace.id,
        request: journalRequest, phase: 'completed', bytes: journalResult.bytes, sha256: journalResult.sha256,
        sourceRemoved: false, result: journalResult,
      } as any,
      expectedVersion: null,
      operationId: 'legacy-completed-journal',
    })
    raw.close()

    const migrated = new WorkspaceTopologyStore({ databasePath, writerId: 'current-writer' })
    stores.push(migrated)
    expect(migrated.getTransferJournal(request)).toMatchObject({
      schemaVersion: 2, phase: 'completed', sourceRemoved: false, result, cleanupPending: false,
    })
    expect(migrated.getTransferResult(request)).toEqual({ ...result, status: 'duplicate' })
    expect(migrated.getTransferJournal(journalRequest)).toMatchObject({
      schemaVersion: 2, phase: 'completed', cleanupPending: false, result: journalResult,
    })
  })
})
