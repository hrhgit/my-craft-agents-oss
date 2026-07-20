import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  normalizeRuntimeLogValue,
  redactRuntimeLogString,
  type RuntimeLogEnvelopeV1,
} from '../runtime-log.ts';

const runtimeLogModuleUrl = new URL('../runtime-log.ts', import.meta.url).href;

function removeTempDir(path: string): void {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}

async function runChild(script: string, configDir: string): Promise<void> {
  const result = await runChildResult(script, configDir);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stderr).toBe('');
}

async function runChildResult(
  script: string,
  configDir: string,
): Promise<{ exitCode: number; stderr: string }> {
  const child = Bun.spawn([process.execPath, '-e', script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MORTISE_CONFIG_DIR: configDir,
      MORTISE_PROCESS_ROLE: 'runtime-log-test',
      MORTISE_PRODUCT_VERSION: 'test-version',
      MORTISE_BUILD_ID: 'test-build',
      MORTISE_BACKEND_KIND: 'test-backend',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stderr };
}

function readEntries(configDir: string): RuntimeLogEnvelopeV1[] {
  const path = join(configDir, 'logs', 'runtime.log');
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as RuntimeLogEnvelopeV1);
}

describe('runtime log normalization', () => {
  test('normalizes errors, bigint and circular data without throwing', () => {
    const circular: Record<string, unknown> = { count: 42n };
    circular.self = circular;
    const error = Object.assign(new Error('failed'), { code: 'E_TEST', context: circular });

    const normalized = normalizeRuntimeLogValue({ error }) as {
      error: { name: string; message: string; code: string; context: Record<string, unknown> };
    };

    expect(normalized.error.name).toBe('Error');
    expect(normalized.error.message).toBe('failed');
    expect(normalized.error.code).toBe('E_TEST');
    expect(normalized.error.context.count).toBe('42');
    expect(normalized.error.context.self).toBe('[circular]');
  });

  test('redacts sensitive keys and credential-like values at every depth', () => {
    const normalized = normalizeRuntimeLogValue({
      authorization: 'Bearer top-secret-token',
      nested: {
        accessToken: 'secret-access',
        endpoint: 'https://example.test/run?api_key=query-secret&mode=fast',
        note: 'use Bearer another-secret now',
        providerValue: 'sk-abcdefghijklmnopqrstuvwxyz',
        basicAuth: 'Basic dXNlcjpwYXNzd29yZA==',
        privateMaterial: '-----BEGIN PRIVATE KEY-----\nsecret material\n-----END PRIVATE KEY-----',
      },
    }) as Record<string, any>;

    expect(normalized.authorization).toBe('[redacted]');
    expect(normalized.nested.accessToken).toBe('[redacted]');
    expect(normalized.nested.endpoint).toBe('https://example.test/run?api_key=[redacted]&mode=fast');
    expect(normalized.nested.note).toBe('use Bearer [redacted] now');
    expect(normalized.nested.providerValue).toBe('[redacted]');
    expect(normalized.nested.basicAuth).toBe('Basic [redacted]');
    expect(normalized.nested.privateMaterial).toBe('[redacted]');
    expect(redactRuntimeLogString('Authorization: Bearer abc.def')).not.toContain('abc.def');
  });

  test('bounds strings, collections and nesting', () => {
    const normalized = normalizeRuntimeLogValue({
      huge: 'x'.repeat(20_000),
      list: Array.from({ length: 150 }, (_, index) => index),
      deep: { a: { b: { c: { d: { e: { f: { g: 'hidden' } } } } } } },
    }) as Record<string, any>;

    expect(normalized.huge.length).toBeLessThan(17_000);
    expect(normalized.huge).toEndWith('[truncated]');
    expect(normalized.list).toHaveLength(101);
    expect(normalized.list.at(-1)).toBe('[truncated]');
    expect(JSON.stringify(normalized.deep)).toContain('[truncated]');
  });
});

