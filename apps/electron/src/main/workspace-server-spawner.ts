import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Readable } from 'node:stream'

import { mainLog } from './logger'

const DEFAULT_WORKSPACE_SERVER_STARTUP_TIMEOUT_MS = 60_000

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
  startupTimeoutMs?: number
}

function resolveBunBinary(options: SpawnWorkspaceServerOptions): string {
  const executable = process.platform === 'win32' ? 'bun.exe' : 'bun'
  const candidates = [
    process.env.CRAFT_BUN,
    join(options.appPath, 'vendor', 'bun', executable),
    join(options.resourcesPath, 'vendor', 'bun', executable),
    join(options.bundledAssetsRoot, '..', 'vendor', 'bun', executable),
  ].filter((value): value is string => !!value)

  return candidates.find(candidate => existsSync(candidate)) ?? 'bun'
}

function resolveServerEntry(options: SpawnWorkspaceServerOptions): string | null {
  const explicitEntry = process.env.CRAFT_WORKSPACE_SERVER_ENTRY
  if (explicitEntry) {
    return existsSync(explicitEntry) ? explicitEntry : null
  }

  const packagedEntry = join(options.appPath, 'dist', 'workspace-server.mjs')
  if (options.isPackaged && existsSync(packagedEntry)) {
    return packagedEntry
  }

  const devEntry = join(process.cwd(), 'packages', 'server', 'src', 'index.ts')
  if (existsSync(devEntry)) {
    return devEntry
  }

  if (existsSync(packagedEntry)) {
    return packagedEntry
  }

  return null
}

function attachLineReader(stream: Readable, onLine: (line: string) => void): void {
  let buffer = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    buffer += chunk
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      onLine(line)
    }
  })
  stream.on('end', () => {
    const line = buffer.trim()
    if (line) onLine(line)
  })
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve()
  return new Promise(resolve => child.once('exit', () => resolve()))
}

function appendTail(lines: string[], line: string, maxLines = 20): void {
  lines.push(line)
  if (lines.length > maxLines) lines.shift()
}

function formatCapturedOutput(stdoutLines: string[], stderrLines: string[]): string {
  const parts: string[] = []
  if (stderrLines.length > 0) {
    parts.push(`stderr:\n${stderrLines.join('\n')}`)
  }
  if (stdoutLines.length > 0) {
    parts.push(`stdout:\n${stdoutLines.join('\n')}`)
  }
  return parts.length > 0 ? `\n${parts.join('\n')}` : ''
}

export async function spawnWorkspaceServer(options: SpawnWorkspaceServerOptions): Promise<SpawnedWorkspaceServer | null> {
  const entry = resolveServerEntry(options)
  if (!entry) {
    mainLog.warn('[workspace-server] No standalone server entry found; falling back to embedded workspace runtime.')
    return null
  }

  const bunBinary = resolveBunBinary(options)
  const token = randomUUID()
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_WORKSPACE_SERVER_STARTUP_TIMEOUT_MS
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CRAFT_SERVER_TOKEN: token,
    CRAFT_RPC_HOST: '127.0.0.1',
    CRAFT_RPC_PORT: '0',
    CRAFT_SERVER_LOCK_NAME: '.workspace-server.lock',
    CRAFT_BUNDLED_ASSETS_ROOT: options.bundledAssetsRoot,
    CRAFT_APP_ROOT: options.isPackaged ? options.appPath : process.cwd(),
    CRAFT_RESOURCES_PATH: process.env.CRAFT_RESOURCES_PATH ?? join(options.bundledAssetsRoot, 'resources'),
    CRAFT_VERSION: options.version,
  }

  delete env.CRAFT_SERVER_URL
  delete env.CRAFT_LOCAL_WORKSPACE_SERVER_URL
  delete env.CRAFT_LOCAL_WORKSPACE_SERVER_TOKEN

  const child = spawn(bunBinary, ['run', entry], {
    cwd: options.isPackaged ? options.appPath : process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  mainLog.info('[workspace-server] Starting standalone workspace server', {
    entry,
    bunBinary,
    pid: child.pid,
  })

  return new Promise<SpawnedWorkspaceServer>((resolve, reject) => {
    let settled = false
    let stopped = false
    let url = ''
    const stdoutTail: string[] = []
    const stderrTail: string[] = []

    const finishReject = (error: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child.kill()
      } catch {
        // ignore best-effort cleanup failure
      }
      reject(error)
    }

    const finishResolve = () => {
      if (settled || !url) return
      settled = true
      clearTimeout(timer)
      resolve({
        url,
        token,
        pid: child.pid,
        stop: async () => {
          if (stopped) return
          stopped = true
          if (child.exitCode != null || child.signalCode != null) return

          child.kill('SIGTERM')
          await Promise.race([
            waitForExit(child),
            new Promise<void>(resolveTimeout => {
              setTimeout(() => {
                if (child.exitCode == null && child.signalCode == null) {
                  try {
                    child.kill('SIGKILL')
                  } catch {
                    // ignore best-effort cleanup failure
                  }
                }
                resolveTimeout()
              }, 5_000)
            }),
          ])
        },
      })
    }

    const timer = setTimeout(() => {
      finishReject(new Error(
        `Workspace server did not start within ${startupTimeoutMs}ms${formatCapturedOutput(stdoutTail, stderrTail)}`
      ))
    }, startupTimeoutMs)

    attachLineReader(child.stdout, (line) => {
      appendTail(stdoutTail, line)
      if (line.startsWith('CRAFT_SERVER_URL=')) {
        url = line.slice('CRAFT_SERVER_URL='.length).trim()
        mainLog.info('[workspace-server] Ready', { url, pid: child.pid })
        finishResolve()
        return
      }
      if (line.trim()) {
        mainLog.info(`[workspace-server] ${line}`)
      }
    })

    attachLineReader(child.stderr, (line) => {
      appendTail(stderrTail, line)
      if (line.trim()) {
        mainLog.warn(`[workspace-server] ${line}`)
      }
    })

    child.once('error', (error) => {
      finishReject(error)
    })

    child.once('exit', (code, signal) => {
      mainLog.info('[workspace-server] Process exited', { code, signal, pid: child.pid })
      if (!settled && !url) {
        finishReject(new Error(
          `Workspace server exited before ready (code=${code ?? 'null'}, signal=${signal ?? 'null'})${formatCapturedOutput(stdoutTail, stderrTail)}`
        ))
      }
    })
  })
}
