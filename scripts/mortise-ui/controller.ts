import { randomBytes } from 'node:crypto'
import { closeSync, existsSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { UI_VALIDATION_DEFAULT_TIMEOUT_MS, UI_VALIDATION_MAX_WAIT_MS } from '@mortise/shared/ui-validation'
import { MORTISE_UI_PROTOCOL_VERSION, type MortiseUiFailureDiagnostics, type MortiseUiHistoryEntry, type MortiseUiProfileMode, type MortiseUiResponse, type MortiseUiRunManifest, type MortiseUiStartupPhase, type MortiseUiSurface, type MortiseUiWindowMode } from './protocol.ts'
import { ensureDir, writeJsonAtomic } from './files.ts'
import type { MortiseUiFixtureSpec } from './fixture.ts'
import { redactText } from './redaction.ts'
import { createMortiseUiSurfaceDriver, readEndpointManifest, requestMortiseUiHost } from './client.ts'
import { withFileLock } from './artifacts.ts'
import { getProcessStartTime, isProcessAlive, matchesProcessIdentity, type MortiseUiProcessIdentity } from './process-identity.ts'

export const DEFAULT_MORTISE_UI_RUN_ROOT = resolve(process.env.MORTISE_UI_RUN_ROOT ?? join(process.cwd(), 'output', 'mortise-ui'))
export const DEFAULT_MORTISE_UI_START_WAIT_MS = 600_000
const MORTISE_UI_RUN_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/
const MORTISE_UI_SHUTDOWN_REQUEST_TIMEOUT_MS = 30_000
const MORTISE_UI_SHUTDOWN_GRACE_PERIOD_MS = 30_000
const MORTISE_UI_FORCED_STOP_GRACE_PERIOD_MS = 10_000
const MORTISE_UI_DIAGNOSTIC_TAIL_BYTES = 16_000
const MORTISE_UI_HISTORY_LIMIT = 50

export class MortiseUiStartError extends Error {
  constructor(message: string, readonly manifest: MortiseUiRunManifest) {
    super(message)
    this.name = 'MortiseUiStartError'
  }
}

export function getDefaultAdapterCommand(surface: MortiseUiSurface): string[] {
  if (surface === 'webui') return [
    process.env.MORTISE_UI_NODE_EXECUTABLE || 'node',
    '--import', './scripts/mortise-ui/register-ts-loader.mjs',
    './scripts/mortise-ui/web-adapter.ts',
  ]
  const developerHost = resolveDeveloperHostExecutable()
  if (developerHost) return [developerHost]
  return [process.execPath, resolve(process.cwd(), 'scripts', 'mortise-ui', 'electron-adapter.ts')]
}

function resolveDeveloperHostExecutable(): string | null {
  const configured = process.env.MORTISE_DEV_HOST_PATH?.trim()
  if (configured) {
    const absolute = resolve(configured)
    if (!existsSync(absolute)) throw new Error(`MORTISE_DEV_HOST_PATH does not exist: ${absolute}`)
    return absolute
  }

  const kitRoot = resolve(dirname(process.execPath), '..')
  const candidates = process.platform === 'win32'
    ? [join(kitRoot, 'dev-host', 'Mortise Developer Host.exe')]
    : process.platform === 'darwin'
      ? [join(kitRoot, 'dev-host', 'Mortise Developer Host.app', 'Contents', 'MacOS', 'Mortise Developer Host')]
      : [join(kitRoot, 'dev-host', 'mortise-developer-host')]
  return candidates.find(existsSync) ?? null
}

function makeRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')
  return `${stamp}-${randomBytes(4).toString('hex')}`
}

function validateRunLabel(label: string | undefined): string | undefined {
  if (label === undefined) return undefined
  if (!MORTISE_UI_RUN_LABEL_PATTERN.test(label)) {
    throw new Error('Run label must be 1-64 lowercase characters using letters, numbers, ".", "_", or "-", and must start and end with a letter or number')
  }
  return label
}

function isActiveRun(run: MortiseUiRunManifest): boolean {
  return (run.status === 'starting' || run.status === 'ready' || run.status === 'stopping')
    && (hostAlive(run) || launcherAlive(run))
}

