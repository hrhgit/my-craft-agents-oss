import { describe, expect, it } from 'bun:test'
import { WorkspaceLocationActivityRegistry } from './workspace-location-activity-registry'

describe('WorkspaceLocationActivityRegistry', () => {
  it('indexes only live activities by Workspace and location', () => {
    const registry = new WorkspaceLocationActivityRegistry()
    const releaseSession = registry.begin({
      workspaceId: 'workspace', locationId: 'primary', kind: 'session', activityId: 'session-1',
    })
    registry.begin({
      workspaceId: 'workspace', locationId: 'attached', kind: 'tool', activityId: 'tool-1', ownerSessionId: 'session-2',
    })

    expect(registry.list({ workspaceId: 'workspace', locationId: 'primary' })).toHaveLength(1)
    expect(registry.list({ workspaceId: 'workspace', locationId: 'attached' })).toEqual([
      expect.objectContaining({ kind: 'tool', activityId: 'tool-1', ownerSessionId: 'session-2' }),
    ])
    releaseSession()
    expect(registry.list({ workspaceId: 'workspace', locationId: 'primary' })).toEqual([])
  })

  it('does not let a stale release remove a replacement activity', () => {
    const registry = new WorkspaceLocationActivityRegistry()
    const first = registry.begin({ workspaceId: 'workspace', locationId: 'old', kind: 'tool', activityId: 'tool-1' })
    registry.begin({ workspaceId: 'workspace', locationId: 'new', kind: 'tool', activityId: 'tool-1' })
    first()
    expect(registry.list({ workspaceId: 'workspace' })).toEqual([
      expect.objectContaining({ locationId: 'new' }),
    ])
  })

  it('clears every concrete activity owned by a Session', () => {
    const registry = new WorkspaceLocationActivityRegistry()
    registry.begin({ workspaceId: 'workspace', locationId: 'primary', kind: 'session', activityId: 'session-1' })
    registry.begin({ workspaceId: 'workspace', locationId: 'primary', kind: 'child-task', activityId: 'child-1', ownerSessionId: 'session-1' })
    registry.begin({ workspaceId: 'workspace', locationId: 'primary', kind: 'automation-run', activityId: 'run-1' })
    registry.clearSession('session-1')
    expect(registry.list({ workspaceId: 'workspace' })).toEqual([
      expect.objectContaining({ kind: 'automation-run', activityId: 'run-1' }),
    ])
  })
})