describe('runtime log persistence', () => {
  test('writes V1 envelopes and maps legacy meta to data', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'mortise-runtime-log-'));
    try {
      await runChild(`
        import { createRuntimeLogger, writeRuntimeLog } from ${JSON.stringify(runtimeLogModuleUrl)};
        writeRuntimeLog('warn', {
          scope: 'legacy', event: 'legacy_event', message: 'legacy message',
          meta: { token: 'must-not-leak', value: 7 },
          correlation: { sessionId: 'session-1' },
        });
        const logger = createRuntimeLogger('capability', {
          correlation: { traceId: 'trace-1', runtimeId: 'runtime-base' },
        });
        logger.info({
          event: 'started', data: { ok: true },
          correlation: { requestId: 'request-1', runtimeId: 'runtime-call' },
        });
      `, configDir);

      const [legacy, current] = readEntries(configDir);
      expect(legacy).toMatchObject({
        schemaVersion: 1,
        level: 'warn',
        scope: 'legacy',
        event: 'legacy_event',
        message: 'legacy message',
        processRole: 'runtime-log-test',
        productVersion: 'test-version',
        buildId: 'test-build',
        backendKind: 'test-backend',
        correlation: { sessionId: 'session-1' },
        data: { token: '[redacted]', value: 7 },
      });
      expect(legacy?.eventId).toMatch(/^[0-9a-f-]{36}$/);
      expect(legacy?.processId).toBeNumber();
      expect(legacy?.processInstanceId).toMatch(/^[0-9a-f-]{36}$/);
      expect(current).toMatchObject({
        scope: 'capability',
        event: 'started',
        correlation: {
          traceId: 'trace-1',
          runtimeId: 'runtime-call',
          requestId: 'request-1',
        },
        data: { ok: true },
      });
      expect(current?.processInstanceId).toBe(legacy?.processInstanceId);
    } finally {
      removeTempDir(configDir);
    }
  });

  test('serializes concurrent processes without corrupting or losing lines', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'mortise-runtime-log-concurrent-'));
    try {
      const writers = Array.from({ length: 4 }, (_, writer) => runChild(`
        import { writeRuntimeLog } from ${JSON.stringify(runtimeLogModuleUrl)};
        for (let index = 0; index < 40; index += 1) {
          writeRuntimeLog('info', {
            scope: 'concurrency', event: 'write',
            correlation: { requestId: '${writer}-' + index },
          });
        }
      `, configDir));
      await Promise.all(writers);

      const entries = readEntries(configDir);
      expect(entries).toHaveLength(160);
      expect(new Set(entries.map((entry) => entry.eventId)).size).toBe(160);
      expect(new Set(entries.map((entry) => entry.correlation?.requestId)).size).toBe(160);
    } finally {
      removeTempDir(configDir);
    }
  });

  test('replaces an oversized entry with a bounded truncation marker', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'mortise-runtime-log-bounded-'));
    try {
      await runChild(`
        import { writeRuntimeLog } from ${JSON.stringify(runtimeLogModuleUrl)};
        const data = Object.fromEntries(Array.from(
          { length: 30 },
          (_, index) => ['field' + index, 'x'.repeat(16_000)],
        ));
        writeRuntimeLog('info', { scope: 'bounded', event: 'oversized', data });
      `, configDir);

      const [entry] = readEntries(configDir);
      expect(entry?.data).toMatchObject({
        truncated: true,
        reason: 'runtime_log_entry_exceeded_limit',
      });
      expect((entry?.data as { originalBytes: number }).originalBytes).toBeGreaterThan(256 * 1024);
      expect(readFileSync(join(configDir, 'logs', 'runtime.log')).byteLength).toBeLessThan(256 * 1024);
    } finally {
      removeTempDir(configDir);
    }
  });

  test('does not throw when persistence fails and emits only bounded redacted fallback text', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-runtime-log-failure-'));
    const invalidConfigDir = join(root, 'Bearer must-not-leak-to-stderr');
    writeFileSync(invalidConfigDir, 'file blocks the log directory');
    try {
      const result = await runChildResult(`
        import { writeRuntimeLog } from ${JSON.stringify(runtimeLogModuleUrl)};
        writeRuntimeLog('error', {
          scope: 'failure', event: 'cannot_write',
          message: 'Bearer must-not-leak-to-stderr',
        });
        console.log('runtime-continued');
      `, invalidConfigDir);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('[mortise runtime-log] write failed:');
      expect(result.stderr).not.toContain('must-not-leak');
      expect(result.stderr.length).toBeLessThan(600);
    } finally {
      removeTempDir(root);
    }
  });

  test('rotates at the size boundary and retains at most five backups', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'mortise-runtime-log-rotation-'));
    try {
      await runChild(`
        import { writeRuntimeLog } from ${JSON.stringify(runtimeLogModuleUrl)};
        const data = Object.fromEntries(Array.from(
          { length: 14 },
          (_, index) => ['field' + index, 'x'.repeat(16_000)],
        ));
        for (let index = 0; index < 155; index += 1) {
          writeRuntimeLog('info', { scope: 'rotation', event: 'large', data });
        }
      `, configDir);

      const names = readdirSync(join(configDir, 'logs')).sort();
      expect(names).toContain('runtime.log');
      for (let index = 1; index <= 5; index += 1) {
        expect(names).toContain(`runtime.log.${index}`);
      }
      expect(names).not.toContain('runtime.log.6');
      expect(names.some((name) => name.endsWith('.lock'))).toBe(false);
    } finally {
      removeTempDir(configDir);
    }
  }, 30_000);
});
