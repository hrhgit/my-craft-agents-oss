import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { chromium, type Browser, type Locator, type Page } from 'playwright-core'
import WebSocket from 'ws'
import { readEndpointManifest } from '../../mortise-ui/client.ts'
import { prepareProfile } from '../../mortise-ui/profile.ts'
import {
  acquireElectronBuild,
  createElectronBuildRuntimeEnvironment,
  releaseElectronBuild,
  resolveElectronBuildExecutable,
} from '../../build/electron-build-cache.ts'
import { getProcessStartTime } from '../../build/process-identity.ts'
import type { MortiseUiProcessIdentity } from '../../build/process-identity.ts'
import { terminateOwnedProcessTrees } from '../../mortise-ui/controller.ts'

interface RawResponse<T = unknown> {
  v: number
  kind: 'response'
  id: string
  requestId: string
  runId: string
  seq: number
  revision: number
  verificationLevel: string
  ok: boolean
  result?: T
  error?: { code: string; message: string }
}

interface SnapshotNode {
  role: string
  name: string
  state?: { checked?: boolean }
}

interface SnapshotResult {
  revision: number
  regions: Record<string, SnapshotNode[]>
}

const runRoot = await mkdtemp(join(tmpdir(), 'mortise-ui-raw-host-'))
const resultPath = resolve(process.env.MORTISE_UI_RAW_SMOKE_RESULT ?? join(process.cwd(), 'output', 'mortise-ui', 'raw-host-smoke-last.json'))
const debugPort = await reserveLoopbackPort()
const runId = `raw-${Date.now()}-${randomBytes(4).toString('hex')}`
const runDir = join(runRoot, runId)
const profileDir = join(runDir, 'profile')
const artifactsDir = join(runDir, 'artifacts')
const endpointManifestPath = join(runDir, 'endpoint.json')
const token = randomBytes(32).toString('hex')
let host: ChildProcess | undefined
let endpointUrl: string | undefined
let hostStderr = ''
let browser: Browser | undefined
let cdpTransport: CdpConnectionTransport | undefined
let rendererDiagnostic: Record<string, unknown> | undefined
let successSummary: Record<string, unknown> | undefined
let failure: unknown
let cleanupFailure: Error | undefined
let buildLease: ReturnType<typeof acquireElectronBuild> | undefined
let hostSpawned = false

