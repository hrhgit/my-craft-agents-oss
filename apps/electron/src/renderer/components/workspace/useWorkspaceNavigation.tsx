import * as React from 'react'
import { AnimatePresence } from 'motion/react'
import { useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { fullscreenOverlayOpenAtom } from '@/atoms/overlay'
import { useTransportConnectionState } from '@/hooks/useTransportConnectionState'
import { waitForTransportConnected } from '@/lib/transport-wait'
import type { WorkspaceInfo } from '../../../shared/types'
import { WorkspaceCreationScreen } from './WorkspaceCreationScreen'
import type { WorkspaceSwitchDestination } from '@/contexts/navigation-history'
import {
  getPrimaryRemoteLocation,
  type RemoteWorkspaceLocationInfo,
} from './workspace-remote-reconnect'
import { useWorkspaceInfoIcons } from './useWorkspaceInfoIcons'

export type { WorkspaceSwitchDestination } from '@/contexts/navigation-history'

export type WorkspaceSelectHandler = (
  workspaceId: string,
  openInNewWindow?: boolean,
  destination?: WorkspaceSwitchDestination,
) => void | Promise<void>

export interface WorkspaceNavigationItem {
  workspace: WorkspaceInfo
  remotePrimary: RemoteWorkspaceLocationInfo | null
  iconUrl?: string
  isActive: boolean
  hasUnread: boolean
  isProcessing: boolean
  isDisconnected: boolean
  isChecking: boolean
  disconnectLabel: string
}

export interface WorkspaceNavigationModel {
  items: WorkspaceNavigationItem[]
  activeWorkspaceId: string | null
  selectWorkspace: (workspaceId: string) => Promise<void>
  selectSession: (workspaceId: string, sessionId: string) => Promise<void>
  openWorkspaceInNewWindow: (workspaceId: string) => Promise<void>
  removeWorkspace: (workspace: WorkspaceInfo) => Promise<void>
  openCreation: () => void
  refreshRemoteHealth: () => void
  overlay: React.ReactNode
}

interface UseWorkspaceNavigationOptions {
  workspaces: WorkspaceInfo[]
  activeWorkspaceId: string | null
  workspaceUnreadMap: Record<string, boolean>
  workspaceProcessingMap: Record<string, boolean>
  onSelectWorkspace: WorkspaceSelectHandler
  onRefreshWorkspaces?: () => void | Promise<void>
}

export function useWorkspaceNavigation({
  workspaces,
  activeWorkspaceId,
  workspaceUnreadMap,
  workspaceProcessingMap,
  onSelectWorkspace,
  onRefreshWorkspaces,
}: UseWorkspaceNavigationOptions): WorkspaceNavigationModel {
  const { t } = useTranslation()
  const setFullscreenOverlayOpen = useSetAtom(fullscreenOverlayOpenAtom)
  const connectionState = useTransportConnectionState()
  const workspaceIconMap = useWorkspaceInfoIcons(workspaces)
  const [showCreationScreen, setShowCreationScreen] = React.useState(false)
  const [reconnectTarget, setReconnectTarget] = React.useState<WorkspaceInfo | null>(null)

  const refreshRemoteHealth = React.useCallback(() => {
    // Inactive remote availability is host-owned and cannot be inferred without
    // exposing credentials to the renderer. The active transport reports itself.
  }, [])

  const closeCreation = React.useCallback(() => {
    setShowCreationScreen(false)
    setReconnectTarget(null)
    setFullscreenOverlayOpen(false)
  }, [setFullscreenOverlayOpen])

  const openCreation = React.useCallback(() => {
    setReconnectTarget(null)
    setShowCreationScreen(true)
    setFullscreenOverlayOpen(true)
  }, [setFullscreenOverlayOpen])

  const isDisconnected = React.useCallback((workspace: WorkspaceInfo) => {
    if (!getPrimaryRemoteLocation(workspace) || workspace.id !== activeWorkspaceId) return false
    if (connectionState?.mode !== 'remote') return false
    return !['connected', 'connecting', 'idle'].includes(connectionState.status)
  }, [activeWorkspaceId, connectionState])

  const disconnectLabel = React.useCallback((workspace: WorkspaceInfo) => {
    if (workspace.id === activeWorkspaceId && connectionState?.lastError) {
      if (connectionState.lastError.kind === 'auth') return t('toast.authenticationFailed')
      if (connectionState.lastError.kind === 'timeout' || connectionState.lastError.kind === 'network') {
        return t('toast.serverUnreachable')
      }
    }
    return t('toast.disconnected')
  }, [activeWorkspaceId, connectionState?.lastError, t])

  const selectWorkspace = React.useCallback(async (workspaceId: string) => {
    const workspace = workspaces.find(item => item.id === workspaceId)
    if (!workspace) return
    if (isDisconnected(workspace)) {
      if (getPrimaryRemoteLocation(workspace)) {
        setReconnectTarget(workspace)
        setShowCreationScreen(true)
        setFullscreenOverlayOpen(true)
      }
      return
    }
    await Promise.resolve(onSelectWorkspace(workspaceId, false, 'newConversation'))
  }, [isDisconnected, onSelectWorkspace, setFullscreenOverlayOpen, workspaces])

  const selectSession = React.useCallback(async (workspaceId: string, sessionId: string) => {
    const workspace = workspaces.find(item => item.id === workspaceId)
    if (!workspace) return
    if (isDisconnected(workspace)) {
      if (getPrimaryRemoteLocation(workspace)) {
        setReconnectTarget(workspace)
        setShowCreationScreen(true)
        setFullscreenOverlayOpen(true)
      }
      return
    }
    await Promise.resolve(onSelectWorkspace(workspaceId, false, { sessionId }))
  }, [isDisconnected, onSelectWorkspace, setFullscreenOverlayOpen, workspaces])

  const openWorkspaceInNewWindow = React.useCallback(async (workspaceId: string) => {
    await Promise.resolve(onSelectWorkspace(workspaceId, true, 'restore'))
  }, [onSelectWorkspace])

  const removeWorkspace = React.useCallback(async (workspace: WorkspaceInfo) => {
    if (workspace.id === activeWorkspaceId) {
      toast.error(t('toast.cannotRemoveActiveWorkspace'))
      return
    }
    const removed = await window.electronAPI.removeWorkspace(workspace.id)
    if (!removed) return
    toast.success(t('toast.removedWorkspace', { name: workspace.name }))
    onRefreshWorkspaces?.()
  }, [activeWorkspaceId, onRefreshWorkspaces, t])

  const handleWorkspaceCreated = React.useCallback((workspace: WorkspaceInfo) => {
    closeCreation()
    toast.success(t('toast.createdWorkspace', { name: workspace.name }))
    onRefreshWorkspaces?.()
    void Promise.resolve(onSelectWorkspace(workspace.id, false, 'newConversation'))
  }, [closeCreation, onRefreshWorkspaces, onSelectWorkspace, t])

  const handleWorkspaceReconnected = React.useCallback(async (workspace: WorkspaceInfo) => {
    if (workspace.id === activeWorkspaceId) {
      await window.electronAPI.switchWorkspace(workspace.id)
    } else {
      await Promise.resolve(onSelectWorkspace(workspace.id, false, 'newConversation'))
    }
    await waitForTransportConnected(window.electronAPI)
    await Promise.resolve(onRefreshWorkspaces?.())
    closeCreation()
    toast.success(t('toast.workspaceReconnected'))
  }, [activeWorkspaceId, closeCreation, onRefreshWorkspaces, onSelectWorkspace, t])

  const items = React.useMemo<WorkspaceNavigationItem[]>(() => workspaces.map(workspace => {
    const remotePrimary = getPrimaryRemoteLocation(workspace)
    return {
      workspace,
      remotePrimary,
      iconUrl: workspaceIconMap.get(workspace.id),
      isActive: workspace.id === activeWorkspaceId,
      hasUnread: !!workspaceUnreadMap[workspace.id],
      isProcessing: !!workspaceProcessingMap[workspace.id]
        || !!(remotePrimary && workspaceProcessingMap[remotePrimary.endpoint.remoteWorkspaceId]),
      isDisconnected: isDisconnected(workspace),
      isChecking: false,
      disconnectLabel: disconnectLabel(workspace),
    }
  }), [activeWorkspaceId, disconnectLabel, isDisconnected, workspaceIconMap, workspaceProcessingMap, workspaceUnreadMap, workspaces])

  const overlay = (
    <AnimatePresence>
      {showCreationScreen && (
        <WorkspaceCreationScreen
          onWorkspaceCreated={handleWorkspaceCreated}
          onClose={closeCreation}
          reconnectWorkspace={reconnectTarget ?? undefined}
          onWorkspaceReconnected={handleWorkspaceReconnected}
        />
      )}
    </AnimatePresence>
  )

  return {
    items,
    activeWorkspaceId,
    selectWorkspace,
    selectSession,
    openWorkspaceInNewWindow,
    removeWorkspace,
    openCreation,
    refreshRemoteHealth,
    overlay,
  }
}
