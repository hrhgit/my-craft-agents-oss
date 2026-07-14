import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { requestCraftUiHost } from '../../craft-ui/client.ts'
import { DEFAULT_CRAFT_UI_RUN_ROOT, startCraftUiRun, stopCraftUiRun } from '../../craft-ui/controller.ts'

interface SnapshotNode {
  ref: string
  semanticId?: string
  role: string
  name: string
  value?: string
}

interface Snapshot {
  revision: number
  regions: Record<string, SnapshotNode[]>
}

interface EvidenceResult { bundleDir: string; artifacts?: Array<{ path?: string }> }

const sourceCraftConfigDir = requiredDirectory('CRAFT_E2E_SOURCE_CRAFT_PROFILE')
const sourcePiAgentDir = requiredDirectory('CRAFT_E2E_SOURCE_PI_PROFILE')
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')
const resultPath = resolve(process.env.CRAFT_E2E_RESULT_PATH
  ?? join(DEFAULT_CRAFT_UI_RUN_ROOT, `electron-chat-${stamp}.json`))
const providerLogPath = resolve(process.env.CRAFT_E2E_PROVIDER_LOG_FILE
  ?? join(DEFAULT_CRAFT_UI_RUN_ROOT, `electron-chat-provider-${stamp}.jsonl`))
const providerHookPath = resolve(import.meta.dir, 'provider-hook.cjs')
const sentinel = `CRAFT_E2E_${stamp.replace(/[^A-Z0-9]/gi, '_').toUpperCase()}`
const prompt = `Reply with exactly this token and no extra text: ${sentinel}`

const manifest = await startCraftUiRun({
  surface: 'electron',
  profileMode: 'clone',
  sourceCraftConfigDir,
  sourcePiAgentDir,
  waitMs: 300_000,
  extraEnv: {
    PI_HOST_HOOKS_MODULE: providerHookPath,
    CRAFT_E2E_PROVIDER_LOG_FILE: providerLogPath,
    CRAFT_E2E_RUN_ID: stamp,
  },
})

const startedAt = Date.now()
let evidence: EvidenceResult | undefined
let sessionId: string | undefined
let failure: unknown

try {
  const initial = await command<Snapshot>('ui.snapshot')
  const newSession = nodes(initial).find(node => node.semanticId === 'app.new-session')
  if (!newSession) throw new Error('AppShell did not expose the stable app.new-session command.')

  await command('ui.action', {
    revision: initial.revision,
    target: { ref: newSession.ref },
    action: 'click',
    mode: 'physical',
    waitUntil: { kind: 'state', scope: 'sessions', phase: 'ready', detail: { count: 1 }, timeoutMs: 60_000 },
    timeoutMs: 60_000,
  }, 'renderer-verified')

  const created = await command<Snapshot>('ui.snapshot')
  const composerInput = nodes(created).find(node => node.semanticId?.startsWith('composer.') && node.semanticId.endsWith('.input'))
  if (!composerInput?.semanticId) throw new Error('Created session did not expose its semantic composer input.')
  sessionId = composerInput.semanticId.slice('composer.'.length, -'.input'.length)

  await command('ui.action', {
    revision: created.revision,
    target: { ref: composerInput.ref },
    action: 'fill',
    mode: 'semantic',
    value: prompt,
  }, 'scenario-verified')

  const filled = await command<Snapshot>('ui.snapshot')
  const send = nodes(filled).find(node => node.semanticId === `composer.${sessionId}.send`)
  if (!send) throw new Error('Composer did not expose its stable send action.')
  await command('ui.action', {
    revision: filled.revision,
    target: { ref: send.ref },
    action: 'click',
    mode: 'physical',
    waitUntil: { kind: 'session-state', sessionId, state: 'busy', timeoutMs: 60_000 },
    timeoutMs: 60_000,
  }, 'renderer-verified')

  await command('ui.wait', {
    predicate: { kind: 'session-state', sessionId, state: 'ready' },
    timeoutMs: 180_000,
    stableForMs: 100,
  })
  await command('ui.wait', {
    predicate: { kind: 'text', value: sentinel },
    timeoutMs: 30_000,
    stableForMs: 100,
  })

  evidence = await command<EvidenceResult>('evidence.capture', { label: 'electron-chat-real' })
  const provider = providerEvidence(providerLogPath, startedAt)
  if (provider.requests < 1) throw new Error('No provider request was observed after the chat started.')
  if (provider.successes < 1) throw new Error('No successful provider response was observed after the chat started.')
  writeResult({
    ok: true,
    runId: manifest.runId,
    sessionId,
    sentinel,
    verificationLevel: 'renderer-verified',
    provider,
    evidence: evidence.bundleDir,
  })
} catch (error) {
  failure = error
  evidence = await command<EvidenceResult>('evidence.capture', { label: 'electron-chat-failure' }).catch(() => undefined)
  writeResult({
    ok: false,
    runId: manifest.runId,
    sessionId,
    error: error instanceof Error ? error.stack ?? error.message : String(error),
    evidence: evidence?.bundleDir,
  })
  throw error
} finally {
  const stopped = await stopCraftUiRun(manifest.runDir)
  if (stopped.status !== 'stopped' && !failure) throw new Error(`craft-ui stop failed: ${stopped.error ?? stopped.cleanupError ?? 'unknown error'}`)
}

async function command<T = Record<string, unknown>>(
  name: string,
  params: Record<string, unknown> = {},
  expectedLevel?: string,
): Promise<T & { verificationLevel: string; seq: number }> {
  const response = await requestCraftUiHost<T>({ ...manifest, command: name, params, timeoutMs: 240_000 })
  if (response.ok === false) throw new Error(`${name} failed: ${response.error.code}: ${response.error.message}`)
  if (expectedLevel && response.verificationLevel !== expectedLevel) {
    throw new Error(`${name} returned ${response.verificationLevel}; expected ${expectedLevel}.`)
  }
  return Object.assign(response.result as T, { verificationLevel: response.verificationLevel, seq: response.seq })
}

function nodes(snapshot: Snapshot): SnapshotNode[] { return Object.values(snapshot.regions).flat() }

function providerEvidence(path: string, afterMs: number): { requests: number; successes: number; errors: number } {
  if (!existsSync(path)) return { requests: 0, successes: 0, errors: 0 }
  const events = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line) as { event?: string; timestampMs?: number; ok?: boolean }] } catch { return [] }
  }).filter(event => (event.timestampMs ?? 0) >= afterMs)
  return {
    requests: events.filter(event => event.event === 'request').length,
    successes: events.filter(event => event.event === 'response' && event.ok === true).length,
    errors: events.filter(event => event.event === 'error').length,
  }
}

function requiredDirectory(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} must explicitly select the source profile used for clone-mode validation.`)
  const path = resolve(value)
  if (!existsSync(path)) throw new Error(`${name} does not exist: ${path}`)
  return path
}

function writeResult(value: Record<string, unknown>): void {
  mkdirSync(dirname(resultPath), { recursive: true })
  writeFileSync(resultPath, `${JSON.stringify({ ...value, completedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
}