try {
  await mkdir(artifactsDir, { recursive: true })
  await writeFile(join(runDir, 'run.json'), `${JSON.stringify({
    status: 'ready',
    runId,
    launcherPid: process.pid,
    createdAt: new Date().toISOString(),
  }, null, 2)}\n`, 'utf8')
  buildLease = acquireElectronBuild({
    runId,
    runDir,
    repoRoot: process.cwd(),
    mode: 'ui-validation',
  })
  const electronExecutable = resolveElectronBuildExecutable(buildLease)
  const profile = await prepareProfile({ profileDir, mode: 'isolated' })
  host = spawn(electronExecutable, [
    `--remote-debugging-port=${debugPort}`,
    '--remote-debugging-address=127.0.0.1',
    '--remote-allow-origins=*',
    `--user-data-dir=${profile.electronUserDataDir}`,
    buildLease.appDir,
  ], {
    cwd: process.cwd(),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      MORTISE_CONFIG_DIR: profile.mortiseConfigDir,
      PI_CODING_AGENT_DIR: profile.mortiseAgentDir,
      MORTISE_UI_RUN_ID: runId,
      MORTISE_UI_SURFACE: 'electron',
      MORTISE_UI_RUN_DIR: runDir,
      MORTISE_UI_PROFILE_DIR: profileDir,
      MORTISE_UI_ARTIFACTS_DIR: artifactsDir,
      MORTISE_UI_ENDPOINT_MANIFEST: endpointManifestPath,
      MORTISE_UI_TOKEN: token,
      MORTISE_UI_PROTOCOL_VERSION: '1',
      MORTISE_UI_ELECTRON_USER_DATA_DIR: profile.electronUserDataDir,
      MORTISE_UI_TEST_HOST: '1',
      ...createElectronBuildRuntimeEnvironment(buildLease, { uiValidation: true }),
    },
  })
  await waitForHostSpawn(host)
  hostSpawned = true
  const hostStartedAt = getProcessStartTime(host.pid) ?? Date.now()
  await writeFile(join(runDir, 'run.json'), `${JSON.stringify({
    status: 'ready',
    runId,
    launcherPid: process.pid,
    hostPid: host.pid,
    hostStartedAt,
    buildId: buildLease.buildId,
    sourceId: buildLease.manifest.sourceId,
    createdAt: new Date().toISOString(),
  }, null, 2)}\n`, 'utf8')
  host.stderr?.on('data', chunk => { hostStderr = boundedLog(hostStderr, String(chunk)) })
  const endpoint = await waitForHostEndpoint(
    endpointManifestPath,
    host,
    buildLease.buildId,
    buildLease.manifest.sourceId,
    90_000,
  )
  endpointUrl = endpoint.url

  const rejected = await rawHostRequest(endpoint.url, runId, 'ui.snapshot', {}, undefined)
  if (rejected.status !== 401 || rejected.body?.ok !== false) {
    throw new Error(`Test Host accepted an unauthenticated request (status ${rejected.status}).`)
  }
  assertGeneratedFailureEnvelope(rejected, runId, 'UNSUPPORTED')
  const unknownHttp = await fetch(`${endpoint.url}/not-found`, { signal: AbortSignal.timeout(30_000) })
  const unknown = { status: unknownHttp.status, body: await unknownHttp.json() as RawResponse }
  if (unknown.status !== 404) throw new Error(`Unknown Test Host endpoint returned HTTP ${unknown.status}.`)
  assertGeneratedFailureEnvelope(unknown, runId, 'TARGET_NOT_FOUND')
  const statusId = randomUUID()
  const status = await rawHostRequest(endpoint.url, runId, 'app.status', {}, token, statusId)
  assertEnvelope(status, statusId, runId)
  if (!status.body.ok) throw new Error(`Raw status request failed: ${status.body.error?.message ?? 'unknown error'}`)

  await waitForCdp(debugPort, 30_000)
  cdpTransport = await CdpConnectionTransport.connect(debugPort)
  browser = await (chromium.connectOverCDP as unknown as (
    transport: CdpConnectionTransport,
    options: { timeout: number; noDefaults: boolean },
  ) => Promise<Browser>)(cdpTransport, {
    timeout: 30_000,
    noDefaults: true,
  })
  const page = await findRendererPage(browser, 30_000)
  await page.waitForLoadState('domcontentloaded', { timeout: 30_000 })
  await page.waitForFunction(() => Boolean((window as unknown as { electronAPI?: unknown }).electronAPI), undefined, { timeout: 30_000 })

  const target = page.locator('[data-testid="onboarding-provider-api_key"]')
  const bodyBefore = await page.locator('body').innerText()
  rendererDiagnostic = { url: page.url(), title: await page.title(), targetCount: await target.count(), body: bodyBefore.slice(0, 2_000) }
  await target.waitFor({ state: 'visible', timeout: 15_000 })
  const targetName = (await target.innerText()).trim()
  await clickPhysicalRendererTarget(page, target)
  await target.waitFor({ state: 'hidden', timeout: 15_000 })

  const snapshotId = randomUUID()
  const snapshot = await rawHostRequest<SnapshotResult>(endpoint.url, runId, 'ui.snapshot', {}, token, snapshotId)
  assertEnvelope(snapshot, snapshotId, runId)
  if (!snapshot.body.ok || !snapshot.body.result) throw new Error(`Raw snapshot failed: ${snapshot.body.error?.message ?? 'missing result'}`)
  if (snapshot.body.seq <= status.body.seq) throw new Error('Test Host response seq did not increase monotonically.')
  if (!Number.isSafeInteger(snapshot.body.revision) || snapshot.body.revision < 0) throw new Error('Test Host response revision is invalid.')
  if (snapshot.body.revision < snapshot.body.result.revision) throw new Error('Envelope revision is older than its snapshot result.')
  const nodes = Object.values(snapshot.body.result.regions).flat()
  if (nodes.length === 0) throw new Error('Raw Test Host snapshot did not contain the real renderer UI.')
  if (nodes.some(node => node.name === targetName)) throw new Error('Raw Test Host snapshot still contained the onboarding target after Playwright advanced the UI.')

  successSummary = {
    ok: true,
    runId,
    debugPort,
    rendererUrl: page.url(),
    build: { buildId: buildLease.buildId, sourceId: buildLease.manifest.sourceId },
    protocol: { requestIdEchoed: true, seq: snapshot.body.seq, revision: snapshot.body.revision, unauthenticatedRejected: true, unknownEndpointRejected: true },
    physicalInput: { testId: 'onboarding-provider-api_key', name: targetName, advanced: true },
  }
} catch (error) {
  failure = error
  throw error
} finally {
  await browser?.close().catch(() => undefined)
  let hostExited = host === undefined || !hostSpawned
  if (host && hostSpawned) {
    let ownedProcesses: MortiseUiProcessIdentity[] = []
    let processTreeFailure: Error | undefined
    try {
      ownedProcesses = collectOwnedProcessTree(host.pid)
    } catch (error) {
      processTreeFailure = error instanceof Error ? error : new Error(String(error))
      ownedProcesses = host.pid
        ? [{ pid: host.pid, startedAt: getProcessStartTime(host.pid), recordedAt: Date.now() }]
        : []
    }
    if (endpointUrl && !hostHasExited(host)) {
      await rawHostRequest(endpointUrl, runId, 'app.shutdown', {}, token).catch(() => undefined)
    }
    hostExited = await waitForHostExit(host, 5_000)
    const remainingPids = await terminateOwnedProcessTrees(ownedProcesses)
    hostExited = !processTreeFailure && remainingPids.length === 0
    if (processTreeFailure) {
      cleanupFailure = new Error(
        `Electron process tree enumeration failed; descendant shutdown cannot be proven and the build lease was retained: ${processTreeFailure.message}`,
        { cause: processTreeFailure },
      )
    } else if (!hostExited) {
      cleanupFailure = new Error(`Electron process tree did not exit: ${remainingPids.join(', ')}; build lease retained.`)
    }
  }
  if (buildLease && hostExited) {
    try {
      releaseElectronBuild(buildLease)
    } catch (error) {
      cleanupFailure = error instanceof Error ? error : new Error(String(error))
    }
  }
  if (cleanupFailure) {
    failure = failure
      ? new AggregateError([failure, cleanupFailure], 'Raw Host smoke and cleanup both failed.')
      : cleanupFailure
    successSummary = undefined
  }
  if (!cleanupFailure) {
    await rm(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined)
  }
  await atomicResult(resultPath, successSummary ?? {
    ok: false,
    error: failure instanceof Error ? failure.stack ?? failure.message : String(failure ?? 'Smoke test ended without a result.'),
    ...(cdpTransport ? { cdpTranscript: cdpTransport.transcript } : {}),
    ...(rendererDiagnostic ? { rendererDiagnostic } : {}),
    ...(hostStderr ? { hostStderr: hostStderr.slice(-20_000) } : {}),
  }).catch(() => undefined)
}

