import { describe, expect, it } from 'bun:test'
import type { CoordinationSnapshot } from '@mortise/shared/coordination'
import { buildWorkspaceCoordinationStatus } from './workspace-coordination'

const snapshot: CoordinationSnapshot = {
  schemaVersion: 1,
  workspace: { schemaVersion: 1, workspaceKey: 'workspace-key', canonicalRoot: '/workspace', workspaceId: 'ws-1' },
  revision: 4,
  activities: [
    {
      schemaVersion: 1,
      activityId: 'activity-a',
      workspaceKey: 'workspace-key',
      actor: { kind: 'agent', id: 'agent-a', sessionId: 'session-a' },
      intent: 'Update the parser',
      status: 'running',
      startedAt: 100,
      updatedAt: 150,
      leaseExpiresAt: 1_000,
    },
    {
      schemaVersion: 1,
      activityId: 'activity-shell',
      workspaceKey: 'workspace-key',
      actor: { kind: 'agent', id: 'agent-shell', sessionId: 'session-shell' },
      intent: 'Run formatter',
      status: 'running',
      startedAt: 115,
      updatedAt: 165,
      leaseExpiresAt: 1_000,
    },
    {
      schemaVersion: 1,
      activityId: 'activity-b',
      workspaceKey: 'workspace-key',
      actor: { kind: 'agent', id: 'agent-b', sessionId: 'session-b' },
      status: 'running',
      startedAt: 110,
      updatedAt: 160,
      leaseExpiresAt: 1_000,
    },
  ],
  claims: [
    {
      schemaVersion: 1,
      claimId: 'claim-a',
      activityId: 'activity-a',
      resource: { kind: 'file', relativePath: 'src/parser.ts', resourceKey: 'file:src/parser.ts' },
      access: 'write',
      enforcement: 'advisory',
      acquiredAt: 120,
      updatedAt: 150,
      leaseExpiresAt: 1_000,
    },
    {
      schemaVersion: 1,
      claimId: 'claim-b',
      activityId: 'activity-b',
      resource: { kind: 'file', relativePath: 'src/parser.ts', resourceKey: 'file:src/parser.ts' },
      access: 'write',
      enforcement: 'advisory',
      acquiredAt: 130,
      updatedAt: 160,
      leaseExpiresAt: 1_000,
    },
    {
      schemaVersion: 1,
      claimId: 'claim-shell',
      activityId: 'activity-shell',
      resource: { kind: 'logical', name: 'workspace/fs', resourceKey: 'logical:workspace/fs' },
      access: 'write',
      enforcement: 'advisory',
      acquiredAt: 140,
      updatedAt: 165,
      leaseExpiresAt: 1_000,
    },
  ],
  recentChanges: [],
}

describe('buildWorkspaceCoordinationStatus', () => {
  it('groups active claims and derives resource conflicts without exposing blobs', () => {
    const status = buildWorkspaceCoordinationStatus(
      'ws-1',
      snapshot,
      new Map([['session-a', 'Parser migration']]),
      200,
    )

    expect(status.activities).toHaveLength(3)
    expect(status.activities[0]).toMatchObject({
      actorLabel: 'Parser migration',
      intent: 'Update the parser',
      claims: [{ resource: 'src/parser.ts' }],
    })
    expect(status.conflicts).toEqual([
      expect.objectContaining({
        resource: 'src/parser.ts',
        activityIds: ['activity-a', 'activity-b'],
        severity: 'advisory',
      }),
      expect.objectContaining({
        resource: 'workspace/fs',
        activityIds: ['activity-a', 'activity-b', 'activity-shell'],
        severity: 'advisory',
      }),
    ])
    expect(JSON.stringify(status)).not.toContain('before')
    expect(JSON.stringify(status)).not.toContain('after')
  })
})
