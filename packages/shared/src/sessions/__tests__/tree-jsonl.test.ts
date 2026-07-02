import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  createSession,
  findPiSessionFile,
  getSessionFilePath,
  listSessions,
  loadPiSessionMessages,
  readPiSessionFile,
  setSharedPiSessionsDirForTests,
  setSharedPiSessionStorageEnabled,
} from '../storage'
import {
  writeSessionJsonl,
  readSessionJsonl,
} from '../jsonl'
import { looksLikeTreeSessionJsonl } from '../tree-jsonl'

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
    setSharedPiSessionStorageEnabled(false)
    setSharedPiSessionsDirForTests(undefined)
    if (existsSync(dir)) rmSync(dir, { recursive: true })
  })

  it('detects and loads a tree JSONL session through Craft JSONL APIs', () => {
    expect(looksLikeTreeSessionJsonl(sessionFile)).toBe(true)

    const stored = readSessionJsonl(sessionFile)
    expect(stored?.id).toBe('abc123')
    expect(stored?.workingDirectory).toBe('/work/project')
    expect(stored?.messages.map(m => m.id)).toEqual(['u1', 'alt'])
    expect(stored?.messages[1]?.content).toBe('This is the latest leaf.')
  })

  it('projects Pi tree messages and metadata for existing Pi history UI', () => {
    const messages = loadPiSessionMessages(sessionFile)
    expect(messages.map(m => m.id)).toEqual(['u1', 'alt'])

    const metadata = readPiSessionFile(sessionFile, '/work/project')
    expect(metadata?.id).toBe('pi-abc123')
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

  it('stores new Craft-managed sessions under the Pi sessions root when shared storage is enabled', async () => {
    const piRoot = join(dir, 'pi-sessions')
    const workspaceRoot = join(dir, 'workspace')
    const workingDirectory = join(dir, 'workspace', 'project')
    mkdirSync(workingDirectory, { recursive: true })

    setSharedPiSessionsDirForTests(piRoot)
    setSharedPiSessionStorageEnabled(true)

    const session = await createSession(workspaceRoot, { workingDirectory, name: 'Shared write' })
    const filePath = getSessionFilePath(workspaceRoot, session.id)

    expect(filePath.startsWith(piRoot)).toBe(true)
    expect(filePath).toContain(`${session.id}.jsonl`)
    expect(existsSync(filePath)).toBe(true)

    const lines = (await Bun.file(filePath).text()).trim().split('\n')
    const header = JSON.parse(lines[0]!)
    expect(header.type).toBe('session')
    expect(header.version).toBe(3)
    expect(header.id).toBe(session.id)
    expect(header.cwd).toBe(workingDirectory)
    expect(header.craft.name).toBe('Shared write')
    expect(lines.length).toBe(1)

    const listed = listSessions(workspaceRoot)
    expect(listed.map(s => s.id)).toContain(session.id)
    expect(listed.find(s => s.id === session.id)?.name).toBe('Shared write')
  })
})
