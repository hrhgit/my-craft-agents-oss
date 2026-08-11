import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { join } from 'node:path'
import type { Readable } from 'node:stream'

import {
  createImmutableRuntimeEnvironment,
  stripRuntimeLayoutProcessEnvironment,
  type ImmutableRuntimeLayout,
} from '@mortise/session-tools-core/runtime'
import {
  WORKSPACE_CAPABILITY_BRIDGE_VERSION,
  isWorkspaceCapabilityBridgeToHostV1,
  type CapabilityRequestV1,
  type WorkspaceCapabilityBridgeToServerV1,
  type WorkspaceCapabilitySessionContextV1,
} from '@mortise/shared/protocol'
import { writeRuntimeLog } from '@mortise/shared/utils'
import { mainLog } from './logger'

const DEFAULT_WORKSPACE_SERVER_STARTUP_TIMEOUT_MS = 60_000
const RESTART_BACKOFF_MS = [500, 1_000, 2_000, 5_000, 10_000]

export interface SpawnedWorkspaceServer {
  url: string
  token: string
  pid?: number
  probeCapability?: (request: CapabilityRequestV1) => Promise<WorkspaceCapabilityProbeResult>
  stop: () => Promise<void>
}

export interface WorkspaceCapabilityProbeResult {
  output: unknown
  progress: unknown[]
}

export interface SpawnWorkspaceServerOptions {
  isPackaged: boolean
  appPath: string
  resourcesPath: string
  bundledAssetsRoot: string
  version: string
  runtimeCachePath?: string
  nodeBinary?: string
  useNodeRuntime?: boolean
  messagingWorkerPath?: string
  immutableRuntime?: ImmutableRuntimeLayout
  startupTimeoutMs?: number
  capabilityExecutor?: WorkspaceCapabilityExecutor
}

export type WorkspaceCapabilityExecutor = (
  request: CapabilityRequestV1,
  session: WorkspaceCapabilitySessionContextV1,
  context: { signal: AbortSignal; reportProgress(progress: unknown): void },
) => Promise<unknown>

interface ProcessExit {
  code: number | null
  signal: NodeJS.Signals | null
}

interface LaunchedWorkspaceServer {
  child: ChildProcess
  url: string
  exit: Promise<ProcessExit>
  capabilityBridge?: AttachedCapabilityBridge
}

export interface AttachedCapabilityBridge {
  dispose(): void
  probe(request: CapabilityRequestV1): Promise<WorkspaceCapabilityProbeResult>
}

export function resolveWorkspaceServerWorkingDirectory(parentWorkingDirectory = process.cwd()): string {
  return parentWorkingDirectory
}

function runtimeLog(level: 'info' | 'warn' | 'error', event: string, meta?: Record<string, unknown>): void {
  writeRuntimeLog(level, { scope: 'workspace-server', event, meta })
}

function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function sanitizeVersion(version: string): string {
  return version.replace(/[^a-zA-Z0-9._-]/g, '_') || 'unknown'
}

/** Stage an immutable bundle in user data so protected install locations and
 * concurrent installed/source backends never execute a mutable app copy. */
export function prepareWorkspaceServerEntry(
  sourceEntry: string,
  options: Pick<SpawnWorkspaceServerOptions, 'isPackaged' | 'runtimeCachePath' | 'version'>,
): string {
  if (!options.isPackaged) return sourceEntry
  if (!options.runtimeCachePath) {
    throw new Error('Packaged workspace server requires a writable runtime cache path')
  }

  const hash = fileSha256(sourceEntry)
  const targetDir = join(options.runtimeCachePath, 'workspace-server', sanitizeVersion(options.version))
  const target = join(targetDir, `workspace-server-${hash}.mjs`)
  mkdirSync(targetDir, { recursive: true })

  if (existsSync(target) && statSync(target).size === statSync(sourceEntry).size && fileSha256(target) === hash) {
    return target
  }

  const temporary = join(targetDir, `.workspace-server-${process.pid}-${randomUUID()}.tmp`)
  copyFileSync(sourceEntry, temporary)
  try {
    renameSync(temporary, target)
  } catch (error) {
    if (!existsSync(target) || fileSha256(target) !== hash) throw error
    try { unlinkSync(temporary) } catch { /* another process won the atomic publish */ }
  }
  return target
}

