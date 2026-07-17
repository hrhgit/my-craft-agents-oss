import * as React from 'react'
import { AnimatePresence } from 'motion/react'
import { useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { fullscreenOverlayOpenAtom } from '@/atoms/overlay'
import { useTransportConnectionState } from '@/hooks/useTransportConnectionState'
import { useWorkspaceIcons } from '@/hooks/useWorkspaceIcon'
import { waitForTransportConnected } from '@/lib/transport-wait'
import type { Workspace } from '../../../shared/types'
import type { RemoteServerConfig } from '../../../shared/types'
import { WorkspaceCreationScreen } from './WorkspaceCreationScreen'
import type { WorkspaceSwitchDestination } from '@/contexts/navigation-history'

export type { WorkspaceSwitchDestination } from '@/contexts/navigation-history'

export type WorkspaceSelectHandler = (
  workspaceId: string,
  openInNewWindow?: boolean,
  destination?: WorkspaceSwitchDestination,
) => void | Promise<void>

export interface WorkspaceNavigationItem {
  workspace: Workspace
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
  removeWorkspace: (workspace: Workspace) => Promise<void>
  openCreation: () => void
  refreshRemoteHealth: () => void
  overlay: React.ReactNode
}

interface UseWorkspaceNavigationOptions {
  workspaces: Workspace[]
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
  const workspaceIconMap = useWorkspaceIcons(workspaces)
  const [showCreationScreen, setShowCreationScreen] = React.useState(false)
  const [reconnectTarget, setReconnectTarget] = React.useState<Workspace | null>(null)
  const [remoteHealthMap, setRemoteHealthMap] = React.useState<Map<string, 'ok' | 'error' | 'checking'>>(new Map())
  const healthCheckAbort = React.useRef<AbortController | null>(null)

  React.useEffect(() => () => healthCheckAbort.current?.abort(), [])

  const refreshRemoteHealth = React.useCallback(() => {
    healthCheckAbort.current?.abort()
    const abort = new AbortController()
    healthCheckAbort.current = abort

    const remoteWorkspaces = workspaces.filter(workspace => workspace.remoteServer && workspace.id !== activeWorkspaceId)
    if (remoteWorkspaces.length === 0) return

    setRemoteHealthMap(previous => {
      const next = new Map(previous)
      for (const workspace of remoteWorkspaces) next.set(workspace.id, 'checking')
      return next
    })

    for (const workspace of remoteWorkspaces) {
      window.electronAPI.testRemoteConnection(
        workspace.remoteServer!.url,
        workspace.remoteServer!.token,
        workspace.remoteServer!.allowInsecureTls,
      )
        .then(result => {
          if (abort.signal.aborted) return
          setRemoteHealthMap(previous => new Map(previous).set(workspace.id, result.ok ? 'ok' : 'error'))
        })
        .catch(() => {
          if (abort.signal.aborted) return
          setRemoteHealthMap(previous => new Map(previous).set(workspace.id, 'error'))
        })
    }
  }, [activeWorkspaceId, workspaces])

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

  const isDisconnected = React.useCallback((workspace: Workspace) => {
    if (!workspace.remoteServer) return false
    if (workspace.id !== activeWorkspaceId) return remoteHealthMap.get(workspace.id) === 'error'
    if (connectionState?.mode !== 'remote') return false
    return !['connected', 'connecting', 'idle'].includes(connectionState.status)
  }, [activeWorkspaceId, connectionState, remoteHealthMap])

  const disconnectLabel = React.useCallback((workspace: Workspace) => {
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
      if (workspace.remoteServer) {
        setReconnectTarget(workspace)
        setShowCreationScreen(true)
        setFullscreenOverlayOpen(true)
      }
      return
    }
    await Promise.resolve(onSelectWorkspace(workspaceId, false, 'allSessions'))
  }, [isDisconnected, onSelectWorkspace, setFullscreenOverlayOpen, workspaces])

  const selectSession = React.useCallback(async (workspaceId: string, sessionId: string) => {
    const workspace = workspaces.find(item => item.id === workspaceId)
    if (!workspace) return
    if (isDisconnected(workspace)) {
      if (workspace.remoteServer) {
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

  const removeWorkspace = React.useCallback(async (workspace: Workspace) => {
    if (workspace.id === activeWorkspaceId) {
      toast.error(t('toast.cannotRemoveActiveWorkspace'))
      return
    }
    const removed = await window.electronAPI.removeWorkspace(workspace.id)
    if (!removed) return
    toast.success(t('toast.removedWorkspace', { name: workspace.name }))
    onRefreshWorkspaces?.()
  }, [activeWorkspaceId, onRefreshWorkspaces, t])

  const handleWorkspaceCreated = React.useCallback((workspace: Workspace) => {
    closeCreation()
    toast.success(t('toast.createdWorkspace', { name: workspace.name }))
    onRefreshWorkspaces?.()
    void Promise.resolve(onSelectWorkspace(workspace.id, false, 'allSessions'))
  }, [closeCreation, onRefreshWorkspaces, onSelectWorkspace, t])

  const handleReconnectWorkspace = React.useCallback(async (
    workspaceId: string,
    remoteServer: RemoteServerConfig,
  ) => {
    await window.electronAPI.updateWorkspaceRemoteServer(workspaceId, remoteServer)
    if (workspaceId === activeWorkspaceId) {
      // SWITCH_WORKSPACE reads the just-saved config and makes RoutedClient
      // replace the immutable WsRpcClient instead of reconnecting the old one.
      await window.electronAPI.switchWorkspace(workspaceId)
    } else {
      await Promise.resolve(onSelectWorkspace(workspaceId, false, 'allSessions'))
    }
    await waitForTransportConnected(window.electronAPI)
    await Promise.resolve(onRefreshWorkspaces?.())
    closeCreation()
    toast.success(t('toast.workspaceReconnected'))
  }, [activeWorkspaceId, closeCreation, onRefreshWorkspaces, onSelectWorkspace, t])

  const items = React.useMemo<WorkspaceNavigationItem[]>(() => workspaces.map(workspace => ({
    workspace,
    iconUrl: workspaceIconMap.get(workspace.id),
    isActive: workspace.id === activeWorkspaceId,
    hasUnread: !!workspaceUnreadMap[workspace.id],
    isProcessing: !!workspaceProcessingMap[workspace.id]
      || !!(workspace.remoteServer?.remoteWorkspaceId && workspaceProcessingMap[workspace.remoteServer.remoteWorkspaceId]),
    isDisconnected: isDisconnected(workspace),
    isChecking: remoteHealthMap.get(workspace.id) === 'checking',
    disconnectLabel: disconnectLabel(workspace),
  })), [activeWorkspaceId, disconnectLabel, isDisconnected, remoteHealthMap, workspaceIconMap, workspaceProcessingMap, workspaceUnreadMap, workspaces])

  const overlay = (
    <AnimatePresence>
      {showCreationScreen && (
        <WorkspaceCreationScreen
          onWorkspaceCreated={handleWorkspaceCreated}
          onClose={closeCreation}
          reconnectWorkspace={reconnectTarget ?? undefined}
          onReconnectWorkspace={handleReconnectWorkspace}
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
