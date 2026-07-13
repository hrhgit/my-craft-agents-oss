import * as React from 'react'
import type { ExtensionBridgeEvent } from '@craft-agent/shared/agent/backend/types'
import type { ExtensionUISurface } from '@craft-agent/shared/protocol'
import { ContributionStore, SurfaceLayoutManager } from './extension-contribution-store'

export const extensionContributionStore = new ContributionStore()
export const extensionSurfaceLayout = new SurfaceLayoutManager()
let hostSubscription: (() => void) | undefined
const refreshedSessions = new Set<string>()

function ensureHostSubscription(): void {
  if (hostSubscription || typeof window === 'undefined') return
  const subscribe = window.electronAPI?.onExtensionEvent
  if (typeof subscribe !== 'function') return
  hostSubscription = subscribe((event: ExtensionBridgeEvent) => {
    if (event.type === 'extension_contribution') extensionContributionStore.apply(event.delta)
    if (event.type === 'extension_contributions_runtime_reset') {
      refreshedSessions.delete(event.sessionId)
      extensionContributionStore.resetRuntime(event.sessionId, event.runtimeId)
    }
  })
}

export function useExtensionContributions(
  sessionId: string,
  surface: ExtensionUISurface,
  target?: { turnId?: string; messageId?: string; toolCallId?: string },
  hydrateRuntime = true,
) {
  ensureHostSubscription()
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
    if (refreshedSessions.has(sessionId)) return
    refreshedSessions.add(sessionId)
    void window.electronAPI?.getExtensionCommands?.(sessionId).catch(() => refreshedSessions.delete(sessionId))
  }, [hydrateRuntime, sessionId, version])
  return React.useMemo(() => {
    void version
    const items = extensionContributionStore.list(sessionId, surface).filter(item => {
      if (!hasTarget) return item.contribution.target === undefined
      const ownTarget = item.contribution.target
      if (!ownTarget) return false
      return (targetTurnId === undefined || ownTarget.turnId === targetTurnId)
        && (targetMessageId === undefined || ownTarget.messageId === targetMessageId)
        && (targetToolCallId === undefined || ownTarget.toolCallId === targetToolCallId)
    })
    return extensionSurfaceLayout.resolve(surface, items)
  }, [hasTarget, sessionId, surface, targetMessageId, targetToolCallId, targetTurnId, version])
}
