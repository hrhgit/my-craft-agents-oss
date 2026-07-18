import { randomBytes } from 'node:crypto'
import { closeSync, existsSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { UI_VALIDATION_DEFAULT_TIMEOUT_MS, UI_VALIDATION_MAX_WAIT_MS } from '@craft-agent/shared/ui-validation'
import { CRAFT_UI_PROTOCOL_VERSION, type CraftUiFailureDiagnostics, type CraftUiProfileMode, type CraftUiResponse, type CraftUiRunManifest, type CraftUiStartupPhase, type CraftUiSurface, type CraftUiWindowMode } from './protocol.ts'
import { ensureDir, writeJsonAtomic } from './files.ts'
import type { CraftUiFixtureSpec } from './fixture.ts'
import { redactText } from './redaction.ts'
import { createCraftUiSurfaceDriver, readEndpointManifest, requestCraftUiHost } from './client.ts'
import { withFileLock } from './artifacts.ts'

export const DEFAULT_CRAFT_UI_RUN_ROOT = resolve(process.cwd(), 'output', 'craft-ui')
export const DEFAULT_CRAFT_UI_START_WAIT_MS = 600_000
const CRAFT_UI_SHUTDOWN_REQUEST_TIMEOUT_MS = 30_000
const CRAFT_UI_SHUTDOWN_GRACE_PERIOD_MS = 30_000
const CRAFT_UI_FORCED_STOP_GRACE_PERIOD_MS = 10_000
const CRAFT_UI_DIAGNOSTIC_TAIL_BYTES = 16_000

export class CraftUiStartError extends Error {
  constructor(message: string, readonly manifest: CraftUiRunManifest) {
    super(message)
    this.name = 'CraftUiStartError'
  }
}

export function getDefaultAdapterCommand(surface: CraftUiSurface): string[] {
  if (surface === 'webui') return [
    process.env.CRAFT_UI_NODE_EXECUTABLE || 'node',
    '--import', './scripts/craft-ui/register-ts-loader.mjs',
    './scripts/craft-ui/web-adapter.ts',
  ]
  return [process.execPath, resolve(process.cwd(), 'scripts', 'craft-ui', 'electron-adapter.ts')]
}

function makeRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')
  return `${stamp}-${randomBytes(4).toString('hex')}`
}

function isPidAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'EPERM' || code === 'EACCES'
  }
}

export function readRunManifest(runDir: string): CraftUiRunManifest {
  return JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')) as CraftUiRunManifest
}

export function updateRunManifest(runDir: string, patch: Partial<CraftUiRunManifest>): CraftUiRunManifest {
  const path = join(runDir, 'run.json')
  return withFileLock(path, () => {
    const manifest = { ...readRunManifest(runDir), ...patch, updatedAt: new Date().toISOString() }
    writeJsonAtomic(path, manifest)
    return manifest
  })
}

