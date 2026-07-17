import * as React from 'react'
import Papa from 'papaparse'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Document, Page, pdfjs } from 'react-pdf'
import {
  AlertCircle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clipboard,
  File,
  FileArchive,
  FileCode2,
  FileImage,
  FileJson,
  FilePlus2,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  GitCompare,
  PanelRight,
  Pencil,
  RefreshCw,
  Save,
  Search,
  Trash2,
  Undo2,
  Eye,
  X,
} from 'lucide-react'
import { Markdown, Spinner } from '@craft-agent/ui'
import type {
  WorkspaceDirectoryListing,
  WorkspaceFileEntry,
  WorkspaceFilePreview,
} from '@craft-agent/shared/protocol'
import { HeaderIconButton } from '@/components/ui/HeaderIconButton'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { RenameDialog } from '@/components/ui/rename-dialog'
import {
  ContextMenu,
  ContextMenuTrigger,
  StyledContextMenuContent,
  StyledContextMenuItem,
  StyledContextMenuSeparator,
} from '@/components/ui/styled-context-menu'
import { ShikiCodeViewer, ShikiDiffViewer } from '@/components/shiki'
import { useAppShellContext } from '@/context/AppShellContext'
import { useWorkspaceElectronApi } from '@/context/WorkspaceElectronApiContext'
import * as storage from '@/lib/local-storage'
import { registerWindowCloseFlusher } from '@/lib/window-close-flush'
import { registerWorkspaceTransitionFlusher } from '@/lib/workspace-transition'
import { useRegisterModal } from '@/context/ModalContext'
import { cn } from '@/lib/utils'
import {
  WorkspaceFileDraftQueue,
  type WorkspaceFileDraftMutation,
} from './file-workbench-draft-queue'
import { FILE_WORKBENCH_SEMANTIC_IDS } from './file-workbench-semantics'
import {
  createFileWorkbenchPersistPolicy,
  deleteFileWorkbenchPersistedPaths,
  hasWorkspaceFileConflict,
  isWorkspaceFileEditorDirty,
  isWorkspaceFileSaveShortcut,
  languageForWorkspaceFile,
  normalizeFileWorkbenchPersistedState,
  remapWorkspacePath,
  renameFileWorkbenchPersistedPaths,
  renameWorkspaceFileEditorPath,
  restoreWorkspaceFileEditor,
  shouldProtectWorkspaceFileTab,
  shouldReconcileWorkspaceFileAfterDirtyTransition,
  workspaceFileSaveExpectation,
  workspaceEntryMutationBlockedByDirtyEditor,
  workspacePathIsWithin,
  type FileWorkbenchPersistedState,
  type FileWorkbenchViewMode,
  type WorkspaceFileEditorState,
} from './file-workbench-state'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import './file-workbench.css'

pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorker

export interface FileWorkbenchProtection {
  dirty: boolean
}

interface FileWorkbenchProps {
  workspaceId: string
  onProtectionChange?: (protection: FileWorkbenchProtection) => void
}

type WorkspaceEntryNameDialogState =
  | { kind: 'create'; type: WorkspaceFileEntry['type']; parentPath: string; value: string }
  | { kind: 'rename'; entry: WorkspaceFileEntry; value: string }

const MAX_TABLE_ROWS = 1000
const MAX_TABLE_COLUMNS = 100
const MAX_EDITOR_BYTES = 2 * 1024 * 1024

