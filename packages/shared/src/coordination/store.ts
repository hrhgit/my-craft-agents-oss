import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MultiWriterStore, type JsonValue } from '../storage/index.ts'
import { CoordinationBlobStore } from './blob-store.ts'
import { createWorkspaceIdentity, normalizeCoordinationResource } from './identity.ts'
import {
  COORDINATION_SCHEMA_VERSION,
  type AcquireClaimInput,
  type AcquireClaimResult,
  type BeginActivityInput,
  type CoordinationActivity,
  type CoordinationActor,
  type CoordinationChangeEvent,
  type CoordinationClaim,
  type CoordinationConflict,
  type CoordinationSnapshot,
  type HeartbeatActivityInput,
  type RecordChangeInput,
  type ReleaseActivityInput,
  type ReleaseClaimInput,
  type WorkspaceCoordinationStoreOptions,
  type WorkspaceIdentity,
} from './types.ts'

const PROJECTION_NAMESPACE = 'workspace-coordination-v1'
const PROJECTION_KEY = 'projection'
const MAX_CAS_ATTEMPTS = 64
const MAX_LEASE_MS = 24 * 60 * 60 * 1000
const DEFAULT_RECENT_CHANGE_LIMIT = 100
const BROAD_FILE_RESOURCE_NAMES = new Set(['workspace/fs', 'workspace/source-snapshot'])

interface CoordinationProjection {
  schemaVersion: typeof COORDINATION_SCHEMA_VERSION
  workspace: WorkspaceIdentity
  revision: number
  activities: Record<string, CoordinationActivity>
  claims: Record<string, CoordinationClaim>
}

function assertIdentifier(value: string, label: string): void {
  if (!value.trim()) throw new TypeError(`${label} must not be empty`)
}

function normalizeLeaseDuration(value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError('leaseDurationMs must be positive')
  return Math.min(Math.floor(value), MAX_LEASE_MS)
}

function cleanActor(actor: CoordinationActor): CoordinationActor {
  assertIdentifier(actor.id, 'actor.id')
  const optional = Object.fromEntries(Object.entries(actor).filter(([, value]) => value !== undefined))
  return optional as unknown as CoordinationActor
}

function cloneProjection(projection: CoordinationProjection): CoordinationProjection {
  return JSON.parse(JSON.stringify(projection)) as CoordinationProjection
}

function conflictFromClaim(claim: CoordinationClaim): CoordinationConflict {
  return {
    claimId: claim.claimId,
    activityId: claim.activityId,
    resource: claim.resource,
    access: claim.access,
    enforcement: claim.enforcement,
    leaseExpiresAt: claim.leaseExpiresAt,
  }
}

export function coordinationResourcesOverlap(
  left: CoordinationClaim['resource'],
  right: CoordinationClaim['resource'],
): boolean {
  return left.resourceKey === right.resourceKey
    || (left.kind === 'logical'
      && BROAD_FILE_RESOURCE_NAMES.has(left.name)
      && (right.kind === 'file'
        || (right.kind === 'logical' && BROAD_FILE_RESOURCE_NAMES.has(right.name))))
    || (right.kind === 'logical'
      && BROAD_FILE_RESOURCE_NAMES.has(right.name)
      && left.kind === 'file')
}

function claimsConflict(left: CoordinationClaim, right: Pick<CoordinationClaim, 'activityId' | 'resource' | 'access'>): boolean {
  return left.activityId !== right.activityId
    && coordinationResourcesOverlap(left.resource, right.resource)
    && (left.access === 'write' || right.access === 'write')
}

export class WorkspaceCoordinationStore {
  readonly workspace: WorkspaceIdentity
  readonly storageRoot: string
  readonly databasePath: string
  private readonly store: MultiWriterStore
  private readonly blobs: CoordinationBlobStore

