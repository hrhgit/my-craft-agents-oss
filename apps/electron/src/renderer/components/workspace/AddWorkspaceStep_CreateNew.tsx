import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { WorkspaceCreationRequestV1 } from '@mortise/shared/protocol'

import { ServerDirectoryBrowser } from '@/components/ServerDirectoryBrowser'
import { Button } from '@/components/ui/button'
import { DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useDirectoryPicker } from '@/hooks/useDirectoryPicker'
import {
  clearWorkspaceCreationDraft,
  readWorkspaceCreationDraft,
  writeWorkspaceCreationDraft,
  type WorkspaceCreationDraft,
} from '@/lib/workspace-creation-draft'
import { AddWorkspaceContainer, AddWorkspaceStepHeader } from './primitives'
import { WorkspaceLocationCollection } from './WorkspaceLocationCollection'

interface AddWorkspaceStepCreateNewProps {
  onCancel: () => void
  onCreate: (request: WorkspaceCreationRequestV1) => Promise<void>
  isCreating: boolean
}

export function AddWorkspaceStep_CreateNew({
  onCancel,
  onCreate,
  isCreating,
}: AddWorkspaceStepCreateNewProps) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<WorkspaceCreationDraft>(readWorkspaceCreationDraft)

  useEffect(() => {
    writeWorkspaceCreationDraft(draft)
  }, [draft])

  const addLocations = useCallback((paths: string[]) => {
    setDraft(current => {
      const existing = new Set(current.locationPaths.map(path => path.toLocaleLowerCase('en-US')))
      const additions = paths.filter(path => {
        const key = path.toLocaleLowerCase('en-US')
        if (existing.has(key)) return false
        existing.add(key)
        return true
      })
      if (additions.length === 0) return current
      return {
        ...current,
        locationPaths: [...current.locationPaths, ...additions],
        primaryLocationIndex: current.primaryLocationIndex ?? 0,
      }
    })
  }, [])

  const directoryPicker = useDirectoryPicker(addLocations, { host: 'client', multiple: true })

  const removeLocation = useCallback((index: number) => {
    setDraft(current => {
      const locationPaths = current.locationPaths.filter((_, candidate) => candidate !== index)
      let primaryLocationIndex = current.primaryLocationIndex
      if (locationPaths.length === 0) primaryLocationIndex = null
      else if (primaryLocationIndex === index) primaryLocationIndex = 0
      else if (primaryLocationIndex !== null && index < primaryLocationIndex) primaryLocationIndex -= 1
      return { ...current, locationPaths, primaryLocationIndex }
    })
  }, [])

  const handleCreate = useCallback(async () => {
    const name = draft.name.trim()
    await onCreate({
      schemaVersion: 1,
      ...(name ? { name } : {}),
      locations: draft.locationPaths.map(rootPath => ({ rootPath })),
      ...(draft.primaryLocationIndex !== null
        ? { primaryLocationIndex: draft.primaryLocationIndex }
        : {}),
    })
    clearWorkspaceCreationDraft()
  }, [draft, onCreate])

  return (
    <AddWorkspaceContainer>
      <AddWorkspaceStepHeader title={t('workspace.createWorkspace')} />

      <form
        className="mt-5 space-y-5"
        onSubmit={(event) => {
          event.preventDefault()
          if (!isCreating) void handleCreate()
        }}
      >
        <div className="space-y-2.5">
          <label htmlFor="workspace-name" className="block text-sm font-medium text-foreground">
            {t('workspace.nameLabel')}
          </label>
          <Input
            id="workspace-name"
            value={draft.name}
            onChange={event => setDraft(current => ({ ...current, name: event.target.value }))}
            placeholder={t('workspace.derivedNamePlaceholder')}
            disabled={isCreating}
            autoFocus
          />
        </div>

        <WorkspaceLocationCollection
          paths={draft.locationPaths}
          primaryIndex={draft.primaryLocationIndex}
          disabled={isCreating}
          onAdd={() => void directoryPicker.pickDirectory()}
          onRemove={removeLocation}
          onSetPrimary={index => setDraft(current => ({ ...current, primaryLocationIndex: index }))}
        />

        <DialogFooter className="pt-1">
          <Button type="button" variant="outline" onClick={onCancel} disabled={isCreating}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={isCreating}>
            {isCreating ? t('workspace.creating') : t('common.create')}
          </Button>
        </DialogFooter>
      </form>

      <ServerDirectoryBrowser
        open={directoryPicker.showServerBrowser}
        mode={directoryPicker.serverBrowserMode}
        onSelect={directoryPicker.confirmServerBrowser}
        onCancel={directoryPicker.cancelServerBrowser}
      />
    </AddWorkspaceContainer>
  )
}
