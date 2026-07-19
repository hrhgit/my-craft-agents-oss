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
import { dirname, join } from 'node:path'
import type { Readable } from 'node:stream'

import { writeRuntimeLog } from '@mortise/shared/utils'
import { mainLog } from './logger'

const DEFAULT_WORKSPACE_SERVER_STARTUP_TIMEOUT_MS = 60_000
const RESTART_BACKOFF_MS = [500, 1_000, 2_000, 5_000, 10_000]

export interface SpawnedWorkspaceServer {
  url: string
  token: string
  pid?: number
  stop: () => Promise<void>
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
  startupTimeoutMs?: number
}

interface ProcessExit {
  code: number | null
  signal: NodeJS.Signals | null
}

interface LaunchedWorkspaceServer {
  child: ChildProcess
  url: string
  exit: Promise<ProcessExit>
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

function resolveServerEntry(options: SpawnWorkspaceServerOptions): string {
  const explicitEntry = process.env.MORTISE_WORKSPACE_SERVER_ENTRY
  if (explicitEntry) {
    if (!existsSync(explicitEntry)) throw new Error(`Workspace server entry not found: ${explicitEntry}`)
    return explicitEntry
  }

  const packagedEntry = join(options.appPath, 'dist', 'workspace-server.mjs')
  if (options.isPackaged) {
    if (!existsSync(packagedEntry)) throw new Error(`Packaged workspace server entry not found: ${packagedEntry}`)
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

function buildChildEnv(
  options: SpawnWorkspaceServerOptions,
  token: string,
  port: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MORTISE_SERVER_TOKEN: token,
    MORTISE_RPC_HOST: '127.0.0.1',
    MORTISE_RPC_PORT: port,
    MORTISE_SERVER_LOCK_NAME: '.workspace-server.lock',
    MORTISE_BUNDLED_ASSETS_ROOT: options.bundledAssetsRoot,
    MORTISE_APP_ROOT: options.isPackaged ? options.appPath : process.cwd(),
    MORTISE_RESOURCES_PATH: options.resourcesPath,
    MORTISE_IS_PACKAGED: options.isPackaged ? 'true' : 'false',
    MORTISE_VERSION: options.version,
  }
  if (options.messagingWorkerPath) env.MORTISE_MESSAGING_WA_WORKER = options.messagingWorkerPath
  if (options.nodeBinary) env.MORTISE_MESSAGING_NODE_BIN = options.nodeBinary
  delete env.MORTISE_SERVER_URL
  delete env.MORTISE_LOCAL_WORKSPACE_SERVER_URL
  delete env.MORTISE_LOCAL_WORKSPACE_SERVER_TOKEN
  return env
}

async function launchWorkspaceServer(
  options: SpawnWorkspaceServerOptions,
  entry: string,
  bunBinary: string,
  token: string,
  port: string,
): Promise<LaunchedWorkspaceServer> {
  const useNodeRuntime = options.isPackaged || options.useNodeRuntime === true
  const runtimeBinary = useNodeRuntime ? options.nodeBinary : bunBinary
  if (!runtimeBinary) throw new Error('Bundled workspace server requires the Electron Node runtime')
  const runtimeArgs = useNodeRuntime ? [entry] : ['run', entry]
  const env = buildChildEnv(options, token, port)
  if (useNodeRuntime) env.ELECTRON_RUN_AS_NODE = '1'

  const child = spawn(runtimeBinary, runtimeArgs, {
    cwd: useNodeRuntime ? dirname(entry) : process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const exit = waitForExit(child)
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
        resolve({ child, url, exit })
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
  const sourceEntry = resolveServerEntry(options)
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
    stop: async () => {
      if (stopped) return
      stopped = true
      await stopChild(current.child)
      await restartTask?.catch(() => undefined)
    },
  }
}