export function resolveRunDir(runRoot = DEFAULT_CRAFT_UI_RUN_ROOT, runId?: string): string {
  const root = resolve(runRoot)
  if (runId) {
    const candidate = resolve(root, runId)
    if (!candidate.startsWith(`${root}\\`) && !candidate.startsWith(`${root}/`)) throw new Error('Run ID escapes the run root')
    if (!existsSync(join(candidate, 'run.json'))) throw new Error(`Craft UI run not found: ${runId}`)
    return candidate
  }
  if (!existsSync(root)) throw new Error('No Craft UI runs exist')
  const runs = readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(root, entry.name, 'run.json')))
    .map(entry => readRunManifest(join(root, entry.name)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const active = runs.filter(run =>
    (run.status === 'starting' || run.status === 'ready' || run.status === 'stopping')
    && (isPidAlive(run.hostPid) || isPidAlive(run.launcherPid)),
  )
  if (active.length === 1) return active[0]!.runDir
  if (active.length > 1) throw new Error('More than one active Craft UI run exists; provide --run explicitly')
  if (runs.length > 0) throw new Error('No active Craft UI run exists; provide --run to inspect a stopped or failed run')
  throw new Error('No Craft UI runs exist')
}

export async function startCraftUiRun(args: {
  surface: CraftUiSurface
  profileMode?: CraftUiProfileMode
  windowMode?: CraftUiWindowMode
  adapterCommand?: string[]
  runRoot?: string
  sourceCraftConfigDir?: string
  sourcePiAgentDir?: string
  waitMs?: number
  waitForReady?: boolean
  extraEnv?: Record<string, string>
  scenario?: Record<string, unknown>
  fixtureSpec?: CraftUiFixtureSpec
}): Promise<CraftUiRunManifest> {
  if (args.profileMode === 'clone' && (!args.sourceCraftConfigDir || !args.sourcePiAgentDir)) {
    throw new Error('clone profile requires explicit sourceCraftConfigDir and sourcePiAgentDir paths')
  }
  if (args.fixtureSpec && args.profileMode !== undefined && args.profileMode !== 'fixture') {
    throw new Error('fixtureSpec requires the fixture profile mode')
  }
  const waitMs = args.waitMs ?? DEFAULT_CRAFT_UI_START_WAIT_MS
  if (!Number.isSafeInteger(waitMs) || waitMs < 1 || waitMs > UI_VALIDATION_MAX_WAIT_MS) {
    throw new Error(`waitMs must be between 1 and ${UI_VALIDATION_MAX_WAIT_MS}`)
  }
  const adapterCommand = args.adapterCommand ?? getDefaultAdapterCommand(args.surface)
  if (adapterCommand.length === 0 || !adapterCommand[0]) throw new Error('An adapter command is required')
  const runId = makeRunId()
  const runDir = join(resolve(args.runRoot ?? DEFAULT_CRAFT_UI_RUN_ROOT), runId)
  const profileDir = join(runDir, 'profile')
  const artifactsDir = join(runDir, 'artifacts')
  const endpointManifestPath = join(runDir, 'endpoint.json')
  const tokenPath = join(runDir, 'token')
  const stdoutPath = join(artifactsDir, 'host.stdout.log')
  const stderrPath = join(artifactsDir, 'host.stderr.log')
  ensureDir(artifactsDir)
  const token = randomBytes(32).toString('hex')
  const now = new Date().toISOString()
  const windowMode = args.windowMode ?? (args.surface === 'electron' ? 'background' : 'foreground')
  writeJsonAtomic(join(artifactsDir, 'manifest.json'), {
    protocolVersion: CRAFT_UI_PROTOCOL_VERSION, runId, updatedAt: new Date().toISOString(), artifacts: [],
  })
  let manifest: CraftUiRunManifest = {
    protocolVersion: CRAFT_UI_PROTOCOL_VERSION,
    runId,
    surface: args.surface,
    status: 'starting',
    createdAt: now,
    updatedAt: now,
    controllerPid: process.pid,
    profileMode: args.profileMode ?? 'fixture',
    windowMode,
    containsClonedUserData: args.profileMode === 'clone',
    runDir,
    profileDir,
    artifactsDir,
    endpointManifestPath,
    tokenPath,
    stdoutPath,
    stderrPath,
    adapterCommand: adapterCommand.map(part => redactText(part, [token])),
    ...(typeof args.scenario?.name === 'string' ? {
      initialScenario: {
        name: args.scenario.name,
        ...(typeof args.scenario.seed === 'number' ? { seed: args.scenario.seed } : {}),
      },
    } : {}),
  }
  writeJsonAtomic(join(runDir, 'run.json'), manifest)
  // Token files are raw strings for simple cross-runtime adapters.
  writeFileSync(tokenPath, `${token}\n`, { encoding: 'utf8', mode: 0o600 })
  let profile: ReturnType<(typeof import('./profile.ts'))['prepareProfile']>
  try {
    const { prepareProfile } = await import('./profile.ts')
    profile = prepareProfile({
      profileDir,
      mode: args.profileMode ?? 'fixture',
      sourceCraftConfigDir: args.sourceCraftConfigDir,
      sourcePiAgentDir: args.sourcePiAgentDir,
      fixtureSpec: args.fixtureSpec,
    })
    manifest = updateRunManifest(runDir, {
      profileMode: profile.mode,
      containsClonedUserData: profile.containsClonedUserData,
      fixture: profile.fixture,
    })
  } catch (error) {
    const message = `Failed to prepare Craft UI profile: ${error instanceof Error ? error.message : String(error)}`
    const failed = await failCraftUiStart(runDir, 'profile', message, [])
    throw new CraftUiStartError(message, failed)
  }

  const stdoutFd = openSync(stdoutPath, 'a')
  const stderrFd = openSync(stderrPath, 'a')
  const [command, ...commandArgs] = adapterCommand
  let child
  try {
    child = spawn(command!, commandArgs, {
      cwd: process.cwd(),
      detached: true,
      windowsHide: true,
      stdio: ['ignore', stdoutFd, stderrFd],
      env: {
        ...process.env,
        ...args.extraEnv,
        CRAFT_CONFIG_DIR: profile.craftConfigDir,
        PI_CODING_AGENT_DIR: profile.piAgentDir,
        CRAFT_UI_RUN_ID: runId,
        CRAFT_UI_SURFACE: args.surface,
        CRAFT_UI_RUN_DIR: runDir,
        CRAFT_UI_PROFILE_DIR: profileDir,
        CRAFT_UI_ARTIFACTS_DIR: artifactsDir,
        CRAFT_UI_ENDPOINT_MANIFEST: endpointManifestPath,
        CRAFT_UI_TOKEN: token,
        CRAFT_UI_PROTOCOL_VERSION: String(CRAFT_UI_PROTOCOL_VERSION),
        CRAFT_UI_ELECTRON_USER_DATA_DIR: profile.electronUserDataDir,
        CRAFT_UI_WINDOW_MODE: windowMode,
        CRAFT_UI_VALIDATION_BUILD: '1',
        CRAFT_UI_TEST_HOST: '1',
      },
    })
  } catch (error) {
    const message = `Failed to start Craft UI host: ${error instanceof Error ? error.message : String(error)}`
    const failed = await failCraftUiStart(runDir, 'spawn', message, [])
    throw new CraftUiStartError(message, failed)
  } finally {
    closeSync(stdoutFd)
    closeSync(stderrFd)
  }
  const spawnError = await new Promise<Error | undefined>((resolveSpawn) => {
    child.once('spawn', () => resolveSpawn(undefined))
    child.once('error', error => resolveSpawn(error))
  })
  if (spawnError) {
    const message = `Failed to start Craft UI host: ${spawnError.message}`
    const failed = await failCraftUiStart(runDir, 'spawn', message, [child.pid])
    throw new CraftUiStartError(message, failed)
  }
  child.unref()
  updateRunManifest(runDir, { launcherPid: child.pid })
  if (args.waitForReady === false) return readRunManifest(runDir)

  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    if (existsSync(endpointManifestPath)) {
      const endpoint = readEndpointManifest(endpointManifestPath)
      if (endpoint.runId !== runId || endpoint.surface !== args.surface || !isPidAlive(endpoint.pid)) {
        const error = 'Host endpoint manifest identity does not match the controller run'
        const failed = await failCraftUiStart(runDir, 'endpoint', error, [child.pid, endpoint.pid])
        throw new CraftUiStartError(error, failed)
      }
      let readyManifest = updateRunManifest(runDir, { launcherPid: child.pid, hostPid: endpoint.pid })
      const appReadyTimeoutMs = Math.max(1, deadline - Date.now())
      const readiness = await requestCraftUiHost({
        ...readyManifest,
        command: 'ui.wait',
        params: { predicate: { kind: 'app-phase', phase: 'ready' }, stableForMs: 50, timeoutMs: appReadyTimeoutMs },
        timeoutMs: appReadyTimeoutMs,
        minimumSeqExclusive: readyManifest.lastResponseSeq,
      }).catch(error => ({ ok: false as const, error: { code: 'NOT_READY', message: error instanceof Error ? error.message : String(error) } }))
      if (!readiness.ok) {
        const error = `Host endpoint opened but the application did not become ready: ${readiness.error.code}: ${readiness.error.message}`
        await requestCraftUiHost({ ...readyManifest, command: 'app.shutdown', timeoutMs: CRAFT_UI_SHUTDOWN_REQUEST_TIMEOUT_MS }).catch(() => undefined)
        const failed = await failCraftUiStart(runDir, 'app-readiness', error, [child.pid, endpoint.pid])
        throw new CraftUiStartError(error, failed)
      }
      readyManifest = updateRunManifest(runDir, { lastResponseSeq: readiness.seq, lastRevision: readiness.revision, verificationLevel: readiness.verificationLevel })
      const semanticReadyTimeoutMs = Math.max(1, deadline - Date.now())
      const semanticReadiness = await requestCraftUiHost({
        ...readyManifest,
        command: 'ui.wait',
        params: { predicate: { kind: 'semantic-ready' }, stableForMs: 50, timeoutMs: semanticReadyTimeoutMs },
        timeoutMs: semanticReadyTimeoutMs,
        minimumSeqExclusive: readyManifest.lastResponseSeq,
      }).catch(error => ({ ok: false as const, error: { code: 'NOT_READY', message: error instanceof Error ? error.message : String(error) } }))
      if (!semanticReadiness.ok) {
        const error = `Application state became ready but its semantic UI did not: ${semanticReadiness.error.code}: ${semanticReadiness.error.message}`
        await requestCraftUiHost({ ...readyManifest, command: 'app.shutdown', timeoutMs: CRAFT_UI_SHUTDOWN_REQUEST_TIMEOUT_MS }).catch(() => undefined)
        const failed = await failCraftUiStart(runDir, 'semantic-readiness', error, [child.pid, endpoint.pid])
        throw new CraftUiStartError(error, failed)
      }
      readyManifest = updateRunManifest(runDir, {
        status: 'ready',
        lastResponseSeq: semanticReadiness.seq,
        lastRevision: semanticReadiness.revision,
        verificationLevel: semanticReadiness.verificationLevel,
      })
      if (args.scenario) {
        const applied = await requestCraftUiHost({
          ...readyManifest,
          command: 'scenario.apply',
          params: args.scenario,
          timeoutMs: waitMs,
          minimumSeqExclusive: readyManifest.lastResponseSeq,
        })
        updateRunManifest(runDir, { lastResponseSeq: applied.seq, lastRevision: applied.revision, verificationLevel: applied.verificationLevel })
        if (!applied.ok) {
          const error = `Initial scenario failed: ${applied.error.code}: ${applied.error.message}`
          await requestCraftUiHost({ ...readyManifest, command: 'app.shutdown', timeoutMs: CRAFT_UI_SHUTDOWN_REQUEST_TIMEOUT_MS }).catch(() => undefined)
          const failed = await failCraftUiStart(runDir, 'initial-scenario', error, [child.pid, endpoint.pid])
          throw new CraftUiStartError(error, failed)
        }
      }
      return readRunManifest(runDir)
    }
    if (!isPidAlive(child.pid)) {
      const error = `Craft UI host exited before becoming ready. See ${stderrPath}`
      const failed = await failCraftUiStart(runDir, 'endpoint', error, [child.pid])
      throw new CraftUiStartError(error, failed)
    }
    await Bun.sleep(100)
  }
  const error = `Timed out waiting for Craft UI host endpoint after ${waitMs}ms`
  const failed = await failCraftUiStart(runDir, 'endpoint', error, [child.pid])
  throw new CraftUiStartError(error, failed)
}

