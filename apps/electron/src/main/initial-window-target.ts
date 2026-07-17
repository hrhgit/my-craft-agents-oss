export interface InitialWindowWorkspace {
  id: string
}

export interface InitialWindowSession {
  id: string
  workspaceId: string
}

export interface InitialWindowTarget {
  workspaceId: string
  initialSessionId?: string
}

export function resolveInitialWindowTarget(args: {
  workspaces: readonly InitialWindowWorkspace[]
  sessions: readonly InitialWindowSession[]
  activeWorkspaceId?: string | null
  activeSessionId?: string | null
}): InitialWindowTarget | null {
  const workspace = args.workspaces.find(item => item.id === args.activeWorkspaceId)
    ?? args.workspaces[0]
  if (!workspace) return null

  const activeSessionId = args.activeSessionId
  const ownsActiveSession = activeSessionId
    ? args.sessions.some(session => session.id === activeSessionId && session.workspaceId === workspace.id)
    : false

  return {
    workspaceId: workspace.id,
    ...(ownsActiveSession ? { initialSessionId: activeSessionId! } : {}),
  }
}
