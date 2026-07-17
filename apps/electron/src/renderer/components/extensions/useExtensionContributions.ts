import * as React from 'react'
import type { ExtensionBridgeEvent } from '@craft-agent/shared/agent/backend/types'
import type { ExtensionUISurface } from '@craft-agent/shared/protocol'
import { ContributionStore, SurfaceLayoutManager } from './extension-contribution-store'
import { extensionValidationStore } from './extension-validation-store'
import { useOptionalAppShellContext } from '@/context/AppShellContext'

export const extensionContributionStore = new ContributionStore()
export const extensionSurfaceLayout = new SurfaceLayoutManager()
let hostSubscription: (() => void) | undefined
const refreshedSessions = new Set<string>()
const refreshKey = (sessionId: string, workspaceId?: string | null) => `${workspaceId ?? ''}\0${sessionId}`

function ensureHostSubscription(): void {
  if (hostSubscription || typeof window === 'undefined') return
  const subscribe = window.electronAPI?.onExtensionEvent
  if (typeof subscribe !== 'function') return
  hostSubscription = subscribe((event: ExtensionBridgeEvent) => {
    if (event.type === 'extension_contribution') extensionContributionStore.apply(event.delta)
    if (event.type === 'extension_ui_validation') extensionValidationStore.apply(event.delta)
    if (event.type === 'extension_contributions_runtime_reset') {
      refreshedSessions.delete(refreshKey(event.sessionId, event.workspaceId))
      refreshedSessions.delete(refreshKey(event.sessionId))
      extensionContributionStore.resetRuntime(event.sessionId, event.runtimeId, event.workspaceId)
      extensionValidationStore.resetRuntime(event.sessionId, event.runtimeId)
    }
  })
}

export function useExtensionContributions(
  sessionId: string,
  surface: ExtensionUISurface,
  target?: { turnId?: string; messageId?: string; toolCallId?: string },
  hydrateRuntime = true,
  workspaceId?: string | null,
) {
  ensureHostSubscription()
  const appShell = useOptionalAppShellContext()
  const activeWorkspace = appShell?.workspaces.find(workspace => workspace.id === appShell.activeWorkspaceId)
  const activeContributionWorkspaceId = activeWorkspace?.remoteServer?.remoteWorkspaceId
    ?? appShell?.activeWorkspaceId
    ?? undefined
  const resolvedWorkspaceId = workspaceId === undefined ? activeContributionWorkspaceId : workspaceId
  const hasTarget = target !== undefined
  const targetTurnId = target?.turnId
  const targetMessageId = target?.messageId
  const targetToolCallId = target?.toolCallId
  const version = React.useSyncExternalStore(
    extensionContributionStore.subscribe,
    extensionContributionStore.getVersion,
    extensionContributionStore.getVersion,
  )
  React.useEffect(() => {
    if (!hydrateRuntime) return
    const key = refreshKey(sessionId, resolvedWorkspaceId)
    if (refreshedSessions.has(key)) return
    refreshedSessions.add(key)
    void window.electronAPI?.getExtensionCommands?.(sessionId).catch(() => refreshedSessions.delete(key))
  }, [hydrateRuntime, resolvedWorkspaceId, sessionId, version])
  return React.useMemo(() => {
    void version
    const surfaceItems = surface === 'workspace.content'
      ? extensionContributionStore.listWorkspaceContent(sessionId, resolvedWorkspaceId)
      : extensionContributionStore.list(sessionId, surface, resolvedWorkspaceId)
    const items = surfaceItems.filter(item => {
      if (!hasTarget) return item.contribution.target === undefined
      const ownTarget = item.contribution.target
      if (!ownTarget) return false
      return (targetTurnId === undefined || ownTarget.turnId === targetTurnId)
        && (targetMessageId === undefined || ownTarget.messageId === targetMessageId)
        && (targetToolCallId === undefined || ownTarget.toolCallId === targetToolCallId)
    })
    return extensionSurfaceLayout.resolve(surface, items)
  }, [hasTarget, resolvedWorkspaceId, sessionId, surface, targetMessageId, targetToolCallId, targetTurnId, version])
}