export async function getCraftUiRunStatus(runDir: string): Promise<Record<string, unknown>> {
  let manifest = readRunManifest(runDir)
  if (existsSync(manifest.endpointManifestPath)) {
    try {
      const endpoint = readEndpointManifest(manifest.endpointManifestPath)
      if (endpoint.runId === manifest.runId && endpoint.surface === manifest.surface && isPidAlive(endpoint.pid) && endpoint.pid !== manifest.hostPid) {
        manifest = updateRunManifest(runDir, { hostPid: endpoint.pid })
      }
    } catch {
      // A partially written or stale endpoint is reported through host status below.
    }
  }
  const processAlive = isPidAlive(manifest.hostPid) || isPidAlive(manifest.launcherPid)
  let host: unknown
  if (existsSync(manifest.endpointManifestPath) && isPidAlive(manifest.hostPid)) {
    try {
      const endpoint = readEndpointManifest(manifest.endpointManifestPath)
      if (endpoint.pid !== manifest.hostPid || endpoint.surface !== manifest.surface) throw new Error('Host endpoint identity changed')
      const driver = createCraftUiSurfaceDriver({ ...manifest, timeoutMs: UI_VALIDATION_DEFAULT_TIMEOUT_MS, minimumSeqExclusive: manifest.lastResponseSeq })
      host = await driver.ready()
      const response = host as CraftUiResponse
      manifest = updateRunManifest(runDir, {
        lastResponseSeq: response.seq,
        lastRevision: response.revision,
        verificationLevel: response.verificationLevel,
      })
      if ((host as { ok?: boolean }).ok && manifest.status === 'starting') manifest = updateRunManifest(runDir, { status: 'ready' })
    }
    catch (error) { host = { ok: false, error: error instanceof Error ? error.message : String(error) } }
  } else if (!processAlive && (manifest.status === 'starting' || manifest.status === 'ready')) {
    manifest = updateRunManifest(runDir, { status: 'failed', error: 'Craft UI host process is no longer running' })
  }
  return { manifest, processAlive, host }
}

