import * as storage from './local-storage'

export interface WorkspaceCreationDraft {
  name: string
  locationPaths: string[]
  primaryLocationIndex: number | null
}

const emptyDraft = (): WorkspaceCreationDraft => ({
  name: '',
  locationPaths: [],
  primaryLocationIndex: null,
})

function rawLocationPaths(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((path): path is string => typeof path === 'string' && path.trim().length > 0)
    : []
}

export function readWorkspaceCreationDraft(): WorkspaceCreationDraft {
  const value = storage.get<Partial<WorkspaceCreationDraft>>(storage.KEYS.workspaceCreationDraft, {})
  const rawPaths = rawLocationPaths(value.locationPaths)
  const paths = [...new Set(rawPaths)]
  const persistedIndex = value.primaryLocationIndex
  const persistedPrimaryPath = Number.isInteger(persistedIndex)
    && (persistedIndex as number) >= 0
    && (persistedIndex as number) < rawPaths.length
    ? rawPaths[persistedIndex as number]
    : null
  const restoredIndex = persistedPrimaryPath === null ? -1 : paths.indexOf(persistedPrimaryPath)
  const index = restoredIndex >= 0 ? restoredIndex : paths.length > 0 ? 0 : null
  return {
    name: typeof value.name === 'string' ? value.name : '',
    locationPaths: paths,
    primaryLocationIndex: index,
  }
}

export function writeWorkspaceCreationDraft(value: WorkspaceCreationDraft): void {
  storage.set(storage.KEYS.workspaceCreationDraft, value)
}

export function clearWorkspaceCreationDraft(): void {
  storage.set(storage.KEYS.workspaceCreationDraft, emptyDraft())
}
