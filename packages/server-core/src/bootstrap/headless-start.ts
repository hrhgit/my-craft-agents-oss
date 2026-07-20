import { randomUUID, timingSafeEqual } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { uptime as osUptime } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { ensureConfigDir, getWorkspaceByNameOrId, loadStoredConfig, saveConfig } from '@mortise/shared/config'
import { CONFIG_DIR } from '@mortise/shared/config/paths'
import { setBundledAssetsRoot } from '@mortise/shared/utils'
import { withFileLockSync } from '@mortise/shared/storage'
import { WsRpcServer, type WsRpcTlsOptions } from '../transport/server'
import type { EventSink, RpcServer, WorkspaceAuthorizationRequest } from '../transport/types'
import { createHeadlessPlatform } from '../runtime/platform-headless'
import type { PlatformServices } from '../runtime/platform'

interface ModelRefreshServiceLike {
  startAll(): void
  stopAll?(): void
}

export interface ServerBootstrapOptions<TSessionManager, THandlerDeps> {
  serverToken?: string
  rpcHost?: string
  rpcPort?: number
  bundledAssetsRoot?: string
  platformFactory?: () => PlatformServices
  applyPlatformToSubsystems?: (platform: PlatformServices) => void
  createSessionManager: () => TSessionManager
  createHandlerDeps: (ctx: {
    sessionManager: TSessionManager
    platform: PlatformServices
  }) => THandlerDeps
  registerAllRpcHandlers: (server: RpcServer, deps: THandlerDeps, serverCtx: ServerHandlerContext) => void
  initializeSessionManager: (sessionManager: TSessionManager) => Promise<void>
  setSessionEventSink: (sessionManager: TSessionManager, sink: EventSink) => void
  /**
   * Optional hook called right after the WS RPC server starts listening. Use
   * this to plumb the server into the SessionManager (e.g. `sm.setRpcServer(server)`)
   * so the remote-bridge code path for `client:browser:invoke` activates.
   */
  bindRpcServer?: (sessionManager: TSessionManager, server: RpcServer) => void
  initModelRefreshService: () => ModelRefreshServiceLike
  cleanupSessionManager?: (sessionManager: TSessionManager) => Promise<void> | void
  cleanupClientResources?: (clientId: string) => void
  onClientConnected?: (info: { clientId: string; webContentsId: number | null; workspaceId: string | null; capabilities: string[] }) => void
  serverId?: string
  /**
   * Name of the lock file under CONFIG_DIR. Use a distinct name for supervised
   * in-process companion servers that share the same config directory.
   */
  serverLockName?: string
  /** App version string, included in handshake_ack for client compatibility checks. */
  serverVersion?: string
  /** TLS configuration. When provided, the server listens on wss:// instead of ws://. */
  tls?: WsRpcTlsOptions
  /** Cookie-based session validator for web UI auth on WebSocket upgrade. */
  validateSessionCookie?: (cookieHeader: string | null) => Promise<boolean>
  /** Workspace authorization hook for transport handshake/reconnect/switch. */
  authorizeWorkspace?: (request: WorkspaceAuthorizationRequest) => Promise<boolean> | boolean
  /**
   * Optional HTTP request handler for non-WebSocket requests on the RPC port.
   * When provided, the WsRpcServer serves HTTP (e.g. WebUI) on the same port.
   */
  httpHandler?: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void
}

export interface ServerHandlerContext {
  getConnectedClientCount: () => number
  serverId: string
  startedAt: number
}

export interface ServerInstance<TSessionManager> {
  platform: PlatformServices
  sessionManager: TSessionManager
  wsServer: WsRpcServer
  host: string
  port: number
  protocol: 'ws' | 'wss'
  token: string
  /** Context for server-level RPC handlers (status, health, active sessions). */
  serverHandlerContext: ServerHandlerContext
  stop: () => Promise<void>
}

// ---------------------------------------------------------------------------
// Token entropy validation
// ---------------------------------------------------------------------------

const MIN_TOKEN_LENGTH = 16

/**
 * Reject tokens that are trivially weak. Runs at startup before the server
 * accepts connections so a bad token never reaches the wire.
 */
