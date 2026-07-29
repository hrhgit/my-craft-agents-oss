export type WorkspaceLocationActivityKind =
  | 'session'
  | 'child-task'
  | 'automation-run'
  | 'tool'
  | 'subprocess'

export interface WorkspaceLocationActivity {
  workspaceId: string
  locationId: string
  kind: WorkspaceLocationActivityKind
  activityId: string
  ownerSessionId?: string
}

/** Backend-local index of work that currently uses a concrete Workspace location. */
export class WorkspaceLocationActivityRegistry {
  private readonly activities = new Map<string, { generation: number; value: WorkspaceLocationActivity }>()
  private nextGeneration = 1

  begin(activity: WorkspaceLocationActivity): () => void {
    validateActivity(activity)
    const key = activityKey(activity.kind, activity.activityId)
    const generation = this.nextGeneration++
    this.activities.set(key, { generation, value: { ...activity } })
    let released = false
    return () => {
      if (released) return
      released = true
      const current = this.activities.get(key)
      if (current?.generation === generation) this.activities.delete(key)
    }
  }

  end(kind: WorkspaceLocationActivityKind, activityId: string): void {
    this.activities.delete(activityKey(kind, activityId))
  }

  list(target: { workspaceId: string; locationId?: string }): WorkspaceLocationActivity[] {
    return [...this.activities.values()].flatMap(({ value }) => (
      value.workspaceId === target.workspaceId
        && (target.locationId === undefined || value.locationId === target.locationId)
        ? [{ ...value }]
        : []
    ))
  }

  clearSession(sessionId: string): void {
    for (const [key, { value }] of this.activities) {
      if (value.ownerSessionId === sessionId || (value.kind === 'session' && value.activityId === sessionId)) {
        this.activities.delete(key)
      }
    }
  }
}

function activityKey(kind: WorkspaceLocationActivityKind, activityId: string): string {
  return `${kind}\0${activityId}`
}

function validateActivity(activity: WorkspaceLocationActivity): void {
  if (!activity.workspaceId.trim() || !activity.locationId.trim() || !activity.activityId.trim()) {
    throw new Error('Workspace location activity requires workspaceId, locationId, and activityId')
  }
}
