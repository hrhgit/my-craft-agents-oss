import log from 'electron-log/main'
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type {
  MessagingLogContext,
  MessagingLogMeta,
  MessagingLogger,
} from '@mortise/messaging-gateway'

/**
 * Resolve debug mode deterministically across runtimes.
 *
 * Priority:
 * 1) --debug flag always enables debug mode
 * 2) MORTISE_IS_PACKAGED env (when explicitly set)
 * 3) Electron runtime heuristic (defaultApp => dev, otherwise packaged)
 * 4) Non-Electron runtimes default to debug mode (headless Bun / node --check)
 */
function resolveDebugMode(): boolean {
  if (process.env.MORTISE_E2E_DEBUG_LOGS === '1') return true
  if (process.argv.includes('--debug')) return true

  const packagedEnv = process.env.MORTISE_IS_PACKAGED
  if (packagedEnv === 'true') return false
  if (packagedEnv === 'false') return true

  const isElectronRuntime = typeof process.versions?.electron === 'string'
  if (isElectronRuntime) {
    if (process.defaultApp) return true
    return false
  }

  return true
}

export const isDebugMode = resolveDebugMode()

// Configure transports based on debug mode
if (isDebugMode) {
  // JSON format for file (agent-parseable)
  // Note: format expects (params: FormatParams) => any[], where params.message has the LogMessage fields
  log.transports.file.format = ({ message }) => [
    JSON.stringify({
      timestamp: message.date.toISOString(),
      level: message.level,
      scope: message.scope,
      message: message.data,
    }),
  ]

  log.transports.file.maxSize = 5 * 1024 * 1024 // 5MB

  // Console output in debug mode with readable format
  // Note: format must return an array - electron-log's transformStyles calls .reduce() on it
  log.transports.console.format = ({ message }) => {
    const scope = message.scope ? `[${message.scope}]` : ''
    const level = message.level.toUpperCase().padEnd(5)
    const data = message.data
      .map((d: unknown) => (typeof d === 'object' ? JSON.stringify(d) : String(d)))
      .join(' ')
    return [`${message.date.toISOString()} ${level} ${scope} ${data}`]
  }
  log.transports.console.level = 'debug'
} else {
  // Disable file and console transports in production
  log.transports.file.level = false
  log.transports.console.level = false
}

// Export scoped loggers for different modules
export const mainLog = log.scope('main')
export const sessionLog = log.scope('session')
export const handlerLog = log.scope('handler')
export const windowLog = log.scope('window')
export const agentLog = log.scope('agent')
export const searchLog = log.scope('search')

const CONFIG_DIR = process.env.MORTISE_CONFIG_DIR || join(homedir(), '.mortise')

export type DedicatedLogLevel = 'info' | 'warn' | 'error'

export interface DedicatedLogQueueStats {
  pending: number
  pendingBytes: number
  dropped: Readonly<Record<DedicatedLogLevel, number>>
  failed: number
  highWaterMark: number
  highWaterBytes: number
  draining: boolean
}

export interface DedicatedLogWriterOptions {
  path: string
  maxBytes: number
  maxPendingLines?: number
  maxPendingBytes?: number
  onFailure?: (error: unknown) => void
}

interface PendingDedicatedLogLine {
  level: DedicatedLogLevel
  line: string
  bytes: number
}

const DEFAULT_DEDICATED_LOG_MAX_PENDING_LINES = 1_024
const MIN_DEDICATED_LOG_MAX_PENDING_BYTES = 1024 * 1024
const DEDICATED_LOG_DRAIN_BATCH_SIZE = 64

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/**
 * Single-file asynchronous writer used by always-on Electron diagnostics.
 * Enqueue never performs filesystem work; the bounded queue prevents a log
 * storm from growing main-process memory without limit.
 */
export class BoundedAsyncDedicatedLogWriter {
  private readonly path: string
  private readonly backupPath: string
  private readonly maxBytes: number
  private readonly maxPendingLines: number
  private readonly maxPendingBytes: number
  private readonly onFailure: (error: unknown) => void
  private readonly pending: PendingDedicatedLogLine[] = []
  private readonly dropped: Record<DedicatedLogLevel, number> = { info: 0, warn: 0, error: 0 }
  private draining = false
  private active: PendingDedicatedLogLine[] = []
  private pendingBytes = 0
  private activeBytes = 0
  private failed = 0
  private highWaterMark = 0
  private highWaterBytes = 0
  private unreportedFailure: unknown = null
  private waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> = []

