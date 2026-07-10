import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CONFIG_DIR } from '../config/paths.ts';

export type RuntimeLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface RuntimeLogEntryInput {
  scope: string;
  event: string;
  message?: string;
  meta?: unknown;
}

export const RUNTIME_LOG_PATH = join(CONFIG_DIR, 'logs', 'runtime.log');

const RUNTIME_LOG_BACKUP_PATH = `${RUNTIME_LOG_PATH}.1`;
const RUNTIME_LOG_MAX_BYTES = 5 * 1024 * 1024;

function rotateRuntimeLogIfNeeded(nextLineBytes: number): void {
  if (!existsSync(RUNTIME_LOG_PATH)) return;

  try {
    const currentSize = statSync(RUNTIME_LOG_PATH).size;
    if (currentSize + nextLineBytes <= RUNTIME_LOG_MAX_BYTES) return;

    if (existsSync(RUNTIME_LOG_BACKUP_PATH)) {
      rmSync(RUNTIME_LOG_BACKUP_PATH, { force: true });
    }
    renameSync(RUNTIME_LOG_PATH, RUNTIME_LOG_BACKUP_PATH);
  } catch {
    // Logging must never break the runtime path it is trying to diagnose.
  }
}

export function normalizeRuntimeLogValue(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (depth > 6) return '[truncated]';
  if (value instanceof Error) {
    const out: Record<string, unknown> = {
      name: value.name,
      message: value.message,
    };
    const code = (value as { code?: unknown }).code;
    if (code !== undefined) out.code = normalizeRuntimeLogValue(code, depth + 1, seen);
    const cause = (value as { cause?: unknown }).cause;
    if (cause !== undefined) out.cause = normalizeRuntimeLogValue(cause, depth + 1, seen);
    if (value.stack) out.stack = value.stack;
    return out;
  }
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) {
    return value.map((item) => normalizeRuntimeLogValue(item, depth + 1, seen));
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = normalizeRuntimeLogValue(inner, depth + 1, seen);
    }
    seen.delete(value);
    return out;
  }
  return value;
}

export function writeRuntimeLog(level: RuntimeLogLevel, input: RuntimeLogEntryInput): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    scope: input.scope,
    event: input.event,
    ...(input.message ? { message: input.message } : {}),
    ...(input.meta !== undefined ? { meta: normalizeRuntimeLogValue(input.meta) } : {}),
  };

  let line: string;
  try {
    line = JSON.stringify(entry) + '\n';
  } catch {
    line = JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'error',
      scope: 'runtime-log',
      event: 'serialize_failed',
      message: `Failed to serialize runtime log entry for ${input.scope}:${input.event}`,
    }) + '\n';
  }

  try {
    mkdirSync(dirname(RUNTIME_LOG_PATH), { recursive: true });
    rotateRuntimeLogIfNeeded(Buffer.byteLength(line));
    appendFileSync(RUNTIME_LOG_PATH, line, 'utf8');
  } catch {
    // Best-effort diagnostics only.
  }
}

export function getRuntimeLogFilePath(): string {
  return RUNTIME_LOG_PATH;
}
