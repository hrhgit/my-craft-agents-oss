import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import {
  appendFile,
  mkdir,
  open,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import pino, { type DestinationStream } from 'pino';
import { lock, lockSync } from 'proper-lockfile';
import { CONFIG_DIR } from '../config/paths.ts';

export type RuntimeLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface RuntimeLogCorrelation {
  traceId?: string;
  sessionId?: string;
  runtimeId?: string;
  clientId?: string;
  toolUseId?: string;
  requestId?: string;
  browserInstanceId?: string;
}

export interface RuntimeLogProcessIdentity {
  processId: number;
  processRole: string;
  processInstanceId: string;
  productVersion: string;
  buildId: string;
  backendKind: string;
}

export interface RuntimeLogEnvelopeV1 extends RuntimeLogProcessIdentity {
  schemaVersion: 1;
  eventId: string;
  timestamp: string;
  level: RuntimeLogLevel;
  scope: string;
  event: string;
  message?: string;
  correlation?: RuntimeLogCorrelation;
  data?: unknown;
}

export interface RuntimeLogEntryInput {
  scope: string;
  event: string;
  message?: string;
  /** Preferred structured event payload. */
  data?: unknown;
  /** Backward-compatible alias for data. */
  meta?: unknown;
  correlation?: RuntimeLogCorrelation;
}

export interface RuntimeLoggerEventInput {
  event: string;
  message?: string;
  data?: unknown;
  meta?: unknown;
  correlation?: RuntimeLogCorrelation;
}

export interface RuntimeLoggerBaseContext {
  correlation?: RuntimeLogCorrelation;
}

export interface RuntimeLogger {
  log(level: RuntimeLogLevel, input: RuntimeLoggerEventInput): void;
  debug(input: RuntimeLoggerEventInput): void;
  info(input: RuntimeLoggerEventInput): void;
  warn(input: RuntimeLoggerEventInput): void;
  error(input: RuntimeLoggerEventInput): void;
}

export const RUNTIME_LOG_PATH = join(CONFIG_DIR, 'logs', 'runtime.log');

const RUNTIME_LOG_MAX_BYTES = 5 * 1024 * 1024;
const RUNTIME_LOG_BACKUP_COUNT = 5;
const MAX_DEPTH = 6;
const MAX_COLLECTION_ITEMS = 100;
const MAX_NORMALIZED_NODES = 2_000;
const MAX_STRING_LENGTH = 16 * 1024;
const MAX_ENTRY_BYTES = 256 * 1024;
const FALLBACK_MAX_LENGTH = 512;
const FALLBACK_THROTTLE_MS = 10_000;
const MAX_PENDING_LINES = 2_048;
const DRAIN_BATCH_SIZE = 32;
const MAX_WRITE_BATCH_BYTES = 1024 * 1024;
const REDACTED = '[redacted]';
const TRUNCATED = '[truncated]';
const PROCESS_INSTANCE_ID = randomUUID();

let lastFallbackAt = 0;

function runtimeProcessIdentity(): RuntimeLogProcessIdentity {
  return {
    processId: process.pid,
    processRole: process.env.MORTISE_PROCESS_ROLE || process.title || 'unknown',
    processInstanceId: PROCESS_INSTANCE_ID,
    productVersion: process.env.MORTISE_PRODUCT_VERSION || process.env.npm_package_version || 'unknown',
    buildId: process.env.MORTISE_BUILD_ID || 'unknown',
    backendKind: process.env.MORTISE_BACKEND_KIND || 'unknown',
  };
}

function isSensitiveKey(key: string): boolean {
  const compact = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return compact === 'key'
    || compact.endsWith('apikey')
    || compact.endsWith('token')
    || compact.endsWith('secret')
    || compact.endsWith('password')
    || compact.endsWith('authorization')
    || compact.endsWith('cookie')
    || compact.endsWith('privatekey')
    || compact.endsWith('credential');
}

export function redactRuntimeLogString(value: string): string {
  const redacted = value
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/g, REDACTED)
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, `$1 ${REDACTED}`)
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{12,}\b/g, REDACTED)
    .replace(/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{12,}\b/gi, REDACTED)
    .replace(/\b(?:gh[opusr]|github_pat)_[A-Za-z0-9_]{12,}\b/gi, REDACTED)
    .replace(/\b(?:glpat|npm)_[A-Za-z0-9_-]{12,}\b/gi, REDACTED)
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gi, REDACTED)
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, REDACTED)
    .replace(/\bAIza[A-Za-z0-9_-]{30,}\b/g, REDACTED)
    .replace(/\b((?:password|pwd|secret|token|api[_-]?key)=)[^\s,;&]+/gi, `$1${REDACTED}`)
    .replace(
      /([?&](?:access[_-]?token|refresh[_-]?token|api[_-]?key|token|key|secret|password|authorization)=)[^&#\s]*/gi,
      `$1${REDACTED}`,
    );
  if (redacted.length <= MAX_STRING_LENGTH) return redacted;
  return `${redacted.slice(0, MAX_STRING_LENGTH)}${TRUNCATED}`;
}

