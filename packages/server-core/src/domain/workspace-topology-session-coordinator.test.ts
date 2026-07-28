import { describe, expect, it } from 'bun:test'
import type { Workspace } from '@mortise/core/types'
import { SessionManager } from '../sessions/SessionManager.ts'
import type { WorkspaceTopologySessionCoordinator } from './workspace-topology-session-coordinator.ts'

function workspace(revision = 1): Workspace {
  return {
    schemaVersion: 2,
    id: 'workspace-a',
    revision,
    name: 'Workspace A',
    nameSource: 'custom',
    slug: 'workspace-a',
    primaryLocationId: 'primary',
    locations: [{
      id: 'primary',
      name: 'Primary',
      rootName: 'workspace-a',
      endpoint: { kind: 'local', rootPath: 'C:\\workspace-a' },
    }],
    createdAt: 1,
  }
}

describe('Workspace topology Session coordinator contract', () => {
  it('is implemented directly by SessionManager without a structural cast', async () => {
    const manager = new SessionManager()
    const coordinator: WorkspaceTopologySessionCoordinator = manager

    await expect(coordinator.interruptWorkspaceSessionsForTopologyChange({
      workspaceId: 'workspace-a',
      scope: 'workspace',
    })).resolves.toEqual({ selectedSessionIds: [], interruptedSessionIds: [] })
  })

  it('adopts a committed topology snapshot without starting Session work', () => {
    const manager = new SessionManager()
    const coordinator: WorkspaceTopologySessionCoordinator = manager

    coordinator.updateWorkspaceTopology(workspace(2))

    expect(manager.getActiveSessionCount('workspace-a')).toBe(0)
  })
})