  private constructor(options: WorkspaceCoordinationStoreOptions) {
    assertIdentifier(options.writerId, 'writerId')
    this.workspace = createWorkspaceIdentity(options.workspaceRoot, options.workspaceId)
    const configDir = options.configDir ?? process.env.MORTISE_CONFIG_DIR ?? join(homedir(), '.mortise')
    this.storageRoot = join(configDir, 'provenance', 'v1', this.workspace.workspaceKey)
    this.databasePath = join(this.storageRoot, 'ledger.sqlite')
    this.store = MultiWriterStore.openSync({
      databasePath: this.databasePath,
      writerId: options.writerId,
      writerVersion: options.writerVersion ?? 1,
      busyTimeoutMs: options.busyTimeoutMs,
    })
    this.blobs = new CoordinationBlobStore(join(this.storageRoot, 'objects'))
    this.ensureProjection()
  }

  static open(options: WorkspaceCoordinationStoreOptions): WorkspaceCoordinationStore {
    return new WorkspaceCoordinationStore(options)
  }

  close(): void {
    this.store.close()
  }

  beginActivity(input: BeginActivityInput): CoordinationActivity {
    assertIdentifier(input.operationId, 'operationId')
    assertIdentifier(input.activityId, 'activityId')
    const now = input.now ?? Date.now()
    const leaseDuration = normalizeLeaseDuration(input.leaseDurationMs)
    return this.mutateProjection(input.operationId, projection => {
      const existing = projection.activities[input.activityId]
      if (existing) {
        if (existing.actor.id !== input.actor.id || existing.actor.kind !== input.actor.kind) {
          throw new Error(`Activity identity conflict: ${input.activityId}`)
        }
        return { changed: false, result: existing }
      }
      const activity: CoordinationActivity = {
        schemaVersion: COORDINATION_SCHEMA_VERSION,
        activityId: input.activityId,
        workspaceKey: this.workspace.workspaceKey,
        actor: cleanActor(input.actor),
        ...(input.intent?.trim() ? { intent: input.intent.trim() } : {}),
        status: 'running',
        startedAt: now,
        updatedAt: now,
        leaseExpiresAt: now + leaseDuration,
      }
      projection.activities[activity.activityId] = activity
      return { changed: true, result: activity }
    }, now)
  }

  heartbeatActivity(input: HeartbeatActivityInput): CoordinationActivity {
    assertIdentifier(input.operationId, 'operationId')
    const now = input.now ?? Date.now()
    const leaseDuration = normalizeLeaseDuration(input.leaseDurationMs)
    return this.mutateProjection(input.operationId, projection => {
      const activity = projection.activities[input.activityId]
      if (!activity || activity.status !== 'running' || activity.leaseExpiresAt <= now) {
        throw new Error(`Activity is not active: ${input.activityId}`)
      }
      activity.updatedAt = now
      activity.leaseExpiresAt = now + leaseDuration
      for (const claim of Object.values(projection.claims)) {
        if (claim.activityId !== input.activityId) continue
        claim.updatedAt = now
        claim.leaseExpiresAt = now + leaseDuration
      }
      return { changed: true, result: activity }
    }, now)
  }

  acquireClaim(input: AcquireClaimInput): AcquireClaimResult {
    assertIdentifier(input.operationId, 'operationId')
    assertIdentifier(input.claimId, 'claimId')
    const now = input.now ?? Date.now()
    const leaseDuration = normalizeLeaseDuration(input.leaseDurationMs)
    const resource = normalizeCoordinationResource(this.workspace, input.resource)
    return this.mutateProjection(input.operationId, projection => {
      const activity = projection.activities[input.activityId]
      if (!activity || activity.status !== 'running' || activity.leaseExpiresAt <= now) {
        throw new Error(`Activity is not active: ${input.activityId}`)
      }
      const existing = projection.claims[input.claimId]
      if (existing) {
        if (existing.activityId !== input.activityId || existing.resource.resourceKey !== resource.resourceKey) {
          throw new Error(`Claim identity conflict: ${input.claimId}`)
        }
        return { changed: false, result: { status: 'acquired', claim: existing, conflicts: [], replayed: true } as AcquireClaimResult }
      }
      const claim: CoordinationClaim = {
        schemaVersion: COORDINATION_SCHEMA_VERSION,
        claimId: input.claimId,
        activityId: input.activityId,
        resource,
        access: input.access ?? 'write',
        enforcement: input.enforcement ?? 'blocking',
        acquiredAt: now,
        updatedAt: now,
        leaseExpiresAt: now + leaseDuration,
        ...(input.baseContentOid ? { baseContentOid: input.baseContentOid } : {}),
      }
      const conflicts = Object.values(projection.claims)
        .filter(candidate => claimsConflict(candidate, claim))
        .map(conflictFromClaim)
      const isBlocked = claim.enforcement === 'blocking'
        && conflicts.some(conflict => conflict.enforcement === 'blocking')
      if (isBlocked) {
        return { changed: false, result: { status: 'conflict', conflicts, replayed: false } as AcquireClaimResult }
      }
      projection.claims[claim.claimId] = claim
      return { changed: true, result: { status: 'acquired', claim, conflicts, replayed: false } as AcquireClaimResult }
    }, now)
  }

