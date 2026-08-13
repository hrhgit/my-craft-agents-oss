export type AppStartupState = 'workspace-picker' | 'ready'

export function resolveAppStartupState(workspaceId: string | null | undefined): AppStartupState {
  return workspaceId ? 'ready' : 'workspace-picker'
}