  constructor(options: DedicatedLogWriterOptions) {
    this.path = options.path
    this.backupPath = `${options.path}.1`
    this.maxBytes = options.maxBytes
    this.maxPendingLines = options.maxPendingLines ?? DEFAULT_DEDICATED_LOG_MAX_PENDING_LINES
    this.maxPendingBytes = options.maxPendingBytes
      ?? Math.max(options.maxBytes * 2, MIN_DEDICATED_LOG_MAX_PENDING_BYTES)
    this.onFailure = options.onFailure ?? (() => {})
    if (this.maxBytes <= 0) throw new Error('Dedicated log maxBytes must be positive')
    if (this.maxPendingLines <= 0) throw new Error('Dedicated log maxPendingLines must be positive')
    if (this.maxPendingBytes <= 0) throw new Error('Dedicated log maxPendingBytes must be positive')
  }

  enqueue(level: DedicatedLogLevel, line: string): boolean {
    const item = { level, line, bytes: Buffer.byteLength(line) }
    while (
      this.pending.length + this.active.length >= this.maxPendingLines
      || this.pendingBytes + this.activeBytes + item.bytes > this.maxPendingBytes
    ) {
      const evictionIndex = this.findEvictionIndex(level)
      if (evictionIndex < 0) {
        this.dropped[level] += 1
        return false
      }
      const [evicted] = this.pending.splice(evictionIndex, 1)
      if (evicted) {
        this.pendingBytes -= evicted.bytes
        this.dropped[evicted.level] += 1
      }
    }

    this.pending.push(item)
    this.pendingBytes += item.bytes
    this.highWaterMark = Math.max(this.highWaterMark, this.pending.length + this.active.length)
    this.highWaterBytes = Math.max(this.highWaterBytes, this.pendingBytes + this.activeBytes)
    this.scheduleDrain()
    return true
  }

  async flush(): Promise<void> {
    if (!this.draining && this.pending.length === 0) {
      this.throwUnreportedFailure()
      return
    }
    await new Promise<void>((resolve, reject) => this.waiters.push({ resolve, reject }))
  }

  /** Reserved for process exit, after the event loop can no longer drain. */
  flushSync(): void {
    const remaining = [...this.active, ...this.pending]
    this.active = []
    this.activeBytes = 0
    this.pending.length = 0
    this.pendingBytes = 0
    for (const item of remaining) {
      try {
        this.appendLineSync(item)
      } catch (error) {
        this.recordFailure(error)
      }
    }
  }

  stats(): DedicatedLogQueueStats {
    return {
      pending: this.pending.length + this.active.length,
      pendingBytes: this.pendingBytes + this.activeBytes,
      dropped: { ...this.dropped },
      failed: this.failed,
      highWaterMark: this.highWaterMark,
      highWaterBytes: this.highWaterBytes,
      draining: this.draining,
    }
  }

  private findEvictionIndex(incoming: DedicatedLogLevel): number {
    const candidates: DedicatedLogLevel[] = incoming === 'error'
      ? ['info', 'warn']
      : incoming === 'warn'
        ? ['info']
        : []
    for (const candidate of candidates) {
      const index = this.pending.findIndex(item => item.level === candidate)
      if (index >= 0) return index
    }
    return -1
  }

  private scheduleDrain(): void {
    if (this.draining) return
    this.draining = true
    setImmediate(() => void this.drain())
  }

  private async drain(): Promise<void> {
    try {
      while (this.pending.length > 0) {
        this.active = this.pending.splice(0, DEDICATED_LOG_DRAIN_BATCH_SIZE)
        this.activeBytes = this.active.reduce((total, item) => total + item.bytes, 0)
        this.pendingBytes -= this.activeBytes
        try {
          await this.appendLines(this.active)
        } catch (error) {
          this.recordFailure(error, this.active.length)
        } finally {
          this.active = []
          this.activeBytes = 0
        }
      }
    } finally {
      this.draining = false
      if (this.pending.length > 0) {
        this.scheduleDrain()
        return
      }
      this.settleWaiters()
    }
  }