function resolveBunBinary(options: SpawnWorkspaceServerOptions): string {
  const executable = process.platform === 'win32' ? 'bun.exe' : 'bun'
  const candidates = [
    process.env.MORTISE_BUN,
    join(options.resourcesPath, 'vendor', 'bun', executable),
    join(options.appPath, 'vendor', 'bun', executable),
    join(options.bundledAssetsRoot, '..', 'vendor', 'bun', executable),
  ].filter((value): value is string => !!value)

  const bundled = candidates.find(candidate => existsSync(candidate))
  if (bundled) return bundled
  if (options.isPackaged) throw new Error(`Bundled Bun runtime not found. Checked: ${candidates.join(', ')}`)
  return 'bun'
}

export function resolveWorkspaceServerEntry(options: SpawnWorkspaceServerOptions): string {
  if (options.immutableRuntime) {
    const immutableEntry = join(options.immutableRuntime.appRootPath, 'dist', 'workspace-server.mjs')
    if (!existsSync(immutableEntry) || !statSync(immutableEntry).isFile()) {
      throw new Error(`Immutable workspace server entry not found: ${immutableEntry}`)
    }
    return immutableEntry
  }

  const explicitEntry = process.env.MORTISE_WORKSPACE_SERVER_ENTRY
  if (explicitEntry && !options.isPackaged) {
    if (!existsSync(explicitEntry) || !statSync(explicitEntry).isFile()) throw new Error(`Workspace server entry not found: ${explicitEntry}`)
    return explicitEntry
  }

  const packagedEntry = join(options.appPath, 'dist', 'workspace-server.mjs')
  if (options.isPackaged) {
    if (!existsSync(packagedEntry) || !statSync(packagedEntry).isFile()) throw new Error(`Packaged workspace server entry not found: ${packagedEntry}`)
    return packagedEntry
  }

  const devEntry = join(process.cwd(), 'packages', 'server', 'src', 'index.ts')
  if (existsSync(devEntry)) return devEntry
  if (existsSync(packagedEntry)) return packagedEntry
  throw new Error(`Workspace server entry not found: ${devEntry}`)
}

function attachLineReader(stream: Readable, onLine: (line: string) => void): void {
  let buffer = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    buffer += chunk
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    for (const line of lines) onLine(line)
  })
  stream.on('end', () => {
    const line = buffer.trim()
    if (line) onLine(line)
  })
}

function appendTail(lines: string[], line: string, maxLines = 20): void {
  lines.push(line)
  if (lines.length > maxLines) lines.shift()
}

function formatCapturedOutput(stdoutLines: string[], stderrLines: string[]): string {
  const parts: string[] = []
  if (stderrLines.length > 0) parts.push(`stderr:\n${stderrLines.join('\n')}`)
  if (stdoutLines.length > 0) parts.push(`stdout:\n${stdoutLines.join('\n')}`)
  return parts.length > 0 ? `\n${parts.join('\n')}` : ''
}

function waitForExit(child: ChildProcess): Promise<ProcessExit> {
  if (child.exitCode != null || child.signalCode != null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  }
  return new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) return
  try { child.kill('SIGTERM') } catch { return }
  const graceful = await Promise.race([
    waitForExit(child).then(() => true),
    new Promise<boolean>(resolve => setTimeout(() => resolve(false), 5_000)),
  ])
  if (graceful || child.exitCode != null || child.signalCode != null) return
  try { child.kill('SIGKILL') } catch { return }
  await waitForExit(child).catch(() => undefined)
}

