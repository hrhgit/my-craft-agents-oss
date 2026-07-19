export interface WorkspaceCoordinationClaimSummaryV1 {
  claimId: string
  resource: string
  resourceKind: 'file' | 'logical'
  access: 'read' | 'write'
  enforcement: 'advisory' | 'blocking'
  leaseExpiresAt: number
}

export interface WorkspaceCoordinationActivitySummaryV1 {
  activityId: string
  actorKind: 'agent' | 'human' | 'automation' | 'process' | 'unknown'
  actorLabel: string
  sessionId?: string
  intent?: string
  startedAt: number
  lastSeenAt: number
  leaseExpiresAt: number
  claims: WorkspaceCoordinationClaimSummaryV1[]
}

export interface WorkspaceCoordinationConflictSummaryV1 {
  conflictId: string
  resource: string
  activityIds: string[]
  severity: 'advisory' | 'blocking'
  detectedAt: number
}

export interface WorkspaceCoordinationChangeSummaryV1 {
  changeId: string
  activityId?: string
  actorKind: WorkspaceCoordinationActivitySummaryV1['actorKind']
  actorLabel: string
  sessionId?: string
  resource: string
  occurredAt: number
  summary?: string
}

export interface WorkspaceCoordinationStatusV1 {
  schemaVersion: 1
  workspaceId: string
  revision: number
  generatedAt: number
  policy: 'protect'
  activities: WorkspaceCoordinationActivitySummaryV1[]
  conflicts: WorkspaceCoordinationConflictSummaryV1[]
  recentChanges: WorkspaceCoordinationChangeSummaryV1[]
}
