import { useState, useCallback } from "react"
import { useTranslation } from "react-i18next"
import type { WorkspaceCreationRequestV1 } from '@mortise/shared/protocol'
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog"
import { useRegisterModal } from "@/context/ModalContext"
import { cn } from "@/lib/utils"
import { AddWorkspaceStep_CreateNew } from "./AddWorkspaceStep_CreateNew"
import {
  AddWorkspaceStep_ConnectRemote,
  type WorkspaceRemoteReconnectFormValue,
} from "./AddWorkspaceStep_ConnectRemote"
import type { WorkspaceInfo } from "../../../shared/types"
import { toast } from "sonner"
import {
  getPrimaryRemoteLocation,
  reconnectWorkspaceRemoteLocation,
} from "./workspace-remote-reconnect"

interface WorkspaceCreationDialogProps {
  /** Callback when a workspace is created successfully */
  onWorkspaceCreated: (workspace: WorkspaceInfo, action: 'created' | 'reconnected') => void
  /** Callback when the screen is dismissed */
  onClose: () => void
  className?: string
  /** When set, skip choice step and open ConnectRemote in reconnect mode */
  reconnectWorkspace?: WorkspaceInfo
  /** Called after the existing remote location is durably replaced. */
  onWorkspaceReconnected?: (workspace: WorkspaceInfo) => void | Promise<void>
}

export function WorkspaceCreationDialog({
  onWorkspaceCreated,
  onClose,
  className,
  reconnectWorkspace,
  onWorkspaceReconnected,
}: WorkspaceCreationDialogProps) {
  const { t } = useTranslation()
  const [isCreating, setIsCreating] = useState(false)
  const handleClose = useCallback(() => {
    if (!isCreating) {
      onClose()
    }
  }, [isCreating, onClose])
  useRegisterModal(true, handleClose)

  const handleCreateWorkspace = useCallback(async (request: WorkspaceCreationRequestV1) => {
    setIsCreating(true)
    try {
      const result = await window.electronAPI.createWorkspace(request)
      onWorkspaceCreated(result.workspace, result.action)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      toast.error(t('toast.failedToCreateWorkspace'), {
        description: message,
      })
    } finally {
      setIsCreating(false)
    }
  }, [onWorkspaceCreated, t])

  const handleReconnectWorkspace = useCallback(async (value: WorkspaceRemoteReconnectFormValue) => {
    const remoteLocation = reconnectWorkspace
      ? getPrimaryRemoteLocation(reconnectWorkspace)
      : null
    if (!reconnectWorkspace || !remoteLocation) throw new Error('Remote Workspace location is unavailable')
    setIsCreating(true)
    try {
      const workspace = await reconnectWorkspaceRemoteLocation(window.electronAPI, {
        workspaceId: reconnectWorkspace.id,
        locationId: remoteLocation.id,
        ...value,
      })
      await onWorkspaceReconnected?.(workspace)
    } finally {
      setIsCreating(false)
    }
  }, [onWorkspaceReconnected, reconnectWorkspace])

  const reconnectLocation = reconnectWorkspace
    ? getPrimaryRemoteLocation(reconnectWorkspace)
    : null

  return (
    <Dialog open onOpenChange={open => { if (!open) handleClose() }}>
      <DialogContent
        semanticId="workspace.creation"
        className={cn("max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-[36rem]", className)}
        showCloseButton={!isCreating}
        onEscapeKeyDown={event => { if (isCreating) event.preventDefault() }}
        onPointerDownOutside={event => { if (isCreating) event.preventDefault() }}
      >
        <DialogTitle className="sr-only">
          {reconnectWorkspace
            ? t('workspace.reconnect', { name: reconnectWorkspace.name })
            : t('workspace.addWorkspace')}
        </DialogTitle>
        {reconnectWorkspace && reconnectLocation ? (
          <AddWorkspaceStep_ConnectRemote
            onBack={onClose}
            onReconnect={handleReconnectWorkspace}
            isCreating={isCreating}
            workspaceName={reconnectWorkspace.name}
            location={reconnectLocation}
          />
        ) : (
          <AddWorkspaceStep_CreateNew
            onCancel={onClose}
            onCreate={handleCreateWorkspace}
            isCreating={isCreating}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