export function buildWorkspaceServerChildEnv(
  options: SpawnWorkspaceServerOptions,
  token: string,
  port: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...stripRuntimeLayoutProcessEnvironment(process.env),
    MORTISE_SERVER_TOKEN: token,
    MORTISE_RPC_HOST: '127.0.0.1',
    MORTISE_RPC_PORT: port,
    MORTISE_SERVER_LOCK_NAME: '.workspace-server.lock',
    MORTISE_BUNDLED_ASSETS_ROOT: options.bundledAssetsRoot,
    MORTISE_APP_ROOT: options.immutableRuntime
      ? options.immutableRuntime.appRootPath
      : options.isPackaged ? options.appPath : process.cwd(),
    MORTISE_RESOURCES_PATH: options.immutableRuntime ? options.immutableRuntime.resourcesPath : options.resourcesPath,
    MORTISE_RESOURCES_BASE: options.immutableRuntime
      ? options.immutableRuntime.resourcesBasePath
      : options.appPath,
    MORTISE_IS_PACKAGED: options.isPackaged ? 'true' : 'false',
    MORTISE_VERSION: options.version,
    MORTISE_PROCESS_ROLE: 'workspace-server',
    MORTISE_BACKEND_KIND: 'workspace-server',
    MORTISE_PRODUCT_VERSION: options.version,
  }
  if (options.immutableRuntime) {
    Object.assign(env, createImmutableRuntimeEnvironment(options.immutableRuntime))
  }
  if (options.messagingWorkerPath) env.MORTISE_MESSAGING_WA_WORKER = options.messagingWorkerPath
  if (options.nodeBinary) env.MORTISE_MESSAGING_NODE_BIN = options.nodeBinary
  if (options.capabilityExecutor) env.MORTISE_ELECTRON_CAPABILITY_BRIDGE = '1'
  delete env.MORTISE_SERVER_URL
  delete env.MORTISE_LOCAL_WORKSPACE_SERVER_URL
  delete env.MORTISE_LOCAL_WORKSPACE_SERVER_TOKEN
  return env
}

export function attachCapabilityBridge(
  child: ChildProcess,
  executor: WorkspaceCapabilityExecutor,
  validationProbeEnabled = process.env.MORTISE_UI_TEST_HOST === '1',
): AttachedCapabilityBridge {
  const pending = new Map<string, AbortController>()
  const probes = new Map<string, {
    resolve(result: WorkspaceCapabilityProbeResult): void
    reject(error: Error): void
    timer: ReturnType<typeof setTimeout>
  }>()

  const send = (message: WorkspaceCapabilityBridgeToServerV1): boolean => {
    if (child.connected !== true || typeof child.send !== 'function') return false
    try { child.send(message); return true } catch { return false }
  }

  const onMessage = (message: unknown): void => {
    if (!isWorkspaceCapabilityBridgeToHostV1(message)) return
    if (message.type === 'workspace_capability_probe_result') {
      const probe = probes.get(message.bridgeId)
      if (!probe) return
      probes.delete(message.bridgeId)
      clearTimeout(probe.timer)
      if (message.ok) probe.resolve({ output: message.output, progress: message.progress })
      else probe.reject(Object.assign(new Error(message.error.message), { code: message.error.code }))
      return
    }
    if (message.type === 'workspace_capability_cancel') {
      pending.get(message.bridgeId)?.abort('cancelled')
      return
    }
    if (pending.has(message.bridgeId)) {
      send({
        type: 'workspace_capability_result',
        version: WORKSPACE_CAPABILITY_BRIDGE_VERSION,
        bridgeId: message.bridgeId,
        ok: false,
        error: { code: 'REQUEST_ID_CONFLICT', message: 'Capability bridge ID is already active' },
      })
      return
    }

    const controller = new AbortController()
    pending.set(message.bridgeId, controller)
    void executor(message.request, message.session, {
      signal: controller.signal,
      reportProgress: progress => send({
        type: 'workspace_capability_progress',
        version: WORKSPACE_CAPABILITY_BRIDGE_VERSION,
        bridgeId: message.bridgeId,
        progress,
      }),
    }).then(
      output => send({
        type: 'workspace_capability_result',
        version: WORKSPACE_CAPABILITY_BRIDGE_VERSION,
        bridgeId: message.bridgeId,
        ok: true,
        output,
      }),
      error => send({
        type: 'workspace_capability_result',
        version: WORKSPACE_CAPABILITY_BRIDGE_VERSION,
        bridgeId: message.bridgeId,
        ok: false,
        error: {
          code: error && typeof error === 'object' && typeof error.code === 'string'
            ? error.code
            : 'PROVIDER_ERROR',
          message: error instanceof Error ? error.message : String(error ?? 'Capability provider failed'),
        },
      }),
    ).finally(() => pending.delete(message.bridgeId))
  }

  child.on('message', onMessage)
  const dispose = () => {
    child.off('message', onMessage)
    for (const controller of pending.values()) controller.abort('workspace_server_exited')
    pending.clear()
    for (const probe of probes.values()) {
      clearTimeout(probe.timer)
      probe.reject(Object.assign(new Error('Workspace capability bridge disconnected'), { code: 'NO_INTERACTIVE_CLIENT' }))
    }
    probes.clear()
  }
  return {
    dispose,
    probe(request) {
      if (!validationProbeEnabled) {
        return Promise.reject(Object.assign(
          new Error('Capability probes require the UI validation host'),
          { code: 'UNSUPPORTED_CAPABILITY' },
        ))
      }
      const bridgeId = randomUUID()
      return new Promise<WorkspaceCapabilityProbeResult>((resolve, reject) => {
        const timeoutMs = request.timeoutMs ?? 30_000
        const timer = setTimeout(() => {
          probes.delete(bridgeId)
          reject(Object.assign(new Error(`Capability probe timed out after ${timeoutMs}ms`), { code: 'CAPABILITY_TIMEOUT' }))
        }, timeoutMs)
        probes.set(bridgeId, { resolve, reject, timer })
        if (!send({
          type: 'workspace_capability_probe',
          version: WORKSPACE_CAPABILITY_BRIDGE_VERSION,
          bridgeId,
          request,
        })) {
          clearTimeout(timer)
          probes.delete(bridgeId)
          reject(Object.assign(new Error('Workspace capability bridge is not connected'), { code: 'NO_INTERACTIVE_CLIENT' }))
        }
      })
    },
  }
}

