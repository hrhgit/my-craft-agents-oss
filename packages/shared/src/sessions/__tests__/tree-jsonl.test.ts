import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import {
  createSession,
  getSessionFilePath,
  listSessions,
  setSharedPiSessionsDirForTests,
} from '../storage'
import {
  readSessionHeader,
  writeSessionJsonl,
  readSessionJsonl,
} from '../jsonl'
import {
  appendStoredMessagesViaPiSessionManager,
  looksLikeTreeSessionJsonl,
  projectTreeSessionProjectionAsStoredSession,
  readTreeSessionJsonl,
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

function projectPiFacadeDto(filePath: string, workspaceRootPath = '/work/project') {
  const parsed = readTreeSessionJsonl(filePath)
  expect(parsed).not.toBeNull()
  return projectTreeSessionProjectionAsStoredSession({
    path: filePath,
    sessionDir: dirname(filePath),
    cwd: workspaceRootPath,
    header: parsed!.header,
    entries: parsed!.entries,
  }, {
    workspaceRootPath,
    sessionIdPrefix: 'pi-',
  })
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
    const projected = projectPiFacadeDto(sessionFile)
    expect(projected?.messages.map(m => m.id)).toEqual(['u1', 'alt'])
    expect(projected?.craftId).toBe('pi-abc123')
    expect(projected?.preview).toBe('Start here')
    expect(projected?.messageCount).toBe(2)
    expect(projected?.lastMessageRole).toBe('assistant')
  })

  it('reads cached tree-session list metadata without projecting the message body', () => {
    const cachedFile = join(dir, '2026-07-01T00-00-01-000Z_cached.jsonl')
    const tokenUsage = {
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
      contextTokens: 120,
      costUsd: 0.01,
    }
    const header = {
      type: 'session',
      version: 3,
      id: 'pi-cached',
      timestamp: '2026-07-01T00:00:00.000Z',
      cwd: '/work/project',
      craft: {
        id: 'craft-cached',
        workspaceRootPath: '/work/project',
        createdAt: 1782864000000,
        lastUsedAt: 1782864001000,
        lastMessageAt: 1782864001000,
        name: 'Cached title',
        messageCount: 42,
        preview: 'Cached preview',
        lastMessageRole: 'assistant',
        lastFinalMessageId: 'a42',
        tokenUsage,
      },
    }
    writeFileSync(cachedFile, `${JSON.stringify(header)}\n${'x'.repeat(2 * 1024 * 1024)}\n`)

    const metadata = readSessionHeader(cachedFile)

    expect(metadata).toMatchObject({
      craftId: 'craft-cached',
      piSessionId: 'pi-cached',
      name: 'Cached title',
      messageCount: 42,
      preview: 'Cached preview',
      lastMessageRole: 'assistant',
      lastFinalMessageId: 'a42',
      tokenUsage,
    })
  })

  it('rebuilds plan artifacts and session state from Pi custom messages', () => {
    const planFile = join(dir, '2026-07-01T00-00-01-000Z_plan.jsonl')
    const planArtifact = {
      schemaVersion: 1,
      kind: 'plan',
      artifactId: 'artifact-1',
      revision: 1,
      state: 'ready',
      review: { status: 'passed', verdict: 'pass', body: 'Architecture is focused.' },
      checklist: [{ id: 'step-1', title: 'Implement protocol', status: 'pending' }],
      createdAt: 1782864002000,
      finalizedAt: 1782864002000,
    }
    writeJsonl(planFile, [
      {
        type: 'session', version: 3, id: 'plan-session',
        timestamp: '2026-07-01T00:00:00.000Z', cwd: '/work/project',
      },
      {
        type: 'message', id: 'u1', parentId: null,
        timestamp: '2026-07-01T00:00:01.000Z',
        message: { role: 'user', content: 'Finalize it' },
      },
      {
        type: 'message', id: 'a1', parentId: 'u1',
        timestamp: '2026-07-01T00:00:02.000Z',
        message: { role: 'assistant', content: '# Final plan' },
      },
      {
        type: 'custom_message', id: 'p1', parentId: 'a1',
        timestamp: '2026-07-01T00:00:03.000Z', customType: 'craft-plan-artifact',
        content: '# Final plan', display: false,
        details: { schemaVersion: 1, artifact: planArtifact },
      },
      {
        type: 'custom_message', id: 's1', parentId: 'p1',
        timestamp: '2026-07-01T00:00:04.000Z', customType: 'craft-plan-state',
        content: '', display: false,
        details: {
          schemaVersion: 1,
          state: { schemaVersion: 1, phase: 'ready', activeArtifactId: 'artifact-1', updatedAt: 1782864004000 },
        },
      },
    ])

    const projected = projectPiFacadeDto(planFile)
    expect(projected?.messages).toHaveLength(2)
    expect(projected?.messages[1]).toMatchObject({
      id: 'a1',
      type: 'assistant',
      content: '# Final plan',
      artifact: { artifactId: 'artifact-1', state: 'ready' },
    })
    expect(projected?.planModeState).toEqual({
      schemaVersion: 1,
      phase: 'ready',
      activeArtifactId: 'artifact-1',
      updatedAt: 1782864004000,
    })
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

    const messages = projectPiFacadeDto(activeBranchFile)?.messages ?? []
    expect(messages.map(m => m.type)).toEqual(['user', 'tool', 'assistant', 'tool'])
    expect(messages[1]?.toolName).toBe('read')
    expect(messages[1]?.toolInput).toEqual({ path: 'README.md' })
    expect(messages[3]?.toolResult).toBe('README contents')
  })

  it('strips Craft-injected prompt context from projected Pi user messages', () => {
    const injectedFile = join(dir, '2026-07-01T00-00-01-000Z_injected.jsonl')
    writeJsonl(injectedFile, [
      {
        type: 'session',
        version: 3,
        id: 'injected',
        timestamp: '2026-07-01T00:00:00.000Z',
        cwd: '/work/project',
      },
      {
        type: 'message',
        id: 'u1',
        parentId: null,
        timestamp: '2026-07-01T00:00:01.000Z',
        message: {
          role: 'user',
          content: `**USER'S DATE AND TIME: Thursday, July 9, 2026 at 10:30 AM GMT+8** - ALWAYS use this as the authoritative current date/time. Ignore any
other date information.

<session_state>
sessionId: injected
permissionMode: explore
plansFolderPath: C:\\Users\\32858\\.pi\\agent\\sessions\\demo\\.craft\\plans
</session_state>

<sources>
Active: none
</sources>

在吗?`,
        },
      },
      {
        type: 'message',
        id: 'a1',
        parentId: 'u1',
        timestamp: '2026-07-01T00:00:02.000Z',
        message: { role: 'assistant', content: '在。' },
      },
    ])

    const messages = readSessionJsonl(injectedFile)?.messages ?? []
    expect(messages[0]?.content).toBe('在吗?')
  })

  it('projects Pi thinking blocks as intermediate assistant messages', () => {
    const thinkingFile = join(dir, '2026-07-01T00-00-01-000Z_thinking.jsonl')
    writeJsonl(thinkingFile, [
      {
        type: 'session',
        version: 3,
        id: 'thinking',
        timestamp: '2026-07-01T00:00:00.000Z',
        cwd: '/work/project',
      },
      {
        type: 'message',
        id: 'u1',
        parentId: null,
        timestamp: '2026-07-01T00:00:01.000Z',
        message: { role: 'user', content: '在吗?' },
      },
      {
        type: 'message',
        id: 'a1',
        parentId: 'u1',
        timestamp: '2026-07-01T00:00:02.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Providing a simple answer\n\nI should answer briefly.' },
            { type: 'text', text: '在。说你的事。' },
          ],
        },
      },
    ])

    const messages = readSessionJsonl(thinkingFile)?.messages ?? []
    expect(messages.map(m => m.type)).toEqual(['user', 'assistant', 'assistant'])
    expect(messages[1]?.isIntermediate).toBe(true)
    expect(messages[1]?.content).toContain('Providing a simple answer')
    expect(messages[2]?.isIntermediate).toBeUndefined()
    expect(messages[2]?.content).toBe('在。说你的事。')
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

  it('keeps Pi header fields as Pi-owned while Craft UI state stays under craft metadata', () => {
    writeJsonl(sessionFile, [
      {
        type: 'session',
        version: 3,
        id: 'pi-owned-session',
        timestamp: '2026-07-01T00:00:00.000Z',
        cwd: '/pi/source-of-truth',
        craft: {
          id: 'craft-owned-session',
          name: 'Craft title',
          labels: ['ui-state'],
          permissionMode: 'ask',
          workingDirectory: '/craft/stale-mirror',
        },
      },
    ])

    const stored = readSessionJsonl(sessionFile)

    expect(stored?.craftId).toBe('craft-owned-session')
    expect(stored?.piSessionId).toBe('pi-owned-session')
    expect(stored?.piCwd).toBe('/pi/source-of-truth')
    expect(stored?.workingDirectory).toBe('/pi/source-of-truth')
    expect(stored?.name).toBe('Craft title')
    expect(stored?.labels).toEqual(['ui-state'])
    expect(stored?.permissionMode).toBe('ask')
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
    expect(overlay.messages[0].content).toBe('Start here')
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
    expect(header.craft.conversationFormat).toBe('pi-projection-v1')
    expect(expandPath(header.craft.workingDirectory)).toBe(workspaceRoot)
    expect(lines.length).toBe(1)

    const listed = listSessions(workspaceRoot)
    expect(listed.map(s => s.craftId)).toContain(session.craftId)
    expect(listed.find(s => s.craftId === session.craftId)?.name).toBe('Shared write')
    expect(listed.find(s => s.craftId === session.craftId)?.conversationFormat).toBe('pi-projection-v1')
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