export function isMortiseUiRunProcessAlive(run: MortiseUiRunManifest): boolean {
  return hostAlive(run) || launcherAlive(run)
}

export function listMortiseUiRuns(root = DEFAULT_MORTISE_UI_RUN_ROOT): MortiseUiRunManifest[] {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(root, entry.name, 'run.json')))
    .map(entry => readRunManifest(join(root, entry.name)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function readRunManifest(runDir: string): MortiseUiRunManifest {
  return JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')) as MortiseUiRunManifest
}

export function updateRunManifest(runDir: string, patch: Partial<MortiseUiRunManifest>): MortiseUiRunManifest {
  const path = join(runDir, 'run.json')
  return withFileLock(path, () => {
    const current = readRunManifest(runDir)
    const manifest = {
      ...current,
      ...patch,
      ...(patch.lastResponseSeq === undefined ? {} : { lastResponseSeq: Math.max(current.lastResponseSeq ?? 0, patch.lastResponseSeq) }),
      ...(patch.lastRevision === undefined ? {} : { lastRevision: Math.max(current.lastRevision ?? 0, patch.lastRevision) }),
      updatedAt: new Date().toISOString(),
    }
    writeJsonAtomic(path, manifest)
    return manifest
  })
}

export function appendRunHistory(runDir: string, entry: MortiseUiHistoryEntry): MortiseUiRunManifest {
  const path = join(runDir, 'run.json')
  return withFileLock(path, () => {
    const current = readRunManifest(runDir)
    const manifest = {
      ...current,
      history: [...(current.history ?? []), entry].slice(-MORTISE_UI_HISTORY_LIMIT),
      updatedAt: new Date().toISOString(),
    }
    writeJsonAtomic(path, manifest)
    return manifest
  })
}

export function pruneMortiseUiRuns(args: {
  runRoot?: string
  olderThanHours?: number
  keep?: number
  apply?: boolean
} = {}): {
  applied: boolean
  protectedRunIds: string[]
  candidateRunIds: string[]
  removedRunIds: string[]
  reclaimedBytes: number
} {
  const runRoot = resolve(args.runRoot ?? DEFAULT_MORTISE_UI_RUN_ROOT)
  const olderThanHours = Number.isFinite(args.olderThanHours) && args.olderThanHours! >= 0 ? args.olderThanHours! : 168
  const keep = Number.isSafeInteger(args.keep) && args.keep! >= 0 ? args.keep! : 20
  const threshold = Date.now() - olderThanHours * 60 * 60 * 1_000
  const runs = listMortiseUiRuns(runRoot)
  const protectedRunIds = runs.filter(isActiveRun).map(run => run.runId)
  const inactive = runs.filter(run => !isActiveRun(run))
  const candidates = inactive.filter((run, index) => index >= keep && Date.parse(run.updatedAt || run.createdAt) <= threshold)
  const candidateRunIds = candidates.map(run => run.runId)
  let reclaimedBytes = 0
  const removedRunIds: string[] = []
  if (args.apply) {
    for (const run of candidates) {
      reclaimedBytes += directoryBytes(run.runDir)
      rmSync(run.runDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      if (!existsSync(run.runDir)) removedRunIds.push(run.runId)
    }
  }
  return { applied: args.apply === true, protectedRunIds, candidateRunIds, removedRunIds, reclaimedBytes }
}

export function resolveRunDir(runRoot = DEFAULT_MORTISE_UI_RUN_ROOT, runSelector?: string): string {
  const root = resolve(runRoot)
  if (runSelector) {
    const candidate = resolve(root, runSelector)
    if (!candidate.startsWith(`${root}\\`) && !candidate.startsWith(`${root}/`)) throw new Error('Run ID escapes the run root')
    if (existsSync(join(candidate, 'run.json'))) return candidate
    const matches = listMortiseUiRuns(root).filter(run => run.label === runSelector)
    if (matches.length === 1) return matches[0]!.runDir
    if (matches.length > 1) {
      const active = matches.filter(isActiveRun)
      if (active.length === 1) return active[0]!.runDir
      const candidates = (active.length > 1 ? active : matches).map(run => run.runId).join(', ')
      throw new Error(`Mortise UI run label is ambiguous: ${runSelector}; use a full run ID: ${candidates}`)
    }
    throw new Error(`Mortise UI run not found: ${runSelector}`)
  }
  if (!existsSync(root)) throw new Error('No Mortise UI runs exist')
  const runs = listMortiseUiRuns(root)
  const active = runs.filter(isActiveRun)
  if (active.length === 1) return active[0]!.runDir
  if (active.length > 1) throw new Error('More than one active Mortise UI run exists; provide --run explicitly')
  if (runs.length > 0) throw new Error('No active Mortise UI run exists; provide --run to inspect a stopped or failed run')
  throw new Error('No Mortise UI runs exist')
}

export async function startMortiseUiRun(args: {
  surface: MortiseUiSurface
  label?: string
  profileMode?: MortiseUiProfileMode
  windowMode?: MortiseUiWindowMode
  adapterCommand?: string[]
  runRoot?: string
  sourceMortiseConfigDir?: string
  sourcePiAgentDir?: string
  waitMs?: number
  waitForReady?: boolean
  extraEnv?: Record<string, string>
  scenario?: Record<string, unknown>
  fixtureSpec?: MortiseUiFixtureSpec
  extensionPaths?: string[]
}): Promise<MortiseUiRunManifest> {
  if (args.profileMode === 'clone' && (!args.sourceMortiseConfigDir || !args.sourcePiAgentDir)) {
    throw new Error('clone profile requires explicit sourceMortiseConfigDir and sourcePiAgentDir paths')
  }
  if (args.fixtureSpec && args.profileMode !== undefined && args.profileMode !== 'fixture') {
    throw new Error('fixtureSpec requires the fixture profile mode')
  }
  const waitMs = args.waitMs ?? DEFAULT_MORTISE_UI_START_WAIT_MS
  if (!Number.isSafeInteger(waitMs) || waitMs < 1 || waitMs > UI_VALIDATION_MAX_WAIT_MS) {
    throw new Error(`waitMs must be between 1 and ${UI_VALIDATION_MAX_WAIT_MS}`)
  }
  const adapterCommand = args.adapterCommand ?? getDefaultAdapterCommand(args.surface)
  if (adapterCommand.length === 0 || !adapterCommand[0]) throw new Error('An adapter command is required')
  const label = validateRunLabel(args.label)
  const runId = makeRunId()
  const runDir = join(resolve(args.runRoot ?? DEFAULT_MORTISE_UI_RUN_ROOT), runId)
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
    protocolVersion: MORTISE_UI_PROTOCOL_VERSION, runId, updatedAt: new Date().toISOString(), artifacts: [],
  })
  let manifest: MortiseUiRunManifest = {
    protocolVersion: MORTISE_UI_PROTOCOL_VERSION,
    runId,
    ...(label ? { label } : {}),
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
      sourceMortiseConfigDir: args.sourceMortiseConfigDir,
      sourcePiAgentDir: args.sourcePiAgentDir,
      fixtureSpec: args.fixtureSpec,
      extensionPaths: args.extensionPaths,
    })
    manifest = updateRunManifest(runDir, {
      profileMode: profile.mode,
      containsClonedUserData: profile.containsClonedUserData,
      fixture: profile.fixture,
      mountedExtensions: profile.mountedExtensions,
    })
  } catch (error) {
    const message = `Failed to prepare Mortise UI profile: ${error instanceof Error ? error.message : String(error)}`
    const failed = await failMortiseUiStart(runDir, 'profile', message, [])
    throw new MortiseUiStartError(message, failed)
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
        MORTISE_CONFIG_DIR: profile.mortiseConfigDir,
        PI_CODING_AGENT_DIR: profile.piAgentDir,
        MORTISE_UI_RUN_ID: runId,
        MORTISE_UI_SURFACE: args.surface,
        MORTISE_UI_RUN_DIR: runDir,
        MORTISE_UI_PROFILE_DIR: profileDir,
        MORTISE_UI_ARTIFACTS_DIR: artifactsDir,
        MORTISE_UI_ENDPOINT_MANIFEST: endpointManifestPath,
        MORTISE_UI_TOKEN: token,
        MORTISE_UI_PROTOCOL_VERSION: String(MORTISE_UI_PROTOCOL_VERSION),
        MORTISE_UI_ELECTRON_USER_DATA_DIR: profile.electronUserDataDir,
        MORTISE_UI_WINDOW_MODE: windowMode,
        MORTISE_UI_VALIDATION_BUILD: '1',
        MORTISE_UI_TEST_HOST: '1',
      },
    })
  } catch (error) {
    const message = `Failed to start Mortise UI host: ${error instanceof Error ? error.message : String(error)}`
    const failed = await failMortiseUiStart(runDir, 'spawn', message, [])
    throw new MortiseUiStartError(message, failed)
  } finally {
    closeSync(stdoutFd)
    closeSync(stderrFd)
  }
  const spawnError = await new Promise<Error | undefined>((resolveSpawn) => {
    child.once('spawn', () => resolveSpawn(undefined))
    child.once('error', error => resolveSpawn(error))
  })
  if (spawnError) {
    const message = `Failed to start Mortise UI host: ${spawnError.message}`
    const failed = await failMortiseUiStart(runDir, 'spawn', message, [child.pid])
    throw new MortiseUiStartError(message, failed)
  }
  child.unref()
  const launcherStartedAt = Date.now()
  updateRunManifest(runDir, { launcherPid: child.pid, launcherStartedAt })
  if (args.waitForReady === false) return readRunManifest(runDir)

  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    if (existsSync(endpointManifestPath)) {
      const endpoint = readEndpointManifest(endpointManifestPath)
      const currentManifest = readRunManifest(runDir)
      if (
        endpoint.runId !== runId
        || endpoint.surface !== args.surface
        || !isProcessAlive(endpoint.pid)
        || (currentManifest.buildId !== undefined && endpoint.buildId !== currentManifest.buildId)
      ) {
        const error = 'Host endpoint manifest identity does not match the controller run'
        const failed = await failMortiseUiStart(runDir, 'endpoint', error, [child.pid, endpoint.pid])
        throw new MortiseUiStartError(error, failed)
      }
      let readyManifest = updateRunManifest(runDir, {
        launcherPid: child.pid,
        launcherStartedAt,
        hostPid: endpoint.pid,
        hostStartedAt: endpoint.pid === child.pid ? launcherStartedAt : getProcessStartTime(endpoint.pid),
      })
      const appReadyTimeoutMs = Math.max(1, deadline - Date.now())
      const readiness = await requestMortiseUiHost({
        ...readyManifest,
        command: 'ui.wait',
        params: { predicate: { kind: 'app-phase', phase: 'ready' }, stableForMs: 50, timeoutMs: appReadyTimeoutMs },
        timeoutMs: appReadyTimeoutMs,
        minimumSeqExclusive: readyManifest.lastResponseSeq,
      }).catch(error => ({ ok: false as const, error: { code: 'NOT_READY', message: error instanceof Error ? error.message : String(error) } }))
      if (!readiness.ok) {
        const error = `Host endpoint opened but the application did not become ready: ${readiness.error.code}: ${readiness.error.message}`
        await requestMortiseUiHost({ ...readyManifest, command: 'app.shutdown', timeoutMs: MORTISE_UI_SHUTDOWN_REQUEST_TIMEOUT_MS }).catch(() => undefined)
        const failed = await failMortiseUiStart(runDir, 'app-readiness', error, [child.pid, endpoint.pid])
        throw new MortiseUiStartError(error, failed)
      }
      readyManifest = updateRunManifest(runDir, { lastResponseSeq: readiness.seq, lastRevision: readiness.revision, verificationLevel: readiness.verificationLevel })
      const semanticReadyTimeoutMs = Math.max(1, deadline - Date.now())
      const semanticReadiness = await requestMortiseUiHost({
        ...readyManifest,
        command: 'ui.wait',
        params: { predicate: { kind: 'semantic-ready' }, stableForMs: 50, timeoutMs: semanticReadyTimeoutMs },
        timeoutMs: semanticReadyTimeoutMs,
        minimumSeqExclusive: readyManifest.lastResponseSeq,
      }).catch(error => ({ ok: false as const, error: { code: 'NOT_READY', message: error instanceof Error ? error.message : String(error) } }))
      if (!semanticReadiness.ok) {
        const error = `Application state became ready but its semantic UI did not: ${semanticReadiness.error.code}: ${semanticReadiness.error.message}`
        await requestMortiseUiHost({ ...readyManifest, command: 'app.shutdown', timeoutMs: MORTISE_UI_SHUTDOWN_REQUEST_TIMEOUT_MS }).catch(() => undefined)
        const failed = await failMortiseUiStart(runDir, 'semantic-readiness', error, [child.pid, endpoint.pid])
        throw new MortiseUiStartError(error, failed)
      }
      readyManifest = updateRunManifest(runDir, {
        status: 'ready',
        lastResponseSeq: semanticReadiness.seq,
        lastRevision: semanticReadiness.revision,
        verificationLevel: semanticReadiness.verificationLevel,
      })
      if (args.scenario) {
        const applied = await requestMortiseUiHost({
          ...readyManifest,
          command: 'scenario.apply',
          params: args.scenario,
          timeoutMs: waitMs,
          minimumSeqExclusive: readyManifest.lastResponseSeq,
        })
        updateRunManifest(runDir, { lastResponseSeq: applied.seq, lastRevision: applied.revision, verificationLevel: applied.verificationLevel })
        if (!applied.ok) {
          const error = `Initial scenario failed: ${applied.error.code}: ${applied.error.message}`
          await requestMortiseUiHost({ ...readyManifest, command: 'app.shutdown', timeoutMs: MORTISE_UI_SHUTDOWN_REQUEST_TIMEOUT_MS }).catch(() => undefined)
          const failed = await failMortiseUiStart(runDir, 'initial-scenario', error, [child.pid, endpoint.pid])
          throw new MortiseUiStartError(error, failed)
        }
      }
      return readRunManifest(runDir)
    }
    if (!isProcessAlive(child.pid)) {
      const latestManifest = readRunManifest(runDir)
      const phase: MortiseUiStartupPhase = latestManifest.buildError ? 'build' : 'endpoint'
      const error = latestManifest.buildError
        ? `Mortise UI build failed: ${latestManifest.buildError}`
        : `Mortise UI host exited before becoming ready. See ${stderrPath}`
      const failed = await failMortiseUiStart(runDir, phase, error, [child.pid])
      throw new MortiseUiStartError(error, failed)
    }
    await Bun.sleep(100)
  }
  const error = `Timed out waiting for Mortise UI host endpoint after ${waitMs}ms`
  const failed = await failMortiseUiStart(runDir, 'endpoint', error, [child.pid])
  throw new MortiseUiStartError(error, failed)
}

