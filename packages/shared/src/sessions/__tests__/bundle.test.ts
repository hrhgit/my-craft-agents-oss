import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { serializeSession, validateBundle } from '../bundle'
import { ensureSharedPiTreeSessionFileAsync, setSharedPiSessionsDirForTests, getSessionPath } from '../storage'
import type { StoredSession } from '../types'

// ============================================================
// Helpers
// ============================================================

function makeTmpDir(): string {
  const dir = join(tmpdir(), `bundle-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function makeStoredSession(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    mortiseId: '260101-test-session',
    workspaceId: overrides.workspaceId ?? 'ws',
    workspaceRootPath: '/tmp/ws',
    createdAt: 1000,
    lastUsedAt: 2000,
    name: 'Test Session',
    messages: [
      {
        id: 'msg-1',
        type: 'user',
        content: 'Hello world',
        timestamp: 1000,
      },
      {
        id: 'msg-2',
        type: 'assistant',
        content: 'Hi there!',
        timestamp: 1500,
      },
    ],
    tokenUsage: {
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      contextTokens: 100,
      costUsd: 0.001,
    },
    ...overrides,
  } as StoredSession
}

/**
 * Set up a session in the Pi tree JSONL v3 format under the test Pi sessions dir.
 * Returns the sidecar directory (.mortise/{sessionId}/) where attachments, plans,
 * etc. should be placed.
 */
async function setupSessionDir(workspaceRoot: string, session: StoredSession): Promise<string> {
  session.workspaceRootPath = workspaceRoot
  // Delegate both canonical header and message persistence to Pi's
  // SessionManager so fixtures exercise the production durability path.
  await ensureSharedPiTreeSessionFileAsync(session, { workspaceId: session.workspaceId })

  // Create the sidecar directory (.mortise/{sessionId}/) for attachment/plan/data
  // files. The canonical materializer does not create this directory.
  const sidecarDir = getSessionPath(session.workspaceId, session.mortiseId)
  mkdirSync(sidecarDir, { recursive: true })
  return sidecarDir
}

// ============================================================
// Tests
// ============================================================

describe('serializeSession', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTmpDir()
    // Override the Pi sessions dir to a temp location for isolation.
    setSharedPiSessionsDirForTests(join(tmpDir, 'pi-sessions'))
  })

  afterEach(() => {
    setSharedPiSessionsDirForTests(undefined)
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true })
    }
  })

  it('produces a valid bundle from a session directory', async () => {
    const session = makeStoredSession()
    await setupSessionDir(tmpDir, session)

    const bundle = serializeSession(session.workspaceId, session.mortiseId)

    expect(bundle).not.toBeNull()
    expect(bundle!.version).toBe(1)
    expect(bundle!.session.header.mortiseId).toBe(session.mortiseId)
    expect(bundle!.session.messages).toHaveLength(2)
    expect(bundle!.session.messages[0]!.content).toBe('Hello world')
    expect(bundle!.session.messages[1]!.content).toBe('Hi there!')
    expect(Array.isArray(bundle!.files)).toBe(true)
  })

  it('includes attachment files in bundle', async () => {
    const session = makeStoredSession()
    const sessionDir = await setupSessionDir(tmpDir, session)

    // Create an attachment
    const attachDir = join(sessionDir, 'attachments')
    mkdirSync(attachDir, { recursive: true })
    writeFileSync(join(attachDir, 'screenshot.png'), Buffer.from('fake-png-data'))

    const bundle = serializeSession(session.workspaceId, session.mortiseId)

    expect(bundle).not.toBeNull()
    expect(bundle!.files).toHaveLength(1)
    expect(bundle!.files[0]!.relativePath).toBe('attachments/screenshot.png')
    expect(bundle!.files[0]!.size).toBe(13) // 'fake-png-data'.length
    // Verify base64 round-trips correctly
    const decoded = Buffer.from(bundle!.files[0]!.contentBase64, 'base64').toString()
    expect(decoded).toBe('fake-png-data')
  })

  it('includes plan and data files in bundle', async () => {
    const session = makeStoredSession()
    const sessionDir = await setupSessionDir(tmpDir, session)

    // Create plan and data files
    mkdirSync(join(sessionDir, 'plans'), { recursive: true })
    writeFileSync(join(sessionDir, 'plans', 'my-plan.md'), '# Plan\n- [ ] Step 1')

    mkdirSync(join(sessionDir, 'data'), { recursive: true })
    writeFileSync(join(sessionDir, 'data', 'result.json'), '{"rows":[]}')

    const bundle = serializeSession(session.workspaceId, session.mortiseId)

    expect(bundle).not.toBeNull()
    expect(bundle!.files).toHaveLength(2)
    const paths = bundle!.files.map(f => f.relativePath).sort()
    expect(paths).toEqual(['data/result.json', 'plans/my-plan.md'])
  })

  it('preserves notes.md in bundle', async () => {
    const session = makeStoredSession()
    const sessionDir = await setupSessionDir(tmpDir, session)

    writeFileSync(join(sessionDir, 'notes.md'), '# My Notes\nSome notes here.')

    const bundle = serializeSession(session.workspaceId, session.mortiseId)

    expect(bundle).not.toBeNull()
    const notesFile = bundle!.files.find(f => f.relativePath === 'notes.md')
    expect(notesFile).toBeDefined()
    expect(Buffer.from(notesFile!.contentBase64, 'base64').toString()).toBe('# My Notes\nSome notes here.')
  })

  it('skips tmp/ directory', async () => {
    const session = makeStoredSession()
    const sessionDir = await setupSessionDir(tmpDir, session)

    mkdirSync(join(sessionDir, 'tmp'), { recursive: true })
    writeFileSync(join(sessionDir, 'tmp', 'cache.dat'), 'cached data')

    const bundle = serializeSession(session.workspaceId, session.mortiseId)

    expect(bundle).not.toBeNull()
    const tmpFiles = bundle!.files.filter(f => f.relativePath.startsWith('tmp'))
    expect(tmpFiles).toHaveLength(0)
  })

  it('skips dotfiles', async () => {
    const session = makeStoredSession()
    const sessionDir = await setupSessionDir(tmpDir, session)

    writeFileSync(join(sessionDir, '.hidden'), 'secret')

    const bundle = serializeSession(session.workspaceId, session.mortiseId)

    expect(bundle).not.toBeNull()
    const dotFiles = bundle!.files.filter(f => f.relativePath.startsWith('.'))
    expect(dotFiles).toHaveLength(0)
  })

  it('does not include session.jsonl in files array', async () => {
    const session = makeStoredSession()
    await setupSessionDir(tmpDir, session)

    const bundle = serializeSession(session.workspaceId, session.mortiseId)

    expect(bundle).not.toBeNull()
    const jsonlFiles = bundle!.files.filter(f => f.relativePath.includes('session.jsonl'))
    expect(jsonlFiles).toHaveLength(0)
  })

  it('returns null for non-existent session', () => {
    const bundle = serializeSession('ws', 'non-existent')
    expect(bundle).toBeNull()
  })

  it('preserves session metadata in header', async () => {
    const session = makeStoredSession({
      permissionMode: 'ask' as any,
    })
    await setupSessionDir(tmpDir, session)

    const bundle = serializeSession(session.workspaceId, session.mortiseId)

    expect(bundle).not.toBeNull()
  })
})

describe('validateBundle', () => {
  it('accepts valid bundle', () => {
    const bundle = {
      version: 1,
      session: {
        header: { mortiseId: 'test', createdAt: 1000 },
        messages: [],
      },
      files: [],
    }
    expect(validateBundle(bundle)).toBe(true)
  })

  it('rejects null', () => {
    expect(validateBundle(null)).toBe(false)
  })

  it('rejects wrong version', () => {
    expect(validateBundle({ version: 2, session: { header: { mortiseId: 'x', createdAt: 1 }, messages: [] }, files: [] })).toBe(false)
  })

  it('rejects missing session', () => {
    expect(validateBundle({ version: 1, files: [] })).toBe(false)
  })

  it('rejects missing header', () => {
    expect(validateBundle({ version: 1, session: { messages: [] }, files: [] })).toBe(false)
  })

  it('rejects missing messages array', () => {
    expect(validateBundle({ version: 1, session: { header: { mortiseId: 'x', createdAt: 1 } }, files: [] })).toBe(false)
  })

  it('rejects missing files array', () => {
    expect(validateBundle({ version: 1, session: { header: { mortiseId: 'x', createdAt: 1 }, messages: [] } })).toBe(false)
  })

  it('rejects header without mortiseId', () => {
    expect(validateBundle({ version: 1, session: { header: { createdAt: 1 }, messages: [] }, files: [] })).toBe(false)
  })

  it('rejects header without createdAt', () => {
    expect(validateBundle({ version: 1, session: { header: { mortiseId: 'x' }, messages: [] }, files: [] })).toBe(false)
  })

  it('rejects the removed id-only bundle header', () => {
    expect(validateBundle({
      version: 1,
      session: { header: { id: 'legacy', createdAt: 1 }, messages: [] },
      files: [],
    })).toBe(false)
  })

  it('rejects unsafe session ids', () => {
    expect(validateBundle({
      version: 1,
      session: {
        header: { mortiseId: '../escape', createdAt: 1 },
        messages: [],
      },
      files: [],
    })).toBe(false)

  })
})
