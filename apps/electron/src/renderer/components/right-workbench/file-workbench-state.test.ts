import { describe, expect, it } from 'bun:test'
import {
  createFileWorkbenchPersistPolicy,
  fileWorkbenchStorageScope,
  hasWorkspaceFileConflict,
  isWorkspaceFileEditorDirty,
  isWorkspaceFileSaveShortcut,
  languageForWorkspaceFile,
  deleteFileWorkbenchPersistedPaths,
  normalizeFileWorkbenchPersistedState,
  renameFileWorkbenchPersistedPaths,
  renameWorkspaceFileEditorPath,
  remapWorkspacePath,
  restoreWorkspaceFileEditor,
  shouldProtectWorkspaceFileTab,
  shouldReconcileWorkspaceFileAfterDirtyTransition,
  workspaceFileSaveExpectation,
  workspaceEntryMutationBlockedByDirtyEditor,
} from './file-workbench-state'
import * as storage from '../../lib/local-storage'

describe('file workbench state', () => {
  it('isolates persisted state by workspace', () => {
    expect(fileWorkbenchStorageScope('workspace-a')).not.toBe(fileWorkbenchStorageScope('workspace-b'))
    const policy = createFileWorkbenchPersistPolicy('workspace-a')
    expect(policy).toMatchObject({
      key: 'mortise-file-workbench.workspace:workspace_workspace-a.state.v2',
      kind: 'normal',
      scopeId: 'workspace_workspace-a',
    })
    expect(storage.getKeyString(storage.KEYS.fileWorkbenchState, policy.storageSuffix)).toBe(policy.key)
  })

  it('restores only bounded workspace-relative values', () => {
    expect(normalizeFileWorkbenchPersistedState({
      selectedFile: 'docs/readme.md',
      filter: 'a'.repeat(200),
      expandedDirectories: ['docs', 'docs', '../outside', '/absolute'],
      treeOpen: true,
    })).toEqual({
      selectedFile: 'docs/readme.md',
      filter: 'a'.repeat(120),
      expandedDirectories: ['docs'],
      treeOpen: true,
      viewMode: 'preview',
    })
  })

  it('falls back safely for malformed state', () => {
    expect(normalizeFileWorkbenchPersistedState('broken')).toEqual({
      selectedFile: null,
      filter: '',
      expandedDirectories: [],
      treeOpen: false,
      viewMode: 'preview',
    })
  })

  it('never admits file contents into the normal localStorage state', () => {
    const normalized = normalizeFileWorkbenchPersistedState({
      selectedFile: 'notes.txt',
      content: 'private draft',
      baseContent: 'private original',
    })

    expect(normalized).not.toHaveProperty('content')
    expect(normalized).not.toHaveProperty('baseContent')
  })

  it('derives a language from the file extension', () => {
    expect(languageForWorkspaceFile('src/main.ts')).toBe('ts')
    expect(languageForWorkspaceFile('LICENSE')).toBe('text')
  })

  it('restores a dirty draft while retaining the latest disk contents for conflict checks', () => {
    const editor = restoreWorkspaceFileEditor('notes.txt', 'external update', {
      relativePath: 'notes.txt',
      content: 'my draft',
      baseContent: 'original',
    })

    expect(isWorkspaceFileEditorDirty(editor)).toBe(true)
    expect(hasWorkspaceFileConflict(editor)).toBe(true)
    expect(workspaceFileSaveExpectation(editor)).toBe('original')

    editor.conflictAcknowledged = true
    expect(workspaceFileSaveExpectation(editor)).toBe('external update')
  })

  it('ignores a draft belonging to another resource', () => {
    const editor = restoreWorkspaceFileEditor('alpha.txt', 'alpha', {
      relativePath: 'beta.txt',
      content: 'beta draft',
      baseContent: 'beta',
    })
    expect(editor.content).toBe('alpha')
    expect(isWorkspaceFileEditorDirty(editor)).toBe(false)
  })

  it('re-establishes dirty protection when an on-demand tab remounts', () => {
    const remounted = restoreWorkspaceFileEditor('notes.txt', 'saved version', {
      relativePath: 'notes.txt',
      content: 'recoverable edit',
      baseContent: 'saved version',
    })

    expect(isWorkspaceFileEditorDirty(remounted)).toBe(true)
  })

  it('keeps the tab protected while a clean draft deletion still needs retrying', () => {
    const clean = restoreWorkspaceFileEditor('notes.txt', 'saved version', null)
    expect(isWorkspaceFileEditorDirty(clean)).toBe(false)
    expect(shouldProtectWorkspaceFileTab(clean, true)).toBe(true)
    expect(shouldProtectWorkspaceFileTab(clean, false)).toBe(false)
  })

  it('recognizes Ctrl+S and Cmd+S as editor save shortcuts', () => {
    const base = { key: 's', ctrlKey: false, metaKey: false, altKey: false }
    expect(isWorkspaceFileSaveShortcut({ ...base, ctrlKey: true })).toBe(true)
    expect(isWorkspaceFileSaveShortcut({ ...base, metaKey: true })).toBe(true)
    expect(isWorkspaceFileSaveShortcut(base)).toBe(false)
    expect(isWorkspaceFileSaveShortcut({ ...base, ctrlKey: true, altKey: true })).toBe(false)
  })

  it('remaps selected and expanded paths after a file or directory rename', () => {
    const state = renameFileWorkbenchPersistedPaths({
      selectedFile: 'docs/guides/readme.md',
      filter: 'readme',
      expandedDirectories: ['docs', 'docs/guides', 'other'],
      treeOpen: true,
      viewMode: 'edit',
    }, 'docs', 'documentation')

    expect(state).toEqual({
      selectedFile: 'documentation/guides/readme.md',
      filter: 'readme',
      expandedDirectories: ['documentation', 'documentation/guides', 'other'],
      treeOpen: true,
      viewMode: 'edit',
    })
    expect(remapWorkspacePath('docs-archive/readme.md', 'docs', 'documentation'))
      .toBe('docs-archive/readme.md')
    expect(renameWorkspaceFileEditorPath({
      relativePath: 'docs/guides/readme.md',
      baseContent: 'base',
      content: 'base',
      currentContent: 'base',
      conflictAcknowledged: false,
    }, 'docs', 'documentation')?.relativePath).toBe('documentation/guides/readme.md')
  })

  it('clears only state owned by a deleted file or directory prefix', () => {
    expect(deleteFileWorkbenchPersistedPaths({
      selectedFile: 'docs/guides/readme.md',
      filter: '',
      expandedDirectories: ['docs', 'docs/guides', 'docs-archive'],
      treeOpen: true,
      viewMode: 'diff',
    }, 'docs')).toEqual({
      selectedFile: null,
      filter: '',
      expandedDirectories: ['docs-archive'],
      treeOpen: true,
      viewMode: 'preview',
    })
  })

  it('blocks dirty mutations only for the edited file or one of its ancestor directories', () => {
    const dirtyEditor = {
      relativePath: 'docs/guides/readme.md',
      baseContent: 'base',
      content: 'draft',
      currentContent: 'base',
      conflictAcknowledged: false,
    }
    expect(workspaceEntryMutationBlockedByDirtyEditor('docs/guides/readme.md', dirtyEditor)).toBe(true)
    expect(workspaceEntryMutationBlockedByDirtyEditor('docs', dirtyEditor)).toBe(true)
    expect(workspaceEntryMutationBlockedByDirtyEditor('docs-archive', dirtyEditor)).toBe(false)
    expect(workspaceEntryMutationBlockedByDirtyEditor('other.txt', dirtyEditor)).toBe(false)
    expect(workspaceEntryMutationBlockedByDirtyEditor('docs', { ...dirtyEditor, content: 'base' })).toBe(false)
  })

  it('reconciles a selected file when dirty protection is released', () => {
    expect(shouldReconcileWorkspaceFileAfterDirtyTransition(true, false)).toBe(true)
    expect(shouldReconcileWorkspaceFileAfterDirtyTransition(false, false)).toBe(false)
    expect(shouldReconcileWorkspaceFileAfterDirtyTransition(true, true)).toBe(false)
  })
})
