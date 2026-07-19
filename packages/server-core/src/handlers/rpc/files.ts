import { chmod, readFile, writeFile, unlink, mkdir, readdir, rename, stat, lstat, realpath, rm } from 'fs/promises'
import { isAbsolute, join, dirname, extname, parse as parsePath, relative } from 'path'
import { homedir } from 'os'
import { validatePathFormat } from '../../utils/path-validation'
import { createHash, randomUUID } from 'crypto'
import {
  RPC_CHANNELS,
  type FileAttachment,
  type DirectoryListingResult,
  type WorkspaceDirectoryListing,
  type WorkspaceFileEntry,
  type WorkspaceFilePreview,
  type WorkspaceFileDraft,
  type WorkspaceEntryMutationResult,
  type WorkspaceEntryRenameResult,
  type FileTextWriteResult,
} from '@mortise/shared/protocol'
import type { StoredAttachment } from '@mortise/core/types'
import {
  ATTACHMENT_SINGLE_FILE_LIMIT_BYTES,
  ATTACHMENT_TEXT_INLINE_LIMIT_BYTES,
  readFileAttachment,
  validateImageForClaudeAPI,
  IMAGE_LIMITS,
} from '@mortise/shared/utils'
import { getSessionAttachmentsPath, validateSessionId } from '@mortise/shared/sessions'
import { getWorkspaceOrThrow } from '../utils'
import { resizeImageForAPI, inspectImageBuffer } from '@mortise/server-core/services'
import { sanitizeFilename, validateFilePath, getWorkspaceAllowedDirs, isSensitivePath } from '../utils'
import { MarkItDown } from 'markitdown-js'
import chokidar, { type FSWatcher as ChokidarWatcher } from 'chokidar'
import { pushTyped, type HandlerFn, type RpcServer } from '@mortise/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { requestClientOpenFileDialog } from '@mortise/server-core/transport'
import { setTransferableHandler } from './transfer'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.file.READ,
  RPC_CHANNELS.file.READ_DATA_URL,
  RPC_CHANNELS.file.READ_PREVIEW_DATA_URL,
  RPC_CHANNELS.file.READ_BINARY,
  RPC_CHANNELS.file.OPEN_DIALOG,
  RPC_CHANNELS.file.READ_ATTACHMENT,
  RPC_CHANNELS.file.READ_USER_ATTACHMENT,
  RPC_CHANNELS.file.STORE_ATTACHMENT,
  RPC_CHANNELS.file.GENERATE_THUMBNAIL,
  RPC_CHANNELS.fs.SEARCH,
  RPC_CHANNELS.fs.LIST_DIRECTORY,
  RPC_CHANNELS.fs.LIST_WORKSPACE_DIRECTORY,
  RPC_CHANNELS.fs.SEARCH_WORKSPACE,
  RPC_CHANNELS.fs.READ_WORKSPACE_PREVIEW,
  RPC_CHANNELS.fs.READ_WORKSPACE_DRAFT,
  RPC_CHANNELS.fs.SET_WORKSPACE_DRAFT,
  RPC_CHANNELS.fs.DELETE_WORKSPACE_DRAFT,
  RPC_CHANNELS.fs.WRITE_WORKSPACE_TEXT,
  RPC_CHANNELS.fs.CREATE_WORKSPACE_ENTRY,
  RPC_CHANNELS.fs.RENAME_WORKSPACE_ENTRY,
  RPC_CHANNELS.fs.DELETE_WORKSPACE_ENTRY,
  RPC_CHANNELS.fs.WATCH_WORKSPACE,
  RPC_CHANNELS.fs.UNWATCH_WORKSPACE,
] as const

const WORKSPACE_DIRECTORY_ENTRY_LIMIT = 1000
const WORKSPACE_SEARCH_RESULT_LIMIT = 200
const WORKSPACE_SEARCH_ENTRY_LIMIT = 20_000
const WORKSPACE_SEARCH_DIRECTORY_BATCH_SIZE = 32
const WORKSPACE_TEXT_PREVIEW_MAX_BYTES = 2 * 1024 * 1024
const WORKSPACE_RICH_PREVIEW_MAX_BYTES = 25 * 1024 * 1024
const WORKSPACE_OFFICE_PREVIEW_MAX_BYTES = 20 * 1024 * 1024
const WORKSPACE_CONVERTED_PREVIEW_MAX_CHARS = 2_000_000
const WORKSPACE_TEXT_EDITOR_MAX_BYTES = 2 * 1024 * 1024
const WORKSPACE_FILE_DRAFT_VERSION = 1
const WORKSPACE_WATCH_DEBOUNCE_MS = 120

const WORKSPACE_IMAGE_MIME_TYPES: Record<string, string> = {
  avif: 'image/avif',
  bmp: 'image/bmp',
  gif: 'image/gif',
  ico: 'image/x-icon',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
}

const WORKSPACE_OFFICE_EXTENSIONS = new Set(['docx', 'pptx', 'xlsx'])
const WORKSPACE_BINARY_EXTENSIONS = new Set([
  '7z', 'avi', 'class', 'dll', 'dmg', 'dylib', 'exe', 'gz', 'heic', 'heif', 'jar',
  'mov', 'mp3', 'mp4', 'o', 'psd', 'so', 'tar', 'tif', 'tiff', 'webm', 'zip',
])
const WORKSPACE_SEARCH_SKIPPED_DIRECTORIES = new Set([
  '.git', '.hg', '.next', '.nuxt', '.nyc_output', '.svn', '.turbo',
  '__pycache__', 'build', 'coverage', 'dist', 'node_modules', 'out', 'vendor',
])

export function normalizeWorkspaceRelativePath(value: unknown): string {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string') throw new Error('Workspace file path must be a string')
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '')
  if (normalized.includes('\0')) throw new Error('Workspace file path cannot contain null bytes')
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new Error('Workspace file path must be relative')
  }
  const parts = normalized.split('/').filter(part => part !== '' && part !== '.')
  if (parts.some(part => part === '..')) throw new Error('Workspace file path cannot traverse outside the workspace')
  return parts.join('/')
}

function getRequestWorkspaceRoot(
  ctx: { workspaceId?: string | null; webContentsId?: number | null },
  deps: HandlerDeps,
): { workspaceId: string; rootPath: string } {
  const workspaceId = ctx.workspaceId
    ?? (ctx.webContentsId != null ? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId) : undefined)
  if (!workspaceId) throw new Error('A workspace is required')
  const workspace = deps.sessionManager.getWorkspaces().find(candidate => candidate.id === workspaceId)
    ?? getWorkspaceOrThrow(workspaceId)
  return { workspaceId, rootPath: workspace.rootPath }
}

async function resolveWorkspaceRelativePath(
  ctx: { workspaceId?: string | null; webContentsId?: number | null },
  deps: HandlerDeps,
  value: unknown,
): Promise<{ relativePath: string; candidatePath: string; safePath: string; rootPath: string }> {
  const relativePath = normalizeWorkspaceRelativePath(value)
  const { rootPath } = getRequestWorkspaceRoot(ctx, deps)
  const candidatePath = relativePath ? join(rootPath, ...relativePath.split('/')) : rootPath
  const safePath = await validateFilePath(candidatePath, [rootPath], { allowHome: false, allowTmp: false })
  return { relativePath, candidatePath, safePath, rootPath }
}

async function resolveWorkspaceMutationPath(
  ctx: { workspaceId?: string | null; webContentsId?: number | null },
  deps: HandlerDeps,
  value: unknown,
) {
  const resolved = await resolveWorkspaceRelativePath(ctx, deps, value)
  if (!resolved.relativePath) throw new Error('The workspace root cannot be modified')
  if (
    isSensitivePath(resolved.candidatePath)
    || isSensitivePath(`${resolved.candidatePath}/`)
    || isSensitivePath(resolved.safePath)
    || isSensitivePath(`${resolved.safePath}/`)
  ) {
    throw new Error('Access denied: cannot modify sensitive files')
  }
  return resolved
}

async function resolveWorkspaceMutationSourcePath(
  ctx: { workspaceId?: string | null; webContentsId?: number | null },
  deps: HandlerDeps,
  value: unknown,
) {
  const relativePath = normalizeWorkspaceRelativePath(value)
  if (!relativePath) throw new Error('The workspace root cannot be modified')
  const { rootPath } = getRequestWorkspaceRoot(ctx, deps)
  const candidatePath = join(rootPath, ...relativePath.split('/'))
  await validateFilePath(dirname(candidatePath), [rootPath], { allowHome: false, allowTmp: false })
  if (isSensitivePath(candidatePath) || isSensitivePath(`${candidatePath}/`)) {
    throw new Error('Access denied: cannot modify sensitive files')
  }
  const entry = await lstat(candidatePath)
  if (!entry.isSymbolicLink()) {
    return { ...await resolveWorkspaceMutationPath(ctx, deps, relativePath), symlinkTargetValidated: true }
  }
  try {
    const safePath = await validateFilePath(candidatePath, [rootPath], { allowHome: false, allowTmp: false })
    return { relativePath, candidatePath, safePath, rootPath, symlinkTargetValidated: true }
  } catch {
    // The lexical parent is workspace-owned, so mutation may safely operate on
    // the link itself even when its target escapes, is sensitive, or is broken.
    return { relativePath, candidatePath, safePath: candidatePath, rootPath, symlinkTargetValidated: false }
  }
}

