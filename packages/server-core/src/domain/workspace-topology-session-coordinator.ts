import type { Workspace } from '@mortise/core/types'

export type WorkspaceSessionInterruptionTarget =
  | { workspaceId: string; scope: 'workspace' }
  | { workspaceId: string; scope: 'location'; locationId: string }

export interface WorkspaceSessionInterruptionResult {
  selectedSessionIds: string[]
  interruptedSessionIds: string[]
}

/**
 * Session lifecycle boundary required by Workspace topology mutations.
 *
 * `interruptWorkspaceSessionsForTopologyChange` resolves only after affected
 * current work is terminal, queued recovery is fenced, and the cancellation
 * state is durable. A rejection blocks the topology mutation. The subsequent
 * topology update adopts the committed Workspace snapshot only; it must never
 * restart or replay interrupted Session work automatically.
 */
export interface WorkspaceTopologySessionCoordinator {
  interruptWorkspaceSessionsForTopologyChange(
    target: WorkspaceSessionInterruptionTarget,
  ): Promise<WorkspaceSessionInterruptionResult>

  updateWorkspaceTopology(workspace: Workspace): void
}
