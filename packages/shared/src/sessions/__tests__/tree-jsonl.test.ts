import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import {
  createSession,
  getSessionFilePath,
  getSessionPlansPath,
  loadSession,
  listSessions,
  setSharedPiSessionsDirForTests,
  updateSessionMetadata,
} from '../storage'
import {
  readSessionHeader,
  writeSessionJsonl,
  readSessionJsonl,
} from '../jsonl'
import {
  appendPiBranchMessagesViaSessionManager,
  appendStoredMessagesViaPiSessionManager,
  looksLikeTreeSessionJsonl,
  projectTreeSessionProjectionAsStoredSession,
  readTreeSessionHeader,
  readTreeSessionJsonl,
  writeMortiseSessionOverlayAsync,
} from '../tree-jsonl'
import { RemovedSessionFieldError } from '../types'
import { SessionManager as PiSessionManager } from '@mortise/pi-coding-agent/host-facade'

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

  it('detects and loads a tree JSONL session through Mortise JSONL APIs', () => {
    expect(looksLikeTreeSessionJsonl(sessionFile)).toBe(true)

    const stored = readSessionJsonl(sessionFile)
    expect(stored?.mortiseId).toBe('abc123')
    expect(stored).not.toHaveProperty('workingDirectory')
    expect(stored?.messages.map(m => m.id)).toEqual(['u1', 'alt'])
    expect(stored?.messages[1]?.content).toBe('This is the latest leaf.')
  })

  it('projects Pi tree messages and metadata for existing Pi history UI', () => {
    const projected = projectPiFacadeDto(sessionFile)
    expect(projected?.messages.map(m => m.id)).toEqual(['u1', 'alt'])
    expect(projected?.mortiseId).toBe('pi-abc123')
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
      mortise: {
        id: 'mortise-cached',
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
      mortiseId: 'mortise-cached',
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
        timestamp: '2026-07-01T00:00:03.000Z', customType: 'mortise-plan-artifact',
        content: '# Final plan', display: false,
        details: { schemaVersion: 1, artifact: planArtifact },
      },
      {
        type: 'custom_message', id: 's1', parentId: 'p1',
        timestamp: '2026-07-01T00:00:04.000Z', customType: 'mortise-plan-state',
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

  it('strips Mortise-injected prompt context from projected Pi user messages', () => {
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
plansFolderPath: C:\\Users\\32858\\.pi\\agent\\sessions\\demo\\.mortise\\plans
</session_state>

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

  it('updates Mortise metadata in tree header without flattening tree entries', async () => {
    const stored = readSessionJsonl(sessionFile)
    expect(stored).not.toBeNull()
    stored!.name = 'Unified session'

    await writeSessionJsonl(sessionFile, stored!)

    const lines = (await Bun.file(sessionFile).text()).trim().split('\n')
    const header = JSON.parse(lines[0]!)
    const second = JSON.parse(lines[1]!)

    expect(header.type).toBe('session')
    expect(header.mortise.name).toBe('Unified session')
    expect(second.type).toBe('message')
    expect(second.message.role).toBe('user')

    const reloaded = readSessionJsonl(sessionFile)
    expect(reloaded?.name).toBe('Unified session')
  })

  it('writes Mortise metadata fields through the shared metadata helper', async () => {
    const stored = readSessionJsonl(sessionFile)
    expect(stored).not.toBeNull()
    stored!.previousPermissionMode = 'safe' as any
    stored!.transferredSessionSummaryApplied = true

    await writeSessionJsonl(sessionFile, stored!)

    const lines = (await Bun.file(sessionFile).text()).trim().split('\n')
    const header = JSON.parse(lines[0]!)

    expect(header.mortise.id).toBe(stored!.mortiseId)
    expect(header.mortise.mortiseId).toBeUndefined()
    expect(header.mortise.previousPermissionMode).toBe('safe')
    expect(header.mortise.transferredSessionSummaryApplied).toBe(true)
    expect(header.mortise.messageCount).toBe(stored!.messages.length)
  })

  it('rejects removed provider lock metadata without rewriting the file', async () => {
    writeJsonl(sessionFile, [{
      type: 'session',
      version: 3,
      id: 'abc123',
      timestamp: '2026-07-01T00:00:00.000Z',
      cwd: '/work/project',
      mortise: {
        id: 'abc123',
        provider: 'anthropic',
        connectionLocked: true,
        providerLocked: true,
      },
    }])

    const before = await Bun.file(sessionFile).text()
    expect(readSessionJsonl(sessionFile)).toBeNull()
    expect(await Bun.file(sessionFile).text()).toBe(before)
  })

  it('rejects retired thinking metadata without rewriting the file', async () => {
    writeJsonl(sessionFile, [{
      type: 'session',
      version: 3,
      id: 'retired-thinking',
      timestamp: '2026-07-01T00:00:00.000Z',
      cwd: '/work/project',
      mortise: {
        id: 'retired-thinking',
        thinkingLevel: 'think',
      },
    }])

    const before = await Bun.file(sessionFile).text()
    expect(readTreeSessionHeader(sessionFile)).toBeNull()
    expect(readSessionJsonl(sessionFile)).toBeNull()
    expect(await Bun.file(sessionFile).text()).toBe(before)
  })

  it('persists projection-derived computed metadata instead of recalculating it from overlays', async () => {
    const stored = readSessionJsonl(sessionFile)
    expect(stored).not.toBeNull()
    stored!.messages = []
    stored!.messageCount = 7
    stored!.preview = 'Projected prompt'
    stored!.lastMessageRole = 'assistant'
    stored!.lastFinalMessageId = 'pi-message-7'

    await writeSessionJsonl(sessionFile, stored!)

    const header = JSON.parse((await Bun.file(sessionFile).text()).trim().split('\n')[0]!)
    expect(header.mortise).toMatchObject({
      messageCount: 7,
      preview: 'Projected prompt',
      lastMessageRole: 'assistant',
      lastFinalMessageId: 'pi-message-7',
    })
  })

  it('keeps Pi header fields as Pi-owned while Mortise UI state stays under mortise metadata', async () => {
    writeJsonl(sessionFile, [
      {
        type: 'session',
        version: 3,
        id: 'pi-owned-session',
        timestamp: '2026-07-01T00:00:00.000Z',
        cwd: '/pi/source-of-truth',
        mortise: {
          id: 'mortise-owned-session',
          name: 'Mortise title',
          permissionMode: 'allow-all',
        },
      },
    ])

    const stored = readSessionJsonl(sessionFile)

    expect(stored?.mortiseId).toBe('mortise-owned-session')
    expect(stored?.piSessionId).toBe('pi-owned-session')
    expect(stored?.piCwd).toBe('/pi/source-of-truth')
    expect(stored?.name).toBe('Mortise title')
    expect(stored?.permissionMode).toBe('allow-all')
  })

  it('rejects retired organization metadata without rewriting later JSONL bytes', async () => {
    const header = {
      type: 'session',
      version: 3,
      id: 'legacy-organized',
      timestamp: '2026-07-01T00:00:00.000Z',
      cwd: '/work/project',
      mortise: {
        id: 'legacy-organized',
        name: 'Keep me',
        transferredSessionSummary: 'x'.repeat(9000),
        sessionStatus: 'done',
        labels: ['important'],
        isFlagged: true,
        isArchived: true,
        archivedAt: 12345,
      },
    }
    const laterLines = '\n  {"type":"message","id":"u1","parentId":null,"timestamp":"2026-07-01T00:00:01.000Z","message":{"role":"user","content":"keep exact spacing"}}\r\n'
    await Bun.write(sessionFile, JSON.stringify(header) + laterLines)
    const before = await Bun.file(sessionFile).text()
    expect(readTreeSessionHeader(sessionFile)).toBeNull()
    expect(await Bun.file(sessionFile).text()).toBe(before)
  })

  it('preserves Mortise-only UI fields without copying canonical message content', async () => {
    const stored = readSessionJsonl(sessionFile)
    expect(stored).not.toBeNull()
    const attachment = {
      id: 'att-1',
      type: 'image' as const,
      name: 'screenshot.png',
      mimeType: 'image/png',
      size: 1234,
      originalSize: 1234,
      storedPath: join(dirname(sessionFile), '.mortise', stored!.mortiseId, 'attachments', 'screenshot.png'),
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

    await writeSessionJsonl(sessionFile, stored!)

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

    const overlayPath = join(dirname(sessionFile), '.mortise', stored!.mortiseId, 'overlay.json')
    expect(existsSync(overlayPath)).toBe(true)
    const overlay = JSON.parse(await Bun.file(overlayPath).text())
    expect(overlay.messages[0].id).toBe('u1')
    expect(overlay.messages[0].content).toBeUndefined()
    expect(overlay.messages[0].attachments).toEqual([attachment])
  })

  it('materializes annotation overlays keyed by projection message identity', async () => {
    const stored = readSessionJsonl(sessionFile)
    expect(stored).not.toBeNull()
    const projectionMessageId = 'ts-1700000000000'
    const annotation = {
      id: 'ann-projection',
      schemaVersion: 1 as const,
      createdAt: 1700000000001,
      body: [{ type: 'highlight' as const }],
      target: {
        source: { sessionId: stored!.mortiseId, messageId: projectionMessageId },
        selectors: [{ type: 'text-quote' as const, exact: 'answer' }],
      },
    }
    stored!.messages.push({
      id: projectionMessageId,
      type: 'assistant',
      content: '',
      timestamp: 0,
      annotations: [annotation],
    })

    await writeSessionJsonl(sessionFile, stored!)

    const reloaded = readSessionJsonl(sessionFile)
    expect(reloaded?.messages.find(message => message.id === projectionMessageId)).toMatchObject({
      content: '',
      annotations: [annotation],
    })
  })

  it('sanitizes mortise ids before writing Mortise overlay files', async () => {
    const stored = readSessionJsonl(sessionFile)
    expect(stored).not.toBeNull()

    const escapeId = 'escape-overlay'
    await writeMortiseSessionOverlayAsync(sessionFile, {
      ...stored!,
      mortiseId: `../${escapeId}`,
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
    expect(existsSync(join(dirname(sessionFile), '.mortise', escapeId, 'overlay.json'))).toBe(true)
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

    const firstIdMap = await appendStoredMessagesViaPiSessionManager(retryFile, dirname(retryFile), '/work/project', messages)
    const retryIdMap = await appendStoredMessagesViaPiSessionManager(retryFile, dirname(retryFile), '/work/project', messages)

    const entries = (await Bun.file(retryFile).text()).trim().split('\n').map(line => JSON.parse(line))
    expect(entries.filter(entry => entry.type === 'message')).toHaveLength(2)
    expect(entries.find(entry => entry.message?.role === 'assistant')?.message.content).toEqual([
      { type: 'text', text: 'Hi' },
    ])
    expect([...retryIdMap.entries()]).toEqual([...firstIdMap.entries()])
  })

  it('preserves an active append when a cold metadata update starts from a stale snapshot', async () => {
    const coldSnapshot = readSessionJsonl(sessionFile)
    expect(coldSnapshot).not.toBeNull()
    coldSnapshot!.name = 'Cold metadata update'

    const activeRuntime = PiSessionManager.open(sessionFile, dirname(sessionFile), '/work/project')
    const activeMessageId = activeRuntime.appendMessage({
      role: 'user',
      content: 'Appended by active runtime',
      timestamp: Date.now(),
    })
    await Promise.all([
      activeRuntime.flush(),
      writeSessionJsonl(sessionFile, coldSnapshot!),
    ])

    const persisted = readSessionJsonl(sessionFile)
    expect(persisted?.name).toBe('Cold metadata update')
    expect(persisted?.messages.map(message => message.id)).toContain(activeMessageId)
    expect(persisted?.messages.find(message => message.id === activeMessageId)?.content)
      .toBe('Appended by active runtime')
  })

  it('copies raw Pi branch messages without flattening assistant content blocks', async () => {
    const branchFile = join(dir, '2026-07-01T00-00-03-000Z_branch.jsonl')
    writeJsonl(branchFile, [{
      type: 'session', version: 3, id: 'branch', timestamp: '2026-07-01T00:00:00.000Z', cwd: '/work/project',
    }])
    const entries = [{
      id: 'source-user',
      message: { role: 'user', content: 'Inspect', timestamp: 1 },
    }, {
      id: 'source-assistant',
      message: {
        role: 'assistant', timestamp: 2, stopReason: 'toolUse',
        content: [
          { type: 'thinking', thinking: 'reasoning' },
          { type: 'text', text: 'checking' },
          { type: 'toolCall', id: 'call-1', name: 'Read', arguments: { path: 'a.ts' } },
        ],
      },
    }]

    const firstIdMap = await appendPiBranchMessagesViaSessionManager(
      branchFile, dirname(branchFile), '/work/project', entries,
    )
    const retryIdMap = await appendPiBranchMessagesViaSessionManager(
      branchFile, dirname(branchFile), '/work/project', entries,
    )
    const written = (await Bun.file(branchFile).text()).trim().split('\n').map(line => JSON.parse(line))
    const assistant = written.find(entry => entry.message?.role === 'assistant')

    expect(assistant.message.content).toEqual(entries[1]!.message.content)
    expect([...retryIdMap.entries()]).toEqual([...firstIdMap.entries()])
  })

  it('keeps ordinary new Mortise sessions fileless until Pi publishes the first assistant', async () => {
    const piRoot = join(dir, 'pi-sessions')
    const workspaceRoot = join(dir, 'workspace')
    mkdirSync(workspaceRoot, { recursive: true })
    writeFileSync(join(workspaceRoot, 'config.json'), JSON.stringify({
      id: 'ws_test',
      name: 'Test',
      slug: 'test',
      createdAt: 0,
      updatedAt: 0,
    }))

    setSharedPiSessionsDirForTests(piRoot)

    const session = await createSession('test-workspace', workspaceRoot, { name: 'Shared write' })
    const filePath = getSessionFilePath('test-workspace', session.mortiseId)

    expect(filePath.startsWith(piRoot)).toBe(true)
    expect(filePath).toContain(`${session.mortiseId}.jsonl`)
    expect(existsSync(filePath)).toBe(false)
    expect(loadSession('test-workspace', session.mortiseId)).toBeNull()
    expect(listSessions('test-workspace', workspaceRoot).map(s => s.mortiseId)).not.toContain(session.mortiseId)
  })

  it('rejects the removed workingDirectory field for new sessions', async () => {
    const piRoot = join(dir, 'pi-sessions-custom-cwd')
    const workspaceRoot = join(dir, 'workspace-custom-cwd')
    const sessionWorkingDirectory = join(workspaceRoot, 'custom')
    mkdirSync(sessionWorkingDirectory, { recursive: true })

    writeFileSync(join(workspaceRoot, 'config.json'), JSON.stringify({
      id: 'ws_custom',
      name: 'Custom Cwd',
      slug: 'custom-cwd',
      createdAt: 0,
      updatedAt: 0,
    }))

    setSharedPiSessionsDirForTests(piRoot)

    const createWithRemovedField = createSession as unknown as (
      workspaceId: string,
      root: string,
      options: { workingDirectory: string; name: string },
    ) => Promise<unknown>
    await expect(createWithRemovedField('test-workspace', workspaceRoot, {
      workingDirectory: sessionWorkingDirectory,
      name: 'Custom cwd session',
    })).rejects.toMatchObject({
      name: 'RemovedSessionFieldError',
      code: 'SESSION_FIELD_REMOVED',
      field: 'workingDirectory',
    } satisfies Partial<RemovedSessionFieldError>)
    expect(listSessions('test-workspace', workspaceRoot)).toEqual([])
  })

  it('rejects the removed workingDirectory metadata mutation', async () => {
    const workspaceRoot = join(dir, 'workspace-metadata-contract')
    const piRoot = join(dir, 'pi-sessions-metadata-contract')
    mkdirSync(workspaceRoot, { recursive: true })
    setSharedPiSessionsDirForTests(piRoot)
    const session = await createSession('test-workspace', workspaceRoot, { name: 'Current session' })
    const updateWithRemovedField = updateSessionMetadata as unknown as (
      root: string,
      sessionId: string,
      updates: { workingDirectory: string },
    ) => Promise<void>

    await expect(updateWithRemovedField('test-workspace', session.mortiseId, {
      workingDirectory: join(workspaceRoot, 'nested'),
    })).rejects.toMatchObject({
      name: 'RemovedSessionFieldError',
      code: 'SESSION_FIELD_REMOVED',
      field: 'workingDirectory',
    })
  })

  it('keeps hidden mini sessions out of the unified session list', async () => {
    const piRoot = join(dir, 'pi-sessions-hidden')
    const workspaceRoot = join(dir, 'workspace-hidden')
    mkdirSync(workspaceRoot, { recursive: true })
    setSharedPiSessionsDirForTests(piRoot)

    const visible = await createSession('test-workspace', workspaceRoot, { name: 'Visible' })
    const hidden = await createSession('test-workspace', workspaceRoot, { name: 'Hidden', hidden: true })

    expect(existsSync(getSessionFilePath('test-workspace', visible.mortiseId))).toBe(false)
    expect(listSessions('test-workspace', workspaceRoot).map(session => session.mortiseId)).not.toContain(visible.mortiseId)
    expect(listSessions('test-workspace', workspaceRoot).map(session => session.mortiseId)).not.toContain(hidden.mortiseId)
    expect(loadSession('test-workspace', hidden.mortiseId)?.hidden).toBe(true)
  })

  it('rejects nested legacy session.jsonl paths inside the Pi session bucket', () => {
    const piRoot = join(dir, 'pi-sessions-nested-rejection')
    const workspaceRoot = join(dir, 'workspace-nested-rejection')
    const sessionId = 'legacy-nested'
    mkdirSync(workspaceRoot, { recursive: true })
    setSharedPiSessionsDirForTests(piRoot)

    const flatCandidate = getSessionFilePath('test-workspace', sessionId)
    const nestedSessionFile = join(dirname(flatCandidate), sessionId, 'session.jsonl')
    mkdirSync(dirname(nestedSessionFile), { recursive: true })
    writeJsonl(nestedSessionFile, [{
      type: 'session',
      version: 3,
      id: sessionId,
      timestamp: '2026-07-01T00:00:00.000Z',
      cwd: workspaceRoot,
      mortise: { id: sessionId, workspaceRootPath: workspaceRoot },
    }])

    expect(listSessions('test-workspace', workspaceRoot).map(session => session.mortiseId)).not.toContain(sessionId)
    expect(loadSession('test-workspace', sessionId)).toBeNull()
    expect(getSessionFilePath('test-workspace', sessionId)).not.toBe(nestedSessionFile)
  })

  it('does not expose sidecar plan counts for an unpublished draft', async () => {
    const piRoot = join(dir, 'pi-sessions-plan-count')
    const workspaceRoot = join(dir, 'workspace-plan-count')
    mkdirSync(workspaceRoot, { recursive: true })
    setSharedPiSessionsDirForTests(piRoot)

    const session = await createSession('test-workspace', workspaceRoot, { name: 'Plan count' })
    const plansDir = getSessionPlansPath('test-workspace', session.mortiseId)
    writeFileSync(join(plansDir, 'plan.md'), '# Plan\n')

    const listed = listSessions('test-workspace', workspaceRoot)
    expect(listed.find(s => s.mortiseId === session.mortiseId)).toBeUndefined()
  })
})
