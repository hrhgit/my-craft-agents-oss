/**
 * WorkspacePicker — shown when a thin client connects without a workspace ID.
 * Lists remote server workspaces and allows selection or creation.
 */

import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Folder, Plus } from 'lucide-react'
import { Spinner } from '@mortise/ui'
import type { WorkspaceInfo } from '../../../shared/types'
import {
  AddWorkspaceContainer,
  AddWorkspaceStepHeader,
  AddWorkspacePrimaryButton,
} from './primitives'

interface WorkspacePickerProps {
  onSelectWorkspace: (workspaceId: string) => void
}

type WorkspacePickerView = 'list' | 'create'

const pickerPanelClass = 'max-w-[30rem] rounded-lg border bg-background p-6 shadow-strong'

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

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-sidebar px-4">
        <AddWorkspaceContainer className={pickerPanelClass}>
          <Spinner className="h-6 w-6" />
          <span className="sr-only">{t("workspace.loadingWorkspaces")}</span>
        </AddWorkspaceContainer>
      </div>
    )
  }

  const showWorkspaceList = view === 'list'

  return (
    <div className="flex h-screen items-center justify-center bg-sidebar px-4">
      <AddWorkspaceContainer className={pickerPanelClass}>
        {showWorkspaceList ? (
          <AddWorkspaceStepHeader
            title={t("workspace.selectWorkspace")}
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
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-foreground/5 text-muted-foreground">
                  <Folder className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{ws.name}</div>
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
