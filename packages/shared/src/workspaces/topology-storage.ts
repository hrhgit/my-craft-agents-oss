import { isDeepStrictEqual } from 'node:util'
import { randomUUID } from 'node:crypto'
import { accessSync, constants, realpathSync } from 'node:fs'
import { basename, normalize, parse as parsePath, resolve } from 'node:path'
import type { Workspace, WorkspaceEndpoint, WorkspaceInfo, WorkspaceLocation } from '@mortise/core/types'
import { WORKSPACE_SCHEMA_VERSION } from '@mortise/core/types'
import {
  WORKSPACE_TOPOLOGY_ERROR_CODES,
  parseWorkspaceTransferJournalV2,
  parseWorkspaceTransferRequestV1,
  parseWorkspaceTransferResultV1,
  parseWorkspaceTopologyCommandV1,
  parseWorkspaceV2,
  redactWorkspaceInfo,
  type WorkspaceLocationProjectionV1,
  type WorkspaceTopologyCommandV1,
  type WorkspaceTopologyResultV1,
  type WorkspaceTransferRequestV1,
  type WorkspaceTransferJournalV2,
  type WorkspaceTransferResultV1,
} from '../protocol/workspace-topology.ts'
import { CONFIG_DIR } from '../config/paths.ts'
import {
  MultiWriterStore,
  type JsonValue,
  type MultiWriterReadTransaction,
  type MultiWriterTransaction,
} from '../storage/index.ts'
import { getMortiseStateDatabasePath, MORTISE_STATE_WRITER_VERSION } from '../config/state-contract.ts'
import { ensureWorkspaceMarker, readWorkspaceMarker, removeWorkspaceMarker, WorkspaceTopologyError } from './marker.ts'
import {
  getWorkspaceTopologyOperationIdentity,
  getWorkspaceTopologyRecordIdentity,
  getWorkspaceTopologyRegistryIdentity,
  getWorkspaceTransferDestinationIdentity,
  getWorkspaceTransferOperationIdentity,
} from './state-contract.ts'

const TOPOLOGY_CAPABILITY = 'workspace.topology'
const TOPOLOGY_CAPABILITY_VERSION = 1
const TRANSFER_CAPABILITY = 'workspace.transfer'
const TRANSFER_CAPABILITY_VERSION = 2

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

interface WorkspaceTopologyRegistry {
  schemaVersion: 1
  workspaceIds: string[]
}

export interface ApplyWorkspaceTopologyResult extends WorkspaceTopologyResultV1 {
  previousRevision: number
}

export interface WorkspaceTopologyStoreOptions {
  databasePath: string
  writerId?: string
  projectionProvider?: WorkspaceLocationProjectionProvider
}

interface WorkspaceTransferDestinationReservationV2 {
  schemaVersion: 2
  operationId: string
  request: WorkspaceTransferRequestV1
  status: 'active' | 'released'
}

