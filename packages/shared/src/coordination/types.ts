export const COORDINATION_SCHEMA_VERSION = 1 as const

export type CoordinationEnforcement = 'advisory' | 'blocking'
export type CoordinationAccess = 'read' | 'write'
export type CoordinationActivityStatus = 'running' | 'completed' | 'interrupted'
export type CoordinationActorKind = 'agent' | 'human' | 'automation' | 'process' | 'unknown'

export interface WorkspaceIdentity {
  schemaVersion: typeof COORDINATION_SCHEMA_VERSION
  workspaceKey: string
  canonicalRoot: string
  workspaceId?: string
}

export interface CoordinationActor {
  kind: CoordinationActorKind
  id: string
  sessionId?: string
  threadId?: string
  turnId?: string
  toolUseId?: string
  clientId?: string
  backendInstanceId?: string
  productVersion?: string
  buildIdentity?: string
  assistantResponseId?: string
  assistantTimestamp?: number
}

export interface CoordinationActivity {
  schemaVersion: typeof COORDINATION_SCHEMA_VERSION
  activityId: string
  workspaceKey: string
  actor: CoordinationActor
  intent?: string
  status: CoordinationActivityStatus
  startedAt: number
  updatedAt: number
  leaseExpiresAt: number
}

export type CoordinationResource =
  | { kind: 'file'; relativePath: string; resourceKey: string }
  | { kind: 'logical'; name: string; resourceKey: string }

export interface CoordinationClaim {
  schemaVersion: typeof COORDINATION_SCHEMA_VERSION
  claimId: string
  activityId: string
  resource: CoordinationResource
  access: CoordinationAccess
  enforcement: CoordinationEnforcement
  acquiredAt: number
  updatedAt: number
  leaseExpiresAt: number
  baseContentOid?: string
}

export interface CoordinationConflict {
  claimId: string
  activityId: string
  resource: CoordinationResource
  access: CoordinationAccess
  enforcement: CoordinationEnforcement
  leaseExpiresAt: number
}

export interface CoordinationBlobRef {
  algorithm: 'sha256'
  oid: string
  size: number
}

export interface CoordinationChangeEvent {
  schemaVersion: typeof COORDINATION_SCHEMA_VERSION
  changeId: string
  workspaceKey: string
  activityId?: string
  actor: CoordinationActor
  resource: CoordinationResource
  before: CoordinationBlobRef | null
  after: CoordinationBlobRef | null
  occurredAt: number
  summary?: string
}

export interface CoordinationSnapshot {
  schemaVersion: typeof COORDINATION_SCHEMA_VERSION
  workspace: WorkspaceIdentity
  revision: number
  activities: CoordinationActivity[]
  claims: CoordinationClaim[]
  recentChanges: CoordinationChangeEvent[]
}

export interface WorkspaceCoordinationStoreOptions {
  workspaceRoot: string
  workspaceId?: string
  writerId: string
  writerVersion?: number
  configDir?: string
  busyTimeoutMs?: number
}

export interface BeginActivityInput {
  operationId: string
  activityId: string
  actor: CoordinationActor
  intent?: string
  leaseDurationMs: number
  now?: number
}

export interface HeartbeatActivityInput {
  operationId: string
  activityId: string
  leaseDurationMs: number
  now?: number
}

export interface AcquireClaimInput {
  operationId: string
  claimId: string
  activityId: string
  resource: { kind: 'file'; path: string } | { kind: 'logical'; name: string }
  access?: CoordinationAccess
  enforcement?: CoordinationEnforcement
  leaseDurationMs: number
  baseContentOid?: string
  now?: number
}

export type AcquireClaimResult =
  | { status: 'acquired'; claim: CoordinationClaim; conflicts: CoordinationConflict[]; replayed: boolean }
  | { status: 'conflict'; conflicts: CoordinationConflict[]; replayed: boolean }

export interface ReleaseClaimInput {
  operationId: string
  claimId: string
  activityId: string
  now?: number
}

export interface ReleaseActivityInput {
  operationId: string
  activityId: string
  now?: number
}

export interface RecordChangeInput {
  operationId: string
  changeId: string
  activityId?: string
  actor: CoordinationActor
  resource: { kind: 'file'; path: string } | { kind: 'logical'; name: string }
  beforeContent: string | Uint8Array | null
  afterContent: string | Uint8Array | null
  summary?: string
}