function validateTokenEntropy(token: string): { ok: boolean; warning?: string; error?: string } {
  if (token.length < MIN_TOKEN_LENGTH) {
    return { ok: false, error: `Token too short (${token.length} chars, minimum ${MIN_TOKEN_LENGTH}). Use a cryptographically random value.` }
  }

  // Reject single-character repeats ("aaaaaaaaaaaaaaaa")
  if (new Set(token).size === 1) {
    return { ok: false, error: 'Token has zero entropy (single repeated character).' }
  }

  // Warn (but allow) low-uniqueness tokens — fewer than 8 unique characters
  // in a 16+ char token suggests a pattern like "abcabcabc..."
  const uniqueChars = new Set(token).size
  if (uniqueChars < 8) {
    return { ok: true, warning: `Token has low entropy (${uniqueChars} unique characters). Consider using a stronger token.` }
  }

  return { ok: true }
}

/**
 * Generate a cryptographically random token suitable for server auth.
 * Returns a 48-character hex string (192 bits of entropy).
 */
export function generateServerToken(): string {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

// ---------------------------------------------------------------------------
// Startup lock file
// ---------------------------------------------------------------------------

const DEFAULT_LOCK_NAME = '.server.lock'

interface LockPayload {
  pid: number
  startedAt: number
  protocolVersion?: number
  /** OS process creation time, used to detect same-boot PID reuse on Windows. */
  processStartedAt?: number
}

const WINDOWS_EPOCH_TICKS = 116444736000000000
const PROCESS_START_TIME_TOLERANCE_MS = 2_000
const SERVER_REGISTRY_PROTOCOL = 2
const activeServerRegistrations = new Map<string, string>()

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Read a process creation time on Windows. PID liveness alone is insufficient
 * because Windows can reuse a PID during the same boot session.
 */
function getProcessStartTime(pid: number): number | null {
  if (process.platform !== 'win32') return null

  try {
    const output = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$process = Get-Process -Id ${pid} -ErrorAction Stop; $process.StartTime.ToUniversalTime().Ticks`,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
    ).trim()
    const ticks = Number(output)
    if (!Number.isFinite(ticks) || ticks <= WINDOWS_EPOCH_TICKS) return null
    return (ticks - WINDOWS_EPOCH_TICKS) / 10_000
  } catch {
    // Access to another process can be denied. Keep the conservative lock
    // behavior when its identity cannot be verified.
    return null
  }
}

/**
 * Parse the lock file content (JSON format: `{pid, startedAt}`).
 */
function parseLockContent(raw: string): LockPayload | null {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>
    const pid = typeof parsed.pid === 'number' ? parsed.pid : NaN
    const startedAt = typeof parsed.startedAt === 'number' ? parsed.startedAt : 0
    const processStartedAt = typeof parsed.processStartedAt === 'number' && Number.isFinite(parsed.processStartedAt)
      ? parsed.processStartedAt
      : undefined
    const protocolVersion = typeof parsed.protocolVersion === 'number' ? parsed.protocolVersion : undefined
    if (!isNaN(pid)) return {
      pid,
      startedAt,
      ...(protocolVersion !== undefined ? { protocolVersion } : {}),
      ...(processStartedAt !== undefined ? { processStartedAt } : {}),
    }
  } catch { /* invalid JSON */ }
  return null
}

/**
 * Detect a live PID that no longer represents the process which wrote a lock.
 * Legacy locks have no processStartedAt, so a process created after the lock
 * was written is definitively a reused PID while older processes remain
 * ambiguous and are treated as active by the caller.
 */
export function isProcessIdentityMismatch(
  lock: Pick<LockPayload, 'startedAt' | 'processStartedAt'>,
  observedProcessStartedAt: number | null,
): boolean {
  if (observedProcessStartedAt == null) return false

  if (lock.processStartedAt != null) {
    return Math.abs(observedProcessStartedAt - lock.processStartedAt) > PROCESS_START_TIME_TOLERANCE_MS
  }

  return lock.startedAt > 0 && observedProcessStartedAt > lock.startedAt + PROCESS_START_TIME_TOLERANCE_MS
}

/**
 * Returns true if the lock's `startedAt` timestamp predates the most recent
 * system boot. This means the lock was written in a previous boot cycle and
 * the PID has been reused by an unrelated process.
 */
function isLockFromPreviousBoot(startedAt: number): boolean {
  if (startedAt <= 0) return false // legacy lock without timestamp — can't tell
  const bootTime = Date.now() - osUptime() * 1000
  return startedAt < bootTime
}

function resolveServerLockFile(lockName?: string): string {
  const name = lockName || process.env.MORTISE_SERVER_LOCK_NAME || DEFAULT_LOCK_NAME
  return isAbsolute(name) ? name : join(CONFIG_DIR, name)
}

function registrationDirectory(lockFile: string): string {
  return `${lockFile}.d`
}

function registrationFiles(lockFile: string): string[] {
  const directory = registrationDirectory(lockFile)
  if (!existsSync(directory)) return []
  return readdirSync(directory)
    .filter(name => name.endsWith('.json'))
    .map(name => join(directory, name))
}

function readRegistration(filePath: string): LockPayload | null {
  try { return parseLockContent(readFileSync(filePath, 'utf8')) } catch { return null }
}

function registrationIsLive(payload: LockPayload | null): boolean {
  if (!payload || !isProcessAlive(payload.pid)) return false
  return !isProcessIdentityMismatch(payload, getProcessStartTime(payload.pid))
    && !isLockFromPreviousBoot(payload.startedAt)
}

function writeCoordinator(lockFile: string, payload: LockPayload): void {
  writeFileSync(lockFile, JSON.stringify({ ...payload, protocolVersion: SERVER_REGISTRY_PROTOCOL }), 'utf8')
}

export function acquireServerLock(logger: PlatformServices['logger'], lockFile: string): void {
  void logger
  withFileLockSync(`${lockFile}.registry`, () => {
    const existing = existsSync(lockFile) ? parseLockContent(readFileSync(lockFile, 'utf8')) : null
    // A pre-protocol backend cannot participate in multi-writer persistence.
    // Keep the compatibility sentinel so it is fenced until upgraded.
    if (existing && existing.protocolVersion !== SERVER_REGISTRY_PROTOCOL && registrationIsLive(existing)) {
      throw new Error(
        `Another legacy server instance is already running (PID ${existing.pid}). Upgrade that backend before sharing this config directory.`
      )
    }
    if (existing && existing.protocolVersion !== SERVER_REGISTRY_PROTOCOL) {
      try { unlinkSync(lockFile) } catch { /* stale legacy sentinel */ }
    }

    const directory = registrationDirectory(lockFile)
    mkdirSync(directory, { recursive: true })
    for (const filePath of registrationFiles(lockFile)) {
      if (!registrationIsLive(readRegistration(filePath))) {
        try { unlinkSync(filePath) } catch { /* concurrent cleanup */ }
      }
    }

    const processStartedAt = getProcessStartTime(process.pid)
    const payload: LockPayload = {
      pid: process.pid,
      startedAt: Date.now(),
      protocolVersion: SERVER_REGISTRY_PROTOCOL,
      ...(processStartedAt != null ? { processStartedAt } : {}),
    }
    const registrationPath = join(directory, `${process.pid}-${payload.startedAt}-${randomUUID()}.json`)
    writeFileSync(registrationPath, JSON.stringify(payload), 'utf8')
    activeServerRegistrations.set(lockFile, registrationPath)
    const first = registrationFiles(lockFile)[0]
    const firstPayload = first ? readRegistration(first) : null
    writeCoordinator(lockFile, firstPayload ?? payload)
  })

  // Safety net: release the lock on unexpected exits (SIGKILL, uncaught exceptions, etc.).
  // process.on('exit') only allows synchronous code — releaseServerLock is fully sync.
  process.on('exit', () => { releaseServerLock(lockFile) })
}

/**
 * Remove the lock file if it belongs to the current process.
 * Exported so consumers (e.g. the Electron before-quit handler) can call it
 * directly without going through `instance.stop()`.
 */
export function releaseServerLock(lockFile = resolveServerLockFile()): void {
  try {
    const registrationPath = activeServerRegistrations.get(lockFile)
    if (!registrationPath) return
    withFileLockSync(`${lockFile}.registry`, () => {
      try { unlinkSync(registrationPath) } catch { /* already cleaned */ }
      activeServerRegistrations.delete(lockFile)
      const remaining = registrationFiles(lockFile)
        .map(filePath => ({ filePath, payload: readRegistration(filePath) }))
        .filter(entry => registrationIsLive(entry.payload))
      if (remaining.length === 0) {
        try { unlinkSync(lockFile) } catch { /* already removed */ }
      } else {
        writeCoordinator(lockFile, remaining[0]!.payload!)
      }
    })
  } catch {
    // Best-effort cleanup
  }
}

// ---------------------------------------------------------------------------
// Config artifacts
// ---------------------------------------------------------------------------

function bootstrapConfigArtifacts(platform: PlatformServices): void {
  ensureConfigDir()
  platform.logger.info('[bootstrap] Config artifacts initialized')
}

function ensureGlobalConfigExists(platform: PlatformServices): void {
  const config = loadStoredConfig()
  if (config) {
    platform.logger.info('[bootstrap] Global config found')
    return
  }

  saveConfig({
    workspaces: [],
    activeWorkspaceId: null,
    activeSessionId: null,
  })
  platform.logger.info('[bootstrap] Initialized missing global config')
}

export async function bootstrapServer<TSessionManager, THandlerDeps>(
  options: ServerBootstrapOptions<TSessionManager, THandlerDeps>,
): Promise<ServerInstance<TSessionManager>> {
  const serverToken = options.serverToken ?? process.env.MORTISE_SERVER_TOKEN
  if (!serverToken) {
    throw new Error('Server token is required. Pass options.serverToken or set MORTISE_SERVER_TOKEN.')
  }

  const entropy = validateTokenEntropy(serverToken)
  if (!entropy.ok) {
    throw new Error(`Weak server token: ${entropy.error}`)
  }

  const platform = options.platformFactory?.() ?? createHeadlessPlatform({ appVersion: options.serverVersion })

  const bundledAssetsRoot = options.bundledAssetsRoot
    ?? process.env.MORTISE_BUNDLED_ASSETS_ROOT
    ?? process.cwd()
  setBundledAssetsRoot(bundledAssetsRoot)

  if (entropy.warning) {
    platform.logger.warn(`[bootstrap] ${entropy.warning}`)
  }

  options.applyPlatformToSubsystems?.(platform)

  bootstrapConfigArtifacts(platform)
  ensureGlobalConfigExists(platform)
  const serverLockFile = resolveServerLockFile(options.serverLockName)
  acquireServerLock(platform.logger, serverLockFile)

  const modelRefreshService = options.initModelRefreshService()
  const sessionManager = options.createSessionManager()

  const rpcHost = options.rpcHost ?? process.env.MORTISE_RPC_HOST ?? '127.0.0.1'
  const rpcPortRaw = options.rpcPort ?? parseInt(process.env.MORTISE_RPC_PORT ?? '9100', 10)
  if (!Number.isFinite(rpcPortRaw) || rpcPortRaw < 0 || rpcPortRaw > 65535) {
    throw new Error(`Invalid RPC port: ${rpcPortRaw}`)
  }
  const rpcPort = Math.trunc(rpcPortRaw)

  const wsServer = new WsRpcServer({
    host: rpcHost,
    port: rpcPort,
    requireAuth: true,
    validateToken: async (t) => {
      if (typeof t !== 'string') return false
      // Constant-time comparison to mitigate timing attacks against the server token.
      // Length check is not timing-safe, but leaking length info is low risk.
      const a = Buffer.from(t)
      const b = Buffer.from(serverToken)
      return a.length === b.length && timingSafeEqual(a, b)
    },
    validateSessionCookie: options.validateSessionCookie,
    authorizeWorkspace: options.authorizeWorkspace ?? ((request) => (
      !request.workspaceId || Boolean(getWorkspaceByNameOrId(request.workspaceId))
    )),
    serverId: options.serverId ?? 'headless',
    serverVersion: options.serverVersion,
    tls: options.tls,
    httpHandler: options.httpHandler,
    onClientConnected: options.onClientConnected,
    onClientDisconnected: (clientId) => {
      options.cleanupClientResources?.(clientId)
      // Best-effort: notify SM so it can drop browser-host pins for this client.
      // Duck-typed because TSessionManager is generic at the bootstrap layer.
      const smWithDisconnect = sessionManager as unknown as { onClientDisconnected?: (id: string) => void }
      if (typeof smWithDisconnect.onClientDisconnected === 'function') {
        try {
          smWithDisconnect.onClientDisconnected(clientId)
        } catch {
          // Cleanup hook failures must not break the transport.
        }
      }
    },
  })

  await wsServer.listen()

  options.bindRpcServer?.(sessionManager, wsServer)

  const deps = options.createHandlerDeps({
    sessionManager,
    platform,
  })

  const startedAt = Date.now()
  const serverHandlerContext: ServerHandlerContext = {
    getConnectedClientCount: () => wsServer.getConnectedClientCount(),
    serverId: options.serverId ?? 'headless',
    startedAt,
  }

  options.registerAllRpcHandlers(wsServer, deps, serverHandlerContext)

  options.setSessionEventSink(sessionManager, wsServer.push.bind(wsServer))

  await options.initializeSessionManager(sessionManager)

  modelRefreshService.startAll()

  platform.logger.info(`Mortise Agent server listening on ${wsServer.protocol}://${rpcHost}:${wsServer.port}`)

  let stopped = false
  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true

    platform.logger.info('Shutting down...')

    // Notify connected clients before closing connections
    try {
      wsServer.push('server:shuttingDown', { to: 'all' }, {
        reason: 'shutdown',
        graceMs: 2000,
        timestamp: Date.now(),
      })
      // Brief drain period so clients receive the notification
      await new Promise(resolve => setTimeout(resolve, 2000))
    } catch (error) {
      platform.logger.error('[bootstrap] Failed to send shutdown notification:', error)
    }

    try {
      modelRefreshService.stopAll?.()
    } catch (error) {
      platform.logger.error('[bootstrap] Failed to stop model refresh service:', error)
    }

    try {
      await options.cleanupSessionManager?.(sessionManager)
    } catch (error) {
      platform.logger.error('[bootstrap] Failed to clean up session manager:', error)
    }

    try {
      wsServer.close()
    } catch (error) {
      platform.logger.error('[bootstrap] Failed to close WS server:', error)
    }

    releaseServerLock(serverLockFile)
  }

  return {
    platform,
    sessionManager,
    wsServer,
    host: rpcHost,
    port: wsServer.port,
    protocol: wsServer.protocol,
    token: serverToken,
    serverHandlerContext,
    stop,
  }
}

// ---------------------------------------------------------------------------
// HTTP Health Endpoint (opt-in, for load balancers / k8s probes)
// ---------------------------------------------------------------------------

export interface HealthHttpServerOptions {
  port: number
  deps: { sessionManager: { getWorkspaces(): unknown[] } }
  wsServer: WsRpcServer
  platform: PlatformServices
}

/**
 * Start a minimal HTTP server for health/status probes.
 * Only starts if port > 0. Returns a cleanup function.
 */
export async function startHealthHttpServer(options: HealthHttpServerOptions): Promise<{ stop: () => void } | null> {
  if (options.port <= 0) return null

  // Dynamic import — getHealthCheck uses HandlerDeps shape
  const { getHealthCheck } = await import('../handlers/rpc/server')

  const depsLike = { sessionManager: options.deps.sessionManager } as any

  // Use Bun.serve if available, otherwise skip (Node.js/Electron doesn't need HTTP health)
  if (typeof globalThis.Bun !== 'undefined') {
    const server = Bun.serve({
      port: options.port,
      fetch(req: Request) {
        const path = new URL(req.url).pathname
        if (path === '/health') {
          const health = getHealthCheck(depsLike)
          return Response.json(health, {
            status: health.status === 'ok' ? 200 : 503,
          })
        }
        return new Response('Not Found', { status: 404 })
      },
    })

    options.platform.logger.info(`[bootstrap] Health endpoint listening on http://0.0.0.0:${options.port}/health`)

    return {
      stop: () => server.stop(),
    }
  }

  return null
}
