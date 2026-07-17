import { describe, expect, it } from 'bun:test'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, truncate, unlink, writeFile } from 'fs/promises'
import { homedir, tmpdir } from 'os'
import { dirname, join } from 'path'
import { pathToFileURL } from 'url'
import { EventEmitter } from 'events'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { HandlerFn, RequestContext, RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import {
  deleteWorkspaceFileDraftRecord,
  cleanupWorkspaceFileWatchForClient,
  isCaseOnlyWorkspaceRename,
  readWorkspaceFileDraftRecord,
  registerFilesHandlers,
  setWorkspaceWatcherFactoryForTesting,
  type WorkspaceFileDraftStorageIdentity,
} from './files'

const FILES_MODULE = pathToFileURL(join(import.meta.dir, 'files.ts')).href

function createTestHarness(options?: {
  withWindowManager?: boolean
  workspaceRoot?: string
  secondWorkspaceRoot?: string
}) {
  const handlers = new Map<string, HandlerFn>()
  const warnings: unknown[][] = []
  const pushes: Array<{ channel: string; target: unknown; args: unknown[] }> = []

  const server: RpcServer = {
    handle(channel, handler) {
      handlers.set(channel, handler)
    },
    push(channel, target, ...args) {
      pushes.push({ channel, target, args })
    },
    async invokeClient() {
      return undefined
    },
    hasClientCapability() {
      return false
    },
    findClientsWithCapability() {
      return []
    },
  }

  const deps: HandlerDeps = {
    sessionManager: {
      getWorkspaces: () => [
        ...(options?.workspaceRoot ? [{
          id: 'ws-1',
          name: 'Workspace',
          slug: 'workspace',
          rootPath: options.workspaceRoot,
          createdAt: Date.now(),
        }] : []),
        ...(options?.secondWorkspaceRoot ? [{
          id: 'ws-2',
          name: 'Second Workspace',
          slug: 'second-workspace',
          rootPath: options.secondWorkspaceRoot,
          createdAt: Date.now(),
        }] : []),
      ],
    } as HandlerDeps['sessionManager'],
    oauthFlowStore: {} as HandlerDeps['oauthFlowStore'],
    platform: {
      appRootPath: '/',
      resourcesPath: '/',
      isPackaged: false,
      appVersion: '0.0.0-test',
      isDebugMode: true,
      logger: {
        info: () => {},
        warn: (...args: unknown[]) => {
          warnings.push(args)
        },
        error: () => {},
        debug: () => {},
      },
      imageProcessor: {
        getMetadata: async () => null,
        process: async () => Buffer.from(''),
      },
    },
  }
  if (options?.withWindowManager !== false) {
    deps.windowManager = {
      getWorkspaceForWindow: () => 'ws-1',
      updateWindowWorkspace: async () => true,
      getWindowByWebContentsId: () => null,
      registerWindow: () => {},
      getAllWindowsForWorkspace: () => [],
    }
  }

  registerFilesHandlers(server, deps)

  const readUserAttachment = handlers.get(RPC_CHANNELS.file.READ_USER_ATTACHMENT)
  if (!readUserAttachment) {
    throw new Error('READ_USER_ATTACHMENT handler not registered')
  }

  const ctx: RequestContext = {
    clientId: 'client-1',
    workspaceId: 'ws-1',
    webContentsId: 101,
  }

  const listDirectory = handlers.get(RPC_CHANNELS.fs.LIST_DIRECTORY)
  if (!listDirectory) {
    throw new Error('LIST_DIRECTORY handler not registered')
  }

  const readGenericTextFile = handlers.get(RPC_CHANNELS.file.READ)
  const readGenericFileDataUrl = handlers.get(RPC_CHANNELS.file.READ_DATA_URL)
  const readGenericPreviewDataUrl = handlers.get(RPC_CHANNELS.file.READ_PREVIEW_DATA_URL)
  const readGenericBinaryFile = handlers.get(RPC_CHANNELS.file.READ_BINARY)
  if (
    !readGenericTextFile
    || !readGenericFileDataUrl
    || !readGenericPreviewDataUrl
    || !readGenericBinaryFile
  ) {
    throw new Error('Generic preview file handlers not registered')
  }

  const listWorkspaceDirectory = handlers.get(RPC_CHANNELS.fs.LIST_WORKSPACE_DIRECTORY)
  const searchWorkspaceFiles = handlers.get(RPC_CHANNELS.fs.SEARCH_WORKSPACE)
  const readWorkspaceFilePreview = handlers.get(RPC_CHANNELS.fs.READ_WORKSPACE_PREVIEW)
  const readWorkspaceFileDraft = handlers.get(RPC_CHANNELS.fs.READ_WORKSPACE_DRAFT)
  const setWorkspaceFileDraft = handlers.get(RPC_CHANNELS.fs.SET_WORKSPACE_DRAFT)
  const deleteWorkspaceFileDraft = handlers.get(RPC_CHANNELS.fs.DELETE_WORKSPACE_DRAFT)
  const writeWorkspaceTextFile = handlers.get(RPC_CHANNELS.fs.WRITE_WORKSPACE_TEXT)
  const createWorkspaceEntry = handlers.get(RPC_CHANNELS.fs.CREATE_WORKSPACE_ENTRY)
  const renameWorkspaceEntry = handlers.get(RPC_CHANNELS.fs.RENAME_WORKSPACE_ENTRY)
  const deleteWorkspaceEntry = handlers.get(RPC_CHANNELS.fs.DELETE_WORKSPACE_ENTRY)
  const watchWorkspaceFiles = handlers.get(RPC_CHANNELS.fs.WATCH_WORKSPACE)
  const unwatchWorkspaceFiles = handlers.get(RPC_CHANNELS.fs.UNWATCH_WORKSPACE)
  if (
    !listWorkspaceDirectory
    || !searchWorkspaceFiles
    || !readWorkspaceFilePreview
    || !readWorkspaceFileDraft
    || !setWorkspaceFileDraft
    || !deleteWorkspaceFileDraft
    || !writeWorkspaceTextFile
    || !createWorkspaceEntry
    || !renameWorkspaceEntry
    || !deleteWorkspaceEntry
    || !watchWorkspaceFiles
    || !unwatchWorkspaceFiles
  ) {
    throw new Error('Workspace file browser handlers not registered')
  }

  return {
    readUserAttachment,
    listDirectory,
    readGenericTextFile,
    readGenericFileDataUrl,
    readGenericPreviewDataUrl,
    readGenericBinaryFile,
    listWorkspaceDirectory,
    searchWorkspaceFiles,
    readWorkspaceFilePreview,
    readWorkspaceFileDraft,
    setWorkspaceFileDraft,
    deleteWorkspaceFileDraft,
    writeWorkspaceTextFile,
    createWorkspaceEntry,
    renameWorkspaceEntry,
    deleteWorkspaceEntry,
    watchWorkspaceFiles,
    unwatchWorkspaceFiles,
    ctx,
    warnings,
    pushes,
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

describe('registerFilesHandlers READ_USER_ATTACHMENT', () => {
  it('rejects requests without a trusted local Electron window', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'craft-user-attachment-'))
    try {
      const filePath = join(tmp, 'notes.txt')
      await writeFile(filePath, 'hello')

      const { readUserAttachment, ctx, warnings } = createTestHarness({ withWindowManager: false })

      await expect(readUserAttachment(ctx, filePath)).resolves.toBeNull()
      expect(warnings.some((args) => String(args[0]).includes('rejected non-local'))).toBe(true)
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  it('blocks symlink aliases whose real target is a sensitive path', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'craft-user-attachment-'))
    try {
      const sshDir = join(tmp, '.ssh')
      await mkdir(sshDir)
      const sensitiveTarget = join(sshDir, 'id_rsa')
      const symlinkAlias = join(tmp, 'notes.txt')
      await writeFile(sensitiveTarget, 'private-key')

      try {
        await symlink(sensitiveTarget, symlinkAlias, 'file')
      } catch {
        return
      }

      const { readUserAttachment, ctx, warnings } = createTestHarness()

      await expect(readUserAttachment(ctx, symlinkAlias)).resolves.toBeNull()
      expect(warnings.some((args) => String(args[0]).includes('.ssh'))).toBe(true)
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })
})

describe('registerFilesHandlers LIST_DIRECTORY', () => {
  it('allows a remote client to browse the server home directory', async () => {
    const { listDirectory } = createTestHarness({ withWindowManager: false })
    const result = await listDirectory({
      clientId: 'remote-client',
      workspaceId: null,
      webContentsId: null,
    }, homedir())

    expect(result.currentPath).toBe(homedir())
    expect(Array.isArray(result.entries)).toBe(true)
  })
})

describe('registerFilesHandlers generic preview read limits', () => {
  it('rejects text and rich preview sources before reading oversized files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'craft-preview-read-limits-'))
    try {
      const oversizedText = join(root, 'oversized.html')
      const oversizedImage = join(root, 'oversized.png')
      const oversizedPdf = join(root, 'oversized.pdf')
      await writeFile(oversizedText, '')
      await writeFile(oversizedImage, '')
      await writeFile(oversizedPdf, '')
      await truncate(oversizedText, 2 * 1024 * 1024 + 1)
      await truncate(oversizedImage, 25 * 1024 * 1024 + 1)
      await truncate(oversizedPdf, 25 * 1024 * 1024 + 1)

      const {
        readGenericTextFile,
        readGenericFileDataUrl,
        readGenericPreviewDataUrl,
        readGenericBinaryFile,
        ctx,
      } = createTestHarness({ workspaceRoot: root })

      await expect(readGenericTextFile(ctx, oversizedText)).rejects.toThrow('2 MiB preview limit')
      await expect(readGenericFileDataUrl(ctx, oversizedImage)).rejects.toThrow('25 MiB preview limit')
      await expect(readGenericPreviewDataUrl(ctx, oversizedImage)).rejects.toThrow('25 MiB preview limit')
      await expect(readGenericBinaryFile(ctx, oversizedPdf)).rejects.toThrow('25 MiB preview limit')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('registerFilesHandlers workspace file browser', () => {
  it('lists and searches workspace-relative paths without exposing the root path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'craft-workspace-files-'))
    try {
      await mkdir(join(root, 'docs'))
      await mkdir(join(root, 'node_modules'))
      await writeFile(join(root, 'README.md'), '# Hello')
      await writeFile(join(root, 'docs', 'guide.txt'), 'Guide')
      await writeFile(join(root, 'node_modules', 'hidden.txt'), 'ignored by search')
      const { listWorkspaceDirectory, searchWorkspaceFiles, ctx } = createTestHarness({ workspaceRoot: root })

      const listing = await listWorkspaceDirectory(ctx, '') as {
        relativePath: string
        entries: Array<{ name: string; relativePath: string; type: string }>
      }
      expect(listing.relativePath).toBe('')
      expect(listing.entries.map(entry => entry.name)).toEqual(['docs', 'node_modules', 'README.md'])
      expect(JSON.stringify(listing)).not.toContain(root)

      const search = await searchWorkspaceFiles(ctx, 'guide') as Array<{ relativePath: string }>
      expect(search).toEqual([expect.objectContaining({ relativePath: 'docs/guide.txt' })])
      expect(JSON.stringify(search)).not.toContain(root)
      await expect(listWorkspaceDirectory(ctx, '../')).rejects.toThrow('cannot traverse')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('creates, renames, and explicitly deletes workspace entries without overwriting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'craft-workspace-mutations-'))
    try {
      const {
        createWorkspaceEntry,
        renameWorkspaceEntry,
        deleteWorkspaceEntry,
        ctx,
      } = createTestHarness({ workspaceRoot: root })

      await expect(createWorkspaceEntry(ctx, 'docs', 'directory')).resolves.toMatchObject({
        relativePath: 'docs',
        type: 'directory',
      })
      await expect(createWorkspaceEntry(ctx, 'docs/notes.txt', 'file')).resolves.toMatchObject({
        relativePath: 'docs/notes.txt',
        type: 'file',
      })
      expect(await readFile(join(root, 'docs', 'notes.txt'), 'utf-8')).toBe('')
      await expect(createWorkspaceEntry(ctx, 'docs/notes.txt', 'file')).rejects.toThrow('already exists')

      await expect(renameWorkspaceEntry(ctx, 'docs/notes.txt', 'docs/renamed.txt')).resolves.toMatchObject({
        previousRelativePath: 'docs/notes.txt',
        relativePath: 'docs/renamed.txt',
      })
      await createWorkspaceEntry(ctx, 'docs/existing.txt', 'file')
      await expect(renameWorkspaceEntry(ctx, 'docs/renamed.txt', 'docs/existing.txt'))
        .rejects.toThrow('already exists')

      await expect(deleteWorkspaceEntry(ctx, 'docs', false)).rejects.toThrow('recursive confirmation')
      await expect(deleteWorkspaceEntry(ctx, 'docs', true)).resolves.toMatchObject({ type: 'directory' })
      await expect(stat(join(root, 'docs'))).rejects.toMatchObject({ code: 'ENOENT' })

      await expect(createWorkspaceEntry(ctx, '.env', 'file')).rejects.toThrow('sensitive')
      await expect(createWorkspaceEntry(ctx, '../outside.txt', 'file')).rejects.toThrow('traverse')
      await expect(deleteWorkspaceEntry(ctx, '', true)).rejects.toThrow('root')

      await mkdir(join(root, 'protected'))
      await writeFile(join(root, 'protected', '.env'), 'SECRET=value')
      await expect(renameWorkspaceEntry(ctx, 'protected', 'renamed-protected')).rejects.toThrow('sensitive')
      await expect(deleteWorkspaceEntry(ctx, 'protected', true)).rejects.toThrow('sensitive')
      expect(await readFile(join(root, 'protected', '.env'), 'utf-8')).toBe('SECRET=value')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('recognizes Windows case-only renames and applies them without overwrite semantics', async () => {
    expect(isCaseOnlyWorkspaceRename('docs/Readme.md', 'docs/README.md', 'win32')).toBe(true)
    expect(isCaseOnlyWorkspaceRename('docs/Readme.md', 'docs/README.md', 'linux')).toBe(false)
    expect(isCaseOnlyWorkspaceRename('docs/README.md', 'docs/README.md', 'win32')).toBe(false)
    if (process.platform !== 'win32') return

    const root = await mkdtemp(join(tmpdir(), 'craft-workspace-case-rename-'))
    try {
      await writeFile(join(root, 'Readme.md'), 'content')
      const { renameWorkspaceEntry, listWorkspaceDirectory, ctx } = createTestHarness({ workspaceRoot: root })
      await renameWorkspaceEntry(ctx, 'Readme.md', 'README.md')
      expect(await readFile(join(root, 'README.md'), 'utf-8')).toBe('content')
      const listing = await listWorkspaceDirectory(ctx, '') as { entries: Array<{ name: string }> }
      expect(listing.entries.map(entry => entry.name)).toContain('README.md')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('renames and deletes a symlink node without mutating its target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'craft-workspace-link-mutation-'))
    try {
      const target = join(root, 'target')
      const alias = join(root, 'alias')
      await mkdir(target)
      await writeFile(join(target, 'keep.txt'), 'keep')
      try {
        await symlink(target, alias, 'junction')
      } catch {
        return
      }
      const { renameWorkspaceEntry, deleteWorkspaceEntry, ctx } = createTestHarness({ workspaceRoot: root })

      await expect(renameWorkspaceEntry(ctx, 'alias', 'renamed-alias')).resolves.toMatchObject({
        type: 'directory',
        isSymlink: true,
      })
      expect((await lstat(join(root, 'renamed-alias'))).isSymbolicLink()).toBe(true)
      await expect(deleteWorkspaceEntry(ctx, 'renamed-alias', false)).resolves.toMatchObject({
        type: 'directory',
        isSymlink: true,
      })
      expect(await readFile(join(target, 'keep.txt'), 'utf-8')).toBe('keep')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects entry mutations with active drafts and never revives a discarded draft after recreation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'craft-workspace-draft-mutation-'))
    const configDir = await mkdtemp(join(tmpdir(), 'craft-workspace-draft-mutation-config-'))
    const previousConfigDir = process.env.CRAFT_CONFIG_DIR
    process.env.CRAFT_CONFIG_DIR = configDir
    try {
      await mkdir(join(root, 'docs'))
      await writeFile(join(root, 'docs', 'notes.txt'), 'original')
      const {
        setWorkspaceFileDraft,
        readWorkspaceFileDraft,
        deleteWorkspaceFileDraft,
        createWorkspaceEntry,
        renameWorkspaceEntry,
        deleteWorkspaceEntry,
        ctx,
      } = createTestHarness({ workspaceRoot: root })

      await setWorkspaceFileDraft(ctx, 'docs/notes.txt', 'recoverable edit', 'original')
      await expect(renameWorkspaceEntry(ctx, 'docs', 'renamed-docs')).rejects.toThrow('Save or discard')
      await expect(deleteWorkspaceEntry(ctx, 'docs', true)).rejects.toThrow('Save or discard')

      await unlink(join(root, 'docs', 'notes.txt'))
      await createWorkspaceEntry(ctx, 'docs/notes.txt', 'file')
      await expect(readWorkspaceFileDraft(ctx, 'docs/notes.txt')).resolves.toMatchObject({
        content: 'recoverable edit',
      })
      await deleteWorkspaceFileDraft(ctx, 'docs/notes.txt')
      await deleteWorkspaceEntry(ctx, 'docs/notes.txt', false)
      await createWorkspaceEntry(ctx, 'docs/notes.txt', 'file')
      await expect(readWorkspaceFileDraft(ctx, 'docs/notes.txt')).resolves.toBeNull()
      expect(await readFile(join(root, 'docs', 'notes.txt'), 'utf-8')).toBe('')
    } finally {
      if (previousConfigDir === undefined) delete process.env.CRAFT_CONFIG_DIR
      else process.env.CRAFT_CONFIG_DIR = previousConfigDir
      await rm(root, { recursive: true, force: true })
      await rm(configDir, { recursive: true, force: true })
    }
  })

  it('serializes cross-client draft, save, and entry mutations at the workspace boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'craft-workspace-mutation-race-'))
    const configDir = await mkdtemp(join(tmpdir(), 'craft-workspace-mutation-race-config-'))
    const previousConfigDir = process.env.CRAFT_CONFIG_DIR
    process.env.CRAFT_CONFIG_DIR = configDir
    try {
      await writeFile(join(root, 'draft.txt'), 'original')
      await writeFile(join(root, 'save.txt'), 'original')
      const {
        setWorkspaceFileDraft,
        readWorkspaceFileDraft,
        deleteWorkspaceFileDraft,
        writeWorkspaceTextFile,
        renameWorkspaceEntry,
        ctx,
      } = createTestHarness({ workspaceRoot: root })
      const ctx2 = { ...ctx, clientId: 'client-2', webContentsId: 102 }

      const [renameDraft, setDraft] = await Promise.allSettled([
        renameWorkspaceEntry(ctx, 'draft.txt', 'draft-renamed.txt'),
        setWorkspaceFileDraft(ctx2, 'draft.txt', 'recoverable', 'original'),
      ])
      expect(renameDraft.status === 'fulfilled' && setDraft.status === 'fulfilled').toBe(false)
      if (renameDraft.status === 'fulfilled') {
        expect(setDraft.status).toBe('rejected')
        expect(await readFile(join(root, 'draft-renamed.txt'), 'utf-8')).toBe('original')
      } else {
        expect(setDraft.status).toBe('fulfilled')
        await expect(readWorkspaceFileDraft(ctx, 'draft.txt')).resolves.toMatchObject({ content: 'recoverable' })
        await deleteWorkspaceFileDraft(ctx, 'draft.txt')
      }

      const [renameSave, save] = await Promise.allSettled([
        renameWorkspaceEntry(ctx, 'save.txt', 'save-renamed.txt'),
        writeWorkspaceTextFile(ctx2, 'save.txt', 'updated', 'original'),
      ])
      expect(renameSave.status === 'fulfilled' || save.status === 'fulfilled').toBe(true)
      if (renameSave.status === 'fulfilled') {
        await expect(stat(join(root, 'save.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
        expect(await readFile(join(root, 'save-renamed.txt'), 'utf-8'))
          .toBe(save.status === 'fulfilled' ? 'updated' : 'original')
      } else {
        expect(save.status).toBe('fulfilled')
        expect(await readFile(join(root, 'save.txt'), 'utf-8')).toBe('updated')
      }
    } finally {
      if (previousConfigDir === undefined) delete process.env.CRAFT_CONFIG_DIR
      else process.env.CRAFT_CONFIG_DIR = previousConfigDir
      await rm(root, { recursive: true, force: true })
      await rm(configDir, { recursive: true, force: true })
    }
  })

  it('shares one filtered workspace watcher while keeping client subscriptions independent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'craft-workspace-watch-'))
    const ctx2: RequestContext = {
      clientId: 'client-2',
      workspaceId: 'ws-1',
      webContentsId: 102,
    }
    try {
      await mkdir(join(root, 'node_modules'))
      await mkdir(join(root, '.git'))
      const { watchWorkspaceFiles, unwatchWorkspaceFiles, ctx, pushes } = createTestHarness({ workspaceRoot: root })
      await watchWorkspaceFiles(ctx)
      await watchWorkspaceFiles(ctx2)

      await writeFile(join(root, 'node_modules', 'ignored.txt'), 'ignored')
      await writeFile(join(root, '.git', 'ignored.txt'), 'ignored')
      await writeFile(join(root, '.env'), 'ignored')
      await new Promise(resolve => setTimeout(resolve, 300))
      expect(pushes).toEqual([])

      await writeFile(join(root, 'visible.txt'), 'visible')
      await waitUntil(() => pushes.length >= 2)
      expect(pushes.map(push => push.channel)).toEqual([
        RPC_CHANNELS.fs.WORKSPACE_CHANGED,
        RPC_CHANNELS.fs.WORKSPACE_CHANGED,
      ])
      expect(new Set(pushes.map(push => (push.target as { clientId: string }).clientId)))
        .toEqual(new Set(['client-1', 'client-2']))
      expect(pushes.every(push => push.args[0] === 'ws-1')).toBe(true)

      pushes.length = 0
      await unwatchWorkspaceFiles(ctx)
      await writeFile(join(root, 'visible-2.txt'), 'visible')
      await waitUntil(() => pushes.length >= 1)
      await new Promise(resolve => setTimeout(resolve, 200))
      expect(pushes).toHaveLength(1)
      expect((pushes[0]!.target as { clientId: string }).clientId).toBe('client-2')
      await unwatchWorkspaceFiles(ctx2)
    } finally {
      cleanupWorkspaceFileWatchForClient('client-1')
      cleanupWorkspaceFileWatchForClient('client-2')
      await rm(root, { recursive: true, force: true })
    }
  }, 10_000)

  it('rejects an initial watcher failure and builds a fresh watcher on retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'craft-workspace-watch-retry-'))
    let attempts = 0
    try {
      setWorkspaceWatcherFactoryForTesting(() => {
        attempts += 1
        const watcher = new EventEmitter() as EventEmitter & { close: () => Promise<void> }
        watcher.close = async () => {}
        const attempt = attempts
        queueMicrotask(() => {
          if (attempt === 1) watcher.emit('error', new Error('watch unavailable'))
          else watcher.emit('ready')
        })
        return watcher as unknown as import('chokidar').FSWatcher
      })
      const { watchWorkspaceFiles, unwatchWorkspaceFiles, ctx } = createTestHarness({ workspaceRoot: root })

      await expect(watchWorkspaceFiles(ctx)).rejects.toThrow('watch unavailable')
      await expect(watchWorkspaceFiles(ctx)).resolves.toBeUndefined()
      expect(attempts).toBe(2)
      await unwatchWorkspaceFiles(ctx)
    } finally {
      cleanupWorkspaceFileWatchForClient('client-1')
      setWorkspaceWatcherFactoryForTesting()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not let a stale workspace teardown remove the client\'s newer watch', async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), 'craft-workspace-watch-old-'))
    const secondRoot = await mkdtemp(join(tmpdir(), 'craft-workspace-watch-new-'))
    const nextCtx: RequestContext = {
      clientId: 'client-1',
      workspaceId: 'ws-2',
      webContentsId: 101,
    }
    try {
      const { watchWorkspaceFiles, unwatchWorkspaceFiles, ctx, pushes } = createTestHarness({
        workspaceRoot: firstRoot,
        secondWorkspaceRoot: secondRoot,
      })
      await watchWorkspaceFiles(ctx)
      await watchWorkspaceFiles(nextCtx)

      await unwatchWorkspaceFiles(ctx)
      await writeFile(join(secondRoot, 'still-watched.txt'), 'visible')
      await waitUntil(() => pushes.length >= 1)
      expect(pushes).toContainEqual(expect.objectContaining({
        channel: RPC_CHANNELS.fs.WORKSPACE_CHANGED,
        args: ['ws-2'],
      }))
      await unwatchWorkspaceFiles(nextCtx)
    } finally {
      cleanupWorkspaceFileWatchForClient('client-1')
      await rm(firstRoot, { recursive: true, force: true })
      await rm(secondRoot, { recursive: true, force: true })
    }
  }, 10_000)

  it('returns typed previews and preserves the sensitive-file boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'craft-workspace-preview-'))
    try {
      await writeFile(join(root, 'notes.md'), '# Notes')
      await writeFile(join(root, 'data.csv'), 'name,value\nalpha,1')
      await writeFile(join(root, 'blob.bin'), Buffer.from([0, 1, 2]))
      await writeFile(join(root, '.env'), 'TOKEN=secret')
      const {
        listWorkspaceDirectory,
        searchWorkspaceFiles,
        readWorkspaceFilePreview,
        setWorkspaceFileDraft,
        ctx,
      } = createTestHarness({ workspaceRoot: root })

      await expect(readWorkspaceFilePreview(ctx, 'notes.md')).resolves.toMatchObject({
        kind: 'markdown',
        source: 'native',
        content: '# Notes',
        relativePath: 'notes.md',
      })
      await expect(readWorkspaceFilePreview(ctx, 'data.csv')).resolves.toMatchObject({
        kind: 'table',
        delimiter: ',',
      })
      await expect(readWorkspaceFilePreview(ctx, 'blob.bin')).resolves.toMatchObject({
        kind: 'unsupported',
        reason: 'binary',
      })
      await expect(readWorkspaceFilePreview(ctx, '.env')).rejects.toThrow('sensitive')
      await expect(setWorkspaceFileDraft(ctx, '.env', 'draft', 'TOKEN=secret')).rejects.toThrow('sensitive')
      const listing = await listWorkspaceDirectory(ctx, '') as { entries: Array<{ name: string }> }
      expect(listing.entries.some(entry => entry.name === '.env')).toBe(false)
      await expect(searchWorkspaceFiles(ctx, '.env')).resolves.toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps invalid UTF-8 files read-only without rewriting their bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'craft-workspace-encoding-'))
    try {
      const filePath = join(root, 'latin1.txt')
      const originalBytes = Buffer.from([0x63, 0x61, 0x66, 0xe9])
      await writeFile(filePath, originalBytes)
      const {
        readWorkspaceFilePreview,
        setWorkspaceFileDraft,
        writeWorkspaceTextFile,
        ctx,
      } = createTestHarness({ workspaceRoot: root })

      await expect(readWorkspaceFilePreview(ctx, 'latin1.txt')).resolves.toMatchObject({
        kind: 'unsupported',
        reason: 'binary',
      })
      await expect(setWorkspaceFileDraft(ctx, 'latin1.txt', 'draft', 'base'))
        .rejects.toThrow('cannot be edited as text')
      await expect(writeWorkspaceTextFile(ctx, 'latin1.txt', 'updated', 'caf\uFFFD'))
        .rejects.toThrow('cannot be edited as text')
      expect(await readFile(filePath)).toEqual(originalBytes)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('persists editor drafts under the private server profile and isolates resources', async () => {
    const root = await mkdtemp(join(tmpdir(), 'craft-workspace-drafts-'))
    const configDir = await mkdtemp(join(tmpdir(), 'craft-workspace-draft-config-'))
    const previousConfigDir = process.env.CRAFT_CONFIG_DIR
    process.env.CRAFT_CONFIG_DIR = configDir
    try {
      await writeFile(join(root, 'alpha.txt'), 'alpha')
      await writeFile(join(root, 'beta.txt'), 'beta')
      const {
        readWorkspaceFileDraft,
        setWorkspaceFileDraft,
        deleteWorkspaceFileDraft,
        ctx,
      } = createTestHarness({ workspaceRoot: root })

      await setWorkspaceFileDraft(ctx, 'alpha.txt', 'alpha draft', 'alpha')
      await setWorkspaceFileDraft(ctx, 'beta.txt', 'beta draft', 'beta')
      await expect(readWorkspaceFileDraft(ctx, 'alpha.txt')).resolves.toMatchObject({
        relativePath: 'alpha.txt',
        content: 'alpha draft',
        baseContent: 'alpha',
      })
      await expect(readWorkspaceFileDraft(ctx, 'beta.txt')).resolves.toMatchObject({
        relativePath: 'beta.txt',
        content: 'beta draft',
        baseContent: 'beta',
      })

      const storedFiles = (await readdir(configDir, { recursive: true }))
        .map(entry => String(entry))
        .filter(entry => entry.endsWith('.json'))
      expect(storedFiles).toHaveLength(2)
      expect(storedFiles.every(entry => entry.includes('file-drafts.v1'))).toBe(true)
      const storedDraftPath = join(configDir, storedFiles[0]!)
      expect(await readFile(storedDraftPath, 'utf-8')).toContain('draft')
      if (process.platform !== 'win32') {
        expect((await stat(storedDraftPath)).mode & 0o777).toBe(0o600)
      }

      await deleteWorkspaceFileDraft(ctx, 'alpha.txt')
      await expect(readWorkspaceFileDraft(ctx, 'alpha.txt')).resolves.toBeNull()
      await expect(readWorkspaceFileDraft(ctx, 'beta.txt')).resolves.toMatchObject({ content: 'beta draft' })
    } finally {
      if (previousConfigDir === undefined) delete process.env.CRAFT_CONFIG_DIR
      else process.env.CRAFT_CONFIG_DIR = previousConfigDir
      await rm(root, { recursive: true, force: true })
      await rm(configDir, { recursive: true, force: true })
    }
  })

  it('surfaces unreadable draft records without deleting the recovery source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'craft-workspace-draft-read-error-'))
    const configDir = await mkdtemp(join(tmpdir(), 'craft-workspace-draft-read-error-config-'))
    const previousConfigDir = process.env.CRAFT_CONFIG_DIR
    process.env.CRAFT_CONFIG_DIR = configDir
    try {
      await writeFile(join(root, 'notes.txt'), 'original')
      const { readWorkspaceFileDraft, setWorkspaceFileDraft, ctx } = createTestHarness({ workspaceRoot: root })
      await setWorkspaceFileDraft(ctx, 'notes.txt', 'recover me', 'original')

      const storedDraft = (await readdir(configDir, { recursive: true }))
        .map(entry => String(entry))
        .find(entry => entry.endsWith('.json'))
      expect(storedDraft).toBeDefined()
      const storedDraftPath = join(configDir, storedDraft!)
      await writeFile(storedDraftPath, '{not-json', 'utf-8')

      await expect(readWorkspaceFileDraft(ctx, 'notes.txt')).rejects.toThrow()
      expect(await readFile(storedDraftPath, 'utf-8')).toBe('{not-json')
    } finally {
      if (previousConfigDir === undefined) delete process.env.CRAFT_CONFIG_DIR
      else process.env.CRAFT_CONFIG_DIR = previousConfigDir
      await rm(root, { recursive: true, force: true })
      await rm(configDir, { recursive: true, force: true })
    }
  })

  it('leaves a deletion marker that prevents a discarded draft from reviving after unlink fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'craft-workspace-draft-delete-'))
    const configDir = await mkdtemp(join(tmpdir(), 'craft-workspace-draft-delete-config-'))
    const previousConfigDir = process.env.CRAFT_CONFIG_DIR
    process.env.CRAFT_CONFIG_DIR = configDir
    try {
      await writeFile(join(root, 'notes.txt'), 'original')
      const { setWorkspaceFileDraft, ctx } = createTestHarness({ workspaceRoot: root })
      await setWorkspaceFileDraft(ctx, 'notes.txt', 'discarded draft', 'original')

      const storedDraft = (await readdir(configDir, { recursive: true }))
        .map(entry => String(entry))
        .find(entry => entry.endsWith('.json'))
      expect(storedDraft).toBeDefined()
      const filePath = join(configDir, storedDraft!)
      const storedRecord = JSON.parse(await readFile(filePath, 'utf-8')) as { workspaceScope: string }
      const identity: WorkspaceFileDraftStorageIdentity = {
        relativePath: 'notes.txt',
        workspaceScope: storedRecord.workspaceScope,
        directoryPath: dirname(filePath),
        filePath,
      }
      let simulatedFailure = false
      await expect(deleteWorkspaceFileDraftRecord(identity, async path => {
        if (path === filePath && !simulatedFailure) {
          simulatedFailure = true
          throw Object.assign(new Error('file locked'), { code: 'EPERM' })
        }
        await unlink(path)
      })).rejects.toThrow('file locked')

      expect(await readFile(filePath, 'utf-8')).toContain('discarded draft')
      await expect(readWorkspaceFileDraftRecord(identity)).resolves.toBeNull()

      await deleteWorkspaceFileDraftRecord(identity)
      await expect(readWorkspaceFileDraftRecord(identity)).resolves.toBeNull()
      await expect(readFile(`${filePath}.deleted`, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      if (previousConfigDir === undefined) delete process.env.CRAFT_CONFIG_DIR
      else process.env.CRAFT_CONFIG_DIR = previousConfigDir
      await rm(root, { recursive: true, force: true })
      await rm(configDir, { recursive: true, force: true })
    }
  })

  it('keeps a stale draft recoverable and rejects an optimistic write conflict', async () => {
    const root = await mkdtemp(join(tmpdir(), 'craft-workspace-conflict-'))
    const configDir = await mkdtemp(join(tmpdir(), 'craft-workspace-conflict-config-'))
    const previousConfigDir = process.env.CRAFT_CONFIG_DIR
    process.env.CRAFT_CONFIG_DIR = configDir
    try {
      const filePath = join(root, 'notes.txt')
      await writeFile(filePath, 'original')
      const {
        readWorkspaceFileDraft,
        setWorkspaceFileDraft,
        writeWorkspaceTextFile,
        ctx,
      } = createTestHarness({ workspaceRoot: root })

      await setWorkspaceFileDraft(ctx, 'notes.txt', 'my draft', 'original')
      await writeFile(filePath, 'external update')

      await expect(readWorkspaceFileDraft(ctx, 'notes.txt')).resolves.toMatchObject({
        content: 'my draft',
        baseContent: 'original',
      })
      await expect(writeWorkspaceTextFile(ctx, 'notes.txt', 'my draft', 'original')).resolves.toEqual({
        status: 'conflict',
        currentContent: 'external update',
      })
      expect(await readFile(filePath, 'utf-8')).toBe('external update')

      await expect(writeWorkspaceTextFile(ctx, 'notes.txt', 'my draft', 'external update')).resolves.toEqual({
        status: 'saved',
      })
      expect(await readFile(filePath, 'utf-8')).toBe('my draft')
    } finally {
      if (previousConfigDir === undefined) delete process.env.CRAFT_CONFIG_DIR
      else process.env.CRAFT_CONFIG_DIR = previousConfigDir
      await rm(root, { recursive: true, force: true })
      await rm(configDir, { recursive: true, force: true })
    }
  })

  it('serializes concurrent Craft saves so only one matching expectation can commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'craft-workspace-concurrent-save-'))
    try {
      const filePath = join(root, 'notes.txt')
      await writeFile(filePath, 'original')
      const { writeWorkspaceTextFile, ctx } = createTestHarness({ workspaceRoot: root })

      const results = await Promise.all([
        writeWorkspaceTextFile(ctx, 'notes.txt', 'first save', 'original'),
        writeWorkspaceTextFile(ctx, 'notes.txt', 'second save', 'original'),
      ]) as Array<{ status: string; currentContent?: string }>

      expect(results.filter(result => result.status === 'saved')).toHaveLength(1)
      expect(results.filter(result => result.status === 'conflict')).toHaveLength(1)
      const finalContent = await readFile(filePath, 'utf-8')
      expect(['first save', 'second save']).toContain(finalContent)
      expect(results.find(result => result.status === 'conflict')?.currentContent).toBe(finalContent)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps an escaping symlink manageable without granting access to or deleting its target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'craft-workspace-symlink-'))
    const outside = await mkdtemp(join(tmpdir(), 'craft-workspace-outside-'))
    try {
      await writeFile(join(outside, 'keep.txt'), 'outside')
      try {
        await symlink(outside, join(root, 'outside'), 'junction')
      } catch {
        return
      }
      const {
        listWorkspaceDirectory,
        readWorkspaceFilePreview,
        renameWorkspaceEntry,
        deleteWorkspaceEntry,
        ctx,
      } = createTestHarness({ workspaceRoot: root })
      const listing = await listWorkspaceDirectory(ctx, '') as {
        entries: Array<{ name: string; type: string; isSymlink: boolean }>
      }
      expect(listing.entries).toContainEqual(expect.objectContaining({
        name: 'outside',
        type: 'file',
        isSymlink: true,
      }))
      await expect(readWorkspaceFilePreview(ctx, 'outside')).rejects.toThrow('Access denied')
      await renameWorkspaceEntry(ctx, 'outside', 'outside-link')
      await deleteWorkspaceEntry(ctx, 'outside-link', false)
      expect(await readFile(join(outside, 'keep.txt'), 'utf-8')).toBe('outside')
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })
})

describe('registerFilesHandlers READ', () => {
  it('rejects home-directory reads from remote clients without a trusted local window', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'craft-read-remote-'))
    try {
      const configDir = join(tmp, 'config')
      const piAgentDir = join(tmp, 'pi-agent')
      const workspaceRoot = join(tmp, 'workspace')
      await mkdir(configDir, { recursive: true })
      await mkdir(piAgentDir, { recursive: true })
      await mkdir(workspaceRoot, { recursive: true })
      await writeFile(
        join(configDir, 'config.json'),
        JSON.stringify({
          workspaces: [{ id: 'ws-1', name: 'Workspace', rootPath: workspaceRoot, createdAt: Date.now() }],
          activeWorkspaceId: 'ws-1',
          activeSessionId: null,
        }, null, 2),
        'utf-8',
      )

      const script = `
        import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
        import { registerFilesHandlers } from ${JSON.stringify(FILES_MODULE)}

        const handlers = new Map()
        const server = {
          handle(channel, handler) { handlers.set(channel, handler) },
          push() {},
          async invokeClient() { return undefined },
          hasClientCapability() { return false },
          findClientsWithCapability() { return [] },
        }
        const deps = {
          sessionManager: {},
          oauthFlowStore: {},
          platform: {
            appRootPath: '/',
            resourcesPath: '/',
            isPackaged: false,
            appVersion: '0.0.0-test',
            isDebugMode: true,
            logger: {
              info() {},
              warn() {},
              error() {},
              debug() {},
            },
            imageProcessor: {
              async getMetadata() { return null },
              async process() { return Buffer.from('') },
            },
          },
        }

        registerFilesHandlers(server, deps)
        const readFile = handlers.get(RPC_CHANNELS.file.READ)
        if (!readFile) {
          console.error('READ handler not registered')
          process.exit(1)
        }

        try {
          await readFile(
            { clientId: 'client-1', workspaceId: 'ws-1', webContentsId: null },
            process.env.TEST_HOME_PATH,
          )
          console.error('Expected home path rejection')
          process.exit(1)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (!message.includes('Access denied')) {
            console.error(message)
            process.exit(1)
          }
        }
      `
      const run = Bun.spawnSync([process.execPath, '--eval', script], {
        env: {
          ...process.env,
          CRAFT_CONFIG_DIR: configDir,
          PI_CODING_AGENT_DIR: piAgentDir,
          TEST_HOME_PATH: join(homedir(), 'craft-agent-home-read-regression.txt'),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })

      expect(run.exitCode, `${run.stdout.toString()}\n${run.stderr.toString()}`).toBe(0)
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  }, 15000)
})

describe('registerFilesHandlers STORE_ATTACHMENT', () => {
  it('rejects path-only attachments without a trusted local Electron window', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'craft-store-attachment-'))
    try {
      const configDir = join(tmp, 'config')
      const piAgentDir = join(tmp, 'pi-agent')
      const workspaceRoot = join(tmp, 'workspace')
      await mkdir(configDir, { recursive: true })
      await mkdir(piAgentDir, { recursive: true })
      await mkdir(workspaceRoot, { recursive: true })
      await writeFile(
        join(configDir, 'config.json'),
        JSON.stringify({
          workspaces: [{ id: 'ws-1', name: 'Workspace', rootPath: workspaceRoot, createdAt: Date.now() }],
          activeWorkspaceId: 'ws-1',
          activeSessionId: null,
        }, null, 2),
        'utf-8',
      )

      const filePath = join(tmp, 'notes.txt')
      await writeFile(filePath, 'hello')

      const script = `
        import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
        import { registerFilesHandlers } from ${JSON.stringify(FILES_MODULE)}

        const handlers = new Map()
        const server = {
          handle(channel, handler) { handlers.set(channel, handler) },
          push() {},
          async invokeClient() { return undefined },
          hasClientCapability() { return false },
          findClientsWithCapability() { return [] },
        }
        const deps = {
          sessionManager: {},
          oauthFlowStore: {},
          platform: {
            appRootPath: '/',
            resourcesPath: '/',
            isPackaged: false,
            appVersion: '0.0.0-test',
            isDebugMode: true,
            logger: {
              info() {},
              warn() {},
              error() {},
              debug() {},
            },
            imageProcessor: {
              async getMetadata() { return null },
              async process() { return Buffer.from('') },
            },
          },
        }

        registerFilesHandlers(server, deps)
        const storeAttachment = handlers.get(RPC_CHANNELS.file.STORE_ATTACHMENT)
        if (!storeAttachment) {
          console.error('STORE_ATTACHMENT handler not registered')
          process.exit(1)
        }

        const attachment = {
          type: 'text',
          path: process.env.TEST_ATTACHMENT_PATH,
          name: 'notes.txt',
          mimeType: 'text/plain',
          size: 5,
        }

        try {
          await storeAttachment(
            { clientId: 'client-1', workspaceId: 'ws-1', webContentsId: 101 },
            'session-1',
            attachment,
          )
          console.error('Expected path-only attachment rejection')
          process.exit(1)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (!message.includes('Path-only attachments are only accepted')) {
            console.error(message)
            process.exit(1)
          }
        }
      `
      const run = Bun.spawnSync([process.execPath, '--eval', script], {
        env: {
          ...process.env,
          CRAFT_CONFIG_DIR: configDir,
          PI_CODING_AGENT_DIR: piAgentDir,
          TEST_ATTACHMENT_PATH: filePath,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })

      expect(run.exitCode, `${run.stdout.toString()}\n${run.stderr.toString()}`).toBe(0)
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  }, 15000)
})