interface NormalizeState {
  nodes: number;
}

function normalizeValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  state: NormalizeState,
): unknown {
  state.nodes += 1;
  if (state.nodes > MAX_NORMALIZED_NODES || depth > MAX_DEPTH) return TRUNCATED;
  if (typeof value === 'string') return redactRuntimeLogString(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'symbol') return value.toString();
  if (typeof value === 'function') return `[function ${value.name || 'anonymous'}]`;
  if (value === undefined || value === null || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (value instanceof Error) {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    const out: Record<string, unknown> = {
      name: redactRuntimeLogString(value.name),
      message: redactRuntimeLogString(value.message),
    };
    const code = (value as { code?: unknown }).code;
    if (code !== undefined) out.code = normalizeValue(code, depth + 1, seen, state);
    const cause = (value as { cause?: unknown }).cause;
    if (cause !== undefined) out.cause = normalizeValue(cause, depth + 1, seen, state);
    if (value.stack) out.stack = redactRuntimeLogString(value.stack);
    for (const [key, inner] of Object.entries(value).slice(0, MAX_COLLECTION_ITEMS)) {
      if (key in out) continue;
      out[key] = isSensitiveKey(key) ? REDACTED : normalizeValue(inner, depth + 1, seen, state);
    }
    seen.delete(value);
    return out;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    const out = value
      .slice(0, MAX_COLLECTION_ITEMS)
      .map((item) => normalizeValue(item, depth + 1, seen, state));
    if (value.length > MAX_COLLECTION_ITEMS) out.push(TRUNCATED);
    seen.delete(value);
    return out;
  }
  if (typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    const entries = Object.entries(value);
    const out: Record<string, unknown> = {};
    for (const [key, inner] of entries.slice(0, MAX_COLLECTION_ITEMS)) {
      out[key] = isSensitiveKey(key) ? REDACTED : normalizeValue(inner, depth + 1, seen, state);
    }
    if (entries.length > MAX_COLLECTION_ITEMS) out.__truncated__ = true;
    seen.delete(value);
    return out;
  }
  return String(value);
}

export function normalizeRuntimeLogValue(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  return normalizeValue(value, depth, seen, { nodes: 0 });
}

function normalizeCorrelation(correlation: RuntimeLogCorrelation | undefined): RuntimeLogCorrelation | undefined {
  if (!correlation) return undefined;
  const normalized: RuntimeLogCorrelation = {};
  for (const [key, value] of Object.entries(correlation)) {
    if (typeof value === 'string' && value.length > 0) {
      normalized[key as keyof RuntimeLogCorrelation] = redactRuntimeLogString(value);
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function rotateRuntimeLog(): void {
  const oldest = `${RUNTIME_LOG_PATH}.${RUNTIME_LOG_BACKUP_COUNT}`;
  if (existsSync(oldest)) rmSync(oldest, { force: true });
  for (let index = RUNTIME_LOG_BACKUP_COUNT - 1; index >= 1; index -= 1) {
    const source = `${RUNTIME_LOG_PATH}.${index}`;
    if (existsSync(source)) renameSync(source, `${RUNTIME_LOG_PATH}.${index + 1}`);
  }
  if (existsSync(RUNTIME_LOG_PATH)) renameSync(RUNTIME_LOG_PATH, `${RUNTIME_LOG_PATH}.1`);
}

function acquireRuntimeLogLock(): () => void {
  let lastError: unknown;
  for (let attempt = 0; attempt <= 100; attempt += 1) {
    try {
      return lockSync(RUNTIME_LOG_PATH, {
        realpath: false,
        stale: 10_000,
      });
    } catch (error) {
      lastError = error;
      if (attempt === 100) break;
      const waitMs = Math.min(1 + attempt, 5);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
    }
  }
  throw lastError;
}

function appendRuntimeLogLine(line: string): void {
  mkdirSync(dirname(RUNTIME_LOG_PATH), { recursive: true });
  closeSync(openSync(RUNTIME_LOG_PATH, 'a'));
  const release = acquireRuntimeLogLock();
  try {
    const currentSize = existsSync(RUNTIME_LOG_PATH) ? statSync(RUNTIME_LOG_PATH).size : 0;
    if (currentSize > 0 && currentSize + Buffer.byteLength(line) > RUNTIME_LOG_MAX_BYTES) {
      rotateRuntimeLog();
    }
    appendFileSync(RUNTIME_LOG_PATH, line, 'utf8');
  } finally {
    release();
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function rotateRuntimeLogAsync(): Promise<void> {
  const oldest = `${RUNTIME_LOG_PATH}.${RUNTIME_LOG_BACKUP_COUNT}`;
  await rm(oldest, { force: true });
  for (let index = RUNTIME_LOG_BACKUP_COUNT - 1; index >= 1; index -= 1) {
    const source = `${RUNTIME_LOG_PATH}.${index}`;
    if (await pathExists(source)) await rename(source, `${RUNTIME_LOG_PATH}.${index + 1}`);
  }
  if (await pathExists(RUNTIME_LOG_PATH)) await rename(RUNTIME_LOG_PATH, `${RUNTIME_LOG_PATH}.1`);
}

async function appendRuntimeLogLineAsync(line: string): Promise<void> {
  await mkdir(dirname(RUNTIME_LOG_PATH), { recursive: true });
  const handle = await open(RUNTIME_LOG_PATH, 'a');
  await handle.close();
  const release = await lock(RUNTIME_LOG_PATH, {
    realpath: false,
    stale: 10_000,
    retries: {
      retries: 100,
      factor: 1,
      minTimeout: 1,
      maxTimeout: 5,
      randomize: false,
    },
  });
  try {
    const currentSize = (await stat(RUNTIME_LOG_PATH)).size;
    if (currentSize > 0 && currentSize + Buffer.byteLength(line) > RUNTIME_LOG_MAX_BYTES) {
      await rotateRuntimeLogAsync();
    }
    await appendFile(RUNTIME_LOG_PATH, line, 'utf8');
  } finally {
    await release();
  }
}

/**
 * Keep filesystem rotation and locking off the caller's hot path. The queue is
 * deliberately bounded: debug records may be dropped during a diagnostic
 * storm, while warning/error records are retained whenever a lower-priority
 * record is available to evict.
 */
class RuntimeLogWriter {
  private readonly pending: Array<{ line: string; level: RuntimeLogLevel }> = [];
  private draining = false;
  private readonly dropped: Record<RuntimeLogLevel, number> = { debug: 0, info: 0, warn: 0, error: 0 };
  private failed = 0;
  private highWaterMark = 0;
  private waiters: Array<() => void> = [];

  enqueue(line: string): void {
    const level = this.readLevel(line);
    if (this.pending.length >= MAX_PENDING_LINES) {
      const evictionLevels: RuntimeLogLevel[] = level === 'error'
        ? ['debug', 'info', 'warn', 'error']
        : level === 'warn'
          ? ['debug', 'info']
          : level === 'info'
            ? ['debug']
            : [];
      const evictionIndex = evictionLevels
        .map(candidate => this.pending.findIndex(item => item.level === candidate))
        .find(index => index >= 0) ?? -1;
      if (evictionIndex < 0) {
        this.dropped[level] += 1;
        return;
      }
      const [evicted] = this.pending.splice(evictionIndex, 1);
      if (evicted) this.dropped[evicted.level] += 1;
    }
    this.pending.push({ line, level });
    this.highWaterMark = Math.max(this.highWaterMark, this.pending.length);
    this.schedule();
  }

  async flush(): Promise<void> {
    if (!this.pending.length && !this.draining) return;
    await new Promise<void>(resolve => this.waiters.push(resolve));
    if (this.pending.length || this.draining) return this.flush();
  }

  flushSync(): void {
    while (this.pending.length) {
      const batch = this.takeBatch();
      try {
        appendRuntimeLogLine(batch.map(item => item.line).join(''));
      } catch (error) {
        this.failed += batch.length;
        reportRuntimeLogFailure(error);
      }
    }
  }

  stats(): {
    pending: number;
    dropped: Readonly<Record<RuntimeLogLevel, number>>;
    failed: number;
    highWaterMark: number;
    draining: boolean;
  } {
    return {
      pending: this.pending.length,
      dropped: { ...this.dropped },
      failed: this.failed,
      highWaterMark: this.highWaterMark,
      draining: this.draining,
    };
  }

  private readLevel(line: string): RuntimeLogLevel {
    const match = /"level":"(debug|info|warn|error)"/.exec(line);
    return (match?.[1] as RuntimeLogLevel | undefined) ?? 'info';
  }

  private takeBatch(): Array<{ line: string; level: RuntimeLogLevel }> {
    const batch: Array<{ line: string; level: RuntimeLogLevel }> = [];
    let bytes = 0;
    while (batch.length < DRAIN_BATCH_SIZE && this.pending.length) {
      const next = this.pending[0]!;
      const nextBytes = Buffer.byteLength(next.line);
      if (batch.length && bytes + nextBytes > MAX_WRITE_BATCH_BYTES) break;
      batch.push(this.pending.shift()!);
      bytes += nextBytes;
    }
    return batch;
  }

  private schedule(): void {
    if (this.draining) return;
    this.draining = true;
    setImmediate(() => this.drain());
  }

  private async drain(): Promise<void> {
    try {
      const batch = this.takeBatch();
      if (batch.length) {
        try {
          await appendRuntimeLogLineAsync(batch.map(item => item.line).join(''));
        } catch (error) {
          this.failed += batch.length;
          reportRuntimeLogFailure(error);
        }
      }
    } finally {
      if (this.pending.length) {
        setImmediate(() => this.drain());
        return;
      }
      this.draining = false;
      const waiters = this.waiters.splice(0);
      for (const resolve of waiters) resolve();
    }
  }
}

function reportRuntimeLogFailure(error: unknown): void {
  const now = Date.now();
  if (now - lastFallbackAt < FALLBACK_THROTTLE_MS) return;
  lastFallbackAt = now;
  try {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const text = redactRuntimeLogString(detail).slice(0, FALLBACK_MAX_LENGTH);
    process.stderr.write(`[mortise runtime-log] write failed: ${text}\n`);
  } catch {
    // The diagnostic fallback must not affect the runtime either.
  }
}

function boundEnvelope(entry: RuntimeLogEnvelopeV1): RuntimeLogEnvelopeV1 {
  const serializedBytes = Buffer.byteLength(JSON.stringify(entry));
  if (serializedBytes <= MAX_ENTRY_BYTES) return entry;
  return {
    ...entry,
    data: {
      truncated: true,
      originalBytes: serializedBytes,
      reason: 'runtime_log_entry_exceeded_limit',
    },
  };
}

const runtimeLogWriter = new RuntimeLogWriter();

const runtimeLogDestination: DestinationStream = {
  write(line: string): void {
    runtimeLogWriter.enqueue(line.endsWith('\n') ? line : `${line}\n`);
  },
};

const runtimePinoLogger = pino({
  base: null,
  level: 'debug',
  timestamp: false,
  formatters: {
    level: (label) => ({ level: label }),
  },
}, runtimeLogDestination);

export function writeRuntimeLog(level: RuntimeLogLevel, input: RuntimeLogEntryInput): void {
  try {
    const rawData = input.data !== undefined ? input.data : input.meta;
    const envelope: RuntimeLogEnvelopeV1 = {
      schemaVersion: 1,
      eventId: randomUUID(),
      timestamp: new Date().toISOString(),
      level,
      scope: redactRuntimeLogString(input.scope),
      event: redactRuntimeLogString(input.event),
      ...runtimeProcessIdentity(),
      ...(input.message ? { message: redactRuntimeLogString(input.message) } : {}),
      ...(input.correlation ? { correlation: normalizeCorrelation(input.correlation) } : {}),
      ...(rawData !== undefined ? { data: normalizeRuntimeLogValue(rawData) } : {}),
    };
    if (envelope.correlation === undefined) delete envelope.correlation;
    runtimePinoLogger[level](boundEnvelope(envelope));
  } catch (error) {
    reportRuntimeLogFailure(error);
  }
}

/** Flush queued runtime records before an orderly process shutdown. */
export async function flushRuntimeLogs(): Promise<void> {
  await runtimeLogWriter.flush();
}

/** Reserved for process exit hooks where asynchronous work can no longer run. */
export function flushRuntimeLogsSync(): void {
  runtimeLogWriter.flushSync();
}

export function getRuntimeLogQueueStats(): {
  pending: number;
  dropped: Readonly<Record<RuntimeLogLevel, number>>;
  failed: number;
  highWaterMark: number;
  draining: boolean;
} {
  return runtimeLogWriter.stats();
}

export function createRuntimeLogger(
  scope: string,
  baseContext: RuntimeLoggerBaseContext = {},
): RuntimeLogger {
  const write = (level: RuntimeLogLevel, input: RuntimeLoggerEventInput): void => {
    writeRuntimeLog(level, {
      ...input,
      scope,
      correlation: {
        ...baseContext.correlation,
        ...input.correlation,
      },
    });
  };
  return {
    log: write,
    debug: (input) => write('debug', input),
    info: (input) => write('info', input),
    warn: (input) => write('warn', input),
    error: (input) => write('error', input),
  };
}

export function getRuntimeLogFilePath(): string {
  return RUNTIME_LOG_PATH;
}