async function launchWorkspaceServer(
  options: SpawnWorkspaceServerOptions,
  entry: string,
  bunBinary: string,
  token: string,
  port: string,
): Promise<LaunchedWorkspaceServer> {
  const useNodeRuntime = options.isPackaged || options.useNodeRuntime === true
  const runtimeBinary = useNodeRuntime ? options.immutableRuntime?.nodeRuntimePath ?? options.nodeBinary : bunBinary
  if (!runtimeBinary) throw new Error('Bundled workspace server requires the Electron Node runtime')
  const runtimeArgs = useNodeRuntime ? [entry] : ['run', entry]
  const env = buildWorkspaceServerChildEnv(options, token, port)
  if (useNodeRuntime) env.ELECTRON_RUN_AS_NODE = '1'

  const child = spawn(runtimeBinary, runtimeArgs, {
    // Session buckets derived from relative Workspace identities must resolve
    // identically in the Electron main process and its Workspace server.
    cwd: resolveWorkspaceServerWorkingDirectory(),
    env,
    stdio: options.capabilityExecutor
      ? ['ignore', 'pipe', 'pipe', 'ipc']
      : ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const exit = waitForExit(child)
  const capabilityBridge = options.capabilityExecutor
    ? attachCapabilityBridge(child, options.capabilityExecutor)
    : undefined
  void exit.finally(() => capabilityBridge?.dispose())
  const stdoutTail: string[] = []
  const stderrTail: string[] = []

  mainLog.info('[workspace-server] Starting standalone workspace server', {
    entry,
    runtimeBinary,
    runtimeKind: useNodeRuntime ? 'electron-node' : 'bun',
    pid: child.pid,
    port,
  })
  runtimeLog('info', 'startup.begin', {
    entry,
    runtimeBinary,
    runtimeKind: useNodeRuntime ? 'electron-node' : 'bun',
    pid: child.pid,
    port,
  })

  return new Promise<LaunchedWorkspaceServer>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      const error = new Error(
        `Workspace server did not start within ${options.startupTimeoutMs ?? DEFAULT_WORKSPACE_SERVER_STARTUP_TIMEOUT_MS}ms${formatCapturedOutput(stdoutTail, stderrTail)}`,
      )
      void stopChild(child).finally(() => reject(error))
    }, options.startupTimeoutMs ?? DEFAULT_WORKSPACE_SERVER_STARTUP_TIMEOUT_MS)

    const rejectOnce = (error: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void stopChild(child).finally(() => reject(error))
    }

    attachLineReader(child.stdout!, line => {
      appendTail(stdoutTail, line)
      if (line.startsWith('MORTISE_SERVER_URL=')) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const url = line.slice('MORTISE_SERVER_URL='.length).trim()
        mainLog.info('[workspace-server] Ready', { url, pid: child.pid })
        runtimeLog('info', 'startup.ready', { url, pid: child.pid })
        resolve({ child, url, exit, capabilityBridge })
      } else if (line.trim()) {
        mainLog.info(`[workspace-server] ${line}`)
      }
    })

    attachLineReader(child.stderr!, line => {
      appendTail(stderrTail, line)
      if (line.trim()) mainLog.warn(`[workspace-server] ${line}`)
    })

    child.once('error', error => rejectOnce(error))
    void exit.then(({ code, signal }) => {
      mainLog.info('[workspace-server] Process exited', { code, signal, pid: child.pid })
      if (!settled) {
        rejectOnce(new Error(
          `Workspace server exited before ready (code=${code ?? 'null'}, signal=${signal ?? 'null'})${formatCapturedOutput(stdoutTail, stderrTail)}`,
        ))
      }
    })
  })
}

