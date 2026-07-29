import { afterEach, describe, expect, it, mock } from 'bun:test'
import { ensureSharedPiTreeSessionFileAsync, getSessionFilePath, getSessionPath, setSharedPiSessionsDirForTests, tryGetSessionFilePath } from '@mortise/shared/sessions'
import { spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { SessionValidationController } from '../session-validation-backend'
import type { Workspace } from '@mortise/core/types'

const envKeys = ['MORTISE_UI_TEST_HOST', 'MORTISE_UI_RUN_ID', 'MORTISE_UI_PROFILE_MODE', 'MORTISE_UI_PROFILE_DIR', 'PI_CODING_AGENT_DIR'] as const
const original = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
let profile: string | undefined

afterEach(() => {
  setSharedPiSessionsDirForTests(undefined)
  if (profile) rmSync(profile, { recursive: true, force: true })
  profile = undefined
  for (const key of envKeys) {
    const value = original[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('Session validation backend', () => {
  it('rejects arming outside an isolated Dev Host', () => {
    delete process.env.MORTISE_UI_TEST_HOST
    const controller = new SessionValidationController()
    expect(() => controller.arm({ runId: 'run-a', workspaceId: 'ws-a', mode: { kind: 'fail-before-assistant' } })).toThrow('active Dev Host')
  })

  it('does not consume a provisional lease for a missing or existing Session', () => {
    const controller = setupController()
    controller.arm({ runId: 'run-a', workspaceId: 'ws-a', mode: { kind: 'fail-before-assistant' } })
    const createDefaultBackend = mock(() => ({} as never))

    controller.backendFactory(backendArgs('ws-a', createDefaultBackend, { sessionId: undefined }))
    controller.backendFactory(backendArgs('ws-a', createDefaultBackend, { provisional: false }))

    expect(controller.status()?.phase).toBe('armed')
    expect(createDefaultBackend).toHaveBeenCalledTimes(2)
  })

  it('targets one existing Session and fails only its first chat attempt', async () => {
    const controller = setupController()
    controller.arm({
      runId: 'run-a', workspaceId: 'ws-a', sessionId: 'session-a',
      mode: { kind: 'fail-user-persistence-once', answer: 'accepted retry', message: 'planned persistence failure' },
    })
    const fallback = {} as never
    const createDefaultBackend = mock(() => fallback)

    expect(controller.backendFactory(backendArgs('ws-a', createDefaultBackend, { sessionId: 'session-b', provisional: false }))).toBe(fallback)
    const backend = controller.backendFactory(backendArgs('ws-a', createDefaultBackend, { sessionId: 'session-a', provisional: false }))
    await expect(backend.chat('same payload').next()).rejects.toThrow('planned persistence failure')
    expect(controller.status()?.diagnostics.chatAttempts).toBe(1)
  })

  it('delegates a competing workspace without consuming the lease', async () => {
    const controller = setupController()
    controller.arm({ runId: 'run-a', workspaceId: 'ws-a', mode: { kind: 'fail-before-assistant', message: 'planned failure' } })
    const fallback = {} as never
    const createDefaultBackend = mock(() => fallback)

    expect(controller.backendFactory(backendArgs('ws-b', createDefaultBackend))).toBe(fallback)
    const backend = controller.backendFactory(backendArgs('ws-a', createDefaultBackend))
    await expect(backend.chat('hello').next()).rejects.toThrow('planned failure')
    expect(controller.status()?.phase).toBe('claimed')
  })

  it('allows exactly one concurrent provisional backend to claim the state', () => {
    const controller = setupController()
    controller.arm({ runId: 'run-a', workspaceId: 'ws-a', mode: { kind: 'succeed', answer: 'winner' } })
    const fallback = {} as never
    const createDefaultBackend = mock(() => fallback)

    const results = [
      new SessionValidationController().backendFactory(backendArgs('ws-a', createDefaultBackend, { sessionId: 'session-a' })),
      new SessionValidationController().backendFactory(backendArgs('ws-a', createDefaultBackend, { sessionId: 'session-b' })),
    ]

    expect(results.filter(result => result === fallback)).toHaveLength(1)
    expect(results.filter(result => result !== fallback)).toHaveLength(1)
  })

  it('allows exactly one child process to claim the state', async () => {
    const controller = setupController()
    controller.arm({ runId: 'run-a', workspaceId: 'ws-a', mode: { kind: 'succeed', answer: 'winner' } })

    expect((await Promise.all([runClaimProcess('session-a'), runClaimProcess('session-b')])).sort()).toEqual(['claimed', 'fallback'])
  })

  it('atomically replaces state and leaves no temporary files', () => {
    const controller = setupController()
    controller.arm({ runId: 'run-a', workspaceId: 'ws-a', mode: { kind: 'fail-before-assistant' } })
    controller.arm({ runId: 'run-a', workspaceId: 'ws-a', mode: { kind: 'succeed', answer: 'replacement' } })

    expect(controller.status()?.mode).toBe('succeed')
    expect(readdirSync(profile!).filter(name => name !== 'session-validation.v1.json' && name !== 'pi-agent')).toEqual([])
  })

  it('flushes the first assistant to canonical JSONL before yielding an observable event', async () => {
    const controller = setupController()
    const workspaceRoot = join(profile!, 'workspace')
    const sessionId = 'session-publication'
    mkdirSync(workspaceRoot, { recursive: true })
    controller.arm({
      runId: 'run-a', workspaceId: 'ws-a',
      mode: { kind: 'succeed', answer: 'durable assistant' },
    })
    const backend = controller.backendFactory(backendArgs('ws-a', () => ({} as never), {
      sessionId, workspaceRoot,
    }))

    const first = await backend.chat('durable user').next()
    const sessionFile = tryGetSessionFilePath('ws-a', sessionId)

    expect(first.value).toEqual({ type: 'pi_user_message_persisted' })
    expect(sessionFile).not.toBeNull()
    const entries = readFileSync(sessionFile!, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } })
    expect(entries.filter(entry => entry.type === 'message').map(entry => entry.message?.role))
      .toEqual(['user', 'assistant'])
    expect(entries.at(-1)?.message?.content).toEqual([{ type: 'text', text: 'durable assistant' }])
  })

  it('releases the blocker without racing the retained baseline and cleans it after settlement', async () => {
    const controller = setupController()
    const workspaceRoot = join(profile!, 'workspace')
    const sessionId = 'session-settlement'
    mkdirSync(workspaceRoot, { recursive: true })
    const timestamp = Date.now()
    const sessionFile = await ensureSharedPiTreeSessionFileAsync({
      mortiseId: sessionId,
      workspaceId: 'ws-a',
      workspaceRootPath: workspaceRoot,
      createdAt: timestamp,
      lastUsedAt: timestamp,
      lastMessageAt: timestamp + 1,
      messages: [
        { id: 'baseline-user', type: 'user', content: 'baseline', timestamp },
        { id: 'baseline-assistant', type: 'assistant', content: 'baseline answer', timestamp: timestamp + 1 },
      ],
      tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, contextTokens: 2, costUsd: 0 },
    }, { workspaceId: 'ws-a' })
    const projectionPath = join(getSessionPath('ws-a', sessionId), 'pi-projection-v1.json')
    const projectionBackupPath = join(dirname(projectionPath), 'pi-projection-v1.session-validation-backup-v1.json')
    mkdirSync(dirname(projectionPath), { recursive: true })
    writeFileSync(projectionPath, 'baseline projection', 'utf8')
    const baselineTemporary = `${projectionPath}.baseline.tmp`
    writeFileSync(baselineTemporary, 'pre-existing temporary file', 'utf8')

    controller.arm({
      runId: 'run-a', workspaceId: 'ws-a', sessionId,
      mode: { kind: 'fail-settlement-projection', answer: 'accepted answer' },
    })
    const backend = controller.backendFactory(backendArgs('ws-a', () => ({} as never), {
      sessionId, provisional: false, workspaceRoot,
    }))
    for await (const _event of backend.chat('accepted message')) { /* drain deterministic turn */ }

    expect(lstatSync(projectionPath).isDirectory()).toBe(true)
    expect(controller.status()).toMatchObject({
      phase: 'settlement-blocked',
      diagnostics: { chatAttempts: 1 },
      settlement: { blockerCreated: true, priorProjection: 'file' },
    })

    const failedTemporaryA = `${projectionPath}.failed-a.tmp`
    const failedTemporaryB = `${projectionPath}.failed-b.tmp`
    writeFileSync(failedTemporaryA, 'failed projection write A', 'utf8')
    writeFileSync(failedTemporaryB, 'failed projection write B', 'utf8')

    expect(controller.releaseSettlement()).toMatchObject({ phase: 'settlement-released', settlement: { blockerCreated: false } })
    expect(existsSync(projectionPath)).toBe(false)
    expect(readFileSync(projectionBackupPath, 'utf8')).toBe('baseline projection')
    expect(existsSync(baselineTemporary)).toBe(true)
    expect(existsSync(failedTemporaryA)).toBe(false)
    expect(existsSync(failedTemporaryB)).toBe(false)

    writeFileSync(projectionPath, 'settled projection', 'utf8')
    controller.clear()
    expect(readFileSync(projectionPath, 'utf8')).toBe('settled projection')
    expect(existsSync(projectionBackupPath)).toBe(false)
    expect(controller.status()).toBeUndefined()
  })
})

function setupController(): SessionValidationController {
  process.env.MORTISE_UI_TEST_HOST = '1'
  process.env.MORTISE_UI_RUN_ID = 'run-a'
  process.env.MORTISE_UI_PROFILE_MODE = 'fixture'
  profile = mkdtempSync(join(tmpdir(), 'session-validation-'))
  process.env.MORTISE_UI_PROFILE_DIR = profile
  process.env.PI_CODING_AGENT_DIR = join(profile, 'pi-agent')
  setSharedPiSessionsDirForTests(join(profile, 'agent', 'sessions'))
  return new SessionValidationController()
}

function backendArgs(
  workspaceId: string,
  createDefaultBackend: () => never,
  options: { sessionId?: string; provisional?: boolean; workspaceRoot?: string } = {},
) {
  const sessionId = Object.prototype.hasOwnProperty.call(options, 'sessionId') ? options.sessionId : 'session-a'
  return {
    coreConfig: {
      workspace: validationWorkspace(workspaceId, options.workspaceRoot ?? 'C:/workspace'),
      ...(sessionId ? { session: { mortiseId: sessionId } } : {}),
    },
    provisional: options.provisional ?? true,
    createDefaultBackend,
  }
}

function validationWorkspace(id: string, rootPath: string): Workspace {
  return {
    schemaVersion: 2,
    id,
    revision: 0,
    name: id,
    nameSource: 'custom',
    slug: id,
    primaryLocationId: 'primary',
    locations: [{
      id: 'primary',
      name: 'Primary',
      rootName: 'workspace',
      endpoint: { kind: 'local', rootPath },
    }],
    createdAt: 0,
  }
}

async function runClaimProcess(sessionId: string): Promise<string> {
  const child = spawn(process.execPath, ['run', join(import.meta.dir, 'session-validation-backend-claim.fixture.ts'), sessionId], {
    cwd: process.cwd(), env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })
  if (exitCode !== 0) throw new Error(`Claim process failed (${exitCode}): ${stderr}`)
  return stdout.trim()
}