function collectOwnedProcessTree(rootPid: number | undefined): MortiseUiProcessIdentity[] {
  if (!rootPid) return []
  const recordedAt = Date.now()
  if (process.platform !== 'win32') {
    return [{ pid: rootPid, startedAt: getProcessStartTime(rootPid), recordedAt }]
  }
  const result = spawnSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress',
  ], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error(`Windows process enumeration failed with exit code ${result.status ?? 'unknown'}.`)
  }
  try {
    const parsed = JSON.parse(result.stdout) as
      | { ProcessId: number; ParentProcessId: number }
      | Array<{ ProcessId: number; ParentProcessId: number }>
    const rows = Array.isArray(parsed) ? parsed : [parsed]
    const owned = new Set([rootPid])
    let changed = true
    while (changed) {
      changed = false
      for (const row of rows) {
        if (owned.has(row.ParentProcessId) && !owned.has(row.ProcessId)) {
          owned.add(row.ProcessId)
          changed = true
        }
      }
    }
    return [...owned].map(pid => ({ pid, startedAt: getProcessStartTime(pid), recordedAt }))
  } catch (error) {
    throw new Error('Windows process enumeration returned invalid JSON.', { cause: error })
  }
}

if (cleanupFailure) throw cleanupFailure
if (successSummary) process.stdout.write(`${JSON.stringify(successSummary)}\n`)