export async function recordCraftUiStartFailure(
  runDir: string,
  phase: CraftUiStartupPhase,
  message: string,
): Promise<CraftUiRunManifest> {
  const manifest = readRunManifest(runDir)
  return await failCraftUiStart(runDir, phase, message, [manifest.launcherPid, manifest.hostPid])
}

export async function stopCraftUiRunDetailed(runDir: string): Promise<{ manifest: CraftUiRunManifest; response?: CraftUiResponse }> {
  const original = readRunManifest(runDir)
  if (original.status === 'stopped') return { manifest: original }
  let manifest = updateRunManifest(runDir, { status: 'stopping' })
  let shutdownResponse: CraftUiResponse | undefined
  if (existsSync(manifest.endpointManifestPath) && isPidAlive(manifest.hostPid)) {
    const driver = createCraftUiSurfaceDriver({ ...manifest, timeoutMs: CRAFT_UI_SHUTDOWN_REQUEST_TIMEOUT_MS, minimumSeqExclusive: manifest.lastResponseSeq })
    const response = await driver.dispose().catch(() => undefined)
    if (response) {
      shutdownResponse = response
      manifest = updateRunManifest(runDir, {
        lastResponseSeq: response.seq,
        lastRevision: response.revision,
        verificationLevel: response.verificationLevel,
      })
    }
  }
  const deadline = Date.now() + CRAFT_UI_SHUTDOWN_GRACE_PERIOD_MS
  while (isPidAlive(manifest.hostPid) && Date.now() < deadline) await Bun.sleep(100)
  const ownedPids = original.status === 'failed' && original.failure?.cleanup.remainingPids.length === 0
    ? []
    : uniquePids([manifest.launcherPid, manifest.hostPid])
  const remainingPids = await terminateOwnedProcessTrees(ownedPids)
  if (remainingPids.length > 0) {
    return {
      manifest: updateRunManifest(runDir, {
        status: 'failed',
        error: `Craft UI process tree did not stop: ${remainingPids.join(', ')}`,
      }),
      response: shutdownResponse,
    }
  }
  let cleanupError: string | undefined
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(manifest.profileDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 })
      cleanupError = undefined
      break
    } catch (error) {
      cleanupError = error instanceof Error ? error.message : String(error)
      if (attempt < 4) await Bun.sleep(100 * (attempt + 1))
    }
  }
  manifest = updateRunManifest(runDir, {
    status: 'stopped',
    ...(cleanupError ? { cleanupError } : { profileCleanedAt: new Date().toISOString(), cleanupError: undefined }),
  })
  return { manifest, response: shutdownResponse }
}

