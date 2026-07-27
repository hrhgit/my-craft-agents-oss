import { isDeepStrictEqual } from 'node:util'
import { randomUUID } from 'node:crypto'
import { accessSync, constants, realpathSync } from 'node:fs'
import { basename, normalize, parse as parsePath, resolve } from 'node:path'
import type { Workspace, WorkspaceEndpoint, WorkspaceInfo, WorkspaceLocation } from '@mortise/core/types'
import { WORKSPACE_SCHEMA_VERSION } from '@mortise/core/types'
import {
  WORKSPACE_TOPOLOGY_ERROR_CODES,
  parseWorkspaceTransferRequestV1,
  parseWorkspaceTransferResultV1,
  parseWorkspaceTopologyCommandV1,
  parseWorkspaceV2,
  redactWorkspaceInfo,
  type WorkspaceLocationProjectionV1,
  type WorkspaceTopologyCommandV1,
  type WorkspaceTopologyResultV1,
  type WorkspaceTransferRequestV1,
  type WorkspaceTransferResultV1,
} from '../protocol/workspace-topology.ts'
import { CONFIG_DIR } from '../config/paths.ts'
import { MultiWriterStore, type JsonValue, type MultiWriterTransaction } from '../storage/index.ts'
import { getMortiseStateDatabasePath, MORTISE_STATE_WRITER_VERSION } from '../config/state-contract.ts'
import { ensureWorkspaceMarker, readWorkspaceMarker, WorkspaceTopologyError } from './marker.ts'
import {
  getWorkspaceTopologyOperationIdentity,
  getWorkspaceTopologyRecordIdentity,
  getWorkspaceTransferOperationIdentity,
} from './state-contract.ts'

const TOPOLOGY_CAPABILITY = 'workspace.topology'
const TOPOLOGY_CAPABILITY_VERSION = 1
const TRANSFER_CAPABILITY = 'workspace.transfer'
const TRANSFER_CAPABILITY_VERSION = 1

export interface LegacyWorkspaceV1 {
  id: string
  name: string
  slug?: string
  rootPath: string
  createdAt?: number
  lastAccessedAt?: number
  iconUrl?: string
  mcpUrl?: string
  mcpAuthType?: Workspace['mcpAuthType']
  remoteServer?: {
    url: string
    remoteWorkspaceId: string
    credentialRef?: string
    allowInsecureTls?: boolean
  }
}

interface WorkspaceTopologyReceipt {
  command: WorkspaceTopologyCommandV1
  workspace: Workspace
  previousRevision: number
}

export interface ApplyWorkspaceTopologyResult extends WorkspaceTopologyResultV1 {
  previousRevision: number
}

export interface WorkspaceTopologyStoreOptions {
  databasePath: string
  writerId?: string
  projectionProvider?: WorkspaceLocationProjectionProvider
}

interface WorkspaceTransferReceipt {
  request: WorkspaceTransferRequestV1
  result: WorkspaceTransferResultV1
}

export type WorkspaceLocationProjectionProvider = (
  workspace: Workspace,
) => readonly WorkspaceLocationProjectionV1[]

export class WorkspaceTopologyStore {
  private readonly store: MultiWriterStore
  private projectionProvider: WorkspaceLocationProjectionProvider

  constructor(options: WorkspaceTopologyStoreOptions) {
    this.store = MultiWriterStore.openSync({
      databasePath: options.databasePath,
      writerId: options.writerId ?? `workspace-topology-${process.pid}-${randomUUID()}`,
      writerVersion: MORTISE_STATE_WRITER_VERSION,
      capabilities: {
        [TOPOLOGY_CAPABILITY]: {
          minWriteVersion: TOPOLOGY_CAPABILITY_VERSION,
          maxWriteVersion: TOPOLOGY_CAPABILITY_VERSION,
        },
        [TRANSFER_CAPABILITY]: {
          minWriteVersion: TRANSFER_CAPABILITY_VERSION,
          maxWriteVersion: TRANSFER_CAPABILITY_VERSION,
        },
      },
    })
    this.projectionProvider = options.projectionProvider ?? observeWorkspaceLocations
  }