async function assertWorkspaceEntryMissing(candidatePath: string): Promise<void> {
  try {
    await lstat(candidatePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  throw new Error('A workspace entry already exists at the destination path')
}

async function workspaceMutationResult(
  relativePath: string,
  candidatePath: string,
  safePath: string,
  symlinkTargetValidated = true,
): Promise<WorkspaceEntryMutationResult> {
  const entry = await lstat(candidatePath)
  const isSymlink = entry.isSymbolicLink()
  let type: WorkspaceFileEntry['type'] | null = entry.isDirectory()
    ? 'directory'
    : entry.isFile()
      ? 'file'
      : null
  if (isSymlink && symlinkTargetValidated) {
    const target = await stat(safePath).catch(() => null)
    type = target?.isDirectory() ? 'directory' : 'file'
  } else if (isSymlink) {
    type = 'file'
  }
  if (!type) throw new Error('Workspace entry type is not supported')
  return { relativePath, type, isSymlink }
}

interface WorkspaceWatchRegistration {
  watcher: ChokidarWatcher
  workspaceId: string
  rootPath: string
  clientIds: Set<string>
  debounceTimers: Map<string, ReturnType<typeof setTimeout>>
  ready: Promise<void>
}

const workspaceWatchRegistrations = new Map<string, WorkspaceWatchRegistration>()
const clientWorkspaceWatchKeys = new Map<string, string>()
type WorkspaceWatcherFactory = (
  rootPath: string,
  options: Parameters<typeof chokidar.watch>[1],
) => ChokidarWatcher
const defaultWorkspaceWatcherFactory: WorkspaceWatcherFactory = (rootPath, options) =>
  chokidar.watch(rootPath, options)
let workspaceWatcherFactory = defaultWorkspaceWatcherFactory

function workspaceWatchKey(workspaceId: string, rootPath: string): string {
  return `${workspaceId}\0${rootPath}`
}

function shouldIgnoreWorkspaceWatchPath(rootPath: string, watchedPath: string): boolean {
  const nestedPath = relative(rootPath, watchedPath)
  if (!nestedPath) return false
  const segments = nestedPath.split(/[\\/]/).filter(Boolean)
  return segments.some(segment => WORKSPACE_SEARCH_SKIPPED_DIRECTORIES.has(segment))
    || isSensitivePath(watchedPath)
    || isSensitivePath(`${watchedPath}/`)
}

function closeWorkspaceWatchRegistration(key: string, state: WorkspaceWatchRegistration): void {
  if (workspaceWatchRegistrations.get(key) === state) workspaceWatchRegistrations.delete(key)
  for (const clientId of state.clientIds) {
    if (clientWorkspaceWatchKeys.get(clientId) === key) clientWorkspaceWatchKeys.delete(clientId)
  }
  for (const timer of state.debounceTimers.values()) clearTimeout(timer)
  state.debounceTimers.clear()
  state.clientIds.clear()
  void state.watcher.close().catch(() => {})
}

/** @internal Test seam for deterministic watcher lifecycle coverage. */
export function setWorkspaceWatcherFactoryForTesting(factory?: WorkspaceWatcherFactory): void {
  for (const [key, state] of workspaceWatchRegistrations) {
    closeWorkspaceWatchRegistration(key, state)
  }
  workspaceWatcherFactory = factory ?? defaultWorkspaceWatcherFactory
}

export function cleanupWorkspaceFileWatchForClient(clientId: string): void {
  const key = clientWorkspaceWatchKeys.get(clientId)
  if (!key) return
  clientWorkspaceWatchKeys.delete(clientId)
  const state = workspaceWatchRegistrations.get(key)
  if (!state) return
  const timer = state.debounceTimers.get(clientId)
  if (timer) clearTimeout(timer)
  state.debounceTimers.delete(clientId)
  state.clientIds.delete(clientId)
  if (state.clientIds.size === 0) closeWorkspaceWatchRegistration(key, state)
}

function createWorkspaceWatchRegistration(
  server: RpcServer,
  deps: HandlerDeps,
  workspaceId: string,
  rootPath: string,
): WorkspaceWatchRegistration {
  let resolveReady!: () => void
  let rejectReady!: (error: Error) => void
  let readySettled = false
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const watcher = workspaceWatcherFactory(rootPath, {
    ignored: watchedPath => shouldIgnoreWorkspaceWatchPath(rootPath, watchedPath),
    ignoreInitial: true,
    followSymlinks: false,
    persistent: true,
  })
  const state: WorkspaceWatchRegistration = {
    watcher,
    workspaceId,
    rootPath,
    clientIds: new Set(),
    debounceTimers: new Map(),
    ready,
  }
  watcher.once('ready', () => {
    if (readySettled) return
    readySettled = true
    resolveReady()
  })
  watcher.on('error', error => {
    deps.platform.logger.error('Workspace file watcher error:', workspaceId, error)
    if (!readySettled) {
      readySettled = true
      rejectReady(error instanceof Error ? error : new Error(String(error)))
    }
    closeWorkspaceWatchRegistration(workspaceWatchKey(workspaceId, rootPath), state)
  })
  watcher.on('all', () => {
    for (const clientId of state.clientIds) {
      const pending = state.debounceTimers.get(clientId)
      if (pending) clearTimeout(pending)
      state.debounceTimers.set(clientId, setTimeout(() => {
        state.debounceTimers.delete(clientId)
        if (!state.clientIds.has(clientId)) return
        pushTyped(server, RPC_CHANNELS.fs.WORKSPACE_CHANGED, { to: 'client', clientId }, workspaceId)
      }, WORKSPACE_WATCH_DEBOUNCE_MS))
    }
  })
  return state
}

function workspaceChildPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name
}

function sortWorkspaceEntries(entries: WorkspaceFileEntry[]): void {
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  })
}

async function readWorkspaceDirectoryEntries(
  safePath: string,
  rootPath: string,
  relativePath: string,
): Promise<WorkspaceFileEntry[]> {
  const rawEntries = await readdir(safePath, { withFileTypes: true })
  const entries: WorkspaceFileEntry[] = []
  for (const entry of rawEntries) {
    const childPath = join(safePath, entry.name)
    if (isSensitivePath(childPath) || isSensitivePath(`${childPath}/`)) continue
    let type: WorkspaceFileEntry['type'] | null = entry.isDirectory()
      ? 'directory'
      : entry.isFile()
        ? 'file'
        : null
    const isSymlink = entry.isSymbolicLink()
    if (isSymlink) {
      try {
        await validateFilePath(childPath, [rootPath], { allowHome: false, allowTmp: false })
        const target = await stat(childPath)
        type = target.isDirectory() ? 'directory' : target.isFile() ? 'file' : null
      } catch {
        // Keep the lexical link manageable even when its target is broken or
        // outside the workspace. Read/preview APIs still reject the target.
        type = 'file'
      }
    }
    if (!type) continue
    entries.push({
      name: entry.name,
      relativePath: workspaceChildPath(relativePath, entry.name),
      type,
      isSymlink,
    })
  }
  sortWorkspaceEntries(entries)
  return entries
}

async function assertWorkspaceMutationSubtreeSafe(rootPath: string): Promise<void> {
  const queue = [rootPath]
  while (queue.length > 0) {
    const directoryPath = queue.shift()!
    const entries = await readdir(directoryPath, { withFileTypes: true })
    for (const entry of entries) {
      const childPath = join(directoryPath, entry.name)
      if (isSensitivePath(childPath) || isSensitivePath(`${childPath}/`)) {
        throw new Error('Access denied: cannot modify a directory containing sensitive files')
      }
      if (entry.isDirectory() && !entry.isSymbolicLink()) queue.push(childPath)
    }
  }
}

function previewBase(relativePath: string, size: number) {
  const name = relativePath.split('/').pop() || relativePath
  const extension = extname(name).slice(1).toLowerCase()
  return { name, relativePath, extension, size, truncated: false as boolean }
}

function unsupportedWorkspacePreview(
  relativePath: string,
  size: number,
  reason: 'unsupported-format' | 'too-large' | 'binary',
  maxBytes?: number,
): WorkspaceFilePreview {
  return {
    ...previewBase(relativePath, size),
    kind: 'unsupported',
    reason,
    ...(maxBytes !== undefined ? { maxBytes } : {}),
  }
}

interface StoredWorkspaceFileDraft extends WorkspaceFileDraft {
  version: typeof WORKSPACE_FILE_DRAFT_VERSION
  workspaceScope: string
  revision?: string
}

interface StoredWorkspaceFileDraftDeletionMarker {
  version: typeof WORKSPACE_FILE_DRAFT_VERSION
  workspaceScope: string
  relativePath: string
  draftSha256: string
  deletedAt: number
}

/** @internal Exported for focused persistence tests. */
export interface WorkspaceFileDraftStorageIdentity {
  relativePath: string
  workspaceScope: string
  directoryPath: string
  filePath: string
}

function workspaceDraftIdentity(
  ctx: { workspaceId?: string | null; webContentsId?: number | null },
  deps: HandlerDeps,
  value: unknown,
): WorkspaceFileDraftStorageIdentity {
  const relativePath = normalizeWorkspaceRelativePath(value)
  if (!relativePath) throw new Error('A workspace file path is required')
  const { workspaceId, rootPath } = getRequestWorkspaceRoot(ctx, deps)
  const candidate = join(rootPath, ...relativePath.split('/'))
  if (isSensitivePath(candidate)) throw new Error('Access denied: cannot read sensitive files')

  // CONFIG_DIR identifies the server/profile. Hashing workspace + root prevents
  // a recycled workspace id from restoring a draft for a different directory.
  const workspaceScope = createHash('sha256')
    .update(`${workspaceId}\0${rootPath}`)
    .digest('hex')
  const resourceId = createHash('sha256').update(relativePath).digest('hex')
  const serverConfigDir = process.env.MORTISE_CONFIG_DIR || join(homedir(), '.mortise')
  const directoryPath = join(serverConfigDir, 'workspaces', workspaceScope, 'file-drafts.v1')
  return {
    relativePath,
    workspaceScope,
    directoryPath,
    filePath: join(directoryPath, `${resourceId}.json`),
  }
}