export async function stopCraftUiRun(runDir: string): Promise<CraftUiRunManifest> {
  return (await stopCraftUiRunDetailed(runDir)).manifest
}

async function failCraftUiStart(
  runDir: string,
  phase: CraftUiStartupPhase,
  message: string,
  pids: Array<number | undefined>,
): Promise<CraftUiRunManifest> {
  updateRunManifest(runDir, { status: 'failed', error: message })
  const cleanup = await terminateAndCleanFailedRun(runDir, pids)
  const current = readRunManifest(runDir)
  const failure: CraftUiFailureDiagnostics = {
    phase,
    message,
    stderrTail: readLogTail(current.stderrPath),
    paths: {
      runManifest: join(runDir, 'run.json'),
      stdout: current.stdoutPath,
      stderr: current.stderrPath,
      artifacts: current.artifactsDir,
    },
    cleanup,
  }
  return updateRunManifest(runDir, { failure })
}

async function terminateAndCleanFailedRun(
  runDir: string,
  pids: Array<number | undefined>,
): Promise<CraftUiFailureDiagnostics['cleanup']> {
  const ownedPids = uniquePids(pids)
  const remainingPids = await terminateOwnedProcessTrees(ownedPids)
  const manifest = readRunManifest(runDir)
  let cleanupError: string | undefined
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(manifest.profileDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 })
      cleanupError = undefined
      break
    } catch (error) {
      cleanupError = error instanceof Error ? error.message : String(error)
      if (attempt < 4) await Bun.sleep(100 * (attempt + 1))
    }
  }
  updateRunManifest(runDir, cleanupError
    ? { cleanupError }
    : { profileCleanedAt: new Date().toISOString(), cleanupError: undefined })
  return {
    attempted: ownedPids.length > 0 || existsSync(manifest.profileDir),
    remainingPids,
    profileRemoved: !existsSync(manifest.profileDir),
    ...(cleanupError ? { error: cleanupError } : {}),
  }
}