  setProjectionProvider(provider: WorkspaceLocationProjectionProvider): void {
    this.projectionProvider = provider
  }

  close(): void {
    this.store.close()
  }

  get(workspaceId: string): Workspace | null {
    const identity = getWorkspaceTopologyRecordIdentity(workspaceId)
    const record = this.store.getRecord(identity.namespace, identity.key)
    return record ? parseWorkspaceV2(structuredClone(record.value)) : null
  }

  getInfo(workspaceId: string): WorkspaceInfo | null {
    const workspace = this.get(workspaceId)
    return workspace ? this.project(workspace) : null
  }

  create(workspaceValue: Workspace, operationId = `workspace-create-${workspaceValue.id}`): Workspace {
    const workspace = normalizeWorkspace(workspaceValue)
    assertUniqueEndpoints(workspace.locations, workspace.id)
    for (const location of workspace.locations) {
      if (location.endpoint.kind === 'local') ensureWorkspaceMarker(location.endpoint.rootPath, workspace.id)
    }
    const identity = getWorkspaceTopologyRecordIdentity(workspace.id)
    const result = this.store.mutateRecord({
      capability: TOPOLOGY_CAPABILITY,
      namespace: identity.namespace,
      key: identity.key,
      value: workspace as unknown as JsonValue,
      expectedVersion: null,
      operationId,
    })
    if (result.status === 'conflict') {
      const current = this.get(workspace.id)
      if (current && isDeepStrictEqual(current, workspace)) return current
      throw new Error(`Workspace topology already exists for ${workspace.id}`)
    }
    return parseWorkspaceV2(structuredClone(result.value))
  }

  migrateLegacy(legacy: LegacyWorkspaceV1): Workspace {
    const existing = this.get(legacy.id)
    if (existing) return existing
    const now = Date.now()
    const primary: WorkspaceLocation = legacy.remoteServer
      ? {
          id: 'primary',
          name: 'Primary',
          rootName: legacy.name,
          endpoint: {
            kind: 'remote',
            url: legacy.remoteServer.url,
            remoteWorkspaceId: legacy.remoteServer.remoteWorkspaceId,
            credentialRef: legacy.remoteServer.credentialRef ?? `workspace:${legacy.id}:primary`,
            ...(legacy.remoteServer.allowInsecureTls === undefined
              ? {}
              : { allowInsecureTls: legacy.remoteServer.allowInsecureTls }),
          },
        }
      : {
          id: 'primary',
          name: 'Primary',
          rootName: rootNameFromLocalRoot(canonicalLocalRoot(legacy.rootPath, legacy.id)),
          endpoint: { kind: 'local', rootPath: canonicalLocalRoot(legacy.rootPath, legacy.id) },
        }
    return this.create({
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      id: legacy.id,
      revision: 0,
      name: legacy.name,
      nameSource: 'custom',
      slug: legacy.slug?.trim() || slugFromName(legacy.name),
      primaryLocationId: primary.id,
      locations: [primary],
      createdAt: legacy.createdAt ?? now,
      ...(legacy.lastAccessedAt === undefined ? {} : { lastAccessedAt: legacy.lastAccessedAt }),
      ...(legacy.iconUrl === undefined ? {} : { iconUrl: legacy.iconUrl }),
      ...(legacy.mcpUrl === undefined ? {} : { mcpUrl: legacy.mcpUrl }),
      ...(legacy.mcpAuthType === undefined ? {} : { mcpAuthType: legacy.mcpAuthType }),
    }, `workspace-legacy-migration:${legacy.id}`)
  }

