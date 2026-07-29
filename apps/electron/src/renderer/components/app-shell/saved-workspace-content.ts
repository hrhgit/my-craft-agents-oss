export interface SavedWorkspaceContentTabLike {
  id?: unknown
  component?: unknown
  config?: {
    source?: unknown
    contentKind?: unknown
    resourceId?: unknown
    workspaceId?: unknown
  }
}

const WORKSPACE_CONTENT_KINDS = new Set(['file', 'browser', 'extension'])

/** Layout references remain valid even when their backing Extension is unavailable. */
export function isRestorableWorkspaceContentTab(
  tab: SavedWorkspaceContentTabLike,
  workspaceId: string,
  allowedTabIds?: Set<string>,
): boolean {
  const config = tab.config
  return typeof tab.id === 'string'
    && tab.component === 'workspace-content'
    && config?.source === 'workspace-content'
    && typeof config.contentKind === 'string'
    && WORKSPACE_CONTENT_KINDS.has(config.contentKind)
    && typeof config.resourceId === 'string'
    && config.workspaceId === workspaceId
    && (!allowedTabIds || allowedTabIds.has(tab.id))
}
