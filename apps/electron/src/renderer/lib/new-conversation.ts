const NEW_CONVERSATION_DRAFT_PREFIX = 'mortise.new-conversation'

export interface NewConversationDraftOptions {
  provider?: string
  model?: string
  thinkingLevel: import('@mortise/shared/agent/thinking-levels').ThinkingLevel
  permissionMode: import('../../shared/types').PermissionMode
  workingDirectory?: string
}

export function createNewConversationDraftId(): string {
  return `panel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function getNewConversationDraftStorageKey(workspaceId: string, draftId: string): string {
  const safeWorkspaceId = encodeURIComponent(workspaceId)
  const safeDraftId = encodeURIComponent(draftId)
  return `${NEW_CONVERSATION_DRAFT_PREFIX}.workspace_${safeWorkspaceId}.draft_${safeDraftId}.v1`
}

export function getNewConversationOptionsStorageScope(workspaceId: string, draftId: string): string {
  return `workspace_${encodeURIComponent(workspaceId)}.draft_${encodeURIComponent(draftId)}`
}