function uniquePids(pids: Array<number | undefined>): number[] {
  return [...new Set(pids.filter((pid): pid is number => Number.isInteger(pid) && pid! > 0 && pid !== process.pid))]
}

async function terminateOwnedProcessTrees(pids: Array<number | undefined>): Promise<number[]> {
  const roots = uniquePids(pids)
  if (process.platform === 'win32') {
    for (const pid of roots) {
      if (!isPidAlive(pid)) continue
      spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    }
  } else {
    for (const pid of roots) {
      if (!isPidAlive(pid)) continue
      try { process.kill(-pid, 'SIGTERM') } catch {
        try { process.kill(pid, 'SIGTERM') } catch { /* already stopped */ }
      }
    }
  }

  let deadline = Date.now() + CRAFT_UI_FORCED_STOP_GRACE_PERIOD_MS
  while (roots.some(isPidAlive) && Date.now() < deadline) await Bun.sleep(100)
  if (process.platform !== 'win32') {
    for (const pid of roots) {
      if (!isPidAlive(pid)) continue
      try { process.kill(-pid, 'SIGKILL') } catch {
        try { process.kill(pid, 'SIGKILL') } catch { /* already stopped */ }
      }
    }
    deadline = Date.now() + CRAFT_UI_FORCED_STOP_GRACE_PERIOD_MS
    while (roots.some(isPidAlive) && Date.now() < deadline) await Bun.sleep(100)
  }
  return roots.filter(isPidAlive)
}

function readLogTail(path: string): string {
  try {
    const bytes = readFileSync(path)
    return redactText(bytes.subarray(Math.max(0, bytes.length - CRAFT_UI_DIAGNOSTIC_TAIL_BYTES)).toString('utf8'))
  } catch (error) {
    return `stderr unavailable: ${error instanceof Error ? error.message : String(error)}`
  }
}