const WORKSPACE_TRANSFER_V2_MIGRATION = {
  id: 'workspace-transfer-v2-journal-reservations',
  checksum: 'workspace-transfer-v2-journal-reservations-2026-07-28',
  migrate(transaction: MultiWriterTransaction): void {
    const currentVersion = transaction.getCapabilityVersion(TRANSFER_CAPABILITY)
    if (currentVersion === TRANSFER_CAPABILITY_VERSION) return
    if (currentVersion !== null && currentVersion !== 1) {
      throw new Error(`Unsupported Workspace transfer capability version: ${currentVersion}`)
    }
    const records = transaction.all<{ namespace: string; record_key: string; value_json: string }>(`
      SELECT namespace, record_key, value_json
      FROM mortise_records
      WHERE namespace LIKE 'workspace-transfer-operation/%'
    `)
    const reservations = new Map<string, WorkspaceTransferDestinationReservationV2>()
    for (const record of records) {
      const value = JSON.parse(record.value_json) as Record<string, unknown>
      const request = parseWorkspaceTransferRequestV1(value.request)
      let journal: WorkspaceTransferJournalV2
      if (value.result && !value.phase) {
        const result = parseWorkspaceTransferResultV1(value.result)
        journal = parseWorkspaceTransferJournalV2({
          schemaVersion: 2, operationId: request.operationId, workspaceId: request.workspaceId, request,
          phase: 'completed', bytes: result.bytes, sha256: result.sha256, cleanupPending: false,
          sourceRemoved: result.sourceRemoved, result,
        })
      } else {
        const phase = value.phase
        if (phase !== 'prepared' && phase !== 'destination-published' && phase !== 'completed') {
          throw new Error(`Unsupported Workspace transfer journal phase during migration: ${String(phase)}`)
        }
        const result = value.result ? parseWorkspaceTransferResultV1(value.result) : undefined
        journal = parseWorkspaceTransferJournalV2({
          ...value, schemaVersion: 2, request, phase,
          ...(result ? { result, sourceRemoved: result.sourceRemoved } : {}),
          ...(phase === 'completed' ? { cleanupPending: false } : {}),
        })
      }
      transaction.run(`
        UPDATE mortise_records
        SET value_json = ?, version = version + 1, updated_at = ?
        WHERE namespace = ? AND record_key = ?
      `, JSON.stringify(journal), Date.now(), record.namespace, record.record_key)
      if (journal.phase !== 'completed' && journal.phase !== 'aborted') {
        const identity = getWorkspaceTransferDestinationIdentity(
          request.workspaceId, request.destination.locationId, request.destination.relativePath,
        )
        const reservation: WorkspaceTransferDestinationReservationV2 = {
          schemaVersion: 2, operationId: request.operationId, request, status: 'active',
        }
        const reservationKey = `${identity.namespace}\0${identity.key}`
        const existing = reservations.get(reservationKey)
        if (existing && existing.operationId !== request.operationId) {
          throw new Error(`Conflicting historical Workspace transfer destinations: ${request.destination.relativePath}`)
        }
        reservations.set(reservationKey, reservation)
      }
    }
    for (const [reservationKey, reservation] of reservations) {
      const separator = reservationKey.indexOf('\0')
      transaction.run(`
        INSERT INTO mortise_records (namespace, record_key, version, value_json, updated_at, writer_id)
        VALUES (?, ?, 1, ?, ?, ?)
      `, reservationKey.slice(0, separator), reservationKey.slice(separator + 1), JSON.stringify(reservation), Date.now(), 'workspace-transfer-v2-migration')
    }
    transaction.setCapabilityVersion(TRANSFER_CAPABILITY, TRANSFER_CAPABILITY_VERSION)
  },
} as const

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
      moduleMigrations: [WORKSPACE_TRANSFER_V2_MIGRATION],
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
    return this.store.readTransaction((transaction) => {
      if (!readRegistry(transaction).workspaceIds.includes(workspaceId)) return null
      return readWorkspaceInTransaction(transaction, workspaceId)
    })
  }

  getInfo(workspaceId: string): WorkspaceInfo | null {
    const workspace = this.get(workspaceId)
    return workspace ? this.project(workspace) : null
  }

  list(): Workspace[] {
    return this.store.readTransaction((transaction) => readRegistry(transaction).workspaceIds.map((workspaceId) => {
      const workspace = readWorkspaceInTransaction(transaction, workspaceId)
      if (!workspace) throw new Error(`Workspace registry points to missing topology: ${workspaceId}`)
      return workspace
    }))
  }

  listInfo(): WorkspaceInfo[] {
    return this.list().map(workspace => this.project(workspace))
  }

  create(workspaceValue: Workspace, operationId = `workspace-create-${workspaceValue.id}`): Workspace {
    const workspace = normalizeWorkspace(workspaceValue)
    assertUniqueEndpoints(workspace.locations, workspace.id)
    for (const location of workspace.locations) {
      if (location.endpoint.kind === 'local') ensureWorkspaceMarker(location.endpoint.rootPath, workspace.id)
    }
    return this.store.writeTransaction({ requiredCapabilities: [TOPOLOGY_CAPABILITY] }, (transaction) => {
      const identity = getWorkspaceTopologyRecordIdentity(workspace.id)
      const currentRecord = transaction.getRecord(identity.namespace, identity.key)
      if (currentRecord) {
        const current = parseWorkspaceV2(structuredClone(currentRecord.value))
        const registered = readRegistry(transaction).workspaceIds.includes(workspace.id)
        if (registered && isDeepStrictEqual(current, workspace)) return current
        throw new Error(`Workspace topology already exists for ${workspace.id}`)
      }

      const result = transaction.mutateRecord({
        capability: TOPOLOGY_CAPABILITY,
        namespace: identity.namespace,
        key: identity.key,
        value: workspace as unknown as JsonValue,
        expectedVersion: null,
        operationId,
      })
      if (result.status !== 'applied') throw new Error(`Workspace topology already exists for ${workspace.id}`)

      const registryIdentity = getWorkspaceTopologyRegistryIdentity()
      const registryRecord = transaction.getRecord(registryIdentity.namespace, registryIdentity.key)
      const registry = registryRecord ? parseRegistry(registryRecord.value) : emptyRegistry()
      const registryWrite = transaction.mutateRecord({
        capability: TOPOLOGY_CAPABILITY,
        namespace: registryIdentity.namespace,
        key: registryIdentity.key,
        value: {
          ...registry,
          workspaceIds: [...registry.workspaceIds, workspace.id],
        } as unknown as JsonValue,
        expectedVersion: registryRecord?.version ?? null,
        operationId: `${operationId}:registry`,
      })
      if (registryWrite.status !== 'applied') throw new Error('Workspace registry changed while creating a Workspace')
      return parseWorkspaceV2(structuredClone(result.value))
    })
  }

  remove(workspaceId: string, operationId = `workspace-remove-${workspaceId}`): boolean {
    return this.store.writeTransaction({ requiredCapabilities: [TOPOLOGY_CAPABILITY] }, (transaction) => {
      const identity = getWorkspaceTopologyRegistryIdentity()
      const record = transaction.getRecord(identity.namespace, identity.key)
      if (!record) return false
      const registry = parseRegistry(record.value)
      if (!registry.workspaceIds.includes(workspaceId)) return false
      const write = transaction.mutateRecord({
        capability: TOPOLOGY_CAPABILITY,
        namespace: identity.namespace,
        key: identity.key,
        value: {
          ...registry,
          workspaceIds: registry.workspaceIds.filter(candidate => candidate !== workspaceId),
        } as unknown as JsonValue,
        expectedVersion: record.version,
        operationId,
      })
      if (write.status !== 'applied') throw new Error('Workspace registry changed while removing a Workspace')
      return true
    })
  }

  restore(workspaceId: string, operationId = `workspace-restore-${workspaceId}-${randomUUID()}`): Workspace {
    return this.store.writeTransaction({ requiredCapabilities: [TOPOLOGY_CAPABILITY] }, (transaction) => {
      const workspace = readWorkspaceInTransaction(transaction, workspaceId)
      if (!workspace) throw new Error(`Workspace topology not found: ${workspaceId}`)

      const identity = getWorkspaceTopologyRegistryIdentity()
      const record = transaction.getRecord(identity.namespace, identity.key)
      const registry = record ? parseRegistry(record.value) : emptyRegistry()
      if (registry.workspaceIds.includes(workspaceId)) return workspace

      const write = transaction.mutateRecord({
        capability: TOPOLOGY_CAPABILITY,
        namespace: identity.namespace,
        key: identity.key,
        value: {
          ...registry,
          workspaceIds: [...registry.workspaceIds, workspaceId],
        } as unknown as JsonValue,
        expectedVersion: record?.version ?? null,
        operationId,
      })
      if (write.status !== 'applied') throw new Error('Workspace registry changed while restoring a Workspace')
      return workspace
    })
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

      if (!readRegistry(transaction).workspaceIds.includes(command.workspaceId)) {
        throw new Error(`Workspace topology not found: ${command.workspaceId}`)
      }

      const identity = getWorkspaceTopologyRecordIdentity(command.workspaceId)
      const stored = transaction.getRecord(identity.namespace, identity.key)
      if (!stored) throw new Error(`Workspace topology not found: ${command.workspaceId}`)
      const current = parseWorkspaceV2(structuredClone(stored.value))
      assertExpectedRevision(command, current.revision)
      assertTransferLifecycleAllowsTopologyMutation(transaction, command)
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
      if (command.operation === 'detach') {
        const detached = requireLocation(current, command.locationId)
        if (detached.endpoint.kind === 'local') {
          removeWorkspaceMarker(detached.endpoint.rootPath, command.workspaceId)
        }
      }
      return receiptResult(command.operationId, receipt, 'applied', this.project(persisted))
    })
  }

  getAppliedResult(commandValue: unknown): ApplyWorkspaceTopologyResult | null {
    const command = parseWorkspaceTopologyCommandV1(commandValue)
    if (!this.get(command.workspaceId)) throw new Error(`Workspace topology not found: ${command.workspaceId}`)
    const receipt = this.readReceipt(command)
    return receipt
      ? receiptResult(command.operationId, receipt, 'duplicate', this.project(receipt.workspace))
      : null
  }

  getTransferResult(requestValue: unknown): WorkspaceTransferResultV1 | null {
    const request = parseWorkspaceTransferRequestV1(requestValue)
    if (!this.get(request.workspaceId)) throw new Error(`Workspace topology not found: ${request.workspaceId}`)
    const journal = this.getTransferJournal(request)
    return journal?.phase === 'completed' && journal.result
      ? { ...journal.result, status: 'duplicate' }
      : null
  }

  getTransferJournal(requestValue: unknown): WorkspaceTransferJournalV2 | null {
    const request = parseWorkspaceTransferRequestV1(requestValue)
    if (!this.get(request.workspaceId)) throw new Error(`Workspace topology not found: ${request.workspaceId}`)
    const identity = getWorkspaceTransferOperationIdentity(request.workspaceId, request.operationId)
    const record = this.store.getRecord(identity.namespace, identity.key)
    if (!record) return null
    return parseTransferJournalRecord(record.value, request)
  }

  listPendingTransferCleanup(workspaceIdValue: unknown): WorkspaceTransferRequestV1[] {
    const workspaceId = typeof workspaceIdValue === 'string' ? workspaceIdValue.trim() : ''
    if (!workspaceId) throw new Error('workspaceId must not be empty')
    const namespace = getWorkspaceTransferOperationIdentity(workspaceId, 'pending-cleanup').namespace
    return this.store.readTransaction(transaction => transaction.all<{ value_json: string }>(`
      SELECT value_json
      FROM mortise_records
      WHERE namespace = ?
    `, namespace).map(row => parseWorkspaceTransferJournalV2(JSON.parse(row.value_json)))
      .filter(journal => journal.phase === 'completed' && journal.cleanupPending)
      .map(journal => journal.request))
  }

  prepareTransfer(
    requestValue: unknown,
    manifestValue: { bytes: number; sha256: string },
  ): WorkspaceTransferJournalV2 {
    const request = parseWorkspaceTransferRequestV1(requestValue)
    const bytes = manifestValue?.bytes
    const sha256 = manifestValue?.sha256
    if (!Number.isSafeInteger(bytes) || bytes < 0 || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) {
      throw new Error('Workspace transfer manifest is invalid')
    }
    return this.store.writeTransaction({ requiredCapabilities: [TRANSFER_CAPABILITY] }, transaction => {
      const topology = readWorkspaceInTransaction(transaction, request.workspaceId)
      if (!topology) throw new Error(`Workspace topology not found: ${request.workspaceId}`)
      if (topology.revision !== request.expectedRevision) throw staleTransferRevision(request, topology.revision)
      const identity = getWorkspaceTransferOperationIdentity(request.workspaceId, request.operationId)
      const currentRecord = transaction.getRecord(identity.namespace, identity.key)
      if (currentRecord) {
        const existing = parseTransferJournalRecord(currentRecord.value, request)
        if (existing.bytes !== bytes || existing.sha256 !== sha256) throw new Error(`operationId was already prepared with different content: ${request.operationId}`)
        if (existing.phase !== 'completed' && existing.phase !== 'aborted') {
          const destinationIdentity = getWorkspaceTransferDestinationIdentity(request.workspaceId, request.destination.locationId, request.destination.relativePath)
          const reservationRecord = transaction.getRecord(destinationIdentity.namespace, destinationIdentity.key)
          if (!reservationRecord) throw new Error(`Workspace transfer destination reservation disappeared: ${request.operationId}`)
          const reservation = parseDestinationReservation(reservationRecord.value)
          if (reservation.operationId !== request.operationId || reservation.status !== 'active') throw new Error(`Workspace transfer destination reservation is not owned by ${request.operationId}`)
        }
        return existing
      }
      const destinationIdentity = getWorkspaceTransferDestinationIdentity(request.workspaceId, request.destination.locationId, request.destination.relativePath)
      const reservationRecord = transaction.getRecord(destinationIdentity.namespace, destinationIdentity.key)
      if (reservationRecord) {
        const reservation = parseDestinationReservation(reservationRecord.value)
        if (reservation.status === 'active' && reservation.operationId !== request.operationId) throw new Error(`Workspace transfer destination is already reserved by ${reservation.operationId}`)
      }
      const journal: WorkspaceTransferJournalV2 = {
        schemaVersion: 2, operationId: request.operationId, workspaceId: request.workspaceId, request,
        phase: 'prepared', bytes, sha256,
      }
      const write = transaction.mutateRecord({ capability: TRANSFER_CAPABILITY, namespace: identity.namespace, key: identity.key, value: journal as unknown as JsonValue, expectedVersion: null, operationId: `${request.operationId}:transfer-prepare` })
      if (write.status !== 'applied') throw new Error(`Workspace transfer prepare conflicted: ${request.operationId}`)
      const reservation: WorkspaceTransferDestinationReservationV2 = { schemaVersion: 2, operationId: request.operationId, request, status: 'active' }
      const reservationWrite = transaction.mutateRecord({ capability: TRANSFER_CAPABILITY, namespace: destinationIdentity.namespace, key: destinationIdentity.key, value: reservation as unknown as JsonValue, expectedVersion: reservationRecord?.version ?? null, operationId: `${request.operationId}:transfer-reserve-destination` })
      if (reservationWrite.status !== 'applied') throw new Error(`Workspace transfer destination reservation conflicted: ${request.operationId}`)
      return parseWorkspaceTransferJournalV2(structuredClone(write.value))
    })
  }

  markTransferDestinationPublished(requestValue: unknown, destinationCleanupToken?: string): WorkspaceTransferJournalV2 {
    const request = parseWorkspaceTransferRequestV1(requestValue)
    const current = this.getTransferJournal(request)
    if (!current) throw new Error(`Workspace transfer was not prepared: ${request.operationId}`)
    if (current.phase !== 'prepared') {
      if (destinationCleanupToken && current.destinationCleanupToken !== destinationCleanupToken) {
        throw new Error(`Workspace transfer destination cleanup token conflicted: ${request.operationId}`)
      }
      return current
    }
    return this.advanceTransferJournal(current, {
      ...current,
      phase: 'destination-published',
      ...(destinationCleanupToken ? { destinationCleanupToken } : {}),
    }, 'destination-published')
  }

  markTransferSourceResolved(requestValue: unknown, sourceRemoved: boolean, sourceConflict?: string, sourceCleanupToken?: string): WorkspaceTransferJournalV2 {
    const request = parseWorkspaceTransferRequestV1(requestValue)
    const current = this.getTransferJournal(request)
    if (!current) throw new Error(`Workspace transfer was not prepared: ${request.operationId}`)
    if (current.phase === 'source-resolved' || current.phase === 'completed') {
      if (current.sourceRemoved !== sourceRemoved || sourceConflict || (sourceCleanupToken && current.sourceCleanupToken !== sourceCleanupToken)) throw new Error(`Workspace transfer source outcome conflicted: ${request.operationId}`)
      return current
    }
    if (current.phase === 'source-conflict') {
      if (!sourceConflict || current.sourceConflict !== sourceConflict || (sourceCleanupToken && current.sourceCleanupToken !== sourceCleanupToken)) throw new Error(`Workspace transfer source outcome conflicted: ${request.operationId}`)
      return current
    }
    if (current.phase !== 'destination-published') throw new Error(`Workspace transfer destination is not published: ${request.operationId}`)
    const next = sourceConflict
      ? { ...current, phase: 'source-conflict' as const, sourceConflict, sourceRemoved: false, ...(sourceCleanupToken ? { sourceCleanupToken } : {}) }
      : { ...current, phase: 'source-resolved' as const, sourceRemoved, ...(sourceCleanupToken ? { sourceCleanupToken } : {}) }
    const advanced = this.advanceTransferJournal(current, next, 'source-resolved')
    if (sourceConflict) {
      if (advanced.phase !== 'source-conflict' || advanced.sourceConflict !== sourceConflict) {
        throw new Error(`Workspace transfer source outcome conflicted: ${request.operationId}`)
      }
    } else if (
      (advanced.phase !== 'source-resolved' && advanced.phase !== 'completed')
      || advanced.sourceRemoved !== sourceRemoved
    ) {
      throw new Error(`Workspace transfer source outcome conflicted: ${request.operationId}`)
    }
    return advanced
  }

  abortTransfer(requestValue: unknown): WorkspaceTransferJournalV2 {
    const request = parseWorkspaceTransferRequestV1(requestValue)
    return this.store.writeTransaction({ requiredCapabilities: [TRANSFER_CAPABILITY] }, transaction => {
      const identity = getWorkspaceTransferOperationIdentity(request.workspaceId, request.operationId)
      const journalRecord = transaction.getRecord(identity.namespace, identity.key)
      if (!journalRecord) throw new Error(`Workspace transfer was not prepared: ${request.operationId}`)
      const current = parseTransferJournalRecord(journalRecord.value, request)
      if (current.phase === 'aborted') return current
      if (current.phase !== 'prepared') throw new Error(`Published Workspace transfer cannot be aborted: ${request.operationId}`)
      const destinationIdentity = getWorkspaceTransferDestinationIdentity(request.workspaceId, request.destination.locationId, request.destination.relativePath)
      const reservationRecord = transaction.getRecord(destinationIdentity.namespace, destinationIdentity.key)
      if (!reservationRecord) throw new Error(`Workspace transfer destination reservation disappeared: ${request.operationId}`)
      const reservation = parseDestinationReservation(reservationRecord.value)
      if (reservation.operationId !== request.operationId || reservation.status !== 'active') throw new Error(`Workspace transfer destination reservation is not owned by ${request.operationId}`)
      const next = parseWorkspaceTransferJournalV2({ ...current, phase: 'aborted' })
      const journalWrite = transaction.mutateRecord({ capability: TRANSFER_CAPABILITY, namespace: identity.namespace, key: identity.key, value: next as unknown as JsonValue, expectedVersion: journalRecord.version, operationId: `${request.operationId}:transfer-aborted` })
      if (journalWrite.status !== 'applied') throw new Error(`Workspace transfer abort conflicted: ${request.operationId}`)
      const released = { ...reservation, status: 'released' as const }
      const reservationWrite = transaction.mutateRecord({ capability: TRANSFER_CAPABILITY, namespace: destinationIdentity.namespace, key: destinationIdentity.key, value: released as unknown as JsonValue, expectedVersion: reservationRecord.version, operationId: `${request.operationId}:transfer-release-destination` })
      if (reservationWrite.status !== 'applied') throw new Error(`Workspace transfer destination release conflicted: ${request.operationId}`)
      return next
    })
  }

  recordTransferResult(
    requestValue: unknown,
    resultValue: unknown,
    cleanup: { destinationCleanupToken?: string; sourceCleanupToken?: string } = {},
  ): WorkspaceTransferResultV1 {
    const request = parseWorkspaceTransferRequestV1(requestValue)
    if (!this.get(request.workspaceId)) throw new Error(`Workspace topology not found: ${request.workspaceId}`)
    const result = parseWorkspaceTransferResultV1(resultValue)
    if (result.status !== 'applied') throw new Error('Only an applied Workspace transfer can be recorded')
    assertTransferResultMatchesRequest(request, result)
    return this.store.writeTransaction({ requiredCapabilities: [TRANSFER_CAPABILITY] }, transaction => {
      const identity = getWorkspaceTransferOperationIdentity(request.workspaceId, request.operationId)
      const journalRecord = transaction.getRecord(identity.namespace, identity.key)
      if (!journalRecord) throw new Error(`Workspace transfer must be prepared before completion: ${request.operationId}`)
      const current = parseTransferJournalRecord(journalRecord.value, request)
      if (current.phase === 'completed' && current.result) return { ...current.result, status: 'duplicate' as const }
      if (current.bytes !== result.bytes || current.sha256 !== result.sha256) throw new Error(`Workspace transfer result manifest changed: ${request.operationId}`)
      if (current.phase !== 'source-resolved') throw new Error(`Workspace transfer source outcome is not resolved: ${request.operationId}`)
      if (current.sourceRemoved !== result.sourceRemoved) throw new Error(`Workspace transfer result changed its durable source outcome: ${request.operationId}`)
      if (cleanup.destinationCleanupToken && current.destinationCleanupToken && cleanup.destinationCleanupToken !== current.destinationCleanupToken) throw new Error(`Workspace transfer destination cleanup token conflicted: ${request.operationId}`)
      if (cleanup.sourceCleanupToken && current.sourceCleanupToken && cleanup.sourceCleanupToken !== current.sourceCleanupToken) throw new Error(`Workspace transfer source cleanup token conflicted: ${request.operationId}`)
      const completed = parseWorkspaceTransferJournalV2({
        schemaVersion: 2,
        operationId: current.operationId,
        workspaceId: current.workspaceId,
        request: current.request,
        phase: 'completed',
        bytes: current.bytes,
        sha256: current.sha256,
        sourceRemoved: result.sourceRemoved,
        result: { ...result, status: 'applied' },
        cleanupPending: true,
        ...(current.destinationCleanupToken || cleanup.destinationCleanupToken ? { destinationCleanupToken: current.destinationCleanupToken ?? cleanup.destinationCleanupToken } : {}),
        ...(current.sourceCleanupToken || cleanup.sourceCleanupToken ? { sourceCleanupToken: current.sourceCleanupToken ?? cleanup.sourceCleanupToken } : {}),
      })
      const journalWrite = transaction.mutateRecord({ capability: TRANSFER_CAPABILITY, namespace: identity.namespace, key: identity.key, value: completed as unknown as JsonValue, expectedVersion: journalRecord.version, operationId: `${request.operationId}:transfer-completed` })
      if (journalWrite.status !== 'applied') throw new Error(`Workspace transfer completion conflicted: ${request.operationId}`)
      const destinationIdentity = getWorkspaceTransferDestinationIdentity(request.workspaceId, request.destination.locationId, request.destination.relativePath)
      const reservationRecord = transaction.getRecord(destinationIdentity.namespace, destinationIdentity.key)
      if (!reservationRecord) throw new Error(`Workspace transfer destination reservation disappeared: ${request.operationId}`)
      const reservation = parseDestinationReservation(reservationRecord.value)
      if (reservation.operationId !== request.operationId || reservation.status !== 'active') throw new Error(`Workspace transfer destination reservation is not owned by ${request.operationId}`)
      const reservationWrite = transaction.mutateRecord({ capability: TRANSFER_CAPABILITY, namespace: destinationIdentity.namespace, key: destinationIdentity.key, value: { ...reservation, status: 'released' } as unknown as JsonValue, expectedVersion: reservationRecord.version, operationId: `${request.operationId}:transfer-release-destination` })
      if (reservationWrite.status !== 'applied') throw new Error(`Workspace transfer destination release conflicted: ${request.operationId}`)
      return completed.result!
    })
  }

  markTransferCleanupComplete(requestValue: unknown): WorkspaceTransferJournalV2 {
    const request = parseWorkspaceTransferRequestV1(requestValue)
    return this.store.writeTransaction({ requiredCapabilities: [TRANSFER_CAPABILITY] }, transaction => {
      const identity = getWorkspaceTransferOperationIdentity(request.workspaceId, request.operationId)
      const record = transaction.getRecord(identity.namespace, identity.key)
      if (!record) throw new Error(`Workspace transfer journal disappeared: ${request.operationId}`)
      const current = parseTransferJournalRecord(record.value, request)
      if (current.phase !== 'completed') throw new Error(`Workspace transfer is not completed: ${request.operationId}`)
      if (!current.cleanupPending) return current
      const {
        destinationCleanupToken: _destinationCleanupToken,
        sourceCleanupToken: _sourceCleanupToken,
        ...journalWithoutCleanupTokens
      } = current
      const cleaned = parseWorkspaceTransferJournalV2({
        ...journalWithoutCleanupTokens,
        cleanupPending: false,
      })
      const write = transaction.mutateRecord({
        capability: TRANSFER_CAPABILITY,
        namespace: identity.namespace,
        key: identity.key,
        value: cleaned as unknown as JsonValue,
        expectedVersion: record.version,
        operationId: `${request.operationId}:transfer-cleanup-complete`,
      })
      if (write.status !== 'applied') throw new Error(`Workspace transfer cleanup completion conflicted: ${request.operationId}`)
      return parseWorkspaceTransferJournalV2(structuredClone(write.value))
    })
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

  private advanceTransferJournal(
    current: WorkspaceTransferJournalV2,
    next: WorkspaceTransferJournalV2,
    transition: 'destination-published' | 'source-resolved' | 'completed' | 'aborted',
  ): WorkspaceTransferJournalV2 {
    const identity = getWorkspaceTransferOperationIdentity(current.workspaceId, current.operationId)
    const record = this.store.getRecord(identity.namespace, identity.key)
    if (!record) throw new Error(`Workspace transfer journal disappeared: ${current.operationId}`)
    const stored = parseTransferJournalRecord(record.value, current.request)
    if (stored.phase !== current.phase) return stored
    const write = this.store.mutateRecord({
      capability: TRANSFER_CAPABILITY,
      namespace: identity.namespace,
      key: identity.key,
      value: next as unknown as JsonValue,
      expectedVersion: record.version,
      operationId: `${current.operationId}:transfer-${transition}`,
    })
    if (write.status === 'applied') return parseWorkspaceTransferJournalV2(structuredClone(write.value))
    const replay = this.getTransferJournal(current.request)
    if (!replay) throw new Error(`Workspace transfer transition conflicted: ${current.operationId}`)
    return replay
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

function emptyRegistry(): WorkspaceTopologyRegistry {
  return { schemaVersion: 1, workspaceIds: [] }
}

function assertTransferLifecycleAllowsTopologyMutation(
  transaction: MultiWriterReadTransaction,
  command: WorkspaceTopologyCommandV1,
): void {
  if (command.operation !== 'detach' && command.operation !== 'replace-endpoint') return
  const namespace = getWorkspaceTransferOperationIdentity(command.workspaceId, command.operationId).namespace
  const rows = transaction.all<{ value_json: string }>(`
    SELECT value_json
    FROM mortise_records
    WHERE namespace = ?
  `, namespace)
  for (const row of rows) {
    const journal = parseWorkspaceTransferJournalV2(JSON.parse(row.value_json))
    if (
      (journal.phase === 'prepared'
        || journal.phase === 'destination-published'
        || journal.phase === 'source-resolved'
        || journal.phase === 'source-conflict'
        || (journal.phase === 'completed' && journal.cleanupPending))
      && (journal.request.source.locationId === command.locationId
        || journal.request.destination.locationId === command.locationId)
    ) {
      throw new WorkspaceTopologyError(
        WORKSPACE_TOPOLOGY_ERROR_CODES.LOCATION_IN_USE,
        `Workspace location ${command.locationId} is used by active transfer ${journal.operationId}`,
        { workspaceId: command.workspaceId, locationId: command.locationId, retryable: true },
      )
    }
  }
}

function parseTransferJournalRecord(value: JsonValue, request: WorkspaceTransferRequestV1): WorkspaceTransferJournalV2 {
  const journal = parseWorkspaceTransferJournalV2(structuredClone(value))
  if (!isDeepStrictEqual(journal.request, request)) {
    throw new Error(`operationId was already used for a different Workspace transfer: ${request.operationId}`)
  }
  return journal
}

function parseDestinationReservation(value: JsonValue): WorkspaceTransferDestinationReservationV2 {
  const reservation = value as Partial<WorkspaceTransferDestinationReservationV2>
  if (reservation.schemaVersion !== 2 || typeof reservation.operationId !== 'string' || (reservation.status !== 'active' && reservation.status !== 'released')) throw new Error('Workspace transfer destination reservation is invalid')
  const request = parseWorkspaceTransferRequestV1(reservation.request)
  return { schemaVersion: 2, operationId: reservation.operationId, request, status: reservation.status }
}

function staleTransferRevision(request: WorkspaceTransferRequestV1, actualRevision: number): WorkspaceTopologyError {
  return new WorkspaceTopologyError(
    WORKSPACE_TOPOLOGY_ERROR_CODES.STALE_REVISION,
    `Workspace revision is ${actualRevision}, expected ${request.expectedRevision}`,
    { workspaceId: request.workspaceId, expectedRevision: request.expectedRevision, actualRevision, retryable: true },
  )
}

function parseRegistry(value: JsonValue): WorkspaceTopologyRegistry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Workspace topology registry is invalid')
  }
  const candidate = value as Record<string, JsonValue>
  if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.workspaceIds)) {
    throw new Error('Workspace topology registry is invalid')
  }
  const workspaceIds = candidate.workspaceIds.map((workspaceId) => {
    if (typeof workspaceId !== 'string' || !workspaceId.trim()) {
      throw new Error('Workspace topology registry contains an invalid identity')
    }
    return workspaceId
  })
  if (new Set(workspaceIds).size !== workspaceIds.length) {
    throw new Error('Workspace topology registry contains duplicate identities')
  }
  return { schemaVersion: 1, workspaceIds }
}

function readRegistry(transaction: MultiWriterReadTransaction): WorkspaceTopologyRegistry {
  const identity = getWorkspaceTopologyRegistryIdentity()
  const record = transaction.getRecord(identity.namespace, identity.key)
  return record ? parseRegistry(record.value) : emptyRegistry()
}

function readWorkspaceInTransaction(
  transaction: MultiWriterReadTransaction,
  workspaceId: string,
): Workspace | null {
  const identity = getWorkspaceTopologyRecordIdentity(workspaceId)
  const record = transaction.getRecord(identity.namespace, identity.key)
  return record ? parseWorkspaceV2(structuredClone(record.value)) : null
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
