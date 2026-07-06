import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import {
  createSession,
  findPiSessionFile,
  getSessionFilePath,
  listSessions,
  loadPiSessionMessages,
  readPiSessionFile,
  setSharedPiSessionsDirForTests,
} from '../storage'
import {
  writeSessionJsonl,
  readSessionJsonl,
} from '../jsonl'
import {
  appendStoredMessagesViaPiSessionManager,
  looksLikeTreeSessionJsonl,
  writeCraftSessionOverlay,
} from '../tree-jsonl'
import { expandPath } from '../../utils/paths'

function tmpRoot(): string {
  const dir = join(tmpdir(), `tree-jsonl-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function writeJsonl(filePath: string, entries: unknown[]): void {
  writeFileSync(filePath, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n')
}

describe('tree JSONL session projection', () => {
  let dir: string
  let sessionFile: string

  beforeEach(() => {
    dir = tmpRoot()
    sessionFile = join(dir, '2026-07-01T00-00-00-000Z_abc123.jsonl')
    writeJsonl(sessionFile, [
      {
        type: 'session',
        version: 3,
        id: 'abc123',
        timestamp: '2026-07-01T00:00:00.000Z',
        cwd: '/work/project',
      },
      {
        type: 'message',
        id: 'u1',
        parentId: null,
        timestamp: '2026-07-01T00:00:01.000Z',
        message: { role: 'user', content: 'Start here', timestamp: 1782864001000 },
      },
      {
        type: 'message',
        id: 'a1',
        parentId: 'u1',
        timestamp: '2026-07-01T00:00:02.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'I will inspect it.' },
            { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'README.md' } },
          ],
          provider: 'openai',
          model: 'gpt-test',
          timestamp: 1782864002000,
        },
      },
      {
        type: 'message',
        id: 't1',
        parentId: 'a1',
        timestamp: '2026-07-01T00:00:03.000Z',
        message: {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'read',
          content: [{ type: 'text', text: 'README contents' }],
          isError: false,
          timestamp: 1782864003000,
        },
      },
      {
        type: 'branch_summary',
        id: 'b1',
        parentId: 't1',
        timestamp: '2026-07-01T00:00:04.000Z',
        fromId: 'a1',
        summary: 'Returned from an alternate branch.',
      },
      {
        type: 'message',
        id: 'u2',
        parentId: 'b1',
        timestamp: '2026-07-01T00:00:05.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'Continue' }] },
      },
      {
        type: 'message',
        id: 'alt',
        parentId: 'u1',
        timestamp: '2026-07-01T00:00:06.000Z',
        message: { role: 'assistant', content: 'This is the latest leaf.' },
      },
    ])
  })

  afterEach(() => {
    setSharedPiSessionsDirForTests(undefined)
    if (existsSync(dir)) rmSync(dir, { recursive: true })
  })

  it('detects and loads a tree JSONL session through Craft JSONL APIs', () => {
    expect(looksLikeTreeSessionJsonl(sessionFile)).toBe(true)

    const stored = readSessionJsonl(sessionFile)
    expect(stored?.craftId).toBe('abc123')
    expect(stored?.workingDirectory).toBe('/work/project')
    expect(stored?.messages.map(m => m.id)).toEqual(['u1', 'alt'])
    expect(stored?.messages[1]?.content).toBe('This is the latest leaf.')
  })

  it('projects Pi tree messages and metadata for existing Pi history UI', () => {
    const messages = loadPiSessionMessages(sessionFile)
    expect(messages.map(m => m.id)).toEqual(['u1', 'alt'])

    const metadata = readPiSessionFile(sessionFile, '/work/project')
    expect(metadata?.craftId).toBe('pi-abc123')
    expect(metadata?.preview).toBe('Start here')
    expect(metadata?.messageCount).toBe(2)
    expect(metadata?.lastMessageRole).toBe('assistant')
  })

  it('finds timestamp-prefixed Pi files by header id', () => {
    const found = findPiSessionFile(dir, 'abc123')
    expect(found).toBe(sessionFile)
  })

  it('projects tool calls and tool results when they are on the active branch', () => {
    const activeBranchFile = join(dir, '2026-07-01T00-00-01-000Z_toolbranch.jsonl')
    writeJsonl(activeBranchFile, [
      {
        type: 'session',
        version: 3,
        id: 'toolbranch',
        timestamp: '2026-07-01T00:00:00.000Z',
        cwd: '/work/project',
      },
      {
        type: 'message',
        id: 'u1',
        parentId: null,
        timestamp: '2026-07-01T00:00:01.000Z',
        message: { role: 'user', content: 'Read the file' },
      },
      {
        type: 'message',
        id: 'a1',
        parentId: 'u1',
        timestamp: '2026-07-01T00:00:02.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Reading now.' },
            { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'README.md' } },
          ],
        },
      },
      {
        type: 'message',
        id: 't1',
        parentId: 'a1',
        timestamp: '2026-07-01T00:00:03.000Z',
        message: {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'read',
          content: [{ type: 'text', text: 'README contents' }],
          isError: false,
        },
      },
    ])

    const messages = loadPiSessionMessages(activeBranchFile)
    expect(messages.map(m => m.type)).toEqual(['user', 'tool', 'assistant', 'tool'])
    expect(messages[1]?.toolName).toBe('read')
    expect(messages[1]?.toolInput).toEqual({ path: 'README.md' })
    expect(messages[3]?.toolResult).toBe('README contents')
  })

  it('updates Craft metadata in tree header without flattening tree entries', () => {
    const stored = readSessionJsonl(sessionFile)
    expect(stored).not.toBeNull()
    stored!.name = 'Unified session'
    stored!.labels = ['important']

    writeSessionJsonl(sessionFile, stored!)

    const rawLines = Bun.file(sessionFile).text()
    return rawLines.then(content => {
      const lines = content.trim().split('\n')
      const header = JSON.parse(lines[0]!)
      const second = JSON.parse(lines[1]!)

      expect(header.type).toBe('session')
      expect(header.craft.name).toBe('Unified session')
      expect(header.craft.labels).toEqual(['important'])
      expect(second.type).toBe('message')
      expect(second.message.role).toBe('user')

      const reloaded = readSessionJsonl(sessionFile)
      expect(reloaded?.name).toBe('Unified session')
      expect(reloaded?.labels).toEqual(['important'])
    })
  })

  it('throws instead of overwriting a tree session when metadata update fails', async () => {
    const before = await Bun.file(sessionFile).text()
    const stored = readSessionJsonl(sessionFile)
    expect(stored).not.toBeNull()
    stored!.name = 'blocked update'

    const lockDir = `${sessionFile}.lock`
    mkdirSync(lockDir)
    try {
      expect(() => writeSessionJsonl(sessionFile, stored!)).toThrow()
    } finally {
      rmSync(lockDir, { recursive: true, force: true })
    }

    expect(await Bun.file(sessionFile).text()).toBe(before)
  })

  it('writes Craft metadata fields through the shared metadata helper', async () => {
    const stored = readSessionJsonl(sessionFile)
    expect(stored).not.toBeNull()
    stored!.previousPermissionMode = 'safe' as any
    stored!.transferredSessionSummaryApplied = true

    writeSessionJsonl(sessionFile, stored!)

    const lines = (await Bun.file(sessionFile).text()).trim().split('\n')
    const header = JSON.parse(lines[0]!)

    expect(header.craft.id).toBe(stored!.craftId)
    expect(header.craft.craftId).toBeUndefined()
    expect(header.craft.previousPermissionMode).toBe('safe')
    expect(header.craft.transferredSessionSummaryApplied).toBe(true)
    expect(header.craft.messageCount).toBe(stored!.messages.length)
  })

  it('preserves Craft-only fields for canonical messages through the overlay', async () => {
    const stored = readSessionJsonl(sessionFile)
    expect(stored).not.toBeNull()
    const attachment = {
      id: 'att-1',
      type: 'image' as const,
      name: 'screenshot.png',
      mimeType: 'image/png',
      size: 1234,
      originalSize: 1234,
      storedPath: join(dirname(sessionFile), '.craft', stored!.craftId, 'attachments', 'screenshot.png'),
      thumbnailBase64: 'thumb',
    }
    stored!.messages[0] = {
      ...stored!.messages[0]!,
      attachments: [attachment],
      badges: [{
        type: 'file',
        label: 'screenshot.png',
        rawText: '@screenshot.png',
        start: 0,
        end: 15,
        filePath: 'attachments/screenshot.png',
      }],
    }

    writeSessionJsonl(sessionFile, stored!)

    const reloaded = readSessionJsonl(sessionFile)
    expect(reloaded?.messages).toHaveLength(stored!.messages.length)
    expect(reloaded?.messages[0]?.attachments).toEqual([attachment])
    expect(reloaded?.messages[0]?.badges).toEqual([
      {
        type: 'file',
        label: 'screenshot.png',
        rawText: '@screenshot.png',
        start: 0,
        end: 15,
        filePath: 'attachments/screenshot.png',
      },
    ])

    const overlayPath = join(dirname(sessionFile), '.craft', stored!.craftId, 'overlay.json')
    expect(existsSync(overlayPath)).toBe(true)
    const overlay = JSON.parse(await Bun.file(overlayPath).text())
    expect(overlay.messages[0].id).toBe('u1')
    expect(overlay.messages[0].content).toBeUndefined()
    expect(overlay.messages[0].attachments).toEqual([attachment])
  })

  it('sanitizes craft ids before writing Craft overlay files', async () => {
    const stored = readSessionJsonl(sessionFile)
    expect(stored).not.toBeNull()

    const escapeId = 'escape-overlay'
    writeCraftSessionOverlay(sessionFile, {
      ...stored!,
      craftId: `../${escapeId}`,
      messages: [{
        ...stored!.messages[0]!,
        attachments: [{
          id: 'att-escape',
          type: 'image' as const,
          name: 'safe.png',
          mimeType: 'image/png',
          size: 10,
          originalSize: 10,
          storedPath: 'attachments/safe.png',
        }],
      }],
    })

    expect(existsSync(join(dirname(sessionFile), escapeId, 'overlay.json'))).toBe(false)
    expect(existsSync(join(dirname(sessionFile), '.craft', escapeId, 'overlay.json'))).toBe(true)
  })

  it('reuses matching Pi entries instead of duplicating messages on import retry', async () => {
    const retryFile = join(dir, '2026-07-01T00-00-02-000Z_retry.jsonl')
    writeJsonl(retryFile, [{
      type: 'session',
      version: 3,
      id: 'retry',
      timestamp: '2026-07-01T00:00:00.000Z',
      cwd: '/work/project',
    }])
    const messages = [
      { id: 'source-u1', type: 'user' as const, content: 'Hello', timestamp: 1 },
      { id: 'source-a1', type: 'assistant' as const, content: 'Hi', timestamp: 2 },
    ]

    const firstIdMap = appendStoredMessagesViaPiSessionManager(retryFile, dirname(retryFile), '/work/project', messages)
    const retryIdMap = appendStoredMessagesViaPiSessionManager(retryFile, dirname(retryFile), '/work/project', messages)

    const entries = (await Bun.file(retryFile).text()).trim().split('\n').map(line => JSON.parse(line))
    expect(entries.filter(entry => entry.type === 'message')).toHaveLength(2)
    expect([...retryIdMap.entries()]).toEqual([...firstIdMap.entries()])
  })

  it('stores new Craft-managed sessions under the Pi sessions root when shared storage is enabled', async () => {
    const piRoot = join(dir, 'pi-sessions')
    const workspaceRoot = join(dir, 'workspace')
    const workingDirectory = join(dir, 'workspace', 'project')
    mkdirSync(workingDirectory, { recursive: true })

    // Legacy defaults.workingDirectory is ignored under complete-unification
    // semantics; new sessions use workspaceRoot as cwd and bucket.
    writeFileSync(join(workspaceRoot, 'config.json'), JSON.stringify({
      id: 'ws_test',
      name: 'Test',
      slug: 'test',
      defaults: { workingDirectory },
      createdAt: 0,
      updatedAt: 0,
    }))

    setSharedPiSessionsDirForTests(piRoot)

    const session = await createSession(workspaceRoot, { workingDirectory, name: 'Shared write' })
    const filePath = getSessionFilePath(workspaceRoot, session.craftId)

    expect(filePath.startsWith(piRoot)).toBe(true)
    expect(filePath).toContain(`${session.craftId}.jsonl`)
    expect(existsSync(filePath)).toBe(true)

    const lines = (await Bun.file(filePath).text()).trim().split('\n')
    const header = JSON.parse(lines[0]!)
    expect(header.type).toBe('session')
    expect(header.version).toBe(3)
    expect(header.id).toBe(session.craftId)
    expect(header.cwd).toBe(workspaceRoot)
    expect(header.craft.name).toBe('Shared write')
    expect(expandPath(header.craft.workingDirectory)).toBe(workspaceRoot)
    expect(lines.length).toBe(1)

    const listed = listSessions(workspaceRoot)
    expect(listed.map(s => s.craftId)).toContain(session.craftId)
    expect(listed.find(s => s.craftId === session.craftId)?.name).toBe('Shared write')
  })

  it('ignores explicit non-default working directories for new sessions', async () => {
    const piRoot = join(dir, 'pi-sessions-custom-cwd')
    const workspaceRoot = join(dir, 'workspace-custom-cwd')
    const defaultWorkingDirectory = join(workspaceRoot, 'default')
    const sessionWorkingDirectory = join(workspaceRoot, 'custom')
    mkdirSync(defaultWorkingDirectory, { recursive: true })
    mkdirSync(sessionWorkingDirectory, { recursive: true })

    writeFileSync(join(workspaceRoot, 'config.json'), JSON.stringify({
      id: 'ws_custom',
      name: 'Custom Cwd',
      slug: 'custom-cwd',
      defaults: { workingDirectory: defaultWorkingDirectory },
      createdAt: 0,
      updatedAt: 0,
    }))

    setSharedPiSessionsDirForTests(piRoot)

    const session = await createSession(workspaceRoot, {
      workingDirectory: sessionWorkingDirectory,
      name: 'Custom cwd session',
    })

    const listed = listSessions(workspaceRoot)
    expect(listed.map(s => s.craftId)).toContain(session.craftId)
    expect(listed.find(s => s.craftId === session.craftId)?.workingDirectory).toBe(workspaceRoot)
  })
})