export async function spawnWorkspaceServer(options: SpawnWorkspaceServerOptions): Promise<SpawnedWorkspaceServer> {
  const sourceEntry = resolveWorkspaceServerEntry(options)
  const entry = prepareWorkspaceServerEntry(sourceEntry, options)
  const bunBinary = resolveBunBinary(options)
  const token = randomUUID()
  let current = await launchWorkspaceServer(options, entry, bunBinary, token, '0')
  const stableUrl = current.url
  const stablePort = new URL(stableUrl).port
  let stopped = false
  let restartTask: Promise<void> | null = null

  const monitor = (launched: LaunchedWorkspaceServer) => {
    void launched.exit.then(({ code, signal }) => {
      if (stopped || current !== launched) return
      runtimeLog('error', 'lifecycle.failure', { code, signal, pid: launched.child.pid, url: stableUrl })
      restartTask = restartLoop()
    })
  }

  const restartLoop = async (): Promise<void> => {
    let attempt = 0
    while (!stopped) {
      const delay = RESTART_BACKOFF_MS[Math.min(attempt, RESTART_BACKOFF_MS.length - 1)]!
      await new Promise(resolve => setTimeout(resolve, delay))
      if (stopped) return
      try {
        const relaunched = await launchWorkspaceServer(options, entry, bunBinary, token, stablePort)
        if (stopped) {
          await stopChild(relaunched.child)
          return
        }
        if (relaunched.url !== stableUrl) {
          await stopChild(relaunched.child)
          throw new Error(`Workspace server restart changed endpoint from ${stableUrl} to ${relaunched.url}`)
        }
        current = relaunched
        runtimeLog('info', 'lifecycle.recovered', { attempt: attempt + 1, pid: relaunched.child.pid, url: stableUrl })
        monitor(relaunched)
        return
      } catch (error) {
        attempt++
        mainLog.error('[workspace-server] Restart failed', error)
        runtimeLog('error', 'restart.failed', { attempt, error })
      }
    }
  }

  monitor(current)

  return {
    url: stableUrl,
    token,
    pid: current.child.pid,
    ...(options.capabilityExecutor && process.env.MORTISE_UI_TEST_HOST === '1' ? {
      probeCapability: (request: CapabilityRequestV1) => {
        if (!current.capabilityBridge) {
          throw Object.assign(new Error('Workspace capability bridge is unavailable'), { code: 'NO_INTERACTIVE_CLIENT' })
        }
        return current.capabilityBridge.probe(request)
      },
    } : {}),
    stop: async () => {
      if (stopped) return
      stopped = true
      await stopChild(current.child)
      await restartTask?.catch(() => undefined)
    },
  }
}