export async function getMortiseUiRunStatus(runDir: string): Promise<Record<string, unknown>> {
  let manifest = readRunManifest(runDir)
  if (existsSync(manifest.endpointManifestPath)) {
    try {
      const endpoint = readEndpointManifest(manifest.endpointManifestPath)
      if (endpoint.runId === manifest.runId && endpoint.surface === manifest.surface && isProcessAlive(endpoint.pid) && endpoint.pid !== manifest.hostPid) {
        manifest = updateRunManifest(runDir, { hostPid: endpoint.pid, hostStartedAt: getProcessStartTime(endpoint.pid) })
      }
    } catch {
      // A partially written or stale endpoint is reported through host status below.
    }
  }
  const processAlive = hostAlive(manifest) || launcherAlive(manifest)
  let host: unknown
  if (existsSync(manifest.endpointManifestPath) && hostAlive(manifest)) {
    try {
      const endpoint = readEndpointManifest(manifest.endpointManifestPath)
      if (endpoint.pid !== manifest.hostPid || endpoint.surface !== manifest.surface) throw new Error('Host endpoint identity changed')
      const driver = createMortiseUiSurfaceDriver({ ...manifest, timeoutMs: UI_VALIDATION_DEFAULT_TIMEOUT_MS, minimumSeqExclusive: manifest.lastResponseSeq })
      host = await driver.ready()
      const response = host as MortiseUiResponse
      manifest = updateRunManifest(runDir, {
        lastResponseSeq: response.seq,
        lastRevision: response.revision,
        verificationLevel: response.verificationLevel,
      })
      if ((host as { ok?: boolean }).ok && manifest.status === 'starting') manifest = updateRunManifest(runDir, { status: 'ready' })
    }
    catch (error) { host = { ok: false, error: error instanceof Error ? error.message : String(error) } }
  } else if (!processAlive && (manifest.status === 'starting' || manifest.status === 'ready')) {
    manifest = updateRunManifest(runDir, { status: 'failed', error: 'Mortise UI host process is no longer running' })
  }
  return { manifest, processAlive, host }
}

