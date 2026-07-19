import { describe, expect, it } from 'bun:test'
import type { WorkspaceCoordinationStatusV1 } from '@mortise/shared/protocol'
import {
  shouldShowWorkspaceCoordinationStatus,
  workspaceCoordinationSemanticPart,
  workspaceCoordinationStatusCounts,
} from './workspace-coordination-status-model'

const emptyStatus: WorkspaceCoordinationStatusV1 = {
  schemaVersion: 1,
  workspaceId: 'ws',
  revision: 1,
  generatedAt: 1,
  policy: 'protect',
  activities: [],
  conflicts: [],
  recentChanges: [],
}

describe('workspace coordination status model', () => {
  it('hides an idle empty status and exposes loading or failure states', () => {
    expect(shouldShowWorkspaceCoordinationStatus(emptyStatus, false, null)).toBe(false)
    expect(shouldShowWorkspaceCoordinationStatus(emptyStatus, true, null)).toBe(true)
    expect(shouldShowWorkspaceCoordinationStatus(emptyStatus, false, 'offline')).toBe(true)
  })

  it('counts activity, recent changes, and blocking conflicts', () => {
    const status: WorkspaceCoordinationStatusV1 = {
      ...emptyStatus,
      activities: [{
        activityId: 'a', actorKind: 'agent', actorLabel: 'Agent', startedAt: 1,
        lastSeenAt: 2, leaseExpiresAt: 3, claims: [],
      }],
      conflicts: [{
        conflictId: 'c', resource: 'src/app.ts', activityIds: ['a', 'b'],
        severity: 'blocking', detectedAt: 2,
      }],
      recentChanges: [{
        changeId: 'change', actorKind: 'agent', actorLabel: 'Agent',
        resource: 'src/app.ts', occurredAt: 2,
      }],
    }
    expect(workspaceCoordinationStatusCounts(status)).toEqual({
      activities: 1,
      conflicts: 1,
      recentChanges: 1,
      blockingConflicts: 1,
    })
    expect(shouldShowWorkspaceCoordinationStatus(status, false, null)).toBe(true)
  })

  it('keeps semantic ids readable and collision-resistant', () => {
    expect(workspaceCoordinationSemanticPart('session/a')).toMatch(/^session_a\.[a-f0-9]{8}$/)
    expect(workspaceCoordinationSemanticPart('session/a')).not.toBe(workspaceCoordinationSemanticPart('session:a'))
  })
})