  apply(commandValue: unknown): ApplyWorkspaceTopologyResult {
    const command = parseWorkspaceTopologyCommandV1(commandValue)
    const replay = this.getAppliedResult(command)
    if (replay) return replay

    const prepared = this.prepareCommand(command)
    return this.store.writeTransaction({ requiredCapabilities: [TOPOLOGY_CAPABILITY] }, transaction => {
      const duplicate = readReceiptInTransaction(transaction, command)
      if (duplicate) return receiptResult(command.operationId, duplicate, 'duplicate', this.project(duplicate.workspace))

      const identity = getWorkspaceTopologyRecordIdentity(command.workspaceId)
      const stored = transaction.getRecord(identity.namespace, identity.key)
      if (!stored) throw new Error(`Workspace topology not found: ${command.workspaceId}`)
      const current = parseWorkspaceV2(structuredClone(stored.value))
      assertExpectedRevision(command, current.revision)
      const next = applyPreparedCommand(current, command, prepared)
      const result = transaction.mutateRecord({
        capability: TOPOLOGY_CAPABILITY,
        namespace: identity.namespace,
        key: identity.key,
        value: next as unknown as JsonValue,
        expectedVersion: stored.version,
        operationId: `${command.operationId}:topology`,
      })
      if (result.status !== 'applied') throw staleRevision(command, current.revision)
      const persisted = parseWorkspaceV2(structuredClone(result.value))
      const receipt: WorkspaceTopologyReceipt = {
        command,
        workspace: persisted,
        previousRevision: current.revision,
      }
      const receiptIdentity = getWorkspaceTopologyOperationIdentity(command.workspaceId, command.operationId)
      const receiptWrite = transaction.mutateRecord({
        capability: TOPOLOGY_CAPABILITY,
        namespace: receiptIdentity.namespace,
        key: receiptIdentity.key,
        value: receipt as unknown as JsonValue,
        expectedVersion: null,
        operationId: `${command.operationId}:receipt`,
      })
      if (receiptWrite.status !== 'applied') throw new Error(`Topology operation receipt conflicted: ${command.operationId}`)
      return receiptResult(command.operationId, receipt, 'applied', this.project(persisted))
    })
  }

  getAppliedResult(commandValue: unknown): ApplyWorkspaceTopologyResult | null {
    const command = parseWorkspaceTopologyCommandV1(commandValue)
    const receipt = this.readReceipt(command)
    return receipt
      ? receiptResult(command.operationId, receipt, 'duplicate', this.project(receipt.workspace))
      : null
  }

  getTransferResult(requestValue: unknown): WorkspaceTransferResultV1 | null {
    const request = parseWorkspaceTransferRequestV1(requestValue)
    const receipt = this.readTransferReceipt(request)
    return receipt ? { ...receipt.result, status: 'duplicate' } : null
  }

  recordTransferResult(requestValue: unknown, resultValue: unknown): WorkspaceTransferResultV1 {
    const request = parseWorkspaceTransferRequestV1(requestValue)
    const result = parseWorkspaceTransferResultV1(resultValue)
    if (result.status !== 'applied') throw new Error('Only an applied Workspace transfer can be recorded')
    assertTransferResultMatchesRequest(request, result)
    const identity = getWorkspaceTransferOperationIdentity(request.workspaceId, request.operationId)
    const receipt: WorkspaceTransferReceipt = { request, result }
    const write = this.store.mutateRecord({
      capability: TRANSFER_CAPABILITY,
      namespace: identity.namespace,
      key: identity.key,
      value: receipt as unknown as JsonValue,
      expectedVersion: null,
      operationId: `${request.operationId}:transfer-receipt`,
    })
    if (write.status === 'applied') return result
    const replay = this.readTransferReceipt(request)
    if (!replay) throw new Error(`Workspace transfer receipt conflicted: ${request.operationId}`)
    return { ...replay.result, status: 'duplicate' }
  }

  private project(workspace: Workspace): WorkspaceInfo {
    return redactWorkspaceInfo(workspace, this.projectionProvider(workspace))
  }

  private readReceipt(command: WorkspaceTopologyCommandV1): WorkspaceTopologyReceipt | null {
    const identity = getWorkspaceTopologyOperationIdentity(command.workspaceId, command.operationId)
    const record = this.store.getRecord(identity.namespace, identity.key)
    if (!record) return null
    return validateReceipt(record.value, command)
  }

  private readTransferReceipt(request: WorkspaceTransferRequestV1): WorkspaceTransferReceipt | null {
    const identity = getWorkspaceTransferOperationIdentity(request.workspaceId, request.operationId)
    const record = this.store.getRecord(identity.namespace, identity.key)
    if (!record) return null
    const receipt = structuredClone(record.value) as unknown as WorkspaceTransferReceipt
    if (!receipt || !isDeepStrictEqual(receipt.request, request)) {
      throw new Error(`operationId was already used for a different Workspace transfer: ${request.operationId}`)
    }
    receipt.request = parseWorkspaceTransferRequestV1(receipt.request)
    receipt.result = parseWorkspaceTransferResultV1(receipt.result)
    assertTransferResultMatchesRequest(receipt.request, receipt.result)
    return receipt
  }