function validateWorkspaceDraftText(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`)
  if (Buffer.byteLength(value, 'utf-8') > WORKSPACE_TEXT_EDITOR_MAX_BYTES) {
    throw new Error(`${name} exceeds the 2 MiB editor limit`)
  }
  return value
}

function isValidUtf8(buffer: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer)
    return true
  } catch {
    return false
  }
}

async function assertEditableWorkspaceTextFile(path: string): Promise<void> {
  const fileStats = await stat(path)
  if (!fileStats.isFile()) throw new Error('Workspace path is not a file')
  if (fileStats.size > WORKSPACE_TEXT_EDITOR_MAX_BYTES) {
    throw new Error('File exceeds the 2 MiB editor limit')
  }
  const extension = extname(path).slice(1).toLowerCase()
  if (
    extension === 'pdf'
    || WORKSPACE_IMAGE_MIME_TYPES[extension]
    || WORKSPACE_OFFICE_EXTENSIONS.has(extension)
    || WORKSPACE_BINARY_EXTENSIONS.has(extension)
  ) {
    throw new Error('This file cannot be edited as text')
  }
  const buffer = await readFile(path)
  if (buffer.includes(0) || !isValidUtf8(buffer)) {
    throw new Error('This file cannot be edited as text')
  }
}

async function assertPreviewReadSize(path: string, maxBytes: number): Promise<void> {
  const fileStats = await stat(path)
  if (!fileStats.isFile()) throw new Error('Preview path is not a file')
  if (fileStats.size > maxBytes) {
    throw new Error(`File exceeds the ${maxBytes / (1024 * 1024)} MiB preview limit`)
  }
}

function isStoredWorkspaceFileDraft(
  value: unknown,
  expected: { relativePath: string; workspaceScope: string },
): value is StoredWorkspaceFileDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Partial<StoredWorkspaceFileDraft>
  return record.version === WORKSPACE_FILE_DRAFT_VERSION
    && record.workspaceScope === expected.workspaceScope
    && record.relativePath === expected.relativePath
    && typeof record.content === 'string'
    && Buffer.byteLength(record.content, 'utf-8') <= WORKSPACE_TEXT_EDITOR_MAX_BYTES
    && typeof record.baseContent === 'string'
    && Buffer.byteLength(record.baseContent, 'utf-8') <= WORKSPACE_TEXT_EDITOR_MAX_BYTES
    && typeof record.updatedAt === 'number'
    && Number.isFinite(record.updatedAt)
    && (record.revision === undefined || typeof record.revision === 'string')
}

function workspaceFileDraftDeletionMarkerPath(identity: WorkspaceFileDraftStorageIdentity): string {
  return `${identity.filePath}.deleted`
}

function isStoredWorkspaceFileDraftDeletionMarker(
  value: unknown,
  expected: WorkspaceFileDraftStorageIdentity,
): value is StoredWorkspaceFileDraftDeletionMarker {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Partial<StoredWorkspaceFileDraftDeletionMarker>
  return record.version === WORKSPACE_FILE_DRAFT_VERSION
    && record.workspaceScope === expected.workspaceScope
    && record.relativePath === expected.relativePath
    && typeof record.draftSha256 === 'string'
    && /^[a-f0-9]{64}$/.test(record.draftSha256)
    && typeof record.deletedAt === 'number'
    && Number.isFinite(record.deletedAt)
}

async function readOptionalUtf8(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function writePrivateJsonFileAtomically(
  directoryPath: string,
  filePath: string,
  value: unknown,
): Promise<void> {
  await mkdir(directoryPath, { recursive: true, mode: 0o700 })
  await chmod(directoryPath, 0o700).catch(() => {})
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`
  try {
    await writeFile(temporary, JSON.stringify(value), { encoding: 'utf-8', flag: 'wx', mode: 0o600 })
    await rename(temporary, filePath)
    await chmod(filePath, 0o600).catch(() => {})
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

/** @internal Exported for focused persistence tests. */
export async function readWorkspaceFileDraftRecord(
  identity: WorkspaceFileDraftStorageIdentity,
): Promise<WorkspaceFileDraft | null> {
  const rawDraft = await readOptionalUtf8(identity.filePath)
  if (rawDraft === null) return null

  const rawMarker = await readOptionalUtf8(workspaceFileDraftDeletionMarkerPath(identity))
  if (rawMarker !== null) {
    const marker = JSON.parse(rawMarker) as unknown
    if (!isStoredWorkspaceFileDraftDeletionMarker(marker, identity)) {
      throw new Error('Invalid workspace file draft deletion marker')
    }
    const draftSha256 = createHash('sha256').update(rawDraft).digest('hex')
    if (marker.draftSha256 === draftSha256) return null
  }

  const parsed = JSON.parse(rawDraft) as unknown
  if (!isStoredWorkspaceFileDraft(parsed, identity)) return null
  const { relativePath, content, baseContent, updatedAt } = parsed
  return { relativePath, content, baseContent, updatedAt }
}

/** @internal Exported for focused persistence tests. */
export async function writeWorkspaceFileDraftRecord(
  identity: WorkspaceFileDraftStorageIdentity,
  content: string,
  baseContent: string,
): Promise<WorkspaceFileDraft> {
  const record: StoredWorkspaceFileDraft = {
    version: WORKSPACE_FILE_DRAFT_VERSION,
    workspaceScope: identity.workspaceScope,
    relativePath: identity.relativePath,
    content,
    baseContent,
    updatedAt: Date.now(),
    revision: randomUUID(),
  }
  await writePrivateJsonFileAtomically(identity.directoryPath, identity.filePath, record)
  // A marker only suppresses the exact record it was written for. Cleanup is
  // best-effort so a locked stale marker cannot make a new draft write fail.
  await unlink(workspaceFileDraftDeletionMarkerPath(identity)).catch(() => {})
  const { relativePath, updatedAt } = record
  return { relativePath, content, baseContent, updatedAt }
}

type RemoveWorkspaceDraftFile = (path: string) => Promise<void>

/**
 * Marks the exact persisted record as deleted before unlinking it. If unlink
 * fails (for example because Windows still has the file open), reads keep
 * returning null and a later queue flush can retry physical cleanup safely.
 * @internal Exported for focused persistence tests.
 */
export async function deleteWorkspaceFileDraftRecord(
  identity: WorkspaceFileDraftStorageIdentity,
  removeFile: RemoveWorkspaceDraftFile = unlink,
): Promise<void> {
  const markerPath = workspaceFileDraftDeletionMarkerPath(identity)
  const rawDraft = await readOptionalUtf8(identity.filePath)
  if (rawDraft !== null) {
    const marker: StoredWorkspaceFileDraftDeletionMarker = {
      version: WORKSPACE_FILE_DRAFT_VERSION,
      workspaceScope: identity.workspaceScope,
      relativePath: identity.relativePath,
      draftSha256: createHash('sha256').update(rawDraft).digest('hex'),
      deletedAt: Date.now(),
    }
    await writePrivateJsonFileAtomically(identity.directoryPath, markerPath, marker)
    try {
      await removeFile(identity.filePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  try {
    await removeFile(markerPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

const workspaceFileDraftMutationChains = new Map<string, Promise<unknown>>()
const workspaceTextWriteChains = new Map<string, Promise<unknown>>()
const workspaceEntryMutationChains = new Map<string, Promise<unknown>>()

function workspacePathMatchesPrefix(relativePath: string, prefix: string): boolean {
  const comparablePath = process.platform === 'win32' ? relativePath.toLowerCase() : relativePath
  const comparablePrefix = process.platform === 'win32' ? prefix.toLowerCase() : prefix
  return comparablePath === comparablePrefix || comparablePath.startsWith(`${comparablePrefix}/`)
}

/** @internal Exported for cross-platform case-only rename tests. */
export function isCaseOnlyWorkspaceRename(
  previousPath: string,
  nextPath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'win32'
    && previousPath !== nextPath
    && previousPath.toLowerCase() === nextPath.toLowerCase()
}

async function renameWorkspaceEntryCaseOnly(
  sourcePath: string,
  destinationPath: string,
): Promise<void> {
  const temporaryPath = join(
    dirname(sourcePath),
    `.${parsePath(sourcePath).base}.mortise-case-rename-${process.pid}-${randomUUID()}`,
  )
  await assertWorkspaceEntryMissing(temporaryPath)
  await rename(sourcePath, temporaryPath)
  try {
    await rename(temporaryPath, destinationPath)
  } catch (error) {
    try {
      await rename(temporaryPath, sourcePath)
    } catch (rollbackError) {
      throw new Error(
        `Case-only rename failed and rollback also failed: ${String(error)}; rollback: ${String(rollbackError)}`,
      )
    }
    throw error
  }
}

async function collectWorkspaceDraftIdentities(
  ctx: { workspaceId?: string | null; webContentsId?: number | null },
  deps: HandlerDeps,
  prefix: string,
): Promise<WorkspaceFileDraftStorageIdentity[]> {
  const anchor = workspaceDraftIdentity(ctx, deps, prefix)
  let names: string[]
  try {
    names = await readdir(anchor.directoryPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }

  const identities = new Map<string, WorkspaceFileDraftStorageIdentity>()
  for (const name of names) {
    const isDraft = name.endsWith('.json')
    const isMarker = name.endsWith('.json.deleted')
    if (!isDraft && !isMarker) continue
    const recordPath = join(anchor.directoryPath, name)
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(recordPath, 'utf-8')) as unknown
    } catch {
      throw new Error('Invalid workspace file draft record blocks file mutation')
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Invalid workspace file draft record blocks file mutation')
    }
    const record = parsed as { workspaceScope?: unknown; relativePath?: unknown }
    if (record.workspaceScope !== anchor.workspaceScope || typeof record.relativePath !== 'string') {
      throw new Error('Invalid workspace file draft record blocks file mutation')
    }
    const identity = workspaceDraftIdentity(ctx, deps, record.relativePath)
    const expectedName = parsePath(isMarker
      ? workspaceFileDraftDeletionMarkerPath(identity)
      : identity.filePath).base
    if (expectedName !== name) {
      throw new Error('Invalid workspace file draft identity blocks file mutation')
    }
    if (workspacePathMatchesPrefix(identity.relativePath, prefix)) {
      identities.set(identity.filePath, identity)
    }
  }
  return [...identities.values()]
}

async function assertNoActiveWorkspaceDraftsAndClearStaleRecords(
  ctx: { workspaceId?: string | null; webContentsId?: number | null },
  deps: HandlerDeps,
  prefix: string,
): Promise<void> {
  const identities = await collectWorkspaceDraftIdentities(ctx, deps, prefix)
  for (const identity of identities) {
    if (await readWorkspaceFileDraftRecord(identity)) {
      throw new Error('Save or discard recoverable drafts before renaming or deleting this workspace entry')
    }
  }
  for (const identity of identities) {
    await deleteWorkspaceFileDraftRecord(identity)
  }
}

function serializePathMutation<T>(
  chains: Map<string, Promise<unknown>>,
  path: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = chains.get(path) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(operation)
  chains.set(path, current)
  void current.finally(() => {
    if (chains.get(path) === current) chains.delete(path)
  }).catch(() => {})
  return current
}

async function writeWorkspaceTextFileAtomically(
  path: string,
  content: string,
  expectedContent: string,
): Promise<FileTextWriteResult> {
  const fileStats = await stat(path)
  const temporary = join(dirname(path), `.${parsePath(path).base}.mortise-save-${process.pid}-${randomUUID()}`)
  let committed = false
  try {
    await writeFile(temporary, content, {
      encoding: 'utf-8',
      flag: 'wx',
      mode: fileStats.mode,
    })

    // Re-check after the temporary file is fully prepared, immediately before
    // replacement. Mortise writes are serialized above this helper. A separate,
    // uncooperative process can still write between this read and rename because
    // portable filesystems do not expose an atomic compare-and-rename primitive.
    const currentBuffer = await readFile(path)
    if (!isValidUtf8(currentBuffer)) throw new Error('This file cannot be edited as text')
    const currentContent = currentBuffer.toString('utf-8')
    if (currentContent !== expectedContent) return { status: 'conflict', currentContent }

    await rename(temporary, path)
    committed = true
    return { status: 'saved' }
  } finally {
    if (!committed) await unlink(temporary).catch(() => {})
  }
}

function isTrustedLocalUserPathRequest(
  ctx: { workspaceId?: string | null; webContentsId?: number | null },
  deps: HandlerDeps,
  workspaceId?: string | null,
): boolean {
  if (ctx.webContentsId == null || !deps.windowManager) return false
  const windowWorkspaceId = deps.windowManager.getWorkspaceForWindow(ctx.webContentsId)
  if (!windowWorkspaceId) return false
  return !workspaceId || workspaceId === windowWorkspaceId
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const reason = signal.reason
  throw reason instanceof Error ? reason : new Error('Request cancelled')
}

function getFilePathValidationOptions(
  ctx: { workspaceId?: string | null; webContentsId?: number | null },
  deps: HandlerDeps,
  workspaceId?: string | null,
) {
  return {
    allowHome: isTrustedLocalUserPathRequest(ctx, deps, workspaceId),
  }
}

export function registerFilesHandlers(server: RpcServer, deps: HandlerDeps): void {
  // Read a file (with path validation to prevent traversal attacks)
  server.handle(RPC_CHANNELS.file.READ, async (ctx, path: string) => {
    try {
      const workspaceId = ctx.workspaceId ?? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId!)
      const safePath = await validateFilePath(path, getWorkspaceAllowedDirs(workspaceId), getFilePathValidationOptions(ctx, deps, workspaceId))
      await assertPreviewReadSize(safePath, WORKSPACE_TEXT_PREVIEW_MAX_BYTES)
      const content = await readFile(safePath, 'utf-8')
      return content
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      // ENOENT is expected for optional config files (e.g. automations.json)
      if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        deps.platform.logger.debug('readFile: file not found:', path)
      } else {
        deps.platform.logger.error('readFile error:', path, message)
      }
      throw new Error(`Failed to read file: ${message}`)
    }
  })

  // Read an image file as a data URL for in-app image preview overlays.
  // Returns data:{mime};base64,{content} — used by ImagePreviewOverlay and markdown image blocks.
  server.handle(RPC_CHANNELS.file.READ_DATA_URL, async (ctx, path: string) => {
    try {
      const workspaceId = ctx.workspaceId ?? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId!)
      const safePath = await validateFilePath(path, getWorkspaceAllowedDirs(workspaceId), getFilePathValidationOptions(ctx, deps, workspaceId))
      await assertPreviewReadSize(safePath, WORKSPACE_RICH_PREVIEW_MAX_BYTES)
      const buffer = await readFile(safePath)
      const ext = safePath.split('.').pop()?.toLowerCase() ?? ''

      // Map previewable image extensions to MIME types.
      // HEIC/HEIF/TIFF are intentionally excluded — no Chromium codec, opened externally instead.
      const mimeMap: Record<string, string> = {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        gif: 'image/gif',
        webp: 'image/webp',
        svg: 'image/svg+xml',
        bmp: 'image/bmp',
        ico: 'image/x-icon',
        avif: 'image/avif',
      }
      const mime = mimeMap[ext] || 'application/octet-stream'
      const base64 = buffer.toString('base64')
      return `data:${mime};base64,${base64}`
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      deps.platform.logger.error('readFileDataUrl error:', message)
      throw new Error(`Failed to read file as data URL: ${message}`)
    }
  })

  // Read an image file as a small preview data URL for lightweight thumbnail rendering.
  // Returns a PNG data URL resized to fit within maxSize×maxSize.
  server.handle(RPC_CHANNELS.file.READ_PREVIEW_DATA_URL, async (ctx, path: string, maxSize = 64) => {
    try {
      const workspaceId = ctx.workspaceId ?? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId!)
      const safePath = await validateFilePath(path, getWorkspaceAllowedDirs(workspaceId), getFilePathValidationOptions(ctx, deps, workspaceId))
      await assertPreviewReadSize(safePath, WORKSPACE_RICH_PREVIEW_MAX_BYTES)
      const size = Number.isFinite(maxSize) ? Math.max(16, Math.min(256, Math.floor(maxSize))) : 64
      const preview = await deps.platform.imageProcessor.process(safePath, {
        resize: { width: size, height: size },
        fit: 'inside',
        format: 'png',
      })
      return `data:image/png;base64,${preview.toString('base64')}`
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      deps.platform.logger.error('readFilePreviewDataUrl error:', message)
      throw new Error(`Failed to read file preview: ${message}`)
    }
  })

  // Read a file as raw binary (Uint8Array) for react-pdf.
  // The WS transport codec preserves Uint8Array payloads over JSON envelopes.
  server.handle(RPC_CHANNELS.file.READ_BINARY, async (ctx, path: string) => {
    try {
      const workspaceId = ctx.workspaceId ?? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId!)
      const safePath = await validateFilePath(path, getWorkspaceAllowedDirs(workspaceId), getFilePathValidationOptions(ctx, deps, workspaceId))
      await assertPreviewReadSize(safePath, WORKSPACE_RICH_PREVIEW_MAX_BYTES)
      const buffer = await readFile(safePath)
      // Return as Uint8Array (serializes to ArrayBuffer over IPC)
      return new Uint8Array(buffer)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      deps.platform.logger.error('readFileBinary error:', message)
      throw new Error(`Failed to read file as binary: ${message}`)
    }
  })

  // Open native file dialog for selecting files to attach (routed to client)
  server.handle(RPC_CHANNELS.file.OPEN_DIALOG, async (ctx) => {
    const result = await requestClientOpenFileDialog(server, ctx.clientId, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        // Allow all files by default - the agent can figure out how to handle them
        { name: 'All Files', extensions: ['*'] },
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'] },
        { name: 'Documents', extensions: ['pdf', 'docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt', 'txt', 'md', 'rtf'] },
        { name: 'Code', extensions: ['js', 'ts', 'tsx', 'jsx', 'py', 'json', 'css', 'html', 'xml', 'yaml', 'yml', 'sh', 'sql', 'go', 'rs', 'rb', 'php', 'java', 'c', 'cpp', 'h', 'swift', 'kt'] },
      ]
    })
    return result.canceled ? [] : result.filePaths
  })

  // Read file and return as FileAttachment with Quick Look thumbnail
  server.handle(RPC_CHANNELS.file.READ_ATTACHMENT, async (ctx, path: string) => {
    try {
      const workspaceId = ctx.workspaceId ?? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId!)
      const safePath = await validateFilePath(path, getWorkspaceAllowedDirs(workspaceId), getFilePathValidationOptions(ctx, deps, workspaceId))
      // Use shared utility that handles file type detection, encoding, etc.
      const attachment = await readFileAttachment(safePath)
      if (!attachment) return null

      // Generate thumbnail for image preview
      // Only works for image formats the processor supports — PDFs/Office files get icon fallback
      try {
        const thumbBuffer = await deps.platform.imageProcessor.process(safePath, {
          resize: { width: 200, height: 200 },
          format: 'png',
        })
        ;(attachment as { thumbnailBase64?: string }).thumbnailBase64 = thumbBuffer.toString('base64')
      } catch (thumbError) {
        // Thumbnail generation failed (non-image file or corrupt) — icon fallback
        deps.platform.logger.info('Thumbnail generation failed (using fallback):', thumbError instanceof Error ? thumbError.message : thumbError)
      }

      return attachment
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      deps.platform.logger.error('readFileAttachment error:', message)
      return null
    }
  })

  // Read a user-attached file (bypasses workspace-dir validation).
  // Used only by renderer draft hydration: the path was written to drafts.json by a
  // previous user-initiated OS-picker / Finder-drag attach, so the path implies consent.
  // NOT exposed to agent code — no equivalent MCP tool. Kept separate from readFileAttachment
  // on purpose to preserve the agent-facing read's narrow trust boundary.
  //
  // SECURITY: container validation is intentionally bypassed (renderer may attach files
  // from anywhere the user picked), but sensitive-file patterns (SSH keys, .env, .pem,
  // credentials.json, etc.) are still blocked to prevent trivial secret exfiltration.
  server.handle(RPC_CHANNELS.file.READ_USER_ATTACHMENT, async (ctx, path: string) => {
    try {
      if (!path || typeof path !== 'string' || !isAbsolute(path)) return null
      const workspaceId = ctx.workspaceId ?? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId!)
      if (!isTrustedLocalUserPathRequest(ctx, deps, workspaceId)) {
        deps.platform.logger.warn('[readUserAttachment] rejected non-local user path request')
        return null
      }
      const realPath = await realpath(path).catch(() => null)
      if (!realPath) return null

      // Block sensitive files even though we bypass workspace-container checks.
      // Check the real target so symlink aliases cannot hide ~/.ssh, .env, etc.
      if (isSensitivePath(realPath)) {
        deps.platform.logger.warn(`[readUserAttachment] blocked sensitive path: ${realPath}`)
        return null
      }
      const info = await stat(realPath).catch(() => null)
      if (!info || !info.isFile()) return null
      if (info.size > ATTACHMENT_SINGLE_FILE_LIMIT_BYTES) {
        deps.platform.logger.warn(`[readUserAttachment] file exceeds ${ATTACHMENT_SINGLE_FILE_LIMIT_BYTES} bytes, skipping: ${realPath}`)
        return null
      }
      const attachment = readFileAttachment(realPath)
      if (!attachment) return null
      try {
        const thumbBuffer = await deps.platform.imageProcessor.process(realPath, {
          resize: { width: 200, height: 200 },
          format: 'png',
        })
        ;(attachment as { thumbnailBase64?: string }).thumbnailBase64 = thumbBuffer.toString('base64')
      } catch {
        // Non-image or corrupt — icon fallback, same as readFileAttachment
      }
      return attachment
    } catch (error) {
      deps.platform.logger.error('readUserAttachment error:', error instanceof Error ? error.message : error)
      return null
    }
  })

  // Generate thumbnail from base64 data (for drag-drop files where we don't have a path)
  server.handle(RPC_CHANNELS.file.GENERATE_THUMBNAIL, async (_ctx, base64: string, _mimeType: string): Promise<string | null> => {
    try {
      const buffer = Buffer.from(base64, 'base64')
      const thumbBuffer = await deps.platform.imageProcessor.process(buffer, {
        resize: { width: 200, height: 200 },
        format: 'png',
      })
      return thumbBuffer.toString('base64')
    } catch (error) {
      deps.platform.logger.info('generateThumbnail failed:', error instanceof Error ? error.message : error)
      return null
    }
  })

  // Store an attachment to disk and generate thumbnail/markdown conversion
  // This is the core of the persistent file attachment system
  const storeAttachmentHandler: HandlerFn = async (ctx, sessionId: string, attachment: FileAttachment): Promise<StoredAttachment> => {
    // Track files we've written for cleanup on error
    const filesToCleanup: string[] = []

    try {
      throwIfAborted(ctx.signal)
      // Reject empty files early
      if (attachment.size === 0) {
        throw new Error('Cannot attach empty file')
      }
      if (attachment.size > ATTACHMENT_SINGLE_FILE_LIMIT_BYTES) {
        throw new Error(`Attachment exceeds the ${Math.round(ATTACHMENT_SINGLE_FILE_LIMIT_BYTES / 1024 / 1024)} MiB single-file limit`)
      }
      if (!attachment.name || typeof attachment.name !== 'string') {
        throw new Error('Attachment name is required')
      }
      if (!attachment.mimeType || typeof attachment.mimeType !== 'string') {
        throw new Error('Attachment MIME type is required')
      }
      if (!['image', 'text', 'pdf', 'office', 'audio', 'unknown'].includes(attachment.type)) {
        throw new Error(`Unsupported attachment type: ${String(attachment.type)}`)
      }

      // Get workspace slug from the calling window
      const workspaceId = ctx.workspaceId ?? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId!)
      if (!workspaceId) {
        throw new Error('Cannot determine workspace for attachment storage')
      }
      const workspace = getWorkspaceOrThrow(workspaceId)
      const workspaceRootPath = workspace.rootPath

      // SECURITY: Validate sessionId to prevent path traversal attacks
      // This must happen before using sessionId in any file path operations
      validateSessionId(sessionId)

      // Create attachments directory if it doesn't exist
      const attachmentsDir = getSessionAttachmentsPath(workspaceRootPath, sessionId)
      await mkdir(attachmentsDir, { recursive: true })
      throwIfAborted(ctx.signal)

      // Generate unique ID for this attachment
      const id = randomUUID()
      const safeName = sanitizeFilename(attachment.name)
      const storedFileName = `${id}_${safeName}`
      const storedPath = join(attachmentsDir, storedFileName)

      // Track if image was resized (for return value)
      let wasResized = false
      let finalSize = attachment.size
      let resizedBase64: string | undefined

      // 1. Save the file (with image validation and resizing)
      if (!attachment.base64 && !attachment.text && attachment.path && isAbsolute(attachment.path)) {
        if (!isTrustedLocalUserPathRequest(ctx, deps, workspaceId)) {
          throw new Error('Path-only attachments are only accepted from the local Electron window. Upload file contents instead.')
        }
        const realAttachmentPath = await realpath(attachment.path).catch(() => null)
        if (!realAttachmentPath) {
          throw new Error('Attachment path does not exist')
        }
        if (isSensitivePath(realAttachmentPath)) {
          throw new Error('Attachment path is blocked because it appears to contain credentials or secrets')
        }
        const info = await stat(realAttachmentPath)
        if (!info.isFile()) {
          throw new Error('Attachment path is not a file')
        }
        if (info.size !== attachment.size) {
          throw new Error(`Attachment size changed before upload (expected ${attachment.size}, got ${info.size})`)
        }
        if (info.size > ATTACHMENT_SINGLE_FILE_LIMIT_BYTES) {
          throw new Error(`Attachment exceeds the ${Math.round(ATTACHMENT_SINGLE_FILE_LIMIT_BYTES / 1024 / 1024)} MiB single-file limit`)
        }
        attachment.base64 = undefined
        attachment.text = undefined
        let decoded: Buffer = await readFile(realAttachmentPath)
        throwIfAborted(ctx.signal)

        // Reuse the same binary validation/resizing path as base64 uploads.
        if (attachment.type === 'image') {
          const imageInspection = await inspectImageBuffer(decoded, deps.platform.imageProcessor)
          const imageSize = imageInspection.status === 'ok'
            ? { width: imageInspection.width, height: imageInspection.height }
            : null

          let shouldResize = false
          let targetSize: { width: number; height: number } | undefined

          if (imageInspection.status === 'processor_unavailable') {
            deps.platform.logger.warn('Image processing unavailable while validating attachment:', imageInspection.error?.message ?? 'unknown error')
            if (decoded.length > IMAGE_LIMITS.MAX_SIZE) {
              throw new Error('Image processing is unavailable, so oversized images cannot be validated or resized automatically. Please attach a smaller image.')
            }
          } else if (imageInspection.status === 'invalid_image') {
            throw new Error(imageInspection.error?.message || 'Invalid or unsupported image file')
          } else {
            const validation = validateImageForClaudeAPI(decoded.length, imageSize!.width, imageSize!.height)
            shouldResize = validation.needsResize ?? false
            targetSize = validation.suggestedSize

            if (!validation.valid && validation.errorCode === 'dimension_exceeded') {
              const maxDim = IMAGE_LIMITS.MAX_DIMENSION
              const scale = Math.min(maxDim / imageSize!.width, maxDim / imageSize!.height)
              targetSize = {
                width: Math.floor(imageSize!.width * scale),
                height: Math.floor(imageSize!.height * scale),
              }
              shouldResize = true
              deps.platform.logger.info(`Image exceeds ${maxDim}px limit (${imageSize!.width}x${imageSize!.height}), will resize to ${targetSize.width}x${targetSize.height}`)
            } else if (!validation.valid && validation.errorCode === 'size_exceeded') {
              shouldResize = true
              deps.platform.logger.info(`Image exceeds 5MB (${(decoded.length / 1024 / 1024).toFixed(1)}MB), will attempt resize`)
            } else if (!validation.valid) {
              throw new Error(validation.error)
            }
          }

          if (shouldResize) {
            const isPhoto = attachment.mimeType === 'image/jpeg'
            if (targetSize) {
              try {
                decoded = await deps.platform.imageProcessor.process(decoded, {
                  resize: { width: targetSize.width, height: targetSize.height },
                  format: isPhoto ? 'jpeg' : 'png',
                  quality: isPhoto ? IMAGE_LIMITS.JPEG_QUALITY_HIGH : undefined,
                })
                wasResized = true
                finalSize = decoded.length
                if (decoded.length > IMAGE_LIMITS.MAX_SIZE) {
                  decoded = await deps.platform.imageProcessor.process(decoded, { format: 'jpeg', quality: IMAGE_LIMITS.JPEG_QUALITY_FALLBACK })
                  finalSize = decoded.length
                  if (decoded.length > IMAGE_LIMITS.MAX_SIZE) {
                    throw new Error(`Image still too large after resize (${(decoded.length / 1024 / 1024).toFixed(1)}MB). Please use a smaller image.`)
                  }
                }
              } catch (resizeError) {
                const reason = resizeError instanceof Error ? resizeError.message : String(resizeError)
                throw new Error(`Image too large and automatic resize failed: ${reason}. Please manually resize it before attaching.`)
              }
            } else {
              const result = await resizeImageForAPI(decoded, { isPhoto })
              if (!result) {
                throw new Error(`Image too large (${(decoded.length / 1024 / 1024).toFixed(1)}MB) and could not be compressed enough. Please use a smaller image.`)
              }
              decoded = result.buffer
              wasResized = true
              finalSize = decoded.length
            }
            resizedBase64 = decoded.toString('base64')
          }
        }

        filesToCleanup.push(storedPath)
        throwIfAborted(ctx.signal)
        await writeFile(storedPath, decoded)
        finalSize = decoded.length
      } else if (attachment.base64) {
        // Images, PDFs, Office files - decode from base64
        let decoded: Buffer = Buffer.from(attachment.base64, 'base64')
        throwIfAborted(ctx.signal)
        if (decoded.length > ATTACHMENT_SINGLE_FILE_LIMIT_BYTES) {
          throw new Error(`Attachment exceeds the ${Math.round(ATTACHMENT_SINGLE_FILE_LIMIT_BYTES / 1024 / 1024)} MiB single-file limit`)
        }
        // Validate decoded size matches expected (allow small variance for encoding overhead)
        if (Math.abs(decoded.length - attachment.size) > 100) {
          throw new Error(`Attachment corrupted: size mismatch (expected ${attachment.size}, got ${decoded.length})`)
        }

        // For images: validate and resize if needed for Claude API compatibility
        if (attachment.type === 'image') {
          const imageInspection = await inspectImageBuffer(decoded, deps.platform.imageProcessor)
          const imageSize = imageInspection.status === 'ok'
            ? { width: imageInspection.width, height: imageInspection.height }
            : null

          // Determine if we should resize
          let shouldResize = false
          let targetSize: { width: number; height: number } | undefined

          if (imageInspection.status === 'processor_unavailable') {
            deps.platform.logger.warn('Image processing unavailable while validating attachment:', imageInspection.error?.message ?? 'unknown error')
            if (decoded.length > IMAGE_LIMITS.MAX_SIZE) {
              throw new Error('Image processing is unavailable, so oversized images cannot be validated or resized automatically. Please attach a smaller image.')
            }
          } else if (imageInspection.status === 'invalid_image') {
            throw new Error(imageInspection.error?.message || 'Invalid or unsupported image file')
          } else {
            // Validate image for Claude API
            const validation = validateImageForClaudeAPI(decoded.length, imageSize!.width, imageSize!.height)

            shouldResize = validation.needsResize ?? false
            targetSize = validation.suggestedSize

            if (!validation.valid && validation.errorCode === 'dimension_exceeded') {
              // Image exceeds 8000px limit - calculate resize to fit within limits
              const maxDim = IMAGE_LIMITS.MAX_DIMENSION
              const scale = Math.min(maxDim / imageSize!.width, maxDim / imageSize!.height)
              targetSize = {
                width: Math.floor(imageSize!.width * scale),
                height: Math.floor(imageSize!.height * scale),
              }
              shouldResize = true
              deps.platform.logger.info(`Image exceeds ${maxDim}px limit (${imageSize!.width}x${imageSize!.height}), will resize to ${targetSize.width}x${targetSize.height}`)
            } else if (!validation.valid && validation.errorCode === 'size_exceeded') {
              // File >5MB — try resize+compress instead of rejecting
              shouldResize = true
              deps.platform.logger.info(`Image exceeds 5MB (${(decoded.length / 1024 / 1024).toFixed(1)}MB), will attempt resize`)
            } else if (!validation.valid) {
              throw new Error(validation.error)
            }
          }

          // If resize is needed (either recommended or required), do it now
          if (shouldResize) {
            const isPhoto = attachment.mimeType === 'image/jpeg'

            if (targetSize) {
              // Dimension-exceeded: resize to specific target dimensions
              deps.platform.logger.info(`Resizing image from ${imageSize!.width}x${imageSize!.height} to ${targetSize.width}x${targetSize.height}`)
              try {
                decoded = await deps.platform.imageProcessor.process(decoded, {
                  resize: { width: targetSize.width, height: targetSize.height },
                  format: isPhoto ? 'jpeg' : 'png',
                  quality: isPhoto ? IMAGE_LIMITS.JPEG_QUALITY_HIGH : undefined,
                })
                wasResized = true
                finalSize = decoded.length

                // Re-validate final size after resize
                if (decoded.length > IMAGE_LIMITS.MAX_SIZE) {
                  decoded = await deps.platform.imageProcessor.process(decoded, { format: 'jpeg', quality: IMAGE_LIMITS.JPEG_QUALITY_FALLBACK })
                  finalSize = decoded.length
                  if (decoded.length > IMAGE_LIMITS.MAX_SIZE) {
                    throw new Error(`Image still too large after resize (${(decoded.length / 1024 / 1024).toFixed(1)}MB). Please use a smaller image.`)
                  }
                }
              } catch (resizeError) {
                deps.platform.logger.error('Image resize failed:', resizeError)
                const reason = resizeError instanceof Error ? resizeError.message : String(resizeError)
                throw new Error(`Image too large (${imageSize!.width}x${imageSize!.height}) and automatic resize failed: ${reason}. Please manually resize it before attaching.`)
              }
            } else {
              // Size-exceeded or optimal resize — use shared utility for full pipeline
              const result = await resizeImageForAPI(decoded, { isPhoto })
              if (!result) {
                throw new Error(`Image too large (${(decoded.length / 1024 / 1024).toFixed(1)}MB) and could not be compressed enough. Please use a smaller image.`)
              }
              decoded = result.buffer
              wasResized = true
              finalSize = decoded.length
            }

            deps.platform.logger.info(`Image resized: ${attachment.size} -> ${finalSize} bytes (${Math.round((1 - finalSize / attachment.size) * 100)}% reduction)`)

            // Store resized base64 to return to renderer
            // This is used when sending to Claude API instead of original large base64
            resizedBase64 = decoded.toString('base64')
          }
        }

        filesToCleanup.push(storedPath)
        throwIfAborted(ctx.signal)
        await writeFile(storedPath, decoded)
      } else if (attachment.text) {
        // Text files - save as UTF-8
        const textBytes = Buffer.byteLength(attachment.text, 'utf-8')
        if (textBytes > ATTACHMENT_TEXT_INLINE_LIMIT_BYTES) {
          throw new Error(`Text attachment exceeds the ${Math.round(ATTACHMENT_TEXT_INLINE_LIMIT_BYTES / 1024 / 1024)} MiB inline text limit`)
        }
        if (Math.abs(textBytes - attachment.size) > 100) {
          throw new Error(`Attachment corrupted: size mismatch (expected ${attachment.size}, got ${textBytes})`)
        }
        filesToCleanup.push(storedPath)
        throwIfAborted(ctx.signal)
        await writeFile(storedPath, attachment.text, 'utf-8')
        finalSize = textBytes
      } else {
        throw new Error('Attachment has no content (neither base64 nor text)')
      }

      throwIfAborted(ctx.signal)

      // 2. Generate thumbnail (images only — PDFs/Office get icon fallback)
      let thumbnailPath: string | undefined
      let thumbnailBase64: string | undefined
      const thumbFileName = `${id}_thumb.png`
      const thumbPath = join(attachmentsDir, thumbFileName)
      try {
        throwIfAborted(ctx.signal)
        const pngBuffer = await deps.platform.imageProcessor.process(storedPath, {
          resize: { width: 200, height: 200 },
          format: 'png',
        })
        throwIfAborted(ctx.signal)
        await writeFile(thumbPath, pngBuffer)
        thumbnailPath = thumbPath
        thumbnailBase64 = pngBuffer.toString('base64')
        filesToCleanup.push(thumbPath)
      } catch (thumbError) {
        // Thumbnail generation failed (non-image or corrupt) — icon fallback
        deps.platform.logger.info('Thumbnail generation failed (using fallback):', thumbError instanceof Error ? thumbError.message : thumbError)
      }

      // 3. Convert Office files to markdown (for sending to Claude)
      // This is required for Office files - Claude can't read raw Office binary
      let markdownPath: string | undefined
      if (attachment.type === 'office') {
        const mdFileName = `${id}_${safeName}.md`
        const mdPath = join(attachmentsDir, mdFileName)
        try {
          throwIfAborted(ctx.signal)
          const markitdown = new MarkItDown()
          const result = await markitdown.convert(storedPath)
          throwIfAborted(ctx.signal)
          if (!result || !result.textContent) {
            throw new Error('Conversion returned empty result')
          }
          await writeFile(mdPath, result.textContent, 'utf-8')
          markdownPath = mdPath
          filesToCleanup.push(mdPath)
          deps.platform.logger.info(`Converted Office file to markdown: ${mdPath}`)
        } catch (convertError) {
          // Conversion failed - throw so user knows the file can't be processed
          // Claude can't read raw Office binary, so a failed conversion = unusable file
          const errorMsg = convertError instanceof Error ? convertError.message : String(convertError)
          deps.platform.logger.error('Office to markdown conversion failed:', errorMsg)
          throw new Error(`Failed to convert "${attachment.name}" to readable format: ${errorMsg}`)
        }
      }

      // Return StoredAttachment metadata
      // Include wasResized flag so UI can show notification
      // Include resizedBase64 so renderer uses resized image for Claude API
      return {
        id,
        type: attachment.type,
        name: attachment.name,
        mimeType: attachment.mimeType,
        size: finalSize, // Use final size (may differ if resized)
        originalSize: wasResized ? attachment.size : undefined, // Track original if resized
        storedPath,
        thumbnailPath,
        thumbnailBase64,
        markdownPath,
        wasResized,
        resizedBase64, // Only set when wasResized=true, used for Claude API
      }
    } catch (error) {
      // Clean up any files we've written before the error
      if (filesToCleanup.length > 0) {
        deps.platform.logger.info(`Cleaning up ${filesToCleanup.length} orphaned file(s) after storage error`)
        await Promise.all(filesToCleanup.map(f => unlink(f).catch(() => {})))
      }

      const message = error instanceof Error ? error.message : 'Unknown error'
      deps.platform.logger.error('storeAttachment error:', message)
      throw new Error(`Failed to store attachment: ${message}`)
    }
  }
  server.handle(RPC_CHANNELS.file.STORE_ATTACHMENT, storeAttachmentHandler)
  setTransferableHandler(RPC_CHANNELS.file.STORE_ATTACHMENT, storeAttachmentHandler)

  server.handle(RPC_CHANNELS.fs.CREATE_WORKSPACE_ENTRY, async (
    ctx,
    requestedPath: string,
    type: WorkspaceFileEntry['type'],
  ): Promise<WorkspaceEntryMutationResult> => {
    if (type !== 'file' && type !== 'directory') {
      throw new Error('Workspace entry type must be file or directory')
    }
    const resolved = await resolveWorkspaceMutationPath(ctx, deps, requestedPath)
    return serializePathMutation(workspaceEntryMutationChains, resolved.rootPath, async () => {
      await assertWorkspaceEntryMissing(resolved.candidatePath)
      if (type === 'directory') {
        await mkdir(resolved.candidatePath)
      } else {
        await writeFile(resolved.candidatePath, '', { encoding: 'utf-8', flag: 'wx' })
      }
      return { relativePath: resolved.relativePath, type, isSymlink: false }
    })
  })

  server.handle(RPC_CHANNELS.fs.RENAME_WORKSPACE_ENTRY, async (
    ctx,
    requestedPath: string,
    requestedNextPath: string,
  ): Promise<WorkspaceEntryRenameResult> => {
    const source = await resolveWorkspaceMutationSourcePath(ctx, deps, requestedPath)
    const destination = await resolveWorkspaceMutationPath(ctx, deps, requestedNextPath)
    if (source.relativePath === destination.relativePath) {
      throw new Error('The source and destination workspace paths are the same')
    }
    const caseOnlyRename = isCaseOnlyWorkspaceRename(source.relativePath, destination.relativePath)
    if (!caseOnlyRename && workspacePathMatchesPrefix(destination.relativePath, source.relativePath)) {
      throw new Error('A workspace directory cannot be moved inside itself')
    }
    return serializePathMutation(workspaceEntryMutationChains, source.rootPath, async () => {
      await assertNoActiveWorkspaceDraftsAndClearStaleRecords(ctx, deps, source.relativePath)
      await assertNoActiveWorkspaceDraftsAndClearStaleRecords(ctx, deps, destination.relativePath)
      const sourceResult = await workspaceMutationResult(
        source.relativePath,
        source.candidatePath,
        source.safePath,
        source.symlinkTargetValidated,
      )
      if (sourceResult.type === 'directory' && !sourceResult.isSymlink) {
        await assertWorkspaceMutationSubtreeSafe(source.candidatePath)
      }
      if (caseOnlyRename) {
        await renameWorkspaceEntryCaseOnly(source.candidatePath, destination.candidatePath)
      } else {
        await assertWorkspaceEntryMissing(destination.candidatePath)
        await rename(source.candidatePath, destination.candidatePath)
      }
      return {
        ...sourceResult,
        previousRelativePath: source.relativePath,
        relativePath: destination.relativePath,
      }
    })
  })

  server.handle(RPC_CHANNELS.fs.DELETE_WORKSPACE_ENTRY, async (
    ctx,
    requestedPath: string,
    recursive: boolean,
  ): Promise<WorkspaceEntryMutationResult> => {
    if (typeof recursive !== 'boolean') throw new Error('Directory deletion requires an explicit recursive flag')
    const resolved = await resolveWorkspaceMutationSourcePath(ctx, deps, requestedPath)
    return serializePathMutation(workspaceEntryMutationChains, resolved.rootPath, async () => {
      await assertNoActiveWorkspaceDraftsAndClearStaleRecords(ctx, deps, resolved.relativePath)
      const result = await workspaceMutationResult(
        resolved.relativePath,
        resolved.candidatePath,
        resolved.safePath,
        resolved.symlinkTargetValidated,
      )
      if (result.type === 'directory' && !result.isSymlink) {
        await assertWorkspaceMutationSubtreeSafe(resolved.candidatePath)
      }
      if (result.type === 'directory' && !result.isSymlink && !recursive) {
        throw new Error('Directory deletion requires recursive confirmation')
      }
      if (result.type === 'directory' && !result.isSymlink) {
        await rm(resolved.candidatePath, { recursive: true, force: false })
      } else {
        await unlink(resolved.candidatePath)
      }
      return result
    })
  })

  server.handle(RPC_CHANNELS.fs.WATCH_WORKSPACE, async ctx => {
    const { workspaceId } = getRequestWorkspaceRoot(ctx, deps)
    const { safePath: rootPath } = await resolveWorkspaceRelativePath(ctx, deps, '')
    const key = workspaceWatchKey(workspaceId, rootPath)
    const currentKey = clientWorkspaceWatchKeys.get(ctx.clientId)
    if (currentKey === key) {
      await workspaceWatchRegistrations.get(key)?.ready
      return
    }
    cleanupWorkspaceFileWatchForClient(ctx.clientId)
    let state = workspaceWatchRegistrations.get(key)
    if (!state) {
      state = createWorkspaceWatchRegistration(server, deps, workspaceId, rootPath)
      workspaceWatchRegistrations.set(key, state)
    }
    state.clientIds.add(ctx.clientId)
    clientWorkspaceWatchKeys.set(ctx.clientId, key)
    await state.ready
  })

  server.handle(RPC_CHANNELS.fs.UNWATCH_WORKSPACE, async ctx => {
    const { workspaceId } = getRequestWorkspaceRoot(ctx, deps)
    const { safePath: rootPath } = await resolveWorkspaceRelativePath(ctx, deps, '')
    if (clientWorkspaceWatchKeys.get(ctx.clientId) === workspaceWatchKey(workspaceId, rootPath)) {
      cleanupWorkspaceFileWatchForClient(ctx.clientId)
    }
  })

  server.handle(RPC_CHANNELS.fs.LIST_WORKSPACE_DIRECTORY, async (ctx, requestedPath?: string): Promise<WorkspaceDirectoryListing> => {
    const { relativePath, safePath, rootPath } = await resolveWorkspaceRelativePath(ctx, deps, requestedPath)
    const directory = await stat(safePath)
    if (!directory.isDirectory()) throw new Error('Workspace path is not a directory')
    const allEntries = await readWorkspaceDirectoryEntries(safePath, rootPath, relativePath)
    return {
      relativePath,
      entries: allEntries.slice(0, WORKSPACE_DIRECTORY_ENTRY_LIMIT),
      truncated: allEntries.length > WORKSPACE_DIRECTORY_ENTRY_LIMIT,
      totalEntries: allEntries.length,
    }
  })

  server.handle(RPC_CHANNELS.fs.SEARCH_WORKSPACE, async (ctx, rawQuery: string): Promise<WorkspaceFileEntry[]> => {
    if (typeof rawQuery !== 'string') throw new Error('Workspace file search query must be a string')
    const query = rawQuery.trim().toLowerCase()
    if (!query) return []
    if (query.length > 120) throw new Error('Workspace file search query is too long')

    const { safePath: rootPath } = await resolveWorkspaceRelativePath(ctx, deps, '')
    const results: WorkspaceFileEntry[] = []
    const queue = ['']
    let scannedEntries = 0
    while (
      queue.length > 0
      && results.length < WORKSPACE_SEARCH_RESULT_LIMIT
      && scannedEntries < WORKSPACE_SEARCH_ENTRY_LIMIT
    ) {
      const batch = queue.splice(0, WORKSPACE_SEARCH_DIRECTORY_BATCH_SIZE)
      const directoryResults = await Promise.all(batch.map(async relativePath => {
        const absolutePath = relativePath ? join(rootPath, ...relativePath.split('/')) : rootPath
        try {
          return { relativePath, entries: await readdir(absolutePath, { withFileTypes: true }) }
        } catch {
          return { relativePath, entries: [] as import('fs').Dirent[] }
        }
      }))

      for (const directoryResult of directoryResults) {
        for (const entry of directoryResult.entries) {
          if (
            results.length >= WORKSPACE_SEARCH_RESULT_LIMIT
            || scannedEntries >= WORKSPACE_SEARCH_ENTRY_LIMIT
          ) break
          scannedEntries += 1
          if (entry.isSymbolicLink()) continue
          const type: WorkspaceFileEntry['type'] | null = entry.isDirectory()
            ? 'directory'
            : entry.isFile()
              ? 'file'
              : null
          if (!type) continue
          const relativePath = workspaceChildPath(directoryResult.relativePath, entry.name)
          const absoluteEntryPath = join(rootPath, ...relativePath.split('/'))
          if (isSensitivePath(absoluteEntryPath) || isSensitivePath(`${absoluteEntryPath}/`)) continue
          if (type === 'directory' && !WORKSPACE_SEARCH_SKIPPED_DIRECTORIES.has(entry.name)) {
            queue.push(relativePath)
          }
          if (entry.name.toLowerCase().includes(query) || relativePath.toLowerCase().includes(query)) {
            results.push({ name: entry.name, relativePath, type, isSymlink: false })
          }
        }
      }
    }
    sortWorkspaceEntries(results)
    return results
  })

  server.handle(RPC_CHANNELS.fs.READ_WORKSPACE_PREVIEW, async (ctx, requestedPath: string): Promise<WorkspaceFilePreview> => {
    const { relativePath, safePath } = await resolveWorkspaceRelativePath(ctx, deps, requestedPath)
    if (!relativePath) throw new Error('A workspace file path is required')
    const fileStats = await stat(safePath)
    if (!fileStats.isFile()) throw new Error('Workspace path is not a file')

    const base = previewBase(relativePath, fileStats.size)
    const extension = base.extension
    const imageMime = WORKSPACE_IMAGE_MIME_TYPES[extension]
    if (imageMime) {
      if (fileStats.size > WORKSPACE_RICH_PREVIEW_MAX_BYTES) {
        return unsupportedWorkspacePreview(relativePath, fileStats.size, 'too-large', WORKSPACE_RICH_PREVIEW_MAX_BYTES)
      }
      const buffer = await readFile(safePath)
      return { ...base, kind: 'image', dataUrl: `data:${imageMime};base64,${buffer.toString('base64')}` }
    }

    if (extension === 'pdf') {
      if (fileStats.size > WORKSPACE_RICH_PREVIEW_MAX_BYTES) {
        return unsupportedWorkspacePreview(relativePath, fileStats.size, 'too-large', WORKSPACE_RICH_PREVIEW_MAX_BYTES)
      }
      return { ...base, kind: 'pdf', data: new Uint8Array(await readFile(safePath)) }
    }

    if (WORKSPACE_OFFICE_EXTENSIONS.has(extension)) {
      if (fileStats.size > WORKSPACE_OFFICE_PREVIEW_MAX_BYTES) {
        return unsupportedWorkspacePreview(relativePath, fileStats.size, 'too-large', WORKSPACE_OFFICE_PREVIEW_MAX_BYTES)
      }
      const converted = await new MarkItDown().convert(safePath)
      const content = converted?.textContent ?? ''
      const truncated = content.length > WORKSPACE_CONVERTED_PREVIEW_MAX_CHARS
      return {
        ...base,
        kind: 'markdown',
        content: truncated ? content.slice(0, WORKSPACE_CONVERTED_PREVIEW_MAX_CHARS) : content,
        source: 'converted',
        truncated,
      }
    }

    if (fileStats.size > WORKSPACE_TEXT_PREVIEW_MAX_BYTES) {
      return unsupportedWorkspacePreview(relativePath, fileStats.size, 'too-large', WORKSPACE_TEXT_PREVIEW_MAX_BYTES)
    }
    if (WORKSPACE_BINARY_EXTENSIONS.has(extension)) {
      return unsupportedWorkspacePreview(relativePath, fileStats.size, 'unsupported-format')
    }

    const buffer = await readFile(safePath)
    if (buffer.includes(0)) return unsupportedWorkspacePreview(relativePath, fileStats.size, 'binary')
    if (!isValidUtf8(buffer)) return unsupportedWorkspacePreview(relativePath, fileStats.size, 'binary')
    const content = buffer.toString('utf-8')
    if (extension === 'md' || extension === 'mdx') {
      return { ...base, kind: 'markdown', content, source: 'native' }
    }
    if (extension === 'csv' || extension === 'tsv') {
      return { ...base, kind: 'table', content, delimiter: extension === 'tsv' ? '\t' : ',' }
    }
    return { ...base, kind: 'text', content }
  })

  server.handle(RPC_CHANNELS.fs.READ_WORKSPACE_DRAFT, async (ctx, requestedPath: string): Promise<WorkspaceFileDraft | null> => {
    const { safePath } = await resolveWorkspaceRelativePath(ctx, deps, requestedPath)
    await assertEditableWorkspaceTextFile(safePath)
    return readWorkspaceFileDraftRecord(workspaceDraftIdentity(ctx, deps, requestedPath))
  })

  server.handle(RPC_CHANNELS.fs.SET_WORKSPACE_DRAFT, async (
    ctx,
    requestedPath: string,
    rawContent: string,
    rawBaseContent: string,
  ): Promise<WorkspaceFileDraft> => {
    const content = validateWorkspaceDraftText(rawContent, 'Draft content')
    const baseContent = validateWorkspaceDraftText(rawBaseContent, 'Draft base content')
    const { safePath, rootPath } = await resolveWorkspaceRelativePath(ctx, deps, requestedPath)
    const identity = workspaceDraftIdentity(ctx, deps, requestedPath)
    return serializePathMutation(workspaceEntryMutationChains, rootPath, () =>
      serializePathMutation(workspaceFileDraftMutationChains, identity.filePath, async () => {
        await assertEditableWorkspaceTextFile(safePath)
        return writeWorkspaceFileDraftRecord(identity, content, baseContent)
      }))
  })

  server.handle(RPC_CHANNELS.fs.DELETE_WORKSPACE_DRAFT, async (ctx, requestedPath: string): Promise<void> => {
    const identity = workspaceDraftIdentity(ctx, deps, requestedPath)
    const { rootPath } = getRequestWorkspaceRoot(ctx, deps)
    await serializePathMutation(workspaceEntryMutationChains, rootPath, () =>
      serializePathMutation(workspaceFileDraftMutationChains, identity.filePath, () =>
        deleteWorkspaceFileDraftRecord(identity)))
  })

  server.handle(RPC_CHANNELS.fs.WRITE_WORKSPACE_TEXT, async (
    ctx,
    requestedPath: string,
    rawContent: string,
    rawExpectedContent: string,
  ): Promise<FileTextWriteResult> => {
    const content = validateWorkspaceDraftText(rawContent, 'File content')
    const expectedContent = validateWorkspaceDraftText(rawExpectedContent, 'Expected file content')
    const { safePath, rootPath } = await resolveWorkspaceRelativePath(ctx, deps, requestedPath)
    return serializePathMutation(workspaceEntryMutationChains, rootPath, () =>
      serializePathMutation(workspaceTextWriteChains, safePath, async () => {
        await assertEditableWorkspaceTextFile(safePath)
        const currentBuffer = await readFile(safePath)
        if (!isValidUtf8(currentBuffer)) throw new Error('This file cannot be edited as text')
        const currentContent = currentBuffer.toString('utf-8')
        if (currentContent !== expectedContent) return { status: 'conflict', currentContent }
        return writeWorkspaceTextFileAtomically(safePath, content, expectedContent)
      }))
  })

  // Filesystem search for @ mention file selection.
  // Parallel BFS walk that skips ignored directories BEFORE entering them,
  // avoiding reading node_modules/etc. contents entirely. Uses withFileTypes
  // to get entry types without separate stat calls.
  server.handle(RPC_CHANNELS.fs.SEARCH, async (ctx, basePath: string, query: string) => {
    deps.platform.logger.info('[FS_SEARCH] called:', basePath, query)
    const MAX_RESULTS = 50

    // SECURITY: Validate basePath itself against the same realpath-aware boundary
    // used by file.READ. Directory symlinks are not enqueued by this Dirent-based
    // walk; keep any future stat-based recursion realpath-aware before entering.
    const workspaceId = ctx.workspaceId ?? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId!)
    const safeBase = await validateFilePath(basePath, getWorkspaceAllowedDirs(workspaceId), getFilePathValidationOptions(ctx, deps, workspaceId))

    // Directories to never recurse into
    const SKIP_DIRS = new Set([
      'node_modules', '.git', '.svn', '.hg', 'dist', 'build',
      '.next', '.nuxt', '.cache', '__pycache__', 'vendor',
      '.idea', '.vscode', 'coverage', '.nyc_output', '.turbo', 'out',
    ])

    const lowerQuery = query.toLowerCase()
    const results: Array<{ name: string; path: string; type: 'file' | 'directory'; relativePath: string }> = []

    try {
      // BFS queue: each entry is a relative path prefix ('' for root)
      let queue = ['']

      while (queue.length > 0 && results.length < MAX_RESULTS) {
        // Process current level: read all directories in parallel
        const nextQueue: string[] = []

        const dirResults = await Promise.all(
          queue.map(async (relDir) => {
            const absDir = relDir ? join(safeBase, relDir) : safeBase
            try {
              return { relDir, entries: await readdir(absDir, { withFileTypes: true }) }
            } catch {
              // Skip dirs we can't read (permissions, broken symlinks, etc.)
              return { relDir, entries: [] as import('fs').Dirent[] }
            }
          })
        )

        for (const { relDir, entries } of dirResults) {
          if (results.length >= MAX_RESULTS) break

          for (const entry of entries) {
            if (results.length >= MAX_RESULTS) break

            const name = entry.name
            // Skip hidden files/dirs and ignored directories
            if (name.startsWith('.') || SKIP_DIRS.has(name)) continue

            const relativePath = relDir ? `${relDir}/${name}` : name
            const isDir = entry.isDirectory()

            // Queue subdirectories for next BFS level
            if (isDir) {
              nextQueue.push(relativePath)
            }

            // Check if name or path matches the query
            const lowerName = name.toLowerCase()
            const lowerRelative = relativePath.toLowerCase()
            if (lowerName.includes(lowerQuery) || lowerRelative.includes(lowerQuery)) {
              results.push({
                name,
                path: join(safeBase, relativePath),
                type: isDir ? 'directory' : 'file',
                relativePath,
              })
            }
          }
        }

        queue = nextQueue
      }

      // Sort: directories first, then by name length (shorter = better match)
      results.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
        return a.name.length - b.name.length
      })

      deps.platform.logger.info('[FS_SEARCH] returning', results.length, 'results')
      return results
    } catch (err) {
      deps.platform.logger.error('[FS_SEARCH] error:', err)
      return []
    }
  })

  // List directories in a given path (for remote directory browsing).
  // Returns only directories (not files) — this is a folder picker.
  server.handle(RPC_CHANNELS.fs.LIST_DIRECTORY, async (ctx, dirPath: string) => {
    // Resolve ~ to server's home directory (thin clients don't know the server's home)
    if (dirPath === '~' || dirPath.startsWith('~/')) {
      dirPath = dirPath === '~' ? homedir() : join(homedir(), dirPath.slice(2))
    }

    // Reject cross-platform and relative paths before resolve() can concatenate with cwd
    const pathCheck = validatePathFormat(dirPath)
    if (!pathCheck.valid) {
      throw new Error(pathCheck.reason!)
    }

    // SECURITY: Validate the path is within allowed directories (workspace root,
    // home, tmp) to prevent listing arbitrary server paths. validateFilePath
    // resolves symlinks and checks container membership. Done after ~ expansion
    // so the legitimate home-dir browsing feature keeps working.
    const workspaceId = ctx.workspaceId ?? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId!)
    // The browser picker starts at the server's home directory. This is a
    // directory-listing-only capability; file reads retain their stricter
    // trusted-local-client requirement in getFilePathValidationOptions().
    const safePath = await validateFilePath(dirPath, getWorkspaceAllowedDirs(workspaceId), {
      allowHome: true,
    })

    // Read entries, filter to directories
    const raw = await readdir(safePath, { withFileTypes: true })

    const entries: Array<{ name: string; path: string; isSymlink: boolean }> = []
    for (const entry of raw) {
      const fullPath = join(safePath, entry.name)
      const isSymlink = entry.isSymbolicLink()

      if (entry.isDirectory()) {
        entries.push({ name: entry.name, path: fullPath, isSymlink: false })
      } else if (isSymlink) {
        // Follow symlink — check if target is a directory
        try {
          const target = await stat(fullPath)
          if (target.isDirectory()) {
            entries.push({ name: entry.name, path: fullPath, isSymlink: true })
          }
        } catch {
          // Broken symlink — skip silently
        }
      }
    }

    // Sort alphabetically (case-insensitive), cap at 500
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    const totalEntries = entries.length
    const truncated = totalEntries > 500
    if (truncated) entries.length = 500

    // Compute parent path
    const parentPath = safePath === parsePath(safePath).root ? null : dirname(safePath)

    // Compute breadcrumbs server-side
    const breadcrumbs: Array<{ name: string; path: string }> = []
    let current = safePath
    while (true) {
      const parsed = parsePath(current)
      const name = parsed.base || parsed.root
      breadcrumbs.unshift({ name, path: current })
      if (current === parsed.root) break
      current = dirname(current)
    }

    return {
      currentPath: safePath,
      parentPath,
      breadcrumbs,
      platform: process.platform as DirectoryListingResult['platform'],
      truncated,
      totalEntries,
      entries,
    } satisfies DirectoryListingResult
  })
}
