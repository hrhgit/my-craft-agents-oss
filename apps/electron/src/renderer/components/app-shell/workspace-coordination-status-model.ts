import type { WorkspaceCoordinationStatusV1 } from '@mortise/shared/protocol'

export interface WorkspaceCoordinationStatusCounts {
  activities: number
  conflicts: number
  recentChanges: number
  blockingConflicts: number
}

export function workspaceCoordinationStatusCounts(
  status: WorkspaceCoordinationStatusV1 | null,
): WorkspaceCoordinationStatusCounts {
  return {
    activities: status?.activities.length ?? 0,
    conflicts: status?.conflicts.length ?? 0,
    recentChanges: status?.recentChanges.length ?? 0,
    blockingConflicts: status?.conflicts.filter(conflict => conflict.severity === 'blocking').length ?? 0,
  }
}

export function shouldShowWorkspaceCoordinationStatus(
  status: WorkspaceCoordinationStatusV1 | null,
  loading: boolean,
  error: string | null,
): boolean {
  if (loading || error) return true
  const counts = workspaceCoordinationStatusCounts(status)
  return counts.activities > 0 || counts.conflicts > 0 || counts.recentChanges > 0
}

export function workspaceCoordinationSemanticPart(value: string): string {
  const readable = value
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'item'
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `${readable}.${(hash >>> 0).toString(16).padStart(8, '0')}`
}