  releaseClaim(input: ReleaseClaimInput): boolean {
    assertIdentifier(input.operationId, 'operationId')
    const now = input.now ?? Date.now()
    return this.mutateProjection(input.operationId, projection => {
      const claim = projection.claims[input.claimId]
      if (!claim) return { changed: false, result: false }
      if (claim.activityId !== input.activityId) throw new Error(`Claim is owned by another activity: ${input.claimId}`)
      delete projection.claims[input.claimId]
      return { changed: true, result: true }
    }, now)
  }

  releaseActivity(input: ReleaseActivityInput): boolean {
    assertIdentifier(input.operationId, 'operationId')
    const now = input.now ?? Date.now()
    return this.mutateProjection(input.operationId, projection => {
      const activity = projection.activities[input.activityId]
      if (!activity) return { changed: false, result: false }
      for (const [claimId, claim] of Object.entries(projection.claims)) {
        if (claim.activityId === input.activityId) delete projection.claims[claimId]
      }
      delete projection.activities[input.activityId]
      return { changed: true, result: true }
    }, now)
  }

  recordChange(input: RecordChangeInput): CoordinationChangeEvent {
    assertIdentifier(input.operationId, 'operationId')
    assertIdentifier(input.changeId, 'changeId')
    const resource = normalizeCoordinationResource(this.workspace, input.resource)
    const before = input.beforeContent === null ? null : this.blobs.put(input.beforeContent)
    const after = input.afterContent === null ? null : this.blobs.put(input.afterContent)
    const payload = {
      schemaVersion: COORDINATION_SCHEMA_VERSION,
      changeId: input.changeId,
      workspaceKey: this.workspace.workspaceKey,
      ...(input.activityId ? { activityId: input.activityId } : {}),
      actor: cleanActor(input.actor),
      resource,
      before,
      after,
      ...(input.summary?.trim() ? { summary: input.summary.trim() } : {}),
    }
    const result = this.store.appendEvent({
      streamId: `workspace-changes:${this.workspace.workspaceKey}`,
      eventId: input.changeId,
      eventType: 'workspace.change',
      schemaVersion: COORDINATION_SCHEMA_VERSION,
      payload: payload as unknown as JsonValue,
      operationId: input.operationId,
    })
    if (result.status === 'conflict') throw new Error(`Change event conflict: ${input.changeId}`)
    const stored = this.store.listEvents<typeof payload & JsonValue>(`workspace-changes:${this.workspace.workspaceKey}`)
      .find(event => event.eventId === input.changeId)
    if (!stored) throw new Error(`Change event was not persisted: ${input.changeId}`)
    return { ...payload, occurredAt: stored.occurredAt }
  }

  snapshot(options: { now?: number; recentChangeLimit?: number } = {}): CoordinationSnapshot {
    const now = options.now ?? Date.now()
    const projection = this.pruneProjection(now)
    return {
      schemaVersion: COORDINATION_SCHEMA_VERSION,
      workspace: projection.workspace,
      revision: projection.revision,
      activities: Object.values(projection.activities).sort((left, right) => right.updatedAt - left.updatedAt),
      claims: Object.values(projection.claims).sort((left, right) => left.resource.resourceKey.localeCompare(right.resource.resourceKey)),
      recentChanges: this.listRecentChanges(options.recentChangeLimit ?? DEFAULT_RECENT_CHANGE_LIMIT),
    }
  }