  private prepareCommand(command: WorkspaceTopologyCommandV1): WorkspaceEndpoint | null {
    const current = this.get(command.workspaceId)
    if (!current) throw new Error(`Workspace topology not found: ${command.workspaceId}`)
    assertExpectedRevision(command, current.revision)
    if (command.operation === 'attach-local') {
      const endpoint: WorkspaceEndpoint = {
        kind: 'local',
        rootPath: canonicalLocalRoot(command.rootPath, command.workspaceId),
      }
      ensureWorkspaceMarker(endpoint.rootPath, command.workspaceId)
      return endpoint
    }
    if (command.operation === 'replace-endpoint' && command.endpoint.kind === 'local') {
      const endpoint: WorkspaceEndpoint = {
        kind: 'local',
        rootPath: canonicalLocalRoot(command.endpoint.rootPath, command.workspaceId),
      }
      ensureWorkspaceMarker(endpoint.rootPath, command.workspaceId)
      return endpoint
    }
    return null
  }
}

let defaultTopologyStore: WorkspaceTopologyStore | null = null

export function getDefaultWorkspaceTopologyStore(): WorkspaceTopologyStore {
  if (!defaultTopologyStore) {
    defaultTopologyStore = new WorkspaceTopologyStore({
      databasePath: getMortiseStateDatabasePath(CONFIG_DIR),
    })
  }
  return defaultTopologyStore
}

export function closeWorkspaceTopologyStorage(): void {
  defaultTopologyStore?.close()
  defaultTopologyStore = null
}

function applyPreparedCommand(
  current: Workspace,
  command: WorkspaceTopologyCommandV1,
  preparedEndpoint: WorkspaceEndpoint | null,
): Workspace {
  let primaryLocationId = current.primaryLocationId
  let locations = [...current.locations]
  switch (command.operation) {
    case 'attach-local':
      assertNewLocation(current, command.locationId, command.name)
      locations.push({
        id: command.locationId,
        name: command.name,
        rootName: rootNameFromLocalRoot((preparedEndpoint as Extract<WorkspaceEndpoint, { kind: 'local' }>).rootPath),
        endpoint: preparedEndpoint!,
      })
      break
    case 'attach-remote':
      assertNewLocation(current, command.locationId, command.name)
      locations.push({
        id: command.locationId,
        name: command.name,
        rootName: command.rootName,
        endpoint: {
          kind: 'remote',
          url: command.url,
          remoteWorkspaceId: command.remoteWorkspaceId,
          credentialRef: command.credentialRef,
          ...(command.allowInsecureTls === undefined ? {} : { allowInsecureTls: command.allowInsecureTls }),
        },
      })
      break
    case 'detach':
      requireLocation(current, command.locationId)
      if (command.locationId === current.primaryLocationId) {
        throw new WorkspaceTopologyError(
          WORKSPACE_TOPOLOGY_ERROR_CODES.LOCATION_IN_USE,
          'The primary location cannot be detached',
          { workspaceId: current.id, locationId: command.locationId, retryable: false },
        )
      }
      locations = locations.filter(location => location.id !== command.locationId)
      break
    case 'replace-endpoint': {
      requireLocation(current, command.locationId)
      const endpoint = preparedEndpoint ?? command.endpoint
      const rootName = endpoint.kind === 'local' ? rootNameFromLocalRoot(endpoint.rootPath) : command.rootName
      locations = locations.map(location => location.id === command.locationId ? { ...location, rootName, endpoint } : location)
      break
    }
    case 'set-primary':
      requireLocation(current, command.locationId)
      if (current.primaryLocationId === command.locationId) throw new Error('Location is already primary')
      primaryLocationId = command.locationId
      break
    case 'rename':
      requireLocation(current, command.locationId)
      if (locations.some(location => location.id !== command.locationId && sameName(location.name, command.name))) {
        throw new Error(`Workspace location name already exists: ${command.name}`)
      }
      locations = locations.map(location => location.id === command.locationId ? { ...location, name: command.name } : location)
      break
  }
  const primary = locations.find(location => location.id === primaryLocationId)
  if (!primary) throw new Error(`Workspace primary location not found: ${primaryLocationId}`)
  const next = normalizeWorkspace({
    ...current,
    revision: current.revision + 1,
    name: current.nameSource === 'derived' ? primary.rootName : current.name,
    primaryLocationId,
    locations: locations as Workspace['locations'],
  })
  assertUniqueEndpoints(next.locations, current.id)
  return next
}

