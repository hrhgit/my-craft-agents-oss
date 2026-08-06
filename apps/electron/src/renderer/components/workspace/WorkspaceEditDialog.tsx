import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { WorkspaceInfo } from '@mortise/core/types'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useRegisterModal } from '@/context/ModalContext'
import { toast } from 'sonner'

import { WorkspaceLocationsSection } from '@/pages/settings/WorkspaceLocationsSection'
import { createWorkspaceTopologyCommand } from '@/pages/settings/workspace-location-settings-model'

interface WorkspaceEditDialogProps {
  workspace: WorkspaceInfo
  onClose: () => void
  onWorkspaceChanged?: () => void | Promise<void>
}

export function WorkspaceEditDialog({
  workspace: initialWorkspace,
  onClose,
  onWorkspaceChanged,
}: WorkspaceEditDialogProps) {
  const { t } = useTranslation()
  const [workspace, setWorkspace] = useState(initialWorkspace)
  const [name, setName] = useState(initialWorkspace.name)
  const [saving, setSaving] = useState(false)

  const handleClose = useCallback(() => {
    if (!saving) onClose()
  }, [onClose, saving])
  useRegisterModal(true, handleClose)

  const saveName = useCallback(async () => {
    const nextName = name.trim()
    if (!nextName || nextName === workspace.name) return true
    if (!window.electronAPI) return false

    setSaving(true)
    try {
      const result = await window.electronAPI.workspaceTopologyCommand(createWorkspaceTopologyCommand(
        workspace,
        crypto.randomUUID(),
        { operation: 'rename-workspace', name: nextName },
      ))
      setWorkspace(result.workspace)
      await onWorkspaceChanged?.()
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.error(t('toast.failedToSaveSetting', { setting: t('common.name') }), {
        description: message,
      })
      return false
    } finally {
      setSaving(false)
    }
  }, [name, onWorkspaceChanged, t, workspace.id, workspace.name])

  return (
    <Dialog open onOpenChange={open => { if (!open) handleClose() }}>
      <DialogContent
        semanticId="workspace.edit"
        className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-[44rem]"
        showCloseButton={!saving}
        onEscapeKeyDown={event => { if (saving) event.preventDefault() }}
        onPointerDownOutside={event => { if (saving) event.preventDefault() }}
      >
        <DialogHeader>
          <DialogTitle>{t('workspace.editWorkspace')}</DialogTitle>
          <DialogDescription>{workspace.name}</DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          <div className="space-y-2">
            <label htmlFor="workspace-edit-name" className="text-sm font-medium text-foreground">
              {t('workspace.nameLabel')}
            </label>
            <Input
              id="workspace-edit-name"
              value={name}
              onChange={event => setName(event.target.value)}
              placeholder={t('workspace.derivedNamePlaceholder')}
              disabled={saving}
              autoFocus
            />
          </div>

          <WorkspaceLocationsSection
            workspace={workspace}
            onWorkspaceChanged={next => {
              setWorkspace(next)
              void onWorkspaceChanged?.()
            }}
          />

          <DialogFooter>
            <Button type="button" variant="outline" onClick={handleClose} disabled={saving}>
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              onClick={() => {
                void saveName().then(saved => {
                  if (saved) onClose()
                })
              }}
              disabled={saving || !name.trim()}
            >
              {saving ? t('common.saving') : t('common.save')}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
}