  listRecentChanges(limit = DEFAULT_RECENT_CHANGE_LIMIT): CoordinationChangeEvent[] {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new TypeError('limit must be a non-negative safe integer')
    if (limit === 0) return []
    const events = this.store.listEvents(`workspace-changes:${this.workspace.workspaceKey}`)
    return events.slice(-limit).reverse().map(event => {
      const payload = event.payload as unknown as Omit<CoordinationChangeEvent, 'occurredAt'>
      return { ...payload, occurredAt: event.occurredAt }
    })
  }

  readBlob(oid: string): Uint8Array {
    return this.blobs.get(oid)
  }

  hasBlob(oid: string): boolean {
    return this.blobs.has(oid)
  }

  private ensureProjection(): void {
    const existing = this.store.getRecord(PROJECTION_NAMESPACE, PROJECTION_KEY)
    if (existing) return
    const projection: CoordinationProjection = {
      schemaVersion: COORDINATION_SCHEMA_VERSION,
      workspace: this.workspace,
      revision: 0,
      activities: {},
      claims: {},
    }
    this.store.mutateRecord({
      namespace: PROJECTION_NAMESPACE,
      key: PROJECTION_KEY,
      value: projection as unknown as JsonValue,
      expectedVersion: null,
      operationId: `initialize:${this.workspace.workspaceKey}`,
    })
  }

  private readProjection(): { version: number; value: CoordinationProjection } {
    const record = this.store.getRecord(PROJECTION_NAMESPACE, PROJECTION_KEY)
    if (!record) throw new Error('Coordination projection is missing')
    const value = record.value as unknown as CoordinationProjection
    if (value.schemaVersion !== COORDINATION_SCHEMA_VERSION || value.workspace.workspaceKey !== this.workspace.workspaceKey) {
      throw new Error('Coordination projection is incompatible with this workspace')
    }
    return { version: record.version, value }
  }

  private pruneProjection(now: number): CoordinationProjection {
    return this.mutateProjection(`prune:${randomUUID()}`, projection => {
      let changed = false
      for (const [activityId, activity] of Object.entries(projection.activities)) {
        if (activity.leaseExpiresAt <= now) {
          delete projection.activities[activityId]
          changed = true
        }
      }
      for (const [claimId, claim] of Object.entries(projection.claims)) {
        if (claim.leaseExpiresAt <= now || !projection.activities[claim.activityId]) {
          delete projection.claims[claimId]
          changed = true
        }
      }
      return { changed, result: projection }
    }, now)
  }

  private mutateProjection<T>(
    operationId: string,
    transform: (projection: CoordinationProjection) => { changed: boolean; result: T },
    now: number,
  ): T {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = this.readProjection()
      const next = cloneProjection(current.value)
      for (const [activityId, activity] of Object.entries(next.activities)) {
        if (activity.leaseExpiresAt <= now) delete next.activities[activityId]
      }
      for (const [claimId, claim] of Object.entries(next.claims)) {
        if (claim.leaseExpiresAt <= now || !next.activities[claim.activityId]) delete next.claims[claimId]
      }
      const transformed = transform(next)
      const pruned = JSON.stringify(next) !== JSON.stringify(current.value)
      if (!transformed.changed && !pruned) return transformed.result
      next.revision = current.value.revision + 1
      const result = this.store.mutateRecord({
        namespace: PROJECTION_NAMESPACE,
        key: PROJECTION_KEY,
        value: next as unknown as JsonValue,
        expectedVersion: current.version,
        operationId: `${operationId}:cas:${current.version}`,
      })
      if (result.status === 'applied') return transformed.result
    }
    throw new Error(`Coordination CAS retry limit exceeded for operation ${operationId}`)
  }
}