function readReceiptInTransaction(
  transaction: MultiWriterTransaction,
  command: WorkspaceTopologyCommandV1,
): WorkspaceTopologyReceipt | null {
  const identity = getWorkspaceTopologyOperationIdentity(command.workspaceId, command.operationId)
  const record = transaction.getRecord(identity.namespace, identity.key)
  return record ? validateReceipt(record.value, command) : null
}

function validateReceipt(value: JsonValue, command: WorkspaceTopologyCommandV1): WorkspaceTopologyReceipt {
  const receipt = structuredClone(value) as unknown as WorkspaceTopologyReceipt
  if (!receipt || !isDeepStrictEqual(receipt.command, command)) {
    throw new Error(`operationId was already used for a different topology command: ${command.operationId}`)
  }
  receipt.workspace = parseWorkspaceV2(receipt.workspace)
  return receipt
}

function receiptResult(
  operationId: string,
  receipt: WorkspaceTopologyReceipt,
  status: 'applied' | 'duplicate',
  workspace: WorkspaceInfo,
): ApplyWorkspaceTopologyResult {
  return {
    schemaVersion: 1,
    operationId,
    status,
    workspace,
    previousRevision: receipt.previousRevision,
  }
}

function assertExpectedRevision(command: WorkspaceTopologyCommandV1, actualRevision: number): void {
  if (command.expectedRevision !== actualRevision) throw staleRevision(command, actualRevision)
}

function staleRevision(command: WorkspaceTopologyCommandV1, actualRevision: number): WorkspaceTopologyError {
  return new WorkspaceTopologyError(
    WORKSPACE_TOPOLOGY_ERROR_CODES.STALE_REVISION,
    `Workspace revision is ${actualRevision}, expected ${command.expectedRevision}`,
    {
      workspaceId: command.workspaceId,
      expectedRevision: command.expectedRevision,
      actualRevision,
      retryable: true,
    },
  )
}

function assertNewLocation(workspace: Workspace, locationId: string, name: string): void {
  if (workspace.locations.some(location => location.id === locationId)) {
    throw new Error(`Workspace location ID already exists: ${locationId}`)
  }
  if (workspace.locations.some(location => sameName(location.name, name))) {
    throw new Error(`Workspace location name already exists: ${name}`)
  }
}

function requireLocation(workspace: Workspace, locationId: string): WorkspaceLocation {
  const location = workspace.locations.find(candidate => candidate.id === locationId)
  if (!location) throw new Error(`Workspace location not found: ${locationId}`)
  return location
}

function normalizeWorkspace(workspace: Workspace): Workspace {
  const locations = workspace.locations.map(location => ({
    ...location,
    rootName: location.endpoint.kind === 'local'
      ? rootNameFromLocalRoot(canonicalLocalRoot(location.endpoint.rootPath, workspace.id))
      : location.rootName,
    endpoint: location.endpoint.kind === 'local'
      ? { kind: 'local' as const, rootPath: canonicalLocalRoot(location.endpoint.rootPath, workspace.id) }
      : normalizeRemoteEndpoint(location.endpoint),
  })) as Workspace['locations']
  const primary = locations.find(location => location.id === workspace.primaryLocationId)
  if (!primary) throw new Error(`Workspace primary location not found: ${workspace.primaryLocationId}`)
  return parseWorkspaceV2({
    ...workspace,
    name: workspace.nameSource === 'derived' ? primary.rootName : workspace.name,
    locations,
  })
}

