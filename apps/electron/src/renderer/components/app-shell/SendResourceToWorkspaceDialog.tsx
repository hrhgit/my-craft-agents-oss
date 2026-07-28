/**
 * SendResourceToWorkspaceDialog — Copy a source, skill, or automation to another workspace.
 *
 * Uses the resources:export → resources:import RPC pipeline.
 * Both operations run through the trusted Workspace runtime router.
 *
 * Adapted from SendToWorkspaceDialog (session transfer).
 */

import * as React from 'react'
import { useState, useCallback } from 'react'
import { Cloud, Monitor, Send } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { CrossfadeAvatar } from '@/components/ui/avatar'
import { useWorkspaceIcons } from '@/hooks/useWorkspaceIcon'
import { cn } from '@/lib/utils'
import { isPrimaryWorkspaceRemote } from '@/lib/workspace-info'
import { copyResourcesToWorkspace } from '@/lib/workspace-transfer'
import type { WorkspaceInfo, ExportResourcesOptions, ResourceImportMode } from '../../../shared/types'

export type SendResourceType = 'skill' | 'automation'

export interface SendResourceToWorkspaceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** What kind of resource to send */
  resourceType: SendResourceType
  /** Slug(s) or ID(s) of resources to send */
  resourceIds: string[]
  /** Display label for the dialog description */
  resourceLabel: string
  /** All workspaces */
  workspaces: WorkspaceInfo[]
  /** Current workspace ID (excluded from picker) */
  activeWorkspaceId: string | null
  /** Called after successful transfer */
  onTransferComplete?: () => void
}

const RESOURCE_TYPE_LABELS: Record<SendResourceType, { singular: string; plural: string }> = {
  skill: { singular: 'skill', plural: 'skills' },
  automation: { singular: 'automation', plural: 'automations' },
}

export function SendResourceToWorkspaceDialog({
  open,
  onOpenChange,
  resourceType,
  resourceIds,
  resourceLabel,
  workspaces,
  activeWorkspaceId,
  onTransferComplete,
}: SendResourceToWorkspaceDialogProps) {
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null)
  const [isSending, setIsSending] = useState(false)
  const workspaceIconMap = useWorkspaceIcons(workspaces)

  // All workspaces except current (both local and remote)
  const targetWorkspaces = workspaces.filter(w => w.id !== activeWorkspaceId)

  const handleSend = useCallback(async () => {
    if (!selectedWorkspaceId || !activeWorkspaceId || resourceIds.length === 0) return

    const sourceWorkspace = workspaces.find(w => w.id === activeWorkspaceId)
    const targetWorkspace = workspaces.find(w => w.id === selectedWorkspaceId)
    if (!sourceWorkspace || !targetWorkspace) return

    setIsSending(true)
    const targetName = targetWorkspace.name
    const { singular, plural } = RESOURCE_TYPE_LABELS[resourceType]
    const count = resourceIds.length
    const label = count === 1 ? singular : plural
    const mode: ResourceImportMode = 'skip'

    const toastId = toast.loading(`Sending ${resourceLabel} to ${targetName}...`)

    try {
      // 1. Export the selected resource(s) from current workspace
      const exportOptions: ExportResourcesOptions = {}
      if (resourceType === 'skill') exportOptions.skills = resourceIds
      else if (resourceType === 'automation') exportOptions.automations = resourceIds

      const { exportResult, importResult } = await copyResourcesToWorkspace(
        window.electronAPI,
        sourceWorkspace,
        targetWorkspace,
        exportOptions,
        mode,
      )

      // 3. Report result
      const bucket = resourceType === 'skill' ? importResult.skills : importResult.automations
      const imported = bucket?.imported?.length ?? 0
      const skipped = bucket?.skipped?.length ?? 0

      if (imported > 0 && skipped === 0) {
        toast.success(`Sent ${resourceLabel} to ${targetName}`, { id: toastId })
      } else if (imported > 0 && skipped > 0) {
        toast.success(`Sent ${imported} ${label}, ${skipped} already existed`, { id: toastId })
      } else if (skipped > 0) {
        toast.info(`${resourceLabel} already exists in ${targetName}`, { id: toastId })
      } else {
        toast.warning(`Nothing was sent to ${targetName}`, { id: toastId })
      }

      if (exportResult.warnings.length > 0) {
        console.warn('[SendResource] Export warnings:', exportResult.warnings)
      }

      onOpenChange(false)
      setSelectedWorkspaceId(null)
      onTransferComplete?.()
    } catch (error: any) {
      const isUnsupported = error?.code === 'CHANNEL_NOT_FOUND' ||
        (error?.message ?? '').includes('No handler for')
      const message = isUnsupported
        ? `${targetName} is running an older version that doesn't support resource import. Update the remote server and try again.`
        : error instanceof Error ? error.message : 'Unknown error'
      toast.error(`Failed to send ${label}`, { id: toastId, description: message })
    } finally {
      setIsSending(false)
    }
  }, [selectedWorkspaceId, activeWorkspaceId, resourceIds, resourceType, resourceLabel, workspaces, onOpenChange, onTransferComplete])

  return (
    <Dialog open={open} onOpenChange={(isOpen) => {
      if (!isSending) {
        onOpenChange(isOpen)
        if (!isOpen) setSelectedWorkspaceId(null)
      }
    }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Send className="h-4 w-4" />
            Send to Workspace
          </DialogTitle>
          <DialogDescription>
            Send {resourceLabel} to another workspace.
          </DialogDescription>
        </DialogHeader>

        {/* Workspace list */}
        <div className="flex flex-col gap-1 max-h-64 overflow-y-auto py-1">
          {targetWorkspaces.length === 0 ? (
            <p className="text-sm text-muted-foreground px-2 py-4 text-center">
              No other workspaces available.
            </p>
          ) : (
            targetWorkspaces.map(workspace => {
              const isSelected = selectedWorkspaceId === workspace.id
              const isRemote = isPrimaryWorkspaceRemote(workspace)

              return (
                <button
                  key={workspace.id}
                  type="button"
                  disabled={isSending}
                  onClick={() => setSelectedWorkspaceId(workspace.id)}
                  className={cn(
                    'flex items-center gap-2 w-full px-2 py-2 rounded-md text-left text-sm transition-colors',
                    'hover:bg-foreground/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    isSelected && 'bg-foreground/10 ring-1 ring-foreground/15',
                  )}
                >
                  <CrossfadeAvatar
                    src={workspaceIconMap.get(workspace.id)}
                    alt={workspace.name}
                    className="h-5 w-5 rounded-full ring-1 ring-border/50 shrink-0"
                    fallbackClassName="bg-muted text-[10px] rounded-full"
                    fallback={workspace.name?.charAt(0) || 'W'}
                  />
                  <span className="flex-1 truncate">{workspace.name}</span>
                  {isRemote ? (
                    <Cloud className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <Monitor className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" />
                  )}
                </button>
              )
            })
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSending}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSend}
            disabled={!selectedWorkspaceId || isSending}
          >
            {isSending ? 'Sending...' : 'Send'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
