export type PersistFieldKind = 'normal' | 'sensitive' | 'transient'

export type PersistPolicy<T> = {
  key: string
  kind: PersistFieldKind
  scopeId?: string
  defaultValue: T
  serializer?: (value: T) => string
  deserializer?: (raw: string) => T
}

export interface FileWorkbenchPersistedState {
  selectedFile: string | null
  filter: string
  expandedDirectories: string[]
  treeOpen: boolean
  viewMode: FileWorkbenchViewMode
}

export type FileWorkbenchViewMode = 'preview' | 'edit' | 'diff'

export interface WorkspaceFileEditorState {
  relativePath: string
  /** File contents when the draft was first created. */
  baseContent: string
  /** Recoverable user edits. Never stored in localStorage. */
  content: string
  /** Latest contents observed on disk. */
  currentContent: string
  /** True only after a save attempt surfaced the current conflicting value. */
  conflictAcknowledged: boolean
}

export const DEFAULT_FILE_WORKBENCH_STATE: FileWorkbenchPersistedState = {
  selectedFile: null,
  filter: '',
  expandedDirectories: [],
  treeOpen: false,
  viewMode: 'preview',
}

const MAX_PERSISTED_DIRECTORIES = 100
const MAX_FILTER_LENGTH = 120

export function fileWorkbenchStorageScope(workspaceId: string): string {
  return `workspace_${encodeURIComponent(workspaceId)}`
}

export function createFileWorkbenchPersistPolicy(
  workspaceId: string,
): PersistPolicy<FileWorkbenchPersistedState> & { storageSuffix: string } {
  const scopeId = fileWorkbenchStorageScope(workspaceId)
  const storageSuffix = `${scopeId}.state.v2`
  return {
    key: `mortise-file-workbench.workspace:${storageSuffix}`,
    kind: 'normal',
    scopeId,
    storageSuffix,
    defaultValue: DEFAULT_FILE_WORKBENCH_STATE,
  }
}

export function normalizeFileWorkbenchPersistedState(value: unknown): FileWorkbenchPersistedState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return DEFAULT_FILE_WORKBENCH_STATE
  const record = value as Record<string, unknown>
  const selectedFile = normalizeRelativePath(record.selectedFile)
  const filter = typeof record.filter === 'string'
    ? record.filter.slice(0, MAX_FILTER_LENGTH)
    : ''
  const expandedDirectories = Array.isArray(record.expandedDirectories)
    ? Array.from(new Set(record.expandedDirectories
      .map(normalizeRelativePath)
      .filter((path): path is string => path !== null)))
      .slice(0, MAX_PERSISTED_DIRECTORIES)
    : []
  return {
    selectedFile,
    filter,
    expandedDirectories,
    treeOpen: record.treeOpen === true,
    viewMode: record.viewMode === 'edit' || record.viewMode === 'diff'
      ? record.viewMode
      : 'preview',
  }
}

export function restoreWorkspaceFileEditor(
  relativePath: string,
  currentContent: string,
  draft: { relativePath: string; content: string; baseContent: string } | null,
): WorkspaceFileEditorState {
  if (!draft || draft.relativePath !== relativePath) {
    return {
      relativePath,
      baseContent: currentContent,
      content: currentContent,
      currentContent,
      conflictAcknowledged: false,
    }
  }
  return {
    relativePath,
    baseContent: draft.baseContent,
    content: draft.content,
    currentContent,
    conflictAcknowledged: false,
  }
}

export function isWorkspaceFileEditorDirty(editor: WorkspaceFileEditorState | null): boolean {
  return Boolean(editor && editor.content !== editor.currentContent)
}

export function shouldProtectWorkspaceFileTab(
  editor: WorkspaceFileEditorState | null,
  draftPersistencePending: boolean,
): boolean {
  return isWorkspaceFileEditorDirty(editor) || draftPersistencePending
}

export function isWorkspaceFileSaveShortcut(event: {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
}): boolean {
  return !event.altKey
    && (event.ctrlKey || event.metaKey)
    && event.key.toLowerCase() === 's'
}

export function hasWorkspaceFileConflict(editor: WorkspaceFileEditorState | null): boolean {
  return Boolean(editor && editor.baseContent !== editor.currentContent)
}

export function workspaceFileSaveExpectation(editor: WorkspaceFileEditorState): string {
  return editor.conflictAcknowledged ? editor.currentContent : editor.baseContent
}

export function workspacePathIsWithin(relativePath: string, prefix: string): boolean {
  return relativePath === prefix || relativePath.startsWith(`${prefix}/`)
}

export function workspaceEntryMutationBlockedByDirtyEditor(
  entryPath: string,
  editor: WorkspaceFileEditorState | null,
): boolean {
  return isWorkspaceFileEditorDirty(editor)
    && Boolean(editor && workspacePathIsWithin(editor.relativePath, entryPath))
}

export function shouldReconcileWorkspaceFileAfterDirtyTransition(
  wasDirty: boolean,
  isDirty: boolean,
): boolean {
  return wasDirty && !isDirty
}

export function remapWorkspacePath(
  relativePath: string,
  previousPrefix: string,
  nextPrefix: string,
): string {
  if (relativePath === previousPrefix) return nextPrefix
  if (!relativePath.startsWith(`${previousPrefix}/`)) return relativePath
  return `${nextPrefix}${relativePath.slice(previousPrefix.length)}`
}

export function renameFileWorkbenchPersistedPaths(
  state: FileWorkbenchPersistedState,
  previousPrefix: string,
  nextPrefix: string,
): FileWorkbenchPersistedState {
  return {
    ...state,
    selectedFile: state.selectedFile
      ? remapWorkspacePath(state.selectedFile, previousPrefix, nextPrefix)
      : null,
    expandedDirectories: Array.from(new Set(state.expandedDirectories.map(path =>
      remapWorkspacePath(path, previousPrefix, nextPrefix)))),
  }
}

export function deleteFileWorkbenchPersistedPaths(
  state: FileWorkbenchPersistedState,
  deletedPrefix: string,
): FileWorkbenchPersistedState {
  const selectedDeleted = Boolean(
    state.selectedFile && workspacePathIsWithin(state.selectedFile, deletedPrefix),
  )
  return {
    ...state,
    selectedFile: selectedDeleted ? null : state.selectedFile,
    expandedDirectories: state.expandedDirectories.filter(path =>
      !workspacePathIsWithin(path, deletedPrefix)),
    viewMode: selectedDeleted ? 'preview' : state.viewMode,
  }
}

export function renameWorkspaceFileEditorPath(
  editor: WorkspaceFileEditorState | null,
  previousPrefix: string,
  nextPrefix: string,
): WorkspaceFileEditorState | null {
  if (!editor || !workspacePathIsWithin(editor.relativePath, previousPrefix)) return editor
  return {
    ...editor,
    relativePath: remapWorkspacePath(editor.relativePath, previousPrefix, nextPrefix),
  }
}

export function languageForWorkspaceFile(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase()
  return extension && extension !== path.toLowerCase() ? extension : 'text'
}

function normalizeRelativePath(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '')
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return null
  const parts = normalized.split('/').filter(part => part !== '' && part !== '.')
  if (parts.length === 0 || parts.some(part => part === '..')) return null
  return parts.join('/')
}