export function observeWorkspaceLocations(workspace: Workspace): WorkspaceLocationProjectionV1[] {
  return workspace.locations.map(location => {
    if (location.endpoint.kind === 'remote') {
      return {
        schemaVersion: 1,
        locationId: location.id,
        availability: { status: 'unknown', reason: 'not-observed' },
        permissions: { read: false, write: false, search: false, runCommands: false },
      }
    }

    const observedAt = Date.now()
    try {
      readWorkspaceMarker(location.endpoint.rootPath, workspace.id)
      accessSync(location.endpoint.rootPath, constants.R_OK)
      let write = true
      try {
        accessSync(location.endpoint.rootPath, constants.W_OK)
      } catch {
        write = false
      }
      return {
        schemaVersion: 1,
        locationId: location.id,
        availability: { status: 'available', observedAt },
        permissions: { read: true, write, search: true, runCommands: true },
      }
    } catch (error) {
      const reason = error instanceof WorkspaceTopologyError
        ? error.code === WORKSPACE_TOPOLOGY_ERROR_CODES.MARKER_MISSING
          ? 'marker-missing'
          : error.code === WORKSPACE_TOPOLOGY_ERROR_CODES.MARKER_MISMATCH
            ? 'marker-mismatch'
            : 'not-found'
        : (error as NodeJS.ErrnoException).code === 'EACCES'
          ? 'permission-denied'
          : 'not-found'
      return {
        schemaVersion: 1,
        locationId: location.id,
        availability: { status: 'unavailable', observedAt, reason },
        permissions: { read: false, write: false, search: false, runCommands: false },
      }
    }
  })
}

function normalizeRemoteEndpoint(endpoint: Extract<WorkspaceEndpoint, { kind: 'remote' }>): WorkspaceEndpoint {
  const url = new URL(endpoint.url)
  url.hash = ''
  url.search = ''
  if (url.pathname === '/') url.pathname = ''
  return {
    ...endpoint,
    url: url.toString().replace(/\/$/, ''),
  }
}

function rootNameFromLocalRoot(rootPath: string): string {
  const leaf = basename(rootPath)
  if (leaf) return leaf
  return parsePath(rootPath).root.replace(/[\\/]+$/, '') || rootPath
}

function assertTransferResultMatchesRequest(
  request: WorkspaceTransferRequestV1,
  result: WorkspaceTransferResultV1,
): void {
  if (
    result.operationId !== request.operationId
    || result.workspaceId !== request.workspaceId
    || result.sourceLocationId !== request.source.locationId
    || result.destinationLocationId !== request.destination.locationId
    || result.revision !== request.expectedRevision
    || result.mode !== request.mode
  ) {
    throw new Error('Workspace transfer result does not match its request')
  }
}

function assertUniqueEndpoints(locations: readonly WorkspaceLocation[], workspaceId: string): void {
  const endpoints = new Set<string>()
  for (const location of locations) {
    const key = endpointKey(location.endpoint)
    if (endpoints.has(key)) {
      throw new Error(`Workspace ${workspaceId} contains a duplicate endpoint at location ${location.id}`)
    }
    endpoints.add(key)
  }
}

function endpointKey(endpoint: WorkspaceEndpoint): string {
  return endpoint.kind === 'local'
    ? `local:${platformPathKey(endpoint.rootPath)}`
    : `remote:${new URL(endpoint.url).toString().replace(/\/$/, '')}:${endpoint.remoteWorkspaceId}`
}

function canonicalLocalRoot(rootPath: string, workspaceId: string): string {
  try {
    return normalize(realpathSync.native(resolve(rootPath)))
  } catch (error) {
    throw new WorkspaceTopologyError(
      WORKSPACE_TOPOLOGY_ERROR_CODES.LOCATION_UNAVAILABLE,
      `Workspace location is unavailable: ${rootPath}`,
      { workspaceId, retryable: true },
    )
  }
}

function platformPathKey(rootPath: string): string {
  const value = normalize(rootPath)
  return process.platform === 'win32' ? value.toLocaleLowerCase('en-US') : value
}

function sameName(left: string, right: string): boolean {
  return left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US')
}

function slugFromName(name: string): string {
  return name.toLocaleLowerCase('en-US').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'workspace'
}