export function FileWorkbench({ workspaceId, onProtectionChange }: FileWorkbenchProps) {
  const { t } = useTranslation()
  const electronApi = useWorkspaceElectronApi()
  const { workspaces } = useAppShellContext()
  const workspace = workspaces.find(candidate => candidate.id === workspaceId)
  const policy = React.useMemo(() => createFileWorkbenchPersistPolicy(workspaceId), [workspaceId])
  const [persisted, setPersisted] = React.useState<FileWorkbenchPersistedState>(() =>
    normalizeFileWorkbenchPersistedState(storage.get(
      storage.KEYS.fileWorkbenchState,
      policy.defaultValue,
      policy.storageSuffix,
    )),
  )
  const persistedRef = React.useRef(persisted)
  const [directories, setDirectories] = React.useState<Record<string, WorkspaceDirectoryListing>>({})
  const directoriesRef = React.useRef(directories)
  const [loadingDirectories, setLoadingDirectories] = React.useState<Set<string>>(new Set())
  const loadingDirectoriesRef = React.useRef(new Set<string>())
  const [treeError, setTreeError] = React.useState<string | null>(null)
  const [searchResults, setSearchResults] = React.useState<WorkspaceFileEntry[] | null>(null)
  const [searching, setSearching] = React.useState(false)
  const [searchError, setSearchError] = React.useState<string | null>(null)
  const [preview, setPreview] = React.useState<WorkspaceFilePreview | null>(null)
  const [editor, setEditor] = React.useState<WorkspaceFileEditorState | null>(null)
  const editorRef = React.useRef(editor)
  const [previewLoading, setPreviewLoading] = React.useState(false)
  const [previewError, setPreviewError] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [draftError, setDraftError] = React.useState<string | null>(null)
  const [draftPersistencePending, setDraftPersistencePending] = React.useState(false)
  const [protectionHydrated, setProtectionHydrated] = React.useState(!persisted.selectedFile)
  const [filesystemRevision, setFilesystemRevision] = React.useState(0)
  const [entryNameDialog, setEntryNameDialog] = React.useState<WorkspaceEntryNameDialogState | null>(null)
  const [deleteTarget, setDeleteTarget] = React.useState<WorkspaceFileEntry | null>(null)
  const [entryMutationPending, setEntryMutationPending] = React.useState(false)
  const [entryMutationError, setEntryMutationError] = React.useState<string | null>(null)
  const previewRequest = React.useRef(0)
  const searchRequest = React.useRef(0)
  const draftQueueRef = React.useRef<WorkspaceFileDraftQueue | null>(null)
  if (!draftQueueRef.current) {
    draftQueueRef.current = new WorkspaceFileDraftQueue({
      set: (relativePath, content, baseContent) =>
        electronApi.setWorkspaceFileDraft(relativePath, content, baseContent),
      delete: relativePath => electronApi.deleteWorkspaceFileDraft(relativePath),
    }, {
      onPendingChange: setDraftPersistencePending,
    })
  }

  const dirty = isWorkspaceFileEditorDirty(editor)
  const previousDirtyRef = React.useRef(dirty)
  const tabProtected = shouldProtectWorkspaceFileTab(editor, draftPersistencePending)
  const conflict = hasWorkspaceFileConflict(editor)

  React.useEffect(() => {
    directoriesRef.current = directories
  }, [directories])

  React.useEffect(() => {
    persistedRef.current = persisted
  }, [persisted])

  React.useEffect(() => {
    editorRef.current = editor
  }, [editor])

  React.useEffect(() => {
    storage.set(storage.KEYS.fileWorkbenchState, persisted, policy.storageSuffix)
  }, [persisted, policy.storageSuffix])

  const enqueueDraftMutation = React.useCallback((mutation: WorkspaceFileDraftMutation) => {
    void draftQueueRef.current!.enqueue(mutation).then(
      () => setDraftError(null),
      reason => setDraftError(reason instanceof Error ? reason.message : String(reason)),
    )
  }, [])

  const flushDraftQueue = React.useCallback(async () => {
    const current = editorRef.current
    const latest: WorkspaceFileDraftMutation | undefined = current
      && isWorkspaceFileEditorDirty(current)
      ? {
          type: 'set',
          relativePath: current.relativePath,
          content: current.content,
          baseContent: current.baseContent,
        }
      : undefined
    try {
      await draftQueueRef.current!.flush(latest)
      setDraftError(null)
    } catch (reason) {
      setDraftError(reason instanceof Error ? reason.message : String(reason))
      throw reason
    }
  }, [])

  React.useEffect(() => {
    const unregisterWindow = registerWindowCloseFlusher(flushDraftQueue)
    const unregisterWorkspace = registerWorkspaceTransitionFlusher(workspaceId, flushDraftQueue)
    return () => {
      unregisterWorkspace()
      unregisterWindow()
    }
  }, [flushDraftQueue, workspaceId])

  React.useEffect(() => {
    if (!editor) return
    if (dirty) {
      enqueueDraftMutation({
        type: 'set',
        relativePath: editor.relativePath,
        content: editor.content,
        baseContent: editor.baseContent,
      })
    } else {
      enqueueDraftMutation({ type: 'delete', relativePath: editor.relativePath })
    }
  }, [dirty, editor, enqueueDraftMutation])

  React.useEffect(() => {
    if (!protectionHydrated) return
    onProtectionChange?.({ dirty: tabProtected })
  }, [onProtectionChange, protectionHydrated, tabProtected])

  React.useEffect(() => {
    if (!tabProtected) return
    const protectReload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', protectReload)
    return () => window.removeEventListener('beforeunload', protectReload)
  }, [tabProtected])

  React.useEffect(() => {
    if (!persisted.treeOpen) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setPersisted(previous => ({ ...previous, treeOpen: false }))
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [persisted.treeOpen])

  const loadDirectory = React.useCallback(async (relativePath: string, force = false) => {
    if (!force && directoriesRef.current[relativePath]) return
    if (loadingDirectoriesRef.current.has(relativePath)) return
    loadingDirectoriesRef.current.add(relativePath)
    setLoadingDirectories(new Set(loadingDirectoriesRef.current))
    setTreeError(null)
    try {
      const listing = await electronApi.listWorkspaceDirectory(relativePath)
      setDirectories(previous => {
        const next = { ...previous, [relativePath]: listing }
        directoriesRef.current = next
        return next
      })
    } catch (reason) {
      setTreeError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      loadingDirectoriesRef.current.delete(relativePath)
      setLoadingDirectories(new Set(loadingDirectoriesRef.current))
    }
  }, [electronApi])

  React.useEffect(() => {
    void loadDirectory('')
  }, [loadDirectory])

  React.useEffect(() => {
    for (const relativePath of persisted.expandedDirectories) {
      void loadDirectory(relativePath)
    }
  }, [loadDirectory, persisted.expandedDirectories])

  React.useEffect(() => {
    const query = persisted.filter.trim()
    const requestId = ++searchRequest.current
    if (!query) {
      setSearchResults(null)
      setSearching(false)
      setSearchError(null)
      return
    }
    setSearching(true)
    setSearchError(null)
    const timer = window.setTimeout(() => {
      void electronApi.searchWorkspaceFiles(query).then(results => {
        if (searchRequest.current === requestId) {
          setSearchResults(results)
          setSearchError(null)
        }
      }).catch(reason => {
        if (searchRequest.current === requestId) {
          setSearchResults([])
          setSearchError(reason instanceof Error ? reason.message : String(reason))
        }
      }).finally(() => {
        if (searchRequest.current === requestId) setSearching(false)
      })
    }, 180)
    return () => window.clearTimeout(timer)
  }, [electronApi, filesystemRevision, persisted.filter])

  const loadPreview = React.useCallback(async (
    relativePath: string,
    options: { preserveEditor?: boolean } = {},
  ) => {
    const requestId = ++previewRequest.current
    setProtectionHydrated(false)
    if (!options.preserveEditor) setEditor(null)
    setPreviewLoading(true)
    setPreviewError(null)
    try {
      const result = await electronApi.readWorkspaceFilePreview(relativePath)
      if (previewRequest.current !== requestId) return
      setPreview(result)

      const currentContent = editableWorkspacePreviewContent(result)
      if (currentContent === null) {
        setEditor(null)
        setProtectionHydrated(true)
        return
      }

      const currentEditor = editorRef.current
      if (
        options.preserveEditor
        && currentEditor?.relativePath === relativePath
        && isWorkspaceFileEditorDirty(currentEditor)
      ) {
        setEditor({
          ...currentEditor,
          currentContent,
          conflictAcknowledged: false,
        })
        if (currentEditor.baseContent !== currentContent) {
          setPersisted(previous => ({ ...previous, viewMode: 'diff' }))
        }
        setProtectionHydrated(true)
        return
      }

      let draft = null
      try {
        draft = await electronApi.readWorkspaceFileDraft(relativePath)
      } catch (reason) {
        setDraftError(reason instanceof Error ? reason.message : String(reason))
        return
      }
      if (previewRequest.current !== requestId) return
      const restored = restoreWorkspaceFileEditor(relativePath, currentContent, draft)
      setEditor(restored)
      setProtectionHydrated(true)
      if (isWorkspaceFileEditorDirty(restored)) {
        setPersisted(previous => ({
          ...previous,
          viewMode: hasWorkspaceFileConflict(restored) ? 'diff' : 'edit',
        }))
      }
    } catch (reason) {
      if (previewRequest.current === requestId) {
        setPreview(null)
        setEditor(null)
        setPreviewError(reason instanceof Error ? reason.message : String(reason))
      }
    } finally {
      if (previewRequest.current === requestId) setPreviewLoading(false)
    }
  }, [electronApi])

  React.useEffect(() => {
    if (!persisted.selectedFile) {
      setPreview(null)
      setEditor(null)
      setPreviewError(null)
      setProtectionHydrated(true)
      return
    }
    void loadPreview(persisted.selectedFile)
  }, [loadPreview, persisted.selectedFile])

  const expandedDirectories = React.useMemo(
    () => new Set(persisted.expandedDirectories),
    [persisted.expandedDirectories],
  )

  const toggleDirectory = React.useCallback((relativePath: string) => {
    setPersisted(previous => {
      const expanded = new Set(previous.expandedDirectories)
      if (expanded.has(relativePath)) expanded.delete(relativePath)
      else expanded.add(relativePath)
      return { ...previous, expandedDirectories: Array.from(expanded) }
    })
  }, [])

  const selectFile = React.useCallback((relativePath: string) => {
    const currentEditor = editorRef.current
    if (
      currentEditor
      && currentEditor.relativePath !== relativePath
      && isWorkspaceFileEditorDirty(currentEditor)
    ) {
      toast.warning(t('workbench.unsavedChanges'))
      return
    }
    setPersisted(previous => ({ ...previous, selectedFile: relativePath, treeOpen: false }))
  }, [t])

  const selectSearchDirectory = React.useCallback((relativePath: string) => {
    setPersisted(previous => {
      const expanded = new Set(previous.expandedDirectories)
      const parts = relativePath.split('/')
      for (let index = 1; index <= parts.length; index += 1) {
        expanded.add(parts.slice(0, index).join('/'))
      }
      return {
        ...previous,
        filter: '',
        expandedDirectories: Array.from(expanded),
        treeOpen: true,
      }
    })
  }, [])

  const refreshTree = React.useCallback(async () => {
    directoriesRef.current = {}
    setDirectories({})
    const paths = ['', ...persistedRef.current.expandedDirectories]
    await Promise.all(paths.map(path => loadDirectory(path, true)))
  }, [loadDirectory])

  const copySelectedPath = React.useCallback(async () => {
    if (!persisted.selectedFile) return
    await navigator.clipboard.writeText(persisted.selectedFile)
    toast.success(t('common.copied'))
  }, [persisted.selectedFile, t])

  const setViewMode = React.useCallback((viewMode: FileWorkbenchViewMode) => {
    if (viewMode !== 'preview' && !editorRef.current) return
    setPersisted(previous => ({ ...previous, viewMode }))
  }, [])

  const updateEditorContent = React.useCallback((content: string) => {
    if (new Blob([content]).size > MAX_EDITOR_BYTES) {
      toast.error(t('workbench.fileTooLarge'))
      return
    }
    setEditor(previous => previous ? { ...previous, content } : previous)
  }, [t])

  const saveEditor = React.useCallback(async () => {
    const current = editorRef.current
    if (!current || !isWorkspaceFileEditorDirty(current) || saving) return
    setSaving(true)
    try {
      const result = await electronApi.writeWorkspaceTextFile(
        current.relativePath,
        current.content,
        workspaceFileSaveExpectation(current),
      )
      if (result.status === 'conflict') {
        setPreview(previous => replaceWorkspacePreviewContent(previous, current.relativePath, result.currentContent))
        setEditor(previous => previous?.relativePath === current.relativePath
          ? {
              ...previous,
              currentContent: result.currentContent,
              conflictAcknowledged: true,
            }
          : previous)
        setPersisted(previous => ({ ...previous, viewMode: 'diff' }))
        toast.warning(t('workbench.fileChangedExternally'))
        return
      }

      const saved = current.content
      setPreview(previous => replaceWorkspacePreviewContent(previous, current.relativePath, saved))
      setEditor(previous => previous?.relativePath === current.relativePath
        ? {
            ...previous,
            baseContent: saved,
            content: saved,
            currentContent: saved,
            conflictAcknowledged: false,
          }
        : previous)
      enqueueDraftMutation({ type: 'delete', relativePath: current.relativePath })
      setPersisted(previous => ({ ...previous, viewMode: 'preview' }))
      toast.success(t('workbench.fileSaved'))
    } catch (reason) {
      setDraftError(reason instanceof Error ? reason.message : String(reason))
      toast.error(t('workbench.fileSaveFailed'))
    } finally {
      setSaving(false)
    }
  }, [electronApi, enqueueDraftMutation, saving, t])

  React.useEffect(() => {
    if (!editor) return
    const saveOnShortcut = (event: KeyboardEvent) => {
      if (!isWorkspaceFileSaveShortcut(event)) return
      event.preventDefault()
      void saveEditor()
    }
    window.addEventListener('keydown', saveOnShortcut)
    return () => window.removeEventListener('keydown', saveOnShortcut)
  }, [editor, saveEditor])

  const revertEditor = React.useCallback(() => {
    const current = editorRef.current
    if (!current) return
    setPreview(previous => replaceWorkspacePreviewContent(previous, current.relativePath, current.currentContent))
    setEditor({
      relativePath: current.relativePath,
      baseContent: current.currentContent,
      content: current.currentContent,
      currentContent: current.currentContent,
      conflictAcknowledged: false,
    })
    enqueueDraftMutation({ type: 'delete', relativePath: current.relativePath })
    setPersisted(previous => ({ ...previous, viewMode: 'preview' }))
  }, [enqueueDraftMutation])

  const refreshSelectedFile = React.useCallback(() => {
    if (!persisted.selectedFile) return
    void loadPreview(persisted.selectedFile, { preserveEditor: true })
  }, [loadPreview, persisted.selectedFile])

  const clearSelectedFile = React.useCallback((relativePath: string) => {
    const next = deleteFileWorkbenchPersistedPaths(persistedRef.current, relativePath)
    persistedRef.current = next
    setPersisted(next)
    previewRequest.current += 1
    editorRef.current = null
    setPreview(null)
    setEditor(null)
    setPreviewError(null)
    setProtectionHydrated(true)
  }, [])

  const reconcileSelectedFile = React.useCallback(async () => {
    const selectedFile = persistedRef.current.selectedFile
    if (!selectedFile || isWorkspaceFileEditorDirty(editorRef.current)) return
    const parentPath = workspaceEntryParentPath(selectedFile)
    try {
      const listing = await electronApi.listWorkspaceDirectory(parentPath)
      if (!listing.entries.some(entry => entry.relativePath === selectedFile)) {
        clearSelectedFile(selectedFile)
        return
      }
      await loadPreview(selectedFile, { preserveEditor: true })
    } catch (reason) {
      if (isMissingWorkspaceEntryError(reason)) clearSelectedFile(selectedFile)
      else setTreeError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [clearSelectedFile, electronApi, loadPreview])

  React.useEffect(() => {
    const wasDirty = previousDirtyRef.current
    previousDirtyRef.current = dirty
    if (shouldReconcileWorkspaceFileAfterDirtyTransition(wasDirty, dirty)) {
      void reconcileSelectedFile()
    }
  }, [dirty, reconcileSelectedFile])

  const handleWorkspaceFilesChanged = React.useCallback(async () => {
    setFilesystemRevision(revision => revision + 1)
    await Promise.allSettled([
      refreshTree(),
      reconcileSelectedFile(),
    ])
  }, [reconcileSelectedFile, refreshTree])

  React.useEffect(() => {
    let disposed = false
    const restoreWatch = async (refresh: boolean) => {
      try {
        await electronApi.watchWorkspaceFiles()
        if (disposed) return
        if (refresh) await handleWorkspaceFilesChanged()
      } catch (reason) {
        if (!disposed) setTreeError(reason instanceof Error ? reason.message : String(reason))
      }
    }
    const unsubscribeChanged = electronApi.onWorkspaceFilesChanged(() => {
      if (!disposed) void handleWorkspaceFilesChanged()
    })
    const unsubscribeReconnect = electronApi.onReconnected(() => {
      if (!disposed) void restoreWatch(true)
    })
    void restoreWatch(false)
    return () => {
      disposed = true
      unsubscribeChanged()
      unsubscribeReconnect()
      void electronApi.unwatchWorkspaceFiles()
    }
  }, [electronApi, handleWorkspaceFilesChanged])

  const beginCreateEntry = React.useCallback((type: WorkspaceFileEntry['type'], parentPath = '') => {
    setEntryMutationError(null)
    setEntryNameDialog({ kind: 'create', type, parentPath, value: '' })
  }, [])

  const beginRenameEntry = React.useCallback((entry: WorkspaceFileEntry) => {
    if (workspaceEntryMutationBlockedByDirtyEditor(entry.relativePath, editorRef.current)) {
      toast.warning(t('workbench.unsavedChanges'))
      return
    }
    setEntryMutationError(null)
    setEntryNameDialog({ kind: 'rename', entry, value: entry.name })
  }, [t])

  const beginDeleteEntry = React.useCallback((entry: WorkspaceFileEntry) => {
    if (workspaceEntryMutationBlockedByDirtyEditor(entry.relativePath, editorRef.current)) {
      toast.warning(t('workbench.unsavedChanges'))
      return
    }
    setEntryMutationError(null)
    setDeleteTarget(entry)
  }, [t])

  const submitEntryNameDialog = React.useCallback(async () => {
    const dialog = entryNameDialog
    if (!dialog || entryMutationPending) return
    const name = dialog.value.trim()
    if (!isValidWorkspaceEntryName(name)) {
      setEntryMutationError(t('workbench.invalidEntryName'))
      return
    }
    setEntryMutationPending(true)
    setEntryMutationError(null)
    try {
      if (dialog.kind === 'create') {
        const relativePath = workspaceChildRelativePath(dialog.parentPath, name)
        await electronApi.createWorkspaceEntry(relativePath, dialog.type)
        const currentEditor = editorRef.current
        if (dialog.type === 'file' && !isWorkspaceFileEditorDirty(currentEditor)) {
          const next = { ...persistedRef.current, selectedFile: relativePath, treeOpen: false }
          persistedRef.current = next
          setPersisted(next)
        } else if (dialog.parentPath) {
          const expanded = new Set(persistedRef.current.expandedDirectories)
          expanded.add(dialog.parentPath)
          const next = { ...persistedRef.current, expandedDirectories: [...expanded] }
          persistedRef.current = next
          setPersisted(next)
        }
        setFilesystemRevision(revision => revision + 1)
        await loadDirectory(dialog.parentPath, true)
        toast.success(t('workbench.entryCreated'))
      } else {
        if (workspaceEntryMutationBlockedByDirtyEditor(dialog.entry.relativePath, editorRef.current)) {
          throw new Error(t('workbench.unsavedChanges'))
        }
        await flushDraftQueue()
        const previousPath = dialog.entry.relativePath
        const nextPath = workspaceChildRelativePath(workspaceEntryParentPath(previousPath), name)
        await electronApi.renameWorkspaceEntry(previousPath, nextPath)

        const nextPersisted = renameFileWorkbenchPersistedPaths(
          persistedRef.current,
          previousPath,
          nextPath,
        )
        persistedRef.current = nextPersisted
        setPersisted(nextPersisted)
        const nextEditor = renameWorkspaceFileEditorPath(editorRef.current, previousPath, nextPath)
        editorRef.current = nextEditor
        setEditor(nextEditor)
        setPreview(previous => renameWorkspacePreviewPath(previous, previousPath, nextPath))
        setFilesystemRevision(revision => revision + 1)
        await refreshTree()
        toast.success(t('workbench.entryRenamed'))
      }
      setEntryNameDialog(null)
    } catch (reason) {
      const message = workspaceEntryMutationError(reason, t)
      setEntryMutationError(message)
      toast.error(message)
    } finally {
      setEntryMutationPending(false)
    }
  }, [electronApi, entryMutationPending, entryNameDialog, flushDraftQueue, loadDirectory, refreshTree, t])

  const confirmDeleteEntry = React.useCallback(async () => {
    const entry = deleteTarget
    if (!entry || entryMutationPending) return
    if (workspaceEntryMutationBlockedByDirtyEditor(entry.relativePath, editorRef.current)) {
      setEntryMutationError(t('workbench.unsavedChanges'))
      return
    }
    setEntryMutationPending(true)
    setEntryMutationError(null)
    try {
      await flushDraftQueue()
      await electronApi.deleteWorkspaceEntry(entry.relativePath, entry.type === 'directory')
      const selectedFile = persistedRef.current.selectedFile
      const selectionDeleted = Boolean(
        selectedFile && workspacePathIsWithin(selectedFile, entry.relativePath),
      )
      const next = deleteFileWorkbenchPersistedPaths(persistedRef.current, entry.relativePath)
      persistedRef.current = next
      setPersisted(next)
      if (selectionDeleted) {
        previewRequest.current += 1
        editorRef.current = null
        setPreview(null)
        setEditor(null)
        setPreviewError(null)
        setProtectionHydrated(true)
      }
      setFilesystemRevision(revision => revision + 1)
      await refreshTree()
      setDeleteTarget(null)
      toast.success(t('workbench.entryDeleted'))
    } catch (reason) {
      const message = workspaceEntryMutationError(reason, t)
      setEntryMutationError(message)
      toast.error(message)
    } finally {
      setEntryMutationPending(false)
    }
  }, [deleteTarget, electronApi, entryMutationPending, flushDraftQueue, refreshTree, t])

  const effectiveViewMode: FileWorkbenchViewMode = editor ? persisted.viewMode : 'preview'

  return (
    <section
      data-craft-semantic-id="workspace.files"
      data-tree-open={persisted.treeOpen}
      data-dirty={dirty}
      data-draft-persistence-pending={draftPersistencePending}
      className="craft-file-workbench-shell relative h-full min-h-0 overflow-hidden bg-background"
      aria-label={t('workbench.files')}
    >
      <div className="craft-file-workbench-layout h-full min-h-0">
        <main className="flex min-h-0 min-w-0 flex-col bg-background">
          <FilePreviewHeader
            selectedPath={persisted.selectedFile}
            preview={preview}
            editor={editor}
            viewMode={effectiveViewMode}
            dirty={dirty}
            conflict={conflict}
            loading={previewLoading}
            saving={saving}
            onCopyPath={() => void copySelectedPath()}
            onRefresh={refreshSelectedFile}
            onViewModeChange={setViewMode}
            onSave={() => void saveEditor()}
            onRevert={revertEditor}
            onToggleTree={() => setPersisted(previous => ({ ...previous, treeOpen: !previous.treeOpen }))}
          />
          {draftError && (
            <div role="alert" className="shrink-0 border-b border-destructive/20 bg-destructive/6 px-3 py-1.5 text-[11px] leading-4 text-destructive">
              {t('workbench.fileSaveFailed')}: {draftError}
            </div>
          )}
          <WorkspacePreviewContent
            selectedPath={persisted.selectedFile}
            preview={preview}
            editor={editor}
            viewMode={effectiveViewMode}
            saving={saving}
            loading={previewLoading}
            error={previewError}
            onEditorChange={updateEditorContent}
          />
        </main>

        <button
          type="button"
          className="craft-file-tree-backdrop"
          aria-label={t('workbench.closeFileTree')}
          onClick={() => setPersisted(previous => ({ ...previous, treeOpen: false }))}
        />

        <aside
          data-craft-semantic-id="workspace.files.tree"
          className="craft-file-workbench-tree min-h-0 min-w-0 bg-background"
          aria-label={t('workbench.fileTree')}
        >
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 px-3">
            <Folder className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{workspace?.name ?? t('workbench.files')}</span>
            <HeaderIconButton
              icon={<FilePlus2 className="size-3.5" />}
              tooltip={t('workbench.newFile')}
              aria-label={t('workbench.newFile')}
              data-craft-semantic-id={FILE_WORKBENCH_SEMANTIC_IDS.createFile}
              disabled={entryMutationPending}
              onClick={() => beginCreateEntry('file')}
            />
            <HeaderIconButton
              icon={<FolderPlus className="size-3.5" />}
              tooltip={t('workbench.newFolder')}
              aria-label={t('workbench.newFolder')}
              data-craft-semantic-id={FILE_WORKBENCH_SEMANTIC_IDS.createFolder}
              disabled={entryMutationPending}
              onClick={() => beginCreateEntry('directory')}
            />
            <HeaderIconButton
              icon={<RefreshCw className={cn('size-3.5', loadingDirectories.size > 0 && 'animate-spin')} />}
              tooltip={t('workbench.refreshFiles')}
              aria-label={t('workbench.refreshFiles')}
              data-craft-semantic-id={FILE_WORKBENCH_SEMANTIC_IDS.refreshTree}
              onClick={() => void refreshTree()}
            />
            <HeaderIconButton
              icon={<X className="size-3.5" />}
              className="craft-file-tree-close"
              tooltip={t('workbench.closeFileTree')}
              aria-label={t('workbench.closeFileTree')}
              data-craft-semantic-id={FILE_WORKBENCH_SEMANTIC_IDS.closeTree}
              onClick={() => setPersisted(previous => ({ ...previous, treeOpen: false }))}
            />
          </div>
          <div className="border-b border-border/50 p-2">
            <label className="relative block">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                value={persisted.filter}
                onChange={event => setPersisted(previous => ({ ...previous, filter: event.target.value.slice(0, 120) }))}
                placeholder={t('workbench.filterFiles')}
                aria-label={t('workbench.filterFiles')}
                data-craft-semantic-id="workspace.files.filter"
                className="h-8 w-full rounded-[5px] border border-border/70 bg-background pl-8 pr-8 text-xs outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:ring-1 focus:ring-ring"
              />
              {persisted.filter && (
                <button
                  type="button"
                  onClick={() => setPersisted(previous => ({ ...previous, filter: '' }))}
                  className="absolute right-1.5 top-1/2 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded-[4px] text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
                  aria-label={t('common.clear')}
                >
                  <X className="size-3.5" />
                </button>
              )}
            </label>
            {entryMutationError && !entryNameDialog && !deleteTarget && (
              <div role="alert" className="mt-2 rounded-[4px] bg-destructive/8 px-2 py-1.5 text-[11px] leading-4 text-destructive">
                {entryMutationError}
              </div>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-1 py-1.5">
            <WorkspaceFileTree
              rootListing={directories['']}
              directories={directories}
              loadingDirectories={loadingDirectories}
              expandedDirectories={expandedDirectories}
              selectedFile={persisted.selectedFile}
              searchResults={searchResults}
              searching={searching}
              error={searchResults !== null ? searchError : treeError}
              onToggleDirectory={toggleDirectory}
              onSelectFile={selectFile}
              onSelectDirectory={selectSearchDirectory}
              onCreateEntry={beginCreateEntry}
              onRenameEntry={beginRenameEntry}
              onDeleteEntry={beginDeleteEntry}
              dirtyEditorPath={dirty ? editor?.relativePath ?? null : null}
              mutationPending={entryMutationPending}
            />
          </div>
        </aside>
      </div>
      <RenameDialog
        open={Boolean(entryNameDialog)}
        onOpenChange={open => {
          if (!open && !entryMutationPending) {
            setEntryNameDialog(null)
            setEntryMutationError(null)
          }
        }}
        title={entryNameDialog?.kind === 'create'
          ? t(entryNameDialog.type === 'file' ? 'workbench.createFile' : 'workbench.createFolder')
          : t('workbench.renameEntry')}
        value={entryNameDialog?.value ?? ''}
        onValueChange={value => setEntryNameDialog(previous => previous ? { ...previous, value } : previous)}
        onSubmit={() => void submitEntryNameDialog()}
        submitLabel={t(entryNameDialog?.kind === 'create' ? 'common.create' : 'common.rename')}
        submitting={entryMutationPending}
        error={entryMutationError}
      />
      <DeleteWorkspaceEntryDialog
        entry={deleteTarget}
        pending={entryMutationPending}
        error={deleteTarget ? entryMutationError : null}
        onOpenChange={open => {
          if (!open && !entryMutationPending) {
            setDeleteTarget(null)
            setEntryMutationError(null)
          }
        }}
        onConfirm={() => void confirmDeleteEntry()}
      />
    </section>
  )
}

function FilePreviewHeader({
  selectedPath,
  preview,
  editor,
  viewMode,
  dirty,
  conflict,
  loading,
  saving,
  onCopyPath,
  onRefresh,
  onViewModeChange,
  onSave,
  onRevert,
  onToggleTree,
}: {
  selectedPath: string | null
  preview: WorkspaceFilePreview | null
  editor: WorkspaceFileEditorState | null
  viewMode: FileWorkbenchViewMode
  dirty: boolean
  conflict: boolean
  loading: boolean
  saving: boolean
  onCopyPath: () => void
  onRefresh: () => void
  onViewModeChange: (mode: FileWorkbenchViewMode) => void
  onSave: () => void
  onRevert: () => void
  onToggleTree: () => void
}) {
  const { t } = useTranslation()
  const name = selectedPath?.split('/').pop() ?? t('workbench.openFile')
  const Icon = fileIconForPath(selectedPath ?? '')
  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 px-3">
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-medium">{name}</span>
          {dirty && (
            <span
              className="size-1.5 shrink-0 rounded-full bg-foreground/60"
              aria-label={t('workbench.unsavedChanges')}
              title={t('workbench.unsavedChanges')}
            />
          )}
        </div>
        {selectedPath && selectedPath !== name && (
          <div className="truncate text-[11px] text-muted-foreground">{selectedPath}</div>
        )}
      </div>
      {preview && (
        <span className="craft-file-preview-size shrink-0 text-[11px] tabular-nums text-muted-foreground">{formatFileSize(preview.size)}</span>
      )}
      {editor && (
        <div
          role="tablist"
          aria-label={t('workbench.fileModes')}
          className="craft-file-editor-modes flex h-7 shrink-0 items-center overflow-hidden rounded-[5px] border border-border/70 bg-foreground/[0.025]"
        >
          {([
            ['preview', Eye, t('workbench.preview')],
            ['edit', Pencil, t('workbench.edit')],
            ['diff', GitCompare, conflict ? t('workbench.fileChangedExternally') : t('workbench.diff')],
          ] as const).map(([mode, ModeIcon, label]) => (
            <button
              key={mode}
              type="button"
              role="tab"
              aria-selected={viewMode === mode}
              aria-label={label}
              title={label}
              data-craft-semantic-id={`workspace.files.mode.${mode}`}
              onClick={() => onViewModeChange(mode)}
              className={cn(
                'inline-flex size-7 items-center justify-center border-r border-border/60 text-muted-foreground outline-none transition-colors last:border-r-0 hover:bg-foreground/5 hover:text-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring',
                viewMode === mode && 'bg-foreground/8 text-foreground',
                mode === 'diff' && conflict && 'text-destructive',
              )}
            >
              <ModeIcon className="size-3.5" />
            </button>
          ))}
        </div>
      )}
      {editor && dirty && (
        <>
          <HeaderIconButton
            icon={<Undo2 className="size-3.5" />}
            tooltip={t('common.revert')}
            aria-label={t('common.revert')}
            data-craft-semantic-id={FILE_WORKBENCH_SEMANTIC_IDS.revert}
            onClick={onRevert}
          />
          <HeaderIconButton
            icon={<Save className="size-3.5" />}
            tooltip={conflict ? t('workbench.compareLatest') : t('common.save')}
            aria-label={t('common.save')}
            data-craft-semantic-id={FILE_WORKBENCH_SEMANTIC_IDS.save}
            disabled={loading || saving}
            onClick={onSave}
          />
        </>
      )}
      <HeaderIconButton
        icon={<Clipboard className="size-3.5" />}
        className="craft-file-copy-action"
        tooltip={t('common.copyPath')}
        aria-label={t('common.copyPath')}
        data-craft-semantic-id={FILE_WORKBENCH_SEMANTIC_IDS.copyPath}
        disabled={!selectedPath}
        onClick={onCopyPath}
      />
      <HeaderIconButton
        icon={<RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />}
        className="craft-file-refresh-action"
        tooltip={t('workbench.refreshPreview')}
        aria-label={t('workbench.refreshPreview')}
        data-craft-semantic-id={FILE_WORKBENCH_SEMANTIC_IDS.refreshPreview}
        disabled={!selectedPath || loading}
        onClick={onRefresh}
      />
      <HeaderIconButton
        icon={<PanelRight className="size-3.5" />}
        className="craft-file-tree-toggle"
        tooltip={t('workbench.toggleFileTree')}
        aria-label={t('workbench.toggleFileTree')}
        data-craft-semantic-id={FILE_WORKBENCH_SEMANTIC_IDS.toggleTree}
        onClick={onToggleTree}
      />
    </header>
  )
}

function WorkspacePreviewContent({
  selectedPath,
  preview,
  editor,
  viewMode,
  saving,
  loading,
  error,
  onEditorChange,
}: {
  selectedPath: string | null
  preview: WorkspaceFilePreview | null
  editor: WorkspaceFileEditorState | null
  viewMode: FileWorkbenchViewMode
  saving: boolean
  loading: boolean
  error: string | null
  onEditorChange: (content: string) => void
}) {
  const { t } = useTranslation()
  if (loading) {
    return <PreviewState icon={<Spinner className="size-5" />} label={t('common.loading')} />
  }
  if (error) {
    return <PreviewState icon={<AlertCircle className="size-5" />} label={t('workbench.fileLoadFailed')} detail={error} tone="error" />
  }
  if (!selectedPath || !preview) {
    return <PreviewState icon={<FolderOpen className="size-7" />} label={t('workbench.openFile')} detail={t('workbench.chooseFromFileTree')} />
  }

  if (editor && viewMode === 'edit') {
    return (
      <textarea
        data-craft-semantic-id="workspace.files.editor"
        value={editor.content}
        onChange={event => onEditorChange(event.target.value)}
        readOnly={saving}
        spellCheck={false}
        aria-label={t('workbench.edit')}
        className="min-h-0 flex-1 resize-none overflow-auto border-0 bg-background p-4 font-mono text-[13px] leading-5 text-foreground outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
      />
    )
  }

  if (editor && viewMode === 'diff') {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {hasWorkspaceFileConflict(editor) && (
          <div role="status" className="shrink-0 border-b border-destructive/20 bg-destructive/6 px-3 py-2 text-xs text-destructive">
            {t('workbench.fileChangedExternally')}
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-auto">
          <ShikiDiffViewer
            original={editor.currentContent}
            modified={editor.content}
            filePath={editor.relativePath}
            language={languageForWorkspaceFile(editor.relativePath)}
            diffStyle="unified"
            className="min-h-full"
          />
        </div>
      </div>
    )
  }

  const renderedPreview: WorkspaceFilePreview = (
    editor && editor.relativePath === preview.relativePath
      ? replaceWorkspacePreviewContent(preview, editor.relativePath, editor.content)
      : preview
  ) ?? preview

  switch (renderedPreview.kind) {
    case 'image':
      return (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-foreground/[0.018] p-6">
          <img src={renderedPreview.dataUrl} alt={renderedPreview.name} className="max-h-full max-w-full object-contain" />
        </div>
      )
    case 'pdf':
      return <InlinePdfPreview data={renderedPreview.data} />
    case 'markdown':
      return (
        <div className="min-h-0 flex-1 overflow-auto">
          {renderedPreview.source === 'converted' && (
            <div className="border-b border-border/50 px-6 py-2 text-xs text-muted-foreground">
              {renderedPreview.truncated ? t('workbench.convertedPreviewTruncated') : t('workbench.convertedPreview')}
            </div>
          )}
          <article className="mx-auto max-w-5xl px-7 py-6 text-sm leading-6">
            <Markdown mode="minimal" allowRawHtml={false}>{renderedPreview.content}</Markdown>
          </article>
        </div>
      )
    case 'table':
      return <DelimitedTablePreview content={renderedPreview.content} delimiter={renderedPreview.delimiter} />
    case 'text':
      return (
        <div className="min-h-0 flex-1 overflow-hidden">
          <ShikiCodeViewer
            code={renderedPreview.content}
            filePath={renderedPreview.relativePath}
            language={languageForWorkspaceFile(renderedPreview.relativePath)}
            className="h-full"
          />
        </div>
      )
    case 'unsupported':
      return (
        <PreviewState
          icon={<FileArchive className="size-6" />}
          label={renderedPreview.reason === 'too-large' ? t('workbench.fileTooLarge') : t('workbench.fileUnsupported')}
          detail={renderedPreview.maxBytes ? t('workbench.filePreviewLimit', { size: formatFileSize(renderedPreview.maxBytes) }) : renderedPreview.name}
        />
      )
  }
}

function PreviewState({
  icon,
  label,
  detail,
  tone = 'default',
}: {
  icon: React.ReactNode
  label: string
  detail?: string
  tone?: 'default' | 'error'
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-8 text-center">
      <div className={cn('max-w-sm', tone === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
        <div className="mx-auto mb-3 flex size-10 items-center justify-center">{icon}</div>
        <div className="text-sm font-medium text-foreground">{label}</div>
        {detail && <div className="mt-1 break-words text-xs leading-5 opacity-80">{detail}</div>}
      </div>
    </div>
  )
}

function WorkspaceFileTree({
  rootListing,
  directories,
  loadingDirectories,
  expandedDirectories,
  selectedFile,
  searchResults,
  searching,
  error,
  onToggleDirectory,
  onSelectFile,
  onSelectDirectory,
  onCreateEntry,
  onRenameEntry,
  onDeleteEntry,
  dirtyEditorPath,
  mutationPending,
}: {
  rootListing?: WorkspaceDirectoryListing
  directories: Record<string, WorkspaceDirectoryListing>
  loadingDirectories: Set<string>
  expandedDirectories: Set<string>
  selectedFile: string | null
  searchResults: WorkspaceFileEntry[] | null
  searching: boolean
  error: string | null
  onToggleDirectory: (relativePath: string) => void
  onSelectFile: (relativePath: string) => void
  onSelectDirectory: (relativePath: string) => void
  onCreateEntry: (type: WorkspaceFileEntry['type'], parentPath?: string) => void
  onRenameEntry: (entry: WorkspaceFileEntry) => void
  onDeleteEntry: (entry: WorkspaceFileEntry) => void
  dirtyEditorPath: string | null
  mutationPending: boolean
}) {
  const { t } = useTranslation()
  if (searching) return <div className="flex h-24 items-center justify-center"><Spinner className="size-4" /></div>
  if (searchResults) {
    if (error) return <div role="alert" className="px-3 py-6 text-xs leading-5 text-destructive">{error}</div>
    if (searchResults.length === 0) return <div className="px-3 py-8 text-center text-xs text-muted-foreground">{t('workbench.noFileResults')}</div>
    return (
      <div role="list" aria-label={t('workbench.fileSearchResults')}>
        {searchResults.map(entry => (
          <SearchResultRow
            key={entry.relativePath}
            entry={entry}
            selected={selectedFile === entry.relativePath}
            onSelectFile={onSelectFile}
            onSelectDirectory={onSelectDirectory}
            onCreateEntry={onCreateEntry}
            onRenameEntry={onRenameEntry}
            onDeleteEntry={onDeleteEntry}
            dirtyEditorPath={dirtyEditorPath}
            mutationPending={mutationPending}
          />
        ))}
      </div>
    )
  }
  if (!rootListing && loadingDirectories.has('')) return <div className="flex h-24 items-center justify-center"><Spinner className="size-4" /></div>
  if (!rootListing && error) return <div className="px-3 py-6 text-xs leading-5 text-destructive">{error}</div>
  if (!rootListing || rootListing.entries.length === 0) return <div className="px-3 py-8 text-center text-xs text-muted-foreground">{t('workbench.fileTreeEmpty')}</div>
  return (
    <>
      {error && <div role="alert" className="mx-1 mb-1 rounded-[4px] bg-destructive/8 px-2 py-1.5 text-[11px] leading-4 text-destructive">{error}</div>}
      <div role="tree" aria-label={t('workbench.fileTree')}>
        {rootListing.entries.map(entry => (
          <WorkspaceFileTreeEntry
            key={entry.relativePath}
            entry={entry}
            depth={0}
            directories={directories}
            loadingDirectories={loadingDirectories}
            expandedDirectories={expandedDirectories}
            selectedFile={selectedFile}
            onToggleDirectory={onToggleDirectory}
            onSelectFile={onSelectFile}
            onCreateEntry={onCreateEntry}
            onRenameEntry={onRenameEntry}
            onDeleteEntry={onDeleteEntry}
            dirtyEditorPath={dirtyEditorPath}
            mutationPending={mutationPending}
          />
        ))}
        {rootListing.truncated && (
          <div className="px-3 py-2 text-[11px] text-muted-foreground">
            {t('workbench.fileTreeTruncated', { shown: rootListing.entries.length, count: rootListing.totalEntries })}
          </div>
        )}
      </div>
    </>
  )
}

function WorkspaceFileTreeEntry({
  entry,
  depth,
  directories,
  loadingDirectories,
  expandedDirectories,
  selectedFile,
  onToggleDirectory,
  onSelectFile,
  onCreateEntry,
  onRenameEntry,
  onDeleteEntry,
  dirtyEditorPath,
  mutationPending,
}: {
  entry: WorkspaceFileEntry
  depth: number
  directories: Record<string, WorkspaceDirectoryListing>
  loadingDirectories: Set<string>
  expandedDirectories: Set<string>
  selectedFile: string | null
  onToggleDirectory: (relativePath: string) => void
  onSelectFile: (relativePath: string) => void
  onCreateEntry: (type: WorkspaceFileEntry['type'], parentPath?: string) => void
  onRenameEntry: (entry: WorkspaceFileEntry) => void
  onDeleteEntry: (entry: WorkspaceFileEntry) => void
  dirtyEditorPath: string | null
  mutationPending: boolean
}) {
  const { t } = useTranslation()
  const isDirectory = entry.type === 'directory'
  const expanded = isDirectory && expandedDirectories.has(entry.relativePath)
  const listing = directories[entry.relativePath]
  const Icon = isDirectory ? (expanded ? FolderOpen : Folder) : fileIconForPath(entry.relativePath)
  return (
    <div role="treeitem" aria-expanded={isDirectory ? expanded : undefined}>
      <WorkspaceEntryContextMenu
        entry={entry}
        onCreateEntry={onCreateEntry}
        onRenameEntry={onRenameEntry}
        onDeleteEntry={onDeleteEntry}
        destructiveActionsDisabled={mutationPending || Boolean(
          dirtyEditorPath && workspacePathIsWithin(dirtyEditorPath, entry.relativePath),
        )}
      >
        <button
          type="button"
          data-craft-semantic-id={`workspace.files.entry.${encodeURIComponent(entry.relativePath)}`}
          onClick={() => isDirectory ? onToggleDirectory(entry.relativePath) : onSelectFile(entry.relativePath)}
          className={cn(
            'flex h-7 w-full min-w-0 items-center gap-1.5 rounded-[4px] pr-2 text-left text-xs outline-none transition-colors hover:bg-foreground/4 focus-visible:ring-1 focus-visible:ring-ring',
            !isDirectory && selectedFile === entry.relativePath && 'bg-foreground/6 text-foreground',
          )}
          style={{ paddingLeft: `${6 + depth * 14}px` }}
          title={entry.relativePath}
        >
          {isDirectory ? (
            expanded ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          ) : <span className="w-3.5 shrink-0" />}
          <Icon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{entry.name}</span>
        </button>
      </WorkspaceEntryContextMenu>
      {expanded && (
        <div role="group">
          {loadingDirectories.has(entry.relativePath) && !listing ? (
            <div className="flex h-7 items-center" style={{ paddingLeft: `${34 + depth * 14}px` }}><Spinner className="size-3" /></div>
          ) : listing?.entries.map(child => (
            <WorkspaceFileTreeEntry
              key={child.relativePath}
              entry={child}
              depth={depth + 1}
              directories={directories}
              loadingDirectories={loadingDirectories}
              expandedDirectories={expandedDirectories}
              selectedFile={selectedFile}
              onToggleDirectory={onToggleDirectory}
              onSelectFile={onSelectFile}
              onCreateEntry={onCreateEntry}
              onRenameEntry={onRenameEntry}
              onDeleteEntry={onDeleteEntry}
              dirtyEditorPath={dirtyEditorPath}
              mutationPending={mutationPending}
            />
          ))}
          {listing?.truncated && (
            <div
              className="py-1.5 pr-2 text-[11px] leading-4 text-muted-foreground"
              style={{ paddingLeft: `${34 + depth * 14}px` }}
            >
              {t('workbench.fileTreeTruncated', {
                shown: listing.entries.length,
                count: listing.totalEntries,
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function SearchResultRow({
  entry,
  selected,
  onSelectFile,
  onSelectDirectory,
  onCreateEntry,
  onRenameEntry,
  onDeleteEntry,
  dirtyEditorPath,
  mutationPending,
}: {
  entry: WorkspaceFileEntry
  selected: boolean
  onSelectFile: (relativePath: string) => void
  onSelectDirectory: (relativePath: string) => void
  onCreateEntry: (type: WorkspaceFileEntry['type'], parentPath?: string) => void
  onRenameEntry: (entry: WorkspaceFileEntry) => void
  onDeleteEntry: (entry: WorkspaceFileEntry) => void
  dirtyEditorPath: string | null
  mutationPending: boolean
}) {
  const Icon = entry.type === 'directory' ? Folder : fileIconForPath(entry.relativePath)
  return (
    <WorkspaceEntryContextMenu
      entry={entry}
      onCreateEntry={onCreateEntry}
      onRenameEntry={onRenameEntry}
      onDeleteEntry={onDeleteEntry}
      destructiveActionsDisabled={mutationPending || Boolean(
        dirtyEditorPath && workspacePathIsWithin(dirtyEditorPath, entry.relativePath),
      )}
    >
      <button
        type="button"
        role="listitem"
        onClick={() => entry.type === 'directory'
          ? onSelectDirectory(entry.relativePath)
          : onSelectFile(entry.relativePath)}
        className={cn(
          'flex min-h-9 w-full min-w-0 items-center gap-2 rounded-[4px] px-2 py-1 text-left outline-none transition-colors hover:bg-foreground/4 focus-visible:ring-1 focus-visible:ring-ring',
          selected && 'bg-foreground/6',
        )}
        title={entry.relativePath}
      >
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs text-foreground">{entry.name}</span>
          <span className="block truncate text-[10px] text-muted-foreground">{entry.relativePath}</span>
        </span>
      </button>
    </WorkspaceEntryContextMenu>
  )
}

function WorkspaceEntryContextMenu({
  entry,
  children,
  onCreateEntry,
  onRenameEntry,
  onDeleteEntry,
  destructiveActionsDisabled,
}: {
  entry: WorkspaceFileEntry
  children: React.ReactElement
  onCreateEntry: (type: WorkspaceFileEntry['type'], parentPath?: string) => void
  onRenameEntry: (entry: WorkspaceFileEntry) => void
  onDeleteEntry: (entry: WorkspaceFileEntry) => void
  destructiveActionsDisabled: boolean
}) {
  const { t } = useTranslation()
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <StyledContextMenuContent>
        {entry.type === 'directory' && (
          <>
            <StyledContextMenuItem onSelect={() => onCreateEntry('file', entry.relativePath)}>
              <FilePlus2 />
              {t('workbench.newFile')}
            </StyledContextMenuItem>
            <StyledContextMenuItem onSelect={() => onCreateEntry('directory', entry.relativePath)}>
              <FolderPlus />
              {t('workbench.newFolder')}
            </StyledContextMenuItem>
            <StyledContextMenuSeparator />
          </>
        )}
        <StyledContextMenuItem
          disabled={destructiveActionsDisabled}
          onSelect={() => onRenameEntry(entry)}
        >
          <Pencil />
          {t('common.rename')}
        </StyledContextMenuItem>
        <StyledContextMenuItem
          disabled={destructiveActionsDisabled}
          variant="destructive"
          onSelect={() => onDeleteEntry(entry)}
        >
          <Trash2 />
          {t('common.delete')}
        </StyledContextMenuItem>
      </StyledContextMenuContent>
    </ContextMenu>
  )
}

function DeleteWorkspaceEntryDialog({
  entry,
  pending,
  error,
  onOpenChange,
  onConfirm,
}: {
  entry: WorkspaceFileEntry | null
  pending: boolean
  error: string | null
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}) {
  const { t } = useTranslation()
  const open = Boolean(entry)
  useRegisterModal(open, () => onOpenChange(false))
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent semanticId="workspace.files.delete-confirmation" className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{t('workbench.deleteEntry')}</DialogTitle>
          <DialogDescription>
            {entry?.type === 'directory'
              ? t('workbench.deleteFolderConfirm', { name: entry.name })
              : t('workbench.deleteFileConfirm', { name: entry?.name ?? '' })}
          </DialogDescription>
        </DialogHeader>
        {error && <div role="alert" className="rounded-[5px] bg-destructive/8 px-3 py-2 text-xs text-destructive">{error}</div>}
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button variant="destructive" disabled={pending} onClick={onConfirm}>
            {t('common.delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DelimitedTablePreview({ content, delimiter }: { content: string; delimiter: ',' | '\t' }) {
  const { t } = useTranslation()
  const parsed = React.useMemo(() => Papa.parse<string[]>(content, {
    delimiter,
    skipEmptyLines: 'greedy',
  }), [content, delimiter])
  const rows = parsed.data.filter(row => row.some(cell => String(cell).length > 0))
  if (rows.length === 0) return <PreviewState icon={<FileSpreadsheet className="size-6" />} label={t('workbench.tableEmpty')} />
  const columnCount = Math.min(MAX_TABLE_COLUMNS, Math.max(...rows.map(row => row.length)))
  const headers = Array.from({ length: columnCount }, (_, index) => String(rows[0]?.[index] ?? `#${index + 1}`))
  const body = rows.slice(1, MAX_TABLE_ROWS + 1)
  const truncated = rows.length > MAX_TABLE_ROWS + 1 || rows.some(row => row.length > MAX_TABLE_COLUMNS)
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="w-max min-w-full border-separate border-spacing-0 text-xs">
        <thead className="sticky top-0 z-10 bg-background">
          <tr>
            <th className="h-8 border-b border-r border-border/70 bg-foreground/[0.025] px-2 text-right font-normal text-muted-foreground">#</th>
            {headers.map((header, index) => (
              <th key={`${header}-${index}`} className="h-8 max-w-80 border-b border-r border-border/70 bg-foreground/[0.025] px-3 text-left font-medium">
                <span className="block truncate">{header}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, rowIndex) => (
            <tr key={rowIndex} className="hover:bg-foreground/[0.02]">
              <td className="h-8 border-b border-r border-border/50 px-2 text-right tabular-nums text-muted-foreground">{rowIndex + 1}</td>
              {headers.map((_, columnIndex) => (
                <td key={columnIndex} className="h-8 max-w-80 border-b border-r border-border/50 px-3 align-top">
                  <span className="block max-w-80 truncate" title={String(row[columnIndex] ?? '')}>{String(row[columnIndex] ?? '')}</span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {truncated && <div className="sticky bottom-0 border-t border-border/60 bg-background px-3 py-2 text-[11px] text-muted-foreground">{t('workbench.tableTruncated')}</div>}
    </div>
  )
}

function InlinePdfPreview({ data }: { data: Uint8Array }) {
  const { t } = useTranslation()
  const containerRef = React.useRef<HTMLDivElement>(null)
  const [width, setWidth] = React.useState(760)
  const [numPages, setNumPages] = React.useState(0)
  const [currentPage, setCurrentPage] = React.useState(1)
  const [error, setError] = React.useState<string | null>(null)
  const file = React.useMemo(() => ({ data: new Uint8Array(data) }), [data])
  React.useEffect(() => {
    setNumPages(0)
    setCurrentPage(1)
    setError(null)
  }, [file])
  React.useEffect(() => {
    const element = containerRef.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(entries => {
      const nextWidth = entries[0]?.contentRect.width
      if (nextWidth) setWidth(nextWidth)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  if (error) return <PreviewState icon={<AlertCircle className="size-5" />} label={t('workbench.fileLoadFailed')} detail={error} tone="error" />
  return (
    <div ref={containerRef} className="min-h-0 flex-1 overflow-auto bg-foreground/[0.025]">
      {numPages > 0 && (
        <div className="sticky top-0 z-20 flex h-10 items-center justify-center gap-2 border-b border-border/60 bg-background/95 px-3 backdrop-blur-sm">
          <HeaderIconButton
            icon={<ChevronLeft className="size-3.5" />}
            tooltip={t('workbench.previousPage')}
            aria-label={t('workbench.previousPage')}
            disabled={currentPage <= 1}
            onClick={() => setCurrentPage(page => Math.max(1, page - 1))}
          />
          <span className="min-w-20 text-center text-xs tabular-nums text-muted-foreground">
            {t('workbench.pdfPageCount', { page: currentPage, count: numPages })}
          </span>
          <HeaderIconButton
            icon={<ChevronRight className="size-3.5" />}
            tooltip={t('workbench.nextPage')}
            aria-label={t('workbench.nextPage')}
            disabled={currentPage >= numPages}
            onClick={() => setCurrentPage(page => Math.min(numPages, page + 1))}
          />
        </div>
      )}
      <Document
        file={file}
        onLoadSuccess={({ numPages: pages }) => {
          setNumPages(pages)
          setCurrentPage(page => Math.min(Math.max(1, page), pages))
        }}
        onLoadError={reason => setError(reason.message)}
        loading={<div className="flex h-24 items-center justify-center"><Spinner className="size-5" /></div>}
        className="px-4 py-5"
      >
        {numPages > 0 && (
          <Page
            key={currentPage}
            pageNumber={currentPage}
            width={Math.max(280, Math.min(width - 32, 960))}
            renderAnnotationLayer
            renderTextLayer
            className="mx-auto shadow-minimal"
          />
        )}
      </Document>
    </div>
  )
}

function workspaceEntryParentPath(relativePath: string): string {
  const separator = relativePath.lastIndexOf('/')
  return separator < 0 ? '' : relativePath.slice(0, separator)
}

function workspaceChildRelativePath(parentPath: string, name: string): string {
  return parentPath ? `${parentPath}/${name}` : name
}

function isValidWorkspaceEntryName(name: string): boolean {
  return Boolean(name)
    && name !== '.'
    && name !== '..'
    && !/[\\/\0]/.test(name)
}

function isMissingWorkspaceEntryError(reason: unknown): boolean {
  const message = reason instanceof Error ? reason.message : String(reason)
  return /\bENOENT\b|no such file or directory/i.test(message)
}

function workspaceEntryMutationError(reason: unknown, t: TFunction): string {
  const message = reason instanceof Error ? reason.message : String(reason)
  if (/Save or discard recoverable drafts/i.test(message)) {
    return t('workbench.saveOrDiscardDrafts')
  }
  return message || t('workbench.fileMutationFailed')
}

function renameWorkspacePreviewPath(
  preview: WorkspaceFilePreview | null,
  previousPrefix: string,
  nextPrefix: string,
): WorkspaceFilePreview | null {
  if (!preview || !workspacePathIsWithin(preview.relativePath, previousPrefix)) return preview
  const relativePath = remapWorkspacePath(preview.relativePath, previousPrefix, nextPrefix)
  const name = relativePath.split('/').pop() ?? relativePath
  return {
    ...preview,
    relativePath,
    name,
    extension: name.includes('.') ? name.split('.').pop()?.toLowerCase() ?? '' : '',
  }
}

function editableWorkspacePreviewContent(preview: WorkspaceFilePreview): string | null {
  if (preview.kind === 'text' || preview.kind === 'table') return preview.content
  if (preview.kind === 'markdown' && preview.source === 'native') return preview.content
  return null
}

function replaceWorkspacePreviewContent(
  preview: WorkspaceFilePreview | null,
  relativePath: string,
  content: string,
): WorkspaceFilePreview | null {
  if (!preview || preview.relativePath !== relativePath) return preview
  const size = new Blob([content]).size
  if (preview.kind === 'text' || preview.kind === 'table') {
    return { ...preview, content, size, truncated: false }
  }
  if (preview.kind === 'markdown' && preview.source === 'native') {
    return { ...preview, content, size, truncated: false }
  }
  return preview
}

function fileIconForPath(path: string): React.ComponentType<{ className?: string }> {
  const extension = path.split('.').pop()?.toLowerCase() ?? ''
  if (['csv', 'tsv', 'xls', 'xlsx'].includes(extension)) return FileSpreadsheet
  if (['avif', 'bmp', 'gif', 'ico', 'jpeg', 'jpg', 'png', 'svg', 'webp'].includes(extension)) return FileImage
  if (extension === 'json' || extension === 'jsonl') return FileJson
  if (['7z', 'gz', 'rar', 'tar', 'zip'].includes(extension)) return FileArchive
  if (['c', 'cpp', 'css', 'go', 'h', 'html', 'java', 'js', 'jsx', 'kt', 'php', 'py', 'rb', 'rs', 'sh', 'sql', 'swift', 'ts', 'tsx', 'vue', 'xml', 'yaml', 'yml'].includes(extension)) return FileCode2
  if (['doc', 'docx', 'md', 'mdx', 'pdf', 'ppt', 'pptx', 'rtf', 'txt'].includes(extension)) return FileText
  return File
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
