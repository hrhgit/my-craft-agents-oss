import { createHash, randomUUID } from 'node:crypto'
import { RPC_CHANNELS, type WorkspaceCoordinationStatusV1 } from '@mortise/shared/protocol'
import {
  WorkspaceCoordinationStore,
  coordinationResourcesOverlap,
  type CoordinationActivity,
  type CoordinationChangeEvent,
  type CoordinationClaim,
} from '@mortise/shared/coordination'
import type { RpcServer } from '@mortise/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { getWorkspaceOrThrow, resolveWorkspaceId } from '../utils'

const STATUS_WRITER_ID = `coordination-status-${process.pid}-${randomUUID()}`

function resourceLabel(claim: CoordinationClaim): string {
  return claim.resource.kind === 'file' ? claim.resource.relativePath : claim.resource.name
}

function changeResourceLabel(change: CoordinationChangeEvent): string {
  return change.resource.kind === 'file' ? change.resource.relativePath : change.resource.name
}

function actorLabel(
  actor: CoordinationActivity['actor'],
  sessionNames: ReadonlyMap<string, string>,
): string {
  if (actor.sessionId) return sessionNames.get(actor.sessionId) ?? actor.sessionId
  return actor.id
}

function conflictId(resource: string, activityIds: string[]): string {
  return createHash('sha256')
    .update(`${resource}\0${activityIds.join('\0')}`)
    .digest('hex')
    .slice(0, 24)
}

export function buildWorkspaceCoordinationStatus(
  workspaceId: string,
  snapshot: ReturnType<WorkspaceCoordinationStore['snapshot']>,
  sessionNames: ReadonlyMap<string, string>,
  now = Date.now(),
): WorkspaceCoordinationStatusV1 {
  const running = snapshot.activities.filter(activity => (
    activity.status === 'running' && activity.leaseExpiresAt > now
  ))
  const runningIds = new Set(running.map(activity => activity.activityId))
  const claims = snapshot.claims.filter(claim => (
    runningIds.has(claim.activityId) && claim.leaseExpiresAt > now
  ))
  const claimsByActivity = new Map<string, CoordinationClaim[]>()
  for (const claim of claims) {
    const activityClaims = claimsByActivity.get(claim.activityId) ?? []
    activityClaims.push(claim)
    claimsByActivity.set(claim.activityId, activityClaims)
  }

  const conflictGroups = new Map<string, CoordinationClaim[]>()
  for (let leftIndex = 0; leftIndex < claims.length; leftIndex += 1) {
    const left = claims[leftIndex]!
    for (let rightIndex = leftIndex + 1; rightIndex < claims.length; rightIndex += 1) {
      const right = claims[rightIndex]!
      if (left.activityId === right.activityId) continue
      if (left.access !== 'write' && right.access !== 'write') continue
      if (!coordinationResourcesOverlap(left.resource, right.resource)) continue
      const resource = left.resource.kind === 'logical' ? resourceLabel(left) : resourceLabel(right)
      const group = conflictGroups.get(resource) ?? []
      group.push(left, right)
      conflictGroups.set(resource, group)
    }
  }
  const conflicts = [...conflictGroups.entries()].map(([resource, group]) => {
    const uniqueClaims = [...new Map(group.map(claim => [claim.claimId, claim])).values()]
    const activityIds = [...new Set(uniqueClaims.map(claim => claim.activityId))].sort()
    return {
      conflictId: conflictId(resource, activityIds),
      resource,
      activityIds,
      severity: uniqueClaims.every(claim => claim.enforcement === 'blocking')
        ? 'blocking' as const
        : 'advisory' as const,
      detectedAt: Math.max(...uniqueClaims.map(claim => claim.acquiredAt)),
    }
  })

  return {
    schemaVersion: 1,
    workspaceId,
    revision: snapshot.revision,
    generatedAt: now,
    policy: 'protect',
    activities: running.map(activity => ({
      activityId: activity.activityId,
      actorKind: activity.actor.kind,
      actorLabel: actorLabel(activity.actor, sessionNames),
      ...(activity.actor.sessionId ? { sessionId: activity.actor.sessionId } : {}),
      ...(activity.intent ? { intent: activity.intent } : {}),
      startedAt: activity.startedAt,
      lastSeenAt: activity.updatedAt,
      leaseExpiresAt: activity.leaseExpiresAt,
      claims: (claimsByActivity.get(activity.activityId) ?? []).map(claim => ({
        claimId: claim.claimId,
        resource: resourceLabel(claim),
        resourceKind: claim.resource.kind,
        access: claim.access,
        enforcement: claim.enforcement,
        leaseExpiresAt: claim.leaseExpiresAt,
      })),
    })),
    conflicts,
    recentChanges: snapshot.recentChanges.map(change => ({
      changeId: change.changeId,
      ...(change.activityId ? { activityId: change.activityId } : {}),
      actorKind: change.actor.kind,
      actorLabel: actorLabel(change.actor, sessionNames),
      ...(change.actor.sessionId ? { sessionId: change.actor.sessionId } : {}),
      resource: changeResourceLabel(change),
      occurredAt: change.occurredAt,
      ...(change.summary ? { summary: change.summary } : {}),
    })),
  }
}

export function registerWorkspaceCoordinationHandlers(server: RpcServer, deps: HandlerDeps): void {
  server.handle(RPC_CHANNELS.workspaceCoordination.GET_STATUS, async ctx => {
    const workspaceId = resolveWorkspaceId(ctx.workspaceId, undefined)
    if (!workspaceId) throw new Error('Workspace coordination requires an authenticated workspace')
    const workspace = getWorkspaceOrThrow(workspaceId)
    const store = WorkspaceCoordinationStore.open({
      workspaceRoot: workspace.rootPath,
      workspaceId,
      writerId: STATUS_WRITER_ID,
    })
    try {
      const sessionNames = new Map(
        deps.sessionManager.getSessions(workspaceId).map(session => [session.id, session.name?.trim() || session.id]),
      )
      return buildWorkspaceCoordinationStatus(
        workspaceId,
        store.snapshot({ recentChangeLimit: 12 }),
        sessionNames,
      )
    } finally {
      store.close()
    }
  })
}