  private async appendLines(items: readonly PendingDedicatedLogLine[]): Promise<void> {
    if (items.length === 0) return
    await mkdir(dirname(this.path), { recursive: true })
    let currentSize = await this.currentSize()
    let lines: string[] = []
    let linesBytes = 0

    const appendPending = async () => {
      if (lines.length === 0) return
      await appendFile(this.path, lines.join(''), 'utf8')
      currentSize += linesBytes
      lines = []
      linesBytes = 0
    }

    for (const item of items) {
      if (currentSize + linesBytes > 0 && currentSize + linesBytes + item.bytes > this.maxBytes) {
        await appendPending()
        await rm(this.backupPath, { force: true })
        await rename(this.path, this.backupPath)
        currentSize = 0
      }
      lines.push(item.line)
      linesBytes += item.bytes
    }
    await appendPending()
  }

  private appendLineSync(item: PendingDedicatedLogLine): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const currentSize = existsSync(this.path) ? statSync(this.path).size : 0
    if (currentSize > 0 && currentSize + item.bytes > this.maxBytes) {
      rmSync(this.backupPath, { force: true })
      renameSync(this.path, this.backupPath)
    }
    appendFileSync(this.path, item.line, 'utf8')
  }

  private async currentSize(): Promise<number> {
    return await pathExists(this.path) ? (await stat(this.path)).size : 0
  }

  private recordFailure(error: unknown, count = 1): void {
    this.failed += count
    this.unreportedFailure ??= error
    try {
      this.onFailure(error)
    } catch {
      // Failure reporting cannot break the writer drain.
    }
  }

  private settleWaiters(): void {
    const waiters = this.waiters.splice(0)
    if (waiters.length === 0) return
    const failure = this.unreportedFailure
    this.unreportedFailure = null
    for (const waiter of waiters) {
      if (failure === null) waiter.resolve()
      else waiter.reject(failure)
    }
  }

  private throwUnreportedFailure(): void {
    if (this.unreportedFailure === null) return
    const failure = this.unreportedFailure
    this.unreportedFailure = null
    throw failure
  }
}

/**
 * Dedicated messaging gateway log.
 *
 * Kept outside the Electron-managed logs folder so messaging issues can be
 * inspected independently at a stable path across debug and production builds.
 */
export const messagingGatewayLogPath = join(CONFIG_DIR, 'logs', 'messaging-gateway.log')
const MESSAGING_LOG_MAX_BYTES = 5 * 1024 * 1024 // 5MB

const messagingGatewayLogWriter = new BoundedAsyncDedicatedLogWriter({
  path: messagingGatewayLogPath,
  maxBytes: MESSAGING_LOG_MAX_BYTES,
  onFailure: error => mainLog.warn(
    '[messaging-gateway] failed to write dedicated log entry',
    normalizeLogValue(error),
  ),
})

function normalizeLogValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[truncated]'
  if (value instanceof Error) {
    const out: Record<string, unknown> = {
      name: value.name,
      message: value.message,
    }
    const code = (value as { code?: unknown }).code
    if (code !== undefined) out.code = code
    const cause = (value as { cause?: unknown }).cause
    if (cause !== undefined) out.cause = normalizeLogValue(cause, depth + 1)
    if (value.stack) out.stack = value.stack
    return out
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeLogValue(item, depth + 1))
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value)) {
      out[key] = normalizeLogValue(inner, depth + 1)
    }
    return out
  }
  return value
}

function normalizeMeta(meta?: MessagingLogMeta): Record<string, unknown> {
  if (!meta) return {}
  const normalized = normalizeLogValue(meta)
  return normalized && typeof normalized === 'object' && !Array.isArray(normalized)
    ? normalized as Record<string, unknown>
    : { meta: normalized }
}

function writeMessagingGatewayLog(
  level: 'info' | 'warn' | 'error',
  context: MessagingLogContext,
  message: string,
  meta?: MessagingLogMeta,
): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    scope: 'messaging-gateway',
    ...context,
    ...normalizeMeta(meta),
    message,
  }

  const line = JSON.stringify(entry) + '\n'
  messagingGatewayLogWriter.enqueue(level, line)

  if (level === 'error') {
    mainLog.error('[messaging-gateway]', message, entry)
  } else if (level === 'warn') {
    mainLog.warn('[messaging-gateway]', message, entry)
  } else if (isDebugMode) {
    mainLog.info('[messaging-gateway]', message, entry)
  }
}

