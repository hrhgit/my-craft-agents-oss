export interface BranchRollbackManagedSession {
  agent?: { destroy?: () => void } | null
}

interface RollbackParams {
  managed: BranchRollbackManagedSession
  workspaceId: string
  sessionId: string
  deleteFromRuntimeSessions: (sessionId: string) => void
  deleteStoredSession: (workspaceId: string, sessionId: string) => void | boolean | Promise<void | boolean>
}

/**
 * Best-effort rollback when branch creation fails during backend preflight.
 * Ensures no orphan child session remains in memory or persistent storage.
 */
export async function rollbackFailedBranchCreation(params: RollbackParams): Promise<void> {
  const { managed, workspaceId, sessionId, deleteFromRuntimeSessions, deleteStoredSession } = params

  try {
    managed.agent?.destroy?.()
  } catch {
    // Best-effort cleanup
  }
  managed.agent = null

  deleteFromRuntimeSessions(sessionId)

  try {
    await deleteStoredSession(workspaceId, sessionId)
  } catch {
    // Best-effort rollback: runtime cleanup is the critical path.
  }
}