async function rawHostRequest<T>(
  url: string,
  runId: string,
  method: string,
  params: Record<string, unknown>,
  token?: string,
  requestId = randomUUID(),
): Promise<{ status: number; body: RawResponse<T> }> {
  const response = await fetch(`${url}/v1/command`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ v: 1, kind: 'request', id: requestId, runId, method, params }),
    signal: AbortSignal.timeout(30_000),
  })
  return { status: response.status, body: await response.json() as RawResponse<T> }
}

function assertEnvelope<T>(response: { status: number; body: RawResponse<T> }, requestId: string, runId: string): void {
  const body = response.body
  if (response.status !== 200) throw new Error(`Expected HTTP 200, received ${response.status}.`)
  if (body.v !== 1 || body.kind !== 'response' || body.id !== requestId || body.requestId !== requestId || body.runId !== runId) {
    throw new Error('Test Host response envelope identity does not match the raw request.')
  }
  if (!Number.isSafeInteger(body.seq) || body.seq < 1) throw new Error('Test Host response seq is invalid.')
  if (!Number.isSafeInteger(body.revision) || body.revision < 0) throw new Error('Test Host response revision is invalid.')
}

function assertGeneratedFailureEnvelope(
  response: { status: number; body: RawResponse },
  runId: string,
  code: string,
): void {
  const body = response.body
  if (body.v !== 1 || body.kind !== 'response' || body.id !== body.requestId || body.runId !== runId
    || body.id.length < 8 || body.id.length > 128 || !Number.isSafeInteger(body.seq) || body.seq < 1
    || !Number.isSafeInteger(body.revision) || body.revision < 0 || body.verificationLevel !== 'scenario-verified'
    || body.ok !== false || body.error?.code !== code) {
    throw new Error(`HTTP ${response.status} did not return a complete bounded V1 failure envelope.`)
  }
}

async function findRendererPage(target: Browser, timeoutMs: number): Promise<Page> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const pages = target.contexts().flatMap(context => context.pages())
    const page = pages.find(candidate => /^(?:file|https?):/i.test(candidate.url()))
    if (page) return page
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  throw new Error('Playwright CDP did not expose the real Electron renderer page.')
}

async function clickPhysicalRendererTarget(page: Page, target: Locator): Promise<void> {
  const bounds = await target.boundingBox()
  if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
    || bounds.width <= 0 || bounds.height <= 0) {
    throw new Error('Raw Electron renderer target has no finite clickable geometry.')
  }
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
}

async function waitForCdp(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1_000) })
      if (response.ok) return
    } catch {
      // Electron may publish the Test Host endpoint before its DevTools endpoint.
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  throw new Error(`Electron CDP endpoint did not become ready on port ${port}.`)
}