class StructuredMessagingGatewayLogger implements MessagingLogger {
  constructor(private readonly context: MessagingLogContext = {}) {}

  child(context: MessagingLogContext): MessagingLogger {
    return new StructuredMessagingGatewayLogger({
      ...this.context,
      ...context,
    })
  }

  info(message: string, meta?: MessagingLogMeta): void {
    writeMessagingGatewayLog('info', this.context, message, meta)
  }

  warn(message: string, meta?: MessagingLogMeta): void {
    writeMessagingGatewayLog('warn', this.context, message, meta)
  }

  error(message: string, meta?: MessagingLogMeta): void {
    writeMessagingGatewayLog('error', this.context, message, meta)
  }
}

export const messagingGatewayLog: MessagingLogger = new StructuredMessagingGatewayLogger({
  component: 'root',
})

/**
 * Dedicated auto-update log.
 *
 * In packaged builds the Electron file/console transports are disabled (see
 * above), so every `[auto-update]` / `[update-flow]` diagnostic is dropped —
 * leaving update-install failures undiagnosable in the field (see #891). This
 * dedicated, always-on rotating log records the update lifecycle at a stable
 * path regardless of debug mode, mirroring the messaging-gateway log above.
 */
export const autoUpdateLogPath = join(CONFIG_DIR, 'logs', 'auto-update.log')
const AUTO_UPDATE_LOG_MAX_BYTES = 2 * 1024 * 1024 // 2MB

const autoUpdateLogWriter = new BoundedAsyncDedicatedLogWriter({
  path: autoUpdateLogPath,
  maxBytes: AUTO_UPDATE_LOG_MAX_BYTES,
  onFailure: error => mainLog.warn(
    '[auto-update] failed to write dedicated log entry',
    normalizeLogValue(error),
  ),
})

function writeAutoUpdateLog(level: 'info' | 'warn' | 'error', message: string, meta?: unknown): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    scope: 'auto-update',
    ...(meta !== undefined ? { meta: normalizeLogValue(meta) } : {}),
    message,
  }

  const line = JSON.stringify(entry) + '\n'
  autoUpdateLogWriter.enqueue(level, line)

  // Mirror to the Electron logger too (a no-op in production where transports
  // are disabled, but keeps --debug console/file output intact).
  if (level === 'error') {
    mainLog.error('[auto-update]', message, entry)
  } else if (level === 'warn') {
    mainLog.warn('[auto-update]', message, entry)
  } else if (isDebugMode) {
    mainLog.info('[auto-update]', message, entry)
  }
}

/** Always-on structured logger for the auto-update lifecycle (see #891). */
export const autoUpdateLog = {
  info: (message: string, meta?: unknown) => writeAutoUpdateLog('info', message, meta),
  warn: (message: string, meta?: unknown) => writeAutoUpdateLog('warn', message, meta),
  error: (message: string, meta?: unknown) => writeAutoUpdateLog('error', message, meta),
}

export function getAutoUpdateLogFilePath(): string {
  return autoUpdateLogPath
}

/**
 * Get the path to the current Electron main log file.
 * Returns undefined if file logging is disabled.
 */
export function getLogFilePath(): string | undefined {
  if (!isDebugMode) return undefined
  return log.transports.file.getFile()?.path
}

export function getMessagingGatewayLogFilePath(): string {
  return messagingGatewayLogPath
}

/** Flush both always-on dedicated logs during an orderly committed exit. */
export async function flushDedicatedLogs(): Promise<void> {
  const results = await Promise.allSettled([
    messagingGatewayLogWriter.flush(),
    autoUpdateLogWriter.flush(),
  ])
  const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Failed to flush dedicated Electron logs')
  }
}

/** Final best-effort fallback for the synchronous process exit event only. */
export function flushDedicatedLogsSync(): void {
  messagingGatewayLogWriter.flushSync()
  autoUpdateLogWriter.flushSync()
}

export function getDedicatedLogQueueStats(): {
  messagingGateway: DedicatedLogQueueStats
  autoUpdate: DedicatedLogQueueStats
} {
  return {
    messagingGateway: messagingGatewayLogWriter.stats(),
    autoUpdate: autoUpdateLogWriter.stats(),
  }
}

export default log
