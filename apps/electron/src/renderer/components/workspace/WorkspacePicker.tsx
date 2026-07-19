/**
 * WorkspacePicker — shown when a thin client connects without a workspace ID.
 * Lists remote server workspaces and allows selection or creation.
 */

import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, FolderOpen, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Spinner } from '@mortise/ui'
import type { WorkspaceInfo } from '../../../shared/types'
import {
  AddWorkspaceContainer,
  AddWorkspaceStepHeader,
  AddWorkspacePrimaryButton,
  AddWorkspaceSecondaryButton,
} from './primitives'
import { AddWorkspaceStep_OpenFolder } from './AddWorkspaceStep_OpenFolder'

interface WorkspacePickerProps {
  onSelectWorkspace: (workspaceId: string) => void
}

type WorkspacePickerView = 'list' | 'create' | 'open'

export function WorkspacePicker({ onSelectWorkspace }: WorkspacePickerProps) {
  const { t } = useTranslation()
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<WorkspacePickerView>('list')
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')

  // Load workspaces from server
  useEffect(() => {
    window.electronAPI.getServerWorkspaces()
      .then(ws => {
        setWorkspaces(ws)
        setLoading(false)
      })
      .catch(err => {
        setError(err instanceof Error ? err.message : 'Failed to load workspaces')
        setLoading(false)
      })
  }, [])

  const handleCreate = useCallback(async () => {
    if (!newName.trim()) return
    setCreating(true)
    try {
      const ws = await window.electronAPI.createServerWorkspace(newName.trim())
      onSelectWorkspace(ws.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create workspace')
      setCreating(false)
    }
  }, [newName, onSelectWorkspace])

  const handleOpenFolder = useCallback(async (folderPath: string, name: string) => {
    setCreating(true)
    try {
      const workspace = await window.electronAPI.createWorkspace(folderPath, name)
      onSelectWorkspace(workspace.id)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to open workspace folder'
      toast.error(t('toast.failedToCreateWorkspace'), { description: message })
      setCreating(false)
    }
  }, [onSelectWorkspace, t])

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-sidebar px-4">
        <AddWorkspaceContainer>
          <Spinner className="h-6 w-6" />
          <p className="mt-3 text-sm text-muted-foreground">{t("workspace.loadingWorkspaces")}</p>
        </AddWorkspaceContainer>
      </div>
    )
  }

  if (view === 'open') {
    return (
      <div className="flex h-screen items-center justify-center bg-sidebar px-4">
        <AddWorkspaceStep_OpenFolder
          onBack={() => setView('list')}
          onCreate={handleOpenFolder}
          isCreating={creating}
        />
      </div>
    )
  }

  const showWorkspaceList = view === 'list'

  return (
    <div className="flex h-screen items-center justify-center bg-sidebar px-4">
      <AddWorkspaceContainer>
        {showWorkspaceList ? (
          <AddWorkspaceStepHeader
            title={t("workspace.selectWorkspace")}
            description={t("workspace.selectWorkspaceDesc")}
          />
        ) : (
          <div className="flex w-full items-center">
            <button
              type="button"
              onClick={() => setView('list')}
              className="flex h-8 w-8 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
              aria-label={t("common.back")}
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <AddWorkspaceStepHeader
              title={t("workspace.createWorkspace")}
              description={t("workspace.createWorkspaceDesc")}
              className="flex-1 pr-8"
            />
          </div>
        )}

        {error && (
          <p className="mt-3 w-full text-center text-sm text-destructive">{error}</p>
        )}

        {showWorkspaceList && workspaces.length > 0 && (
          <div className="mt-5 w-full space-y-1.5">
            {workspaces.map(ws => (
              <button
                key={ws.id}
                onClick={() => onSelectWorkspace(ws.id)}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors hover:bg-foreground/5"
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent text-xs font-semibold uppercase">
                  {ws.name.charAt(0)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{ws.name}</div>
                  <div className="truncate text-xs text-muted-foreground">{ws.slug}</div>
                </div>
              </button>
            ))}
          </div>
        )}

        {showWorkspaceList ? (
          <div className="mt-5 w-full space-y-2">
            <AddWorkspacePrimaryButton
              onClick={() => setView('create')}
              className="bg-accent text-white hover:bg-accent/90"
            >
              <Plus className="mr-1.5 h-4 w-4" />
              {t("workspace.createWorkspace")}
            </AddWorkspacePrimaryButton>
            <AddWorkspaceSecondaryButton
              onClick={() => setView('open')}
              className="h-9 w-full"
            >
              <FolderOpen className="mr-1.5 h-4 w-4" />
              {t("workspace.openFolder")}
            </AddWorkspaceSecondaryButton>
          </div>
        ) : (
          <div className="mt-5 w-full space-y-2">
            <input
              type="text"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleCreate()}
              placeholder={t("workspace.newWorkspaceName")}
              className="w-full rounded-md border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
              autoFocus
            />
            <AddWorkspacePrimaryButton
              onClick={handleCreate}
              disabled={!newName.trim()}
              loading={creating}
              loadingText={t("workspace.creating")}
              className="bg-accent hover:bg-accent/90 text-white"
            >
              <Plus className="mr-1.5 h-4 w-4" />
              {t("workspace.createWorkspace")}
            </AddWorkspacePrimaryButton>
          </div>
        )}
      </AddWorkspaceContainer>
    </div>
  )
}