async function reserveLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolvePort, rejectPort) => {
    const server = createServer()
    server.once('error', rejectPort)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => rejectPort(new Error('Could not allocate a loopback debug port.')))
        return
      }
      server.close(error => error ? rejectPort(error) : resolvePort(address.port))
    })
  })
}

async function atomicResult(path: string, result: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify({ ...result, completedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
}

async function waitForHostEndpoint(
  path: string,
  child: ChildProcess,
  expectedBuildId: string,
  expectedSourceId: string,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const endpoint = readEndpointManifest(path)
      if (
        endpoint.runId !== runId
        || endpoint.pid !== child.pid
        || endpoint.surface !== 'electron'
        || endpoint.buildId !== expectedBuildId
        || endpoint.sourceId !== expectedSourceId
      ) throw new Error('Test Host endpoint identity mismatch.')
      return endpoint
    } catch (error) {
      if (child.exitCode !== null) throw new Error(`Electron exited before Test Host readiness (${child.exitCode}): ${hostStderr}`, { cause: error })
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  throw new Error(`Timed out waiting for source Electron Test Host: ${hostStderr}`)
}

function hostHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

async function waitForHostSpawn(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    const onSpawn = () => {
      child.off('error', onError)
      resolveSpawn()
    }
    const onError = (error: Error) => {
      child.off('spawn', onSpawn)
      rejectSpawn(new Error(`Electron failed to spawn: ${error.message}`, { cause: error }))
    }
    child.once('spawn', onSpawn)
    child.once('error', onError)
  })
  child.on('error', error => {
    hostStderr = boundedLog(hostStderr, `\nElectron process error: ${error.stack ?? error.message}\n`)
  })
}

async function waitForHostExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hostHasExited(child)) return true
  return await new Promise<boolean>(resolveExit => {
    const onExit = () => {
      clearTimeout(timeout)
      resolveExit(true)
    }
    const timeout = setTimeout(() => {
      child.off('exit', onExit)
      resolveExit(hostHasExited(child))
    }, timeoutMs)
    child.once('exit', onExit)
  })
}

function boundedLog(current: string, chunk: string): string {
  const combined = current + chunk
  return combined.length <= 20_000 ? combined : combined.slice(-20_000)
}

class CdpConnectionTransport {
  onmessage?: (message: object) => void
  onclose?: () => void

  readonly transcript: string[] = []

  private constructor(private readonly socket: WebSocket) {
    socket.on('message', data => {
      const message = data.toString()
      this.note('<', message)
      this.onmessage?.(JSON.parse(message) as object)
    })
    socket.on('close', () => this.onclose?.())
  }

  static async connect(port: number): Promise<CdpConnectionTransport> {
    const version = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3_000) }).then(response => response.json()) as { webSocketDebuggerUrl?: string }
    if (!version.webSocketDebuggerUrl) throw new Error('Electron CDP version response omitted webSocketDebuggerUrl.')
    const socket = new WebSocket(version.webSocketDebuggerUrl, { origin: `http://127.0.0.1:${port}` })
    await new Promise<void>((resolveOpen, rejectOpen) => {
      socket.once('open', resolveOpen)
      socket.once('error', rejectOpen)
    })
    return new CdpConnectionTransport(socket)
  }

  send(message: object): void {
    const serialized = JSON.stringify(message)
    this.note('>', serialized)
    this.socket.send(serialized)
  }
  close(): void { this.socket.close() }

  private note(direction: string, message: string): void {
    try {
      const parsed = JSON.parse(message) as { id?: number; method?: string; error?: { message?: string } }
      this.transcript.push(`${direction} ${parsed.id ?? '-'} ${parsed.method ?? (parsed.error ? `ERROR ${parsed.error.message ?? ''}` : 'response')}`)
    } catch { this.transcript.push(`${direction} invalid-json`) }
    if (this.transcript.length > 100) this.transcript.splice(0, this.transcript.length - 100)
  }
}