export async function recordMortiseUiStartFailure(
  runDir: string,
  phase: MortiseUiStartupPhase,
  message: string,
): Promise<MortiseUiRunManifest> {
  const manifest = readRunManifest(runDir)
  return await failMortiseUiStart(runDir, phase, message, [manifest.launcherPid, manifest.hostPid])
}

export async function stopMortiseUiRunDetailed(runDir: string): Promise<{ manifest: MortiseUiRunManifest; response?: MortiseUiResponse }> {
  const original = readRunManifest(runDir)
  if (original.status === 'stopped' && !original.cleanupError && !existsSync(original.profileDir)) return { manifest: original }
  let manifest = updateRunManifest(runDir, { status: 'stopping' })
  let shutdownResponse: MortiseUiResponse | undefined
  if (existsSync(manifest.endpointManifestPath) && hostAlive(manifest)) {
    const driver = createMortiseUiSurfaceDriver({ ...manifest, timeoutMs: MORTISE_UI_SHUTDOWN_REQUEST_TIMEOUT_MS, minimumSeqExclusive: manifest.lastResponseSeq })
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
  const deadline = Date.now() + MORTISE_UI_SHUTDOWN_GRACE_PERIOD_MS
  while (hostAlive(manifest) && Date.now() < deadline) await Bun.sleep(100)
  const ownedProcesses = original.status === 'failed' && original.failure?.cleanup.remainingPids.length === 0
    ? []
    : processIdentities(manifest)
  const remainingPids = await terminateOwnedProcessTrees(ownedProcesses)
  if (remainingPids.length > 0) {
    return {
      manifest: updateRunManifest(runDir, {
        status: 'failed',
        error: `Mortise UI process tree did not stop: ${remainingPids.join(', ')}`,
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
  manifest = updateRunManifest(runDir, cleanupError
    ? { status: 'failed', cleanupError, error: `Mortise UI profile cleanup failed: ${cleanupError}` }
    : { status: 'stopped', profileCleanedAt: new Date().toISOString(), cleanupError: undefined })
  return { manifest, response: shutdownResponse }
}

export async function stopMortiseUiRun(runDir: string): Promise<MortiseUiRunManifest> {
  return (await stopMortiseUiRunDetailed(runDir)).manifest
}

async function failMortiseUiStart(
  runDir: string,
  phase: MortiseUiStartupPhase,
  message: string,
  pids: Array<number | undefined>,
): Promise<MortiseUiRunManifest> {
  updateRunManifest(runDir, { status: 'failed', error: message })
  const cleanup = await terminateAndCleanFailedRun(runDir, pids)
  const current = readRunManifest(runDir)
  const failure: MortiseUiFailureDiagnostics = {
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
): Promise<MortiseUiFailureDiagnostics['cleanup']> {
  const manifest = readRunManifest(runDir)
  const identities = pids.map(pid => identityForPid(manifest, pid)).filter((value): value is MortiseUiProcessIdentity => !!value)
  const remainingPids = await terminateOwnedProcessTrees(identities)
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
    attempted: identities.length > 0 || existsSync(manifest.profileDir),
    remainingPids,
    profileRemoved: !existsSync(manifest.profileDir),
    ...(cleanupError ? { error: cleanupError } : {}),
  }
}

async function terminateOwnedProcessTrees(processes: MortiseUiProcessIdentity[]): Promise<number[]> {
  const identities = uniqueProcessIdentities(processes)
  const roots = identities.filter(matchesProcessIdentity).map(identity => identity.pid!)
  if (process.platform === 'win32') {
    for (const pid of roots) {
      if (!matchesProcessIdentity(identities.find(identity => identity.pid === pid)!)) continue
      spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    }
  } else {
    for (const pid of roots) {
      if (!matchesProcessIdentity(identities.find(identity => identity.pid === pid)!)) continue
      try { process.kill(-pid, 'SIGTERM') } catch {
        try { process.kill(pid, 'SIGTERM') } catch { /* already stopped */ }
      }
    }
  }

  let deadline = Date.now() + MORTISE_UI_FORCED_STOP_GRACE_PERIOD_MS
  while (identities.some(matchesProcessIdentity) && Date.now() < deadline) await Bun.sleep(100)
  if (process.platform !== 'win32') {
    for (const pid of roots) {
      if (!matchesProcessIdentity(identities.find(identity => identity.pid === pid)!)) continue
      try { process.kill(-pid, 'SIGKILL') } catch {
        try { process.kill(pid, 'SIGKILL') } catch { /* already stopped */ }
      }
    }
    deadline = Date.now() + MORTISE_UI_FORCED_STOP_GRACE_PERIOD_MS
    while (identities.some(matchesProcessIdentity) && Date.now() < deadline) await Bun.sleep(100)
  }
  return identities.filter(matchesProcessIdentity).map(identity => identity.pid!)
}

function launcherAlive(manifest: MortiseUiRunManifest): boolean {
  return matchesProcessIdentity({
    pid: manifest.launcherPid,
    startedAt: manifest.launcherStartedAt,
    recordedAt: Date.parse(manifest.createdAt),
  })
}

function hostAlive(manifest: MortiseUiRunManifest): boolean {
  return matchesProcessIdentity({
    pid: manifest.hostPid,
    startedAt: manifest.hostStartedAt,
    recordedAt: Date.parse(manifest.createdAt),
  })
}

function processIdentities(manifest: MortiseUiRunManifest): MortiseUiProcessIdentity[] {
  return [
    { pid: manifest.launcherPid, startedAt: manifest.launcherStartedAt, recordedAt: Date.parse(manifest.createdAt) },
    { pid: manifest.hostPid, startedAt: manifest.hostStartedAt, recordedAt: Date.parse(manifest.createdAt) },
  ]
}

function identityForPid(manifest: MortiseUiRunManifest, pid: number | undefined): MortiseUiProcessIdentity | undefined {
  if (!pid) return undefined
  if (pid === manifest.launcherPid) return { pid, startedAt: manifest.launcherStartedAt, recordedAt: Date.parse(manifest.createdAt) }
  if (pid === manifest.hostPid) return { pid, startedAt: manifest.hostStartedAt, recordedAt: Date.parse(manifest.createdAt) }
  return { pid, recordedAt: Date.parse(manifest.createdAt) }
}

function uniqueProcessIdentities(processes: MortiseUiProcessIdentity[]): MortiseUiProcessIdentity[] {
  const byPid = new Map<number, MortiseUiProcessIdentity>()
  for (const identity of processes) {
    if (!identity.pid || identity.pid === process.pid) continue
    const current = byPid.get(identity.pid)
    if (!current || (current.startedAt === undefined && identity.startedAt !== undefined)) byPid.set(identity.pid, identity)
  }
  return [...byPid.values()]
}

function readLogTail(path: string): string {
  try {
    const bytes = readFileSync(path)
    return redactText(bytes.subarray(Math.max(0, bytes.length - MORTISE_UI_DIAGNOSTIC_TAIL_BYTES)).toString('utf8'))
  } catch (error) {
    return `stderr unavailable: ${error instanceof Error ? error.message : String(error)}`
  }
}

function directoryBytes(root: string): number {
  if (!existsSync(root)) return 0
  let total = 0
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) total += directoryBytes(path)
    else {
      try { total += readFileSync(path).byteLength } catch { /* Best-effort pruning estimate. */ }
    }
  }
  return total
}
