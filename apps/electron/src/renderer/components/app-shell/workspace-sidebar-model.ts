import type { SessionMeta } from '@/atoms/sessions'
import type { Session } from '../../../shared/types'

export type WorkspaceSessionSummary = Pick<
  SessionMeta,
  | 'id'
  | 'name'
  | 'preview'
  | 'workspaceId'
  | 'lastMessageAt'
  | 'isProcessing'
  | 'hasUnread'
  | 'hidden'
  | 'sharedUrl'
  | 'sharedId'
  | 'lastFinalMessageId'
  | 'lastMessageRole'
  | 'readOnly'
>

export const RECENT_WORKSPACE_SESSION_LIMIT = 5

export function toWorkspaceSessionSummary(session: SessionMeta | Session): WorkspaceSessionSummary {
  return {
    id: session.id,
    name: session.name,
    preview: session.preview,
    workspaceId: session.workspaceId,
    lastMessageAt: session.lastMessageAt,
    isProcessing: session.isProcessing,
    hasUnread: session.hasUnread,
    hidden: session.hidden,
    sharedUrl: session.sharedUrl,
    sharedId: session.sharedId,
    lastFinalMessageId: 'lastFinalMessageId' in session ? session.lastFinalMessageId : undefined,
    lastMessageRole: 'lastMessageRole' in session ? session.lastMessageRole : undefined,
    readOnly: 'readOnly' in session ? session.readOnly : undefined,
  }
}

export function updateWorkspaceSessionSummary(
  previous: Record<string, WorkspaceSessionSummary[]>,
  workspaceId: string,
  sessionId: string,
  updates: Partial<WorkspaceSessionSummary>,
): Record<string, WorkspaceSessionSummary[]> {
  const sessions = previous[workspaceId]
  if (!sessions?.some(session => session.id === sessionId)) return previous
  return {
    ...previous,
    [workspaceId]: sessions.map(session => session.id === sessionId ? { ...session, ...updates } : session),
  }
}

export function removeWorkspaceSessionSummary(
  previous: Record<string, WorkspaceSessionSummary[]>,
  workspaceId: string,
  sessionId: string,
): Record<string, WorkspaceSessionSummary[]> {
  const sessions = previous[workspaceId]
  if (!sessions?.some(session => session.id === sessionId)) return previous
  return {
    ...previous,
    [workspaceId]: sessions.filter(session => session.id !== sessionId),
  }
}

export function mergeWorkspaceSessionSummaries(
  previous: Record<string, WorkspaceSessionSummary[]>,
  workspaceId: string,
  summaries: WorkspaceSessionSummary[],
  authoritativeEmpty = false,
): Record<string, WorkspaceSessionSummary[]> {
  // Workspace switching clears the shared metadata atom before the next
  // workspace commits. Preserve the last authoritative list through that
  // transient empty frame so inactive workspace shortcuts do not disappear.
  if (!authoritativeEmpty && summaries.length === 0 && (previous[workspaceId]?.length ?? 0) > 0) return previous
  return { ...previous, [workspaceId]: summaries }
}
