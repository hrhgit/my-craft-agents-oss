import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseArgs, run } from '../cli.ts'
import { queryLogs } from '../query.ts'
import { readRuntimeLogs } from '../reader.ts'
import { MAX_OUTPUT_BYTES, type QueryOptions } from '../types.ts'

const roots: string[] = []
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

function fixture(lines: string[], rotated: string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), 'mortise-logs-'))
  roots.push(root)
  const logDir = join(root, 'logs')
  mkdirSync(logDir)
  const path = join(logDir, 'runtime.log')
  writeFileSync(path, lines.join('\n'))
  if (rotated.length) writeFileSync(`${path}.1`, rotated.join('\n'))
  return path
}

function options(logPath: string, overrides: Partial<QueryOptions> = {}): QueryOptions {
  return { command: 'search', logPath, limit: 20, offset: 0, detail: false, raw: false, correlation: {}, ...overrides }
}

describe('runtime log reader', () => {
  test('merges rotations, normalizes legacy events, and skips malformed lines', () => {
    const logPath = fixture([
      '{bad partial',
      JSON.stringify({ schemaVersion: 1, eventId: 'v1-2', timestamp: '2026-01-02T00:00:00.000Z', level: 'info', scope: 'browser', event: 'finished', correlation: { requestId: 'req-1' }, data: { ok: true } }),
    ], [
      JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', level: 'error', scope: 'pi-rpc', event: 'route_rejected', meta: { requestId: 'req-1', sessionId: 'session-1' } }),
    ])
    const read = readRuntimeLogs(logPath)
    expect(read.events).toHaveLength(2)
    expect(read.events[0].schemaVersion).toBe(0)
    expect(read.events[0].eventId).toMatch(/^legacy-/)
    expect(read.events[0].correlation).toEqual({ sessionId: 'session-1', requestId: 'req-1' })
    expect(read.events[1].eventId).toBe('v1-2')
    expect(read.malformedLines).toBe(1)
    expect(read.schemaCounts).toEqual({ legacy: 1, v1: 1 })
  })

  test('reports a missing path without throwing', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-logs-missing-'))
    roots.push(root)
    const read = readRuntimeLogs(join(root, 'logs', 'runtime.log'))
    expect(read.events).toEqual([])
    expect(read.logFileExists).toBe(false)
    expect(read.logDirectoryExists).toBe(false)
  })
})

describe('queries and disclosure', () => {
  test('keeps default evidence compact and progressively expands detail', () => {
    const logPath = fixture([JSON.stringify({ schemaVersion: 1, eventId: 'event-1', timestamp: '2026-01-01T00:00:00Z', level: 'error', scope: 'browser', event: 'timed_out', correlation: { requestId: 'r1' }, data: { step: 'navigate' } })])
    const read = readRuntimeLogs(logPath)
    const compact = queryLogs(read, options(logPath))
    expect(compact.evidence[0]).not.toHaveProperty('detail')
    expect(compact.evidence[0]).not.toHaveProperty('raw')
    const detailed = queryLogs(read, options(logPath, { detail: true }))
    expect(detailed.evidence[0].detail?.data).toEqual({ step: 'navigate' })
  })

  test('raw disclosure is still recursively redacted', () => {
    const logPath = fixture([JSON.stringify({ schemaVersion: 1, eventId: 'secret-event', timestamp: '2026-01-01T00:00:00Z', level: 'error', scope: 'session', event: 'failed', data: { accessToken: 'plain-secret', message: 'Bearer abc.def.ghi https://host/path?token=secret-value&ok=1' } })])
    const result = queryLogs(readRuntimeLogs(logPath), options(logPath, { raw: true }))
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('plain-secret')
    expect(serialized).not.toContain('abc.def.ghi')
    expect(serialized).not.toContain('secret-value')
    expect(serialized).toContain('[REDACTED]')
  })

  test('searches fields and traces any correlation identity', () => {
    const logPath = fixture([
      JSON.stringify({ schemaVersion: 1, eventId: 'one', timestamp: '2026-01-01T00:00:00Z', level: 'info', scope: 'capability', event: 'requested', correlation: { requestId: 'req-x', sessionId: 's1' } }),
      JSON.stringify({ schemaVersion: 1, eventId: 'two', timestamp: '2026-01-01T00:00:01Z', level: 'warn', scope: 'capability', event: 'route_rejected', correlation: { requestId: 'req-x', sessionId: 's1' } }),
      JSON.stringify({ schemaVersion: 1, eventId: 'three', timestamp: '2026-01-01T00:00:02Z', level: 'error', scope: 'browser', event: 'failed', correlation: { requestId: 'other' } }),
    ])
    const read = readRuntimeLogs(logPath)
    const search = queryLogs(read, options(logPath, { level: 'warn', scope: 'capability' }))
    expect(search.evidence.map(item => item.eventId)).toEqual(['two'])
    const trace = queryLogs(read, options(logPath, { command: 'trace', traceValue: 's1' }))
    expect(trace.evidence.map(item => item.eventId)).toEqual(['one', 'two'])
  })

  test('supports a bounded three-query investigation of a stuck browser capability', () => {
    const correlation = { requestId: 'cap-stuck', sessionId: 'session-stuck', runtimeId: 'runtime-stuck' }
    const logPath = fixture([
      JSON.stringify({ schemaVersion: 1, eventId: 'incident-request', timestamp: '2026-01-01T00:00:00Z', level: 'info', scope: 'capability-bridge', event: 'requested', correlation, data: { capability: 'browser.command', operation: 'execute' } }),
      JSON.stringify({ schemaVersion: 1, eventId: 'incident-browser', timestamp: '2026-01-01T00:00:01Z', level: 'info', scope: 'browser-command', event: 'started', correlation, data: { command: 'navigate', secretArgument: 'https://private.example?token=hidden' } }),
      JSON.stringify({ schemaVersion: 1, eventId: 'incident-route', timestamp: '2026-01-01T00:00:30Z', level: 'warn', scope: 'capability', event: 'route_rejected', correlation, data: { phase: 'response', reason: 'routing_identity_mismatch', expected: { sessionId: 'session-stuck' }, actual: {} } }),
      JSON.stringify({ schemaVersion: 1, eventId: 'incident-timeout', timestamp: '2026-01-01T00:00:31Z', level: 'warn', scope: 'capability', event: 'timed_out', correlation, data: { durationMs: 30000, errorCode: 'CAPABILITY_TIMEOUT' } }),
      JSON.stringify({ schemaVersion: 1, eventId: 'incident-cancel', timestamp: '2026-01-01T00:28:00Z', level: 'warn', scope: 'session', event: 'cancelled', correlation, data: { source: 'user' } }),
    ])
    const read = readRuntimeLogs(logPath)

    const recent = queryLogs(read, options(logPath, { command: 'recent' }))
    expect(recent.evidence.map(item => item.eventId)).toContain('incident-route')
    expect(JSON.stringify(recent)).not.toContain('private.example')

    const trace = queryLogs(read, options(logPath, { command: 'trace', traceValue: 'cap-stuck' }))
    expect(trace.evidence.map(item => item.event)).toEqual(['requested', 'started', 'route_rejected', 'timed_out', 'cancelled'])
    expect(trace.evidence.every(item => !item.detail && !item.raw)).toBe(true)

    const route = queryLogs(read, options(logPath, { event: 'route_rejected', detail: true }))
    expect(route.evidence[0].detail?.data).toMatchObject({ phase: 'response', reason: 'routing_identity_mismatch', expected: { sessionId: 'session-stuck' }, actual: {} })
  })

  test('paginates deterministically and carries filters into the continuation', () => {
    const logPath = fixture(Array.from({ length: 3 }, (_, index) => JSON.stringify({ schemaVersion: 1, eventId: `page-${index}`, timestamp: `2026-01-01T00:00:0${index}Z`, level: 'info', scope: 'browser', event: 'progress', correlation: { sessionId: 's-page' } })))
    const read = readRuntimeLogs(logPath)
    const first = queryLogs(read, options(logPath, { limit: 1, scope: 'browser', correlation: { sessionId: 's-page' } }))
    expect(first.evidence[0].eventId).toBe('page-0')
    expect(first.disclosure.continuation?.argv).toContain('--scope')
    const second = queryLogs(read, options(logPath, { limit: 1, offset: 1, scope: 'browser', correlation: { sessionId: 's-page' } }))
    expect(second.evidence[0].eventId).toBe('page-1')
  })

  test('recent reports correlated started events without terminal events as retained-log gaps', () => {
    const logPath = fixture([
      JSON.stringify({ schemaVersion: 1, eventId: 'pending', timestamp: '2026-01-01T00:00:00Z', level: 'info', scope: 'browser', event: 'command.started', correlation: { requestId: 'unsettled' } }),
      JSON.stringify({ schemaVersion: 1, eventId: 'done-start', timestamp: '2026-01-01T00:00:01Z', level: 'info', scope: 'browser', event: 'command.started', correlation: { requestId: 'settled' } }),
      JSON.stringify({ schemaVersion: 1, eventId: 'done-end', timestamp: '2026-01-01T00:00:02Z', level: 'info', scope: 'browser', event: 'command.finished', correlation: { requestId: 'settled' } }),
    ])
    const recent = queryLogs(readRuntimeLogs(logPath), options(logPath, { command: 'recent' }))
    expect(recent.evidence.map(item => item.eventId)).toEqual(['pending'])
    expect(recent.observations[1]).toContain('1 started lifecycle')
  })

  test('caps output at 256 KB and provides an exact continuation', () => {
    const records = Array.from({ length: 30 }, (_, index) => JSON.stringify({ schemaVersion: 1, eventId: `huge-${index}`, timestamp: `2026-01-01T00:00:${String(index).padStart(2, '0')}Z`, level: 'error', scope: 'session', event: 'failed', data: Object.fromEntries(Array.from({ length: 100 }, (__, key) => [`field${key}`, 'x'.repeat(4096)])) }))
    const logPath = fixture(records)
    const result = queryLogs(readRuntimeLogs(logPath), options(logPath, { raw: true, limit: 30 }))
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(MAX_OUTPUT_BYTES)
    expect(result.disclosure.omitted).toBeGreaterThan(0)
    expect(result.disclosure.continuation?.command).toBe('search')
  })
})

describe('CLI contract', () => {
  test('rejects unknown arguments and limits over 100', () => {
    expect(() => parseArgs(['bun', 'cli.ts', 'search', '--wat'])).toThrow('Unknown argument')
    expect(() => parseArgs(['bun', 'cli.ts', 'search', '--limit', '101'])).toThrow('between 1 and 100')
  })

  test('show not-found and invalid parameters use stable JSON envelopes and exit codes', async () => {
    const logPath = fixture([])
    const lines: string[] = []
    const notFound = await run(['bun', 'cli.ts', 'show', '--event-id', 'absent', '--log-path', logPath], {}, line => lines.push(line))
    expect(notFound).toBe(2)
    expect(JSON.parse(lines.pop()!).error.code).toBe('NOT_FOUND')
    const invalid = await run(['bun', 'cli.ts', 'search', '--limit', '0'], {}, line => lines.push(line))
    expect(invalid).toBe(1)
    expect(JSON.parse(lines.pop()!).error.code).toBe('INVALID_ARGUMENT')
  })

  test('does not report an unavailable log source as an empty successful query', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-logs-unavailable-'))
    roots.push(root)
    const lines: string[] = []
    const exit = await run(['bun', 'cli.ts', 'search', '--log-path', join(root, 'missing', 'runtime.log')], {}, line => lines.push(line))
    expect(exit).toBe(2)
    expect(JSON.parse(lines[0]).error.code).toBe('LOG_NOT_FOUND')
  })

  test('tail --once emits one bounded envelope', async () => {
    const logPath = fixture([JSON.stringify({ schemaVersion: 1, eventId: 'tail-1', timestamp: '2026-01-01T00:00:00Z', level: 'info', scope: 'process', event: 'started' })])
    const lines: string[] = []
    const exit = await run(['bun', 'cli.ts', 'tail', '--once', '--log-path', logPath], {}, line => lines.push(line))
    expect(exit).toBe(0)
    expect(lines).toHaveLength(1)
    const envelope = JSON.parse(lines[0])
    expect(envelope.schemaVersion).toBe(1)
    expect(envelope.evidence[0].eventId).toBe('tail-1')
  })

  test('health reports file, schema, malformed-line, and directory facts', async () => {
    const logPath = fixture(['broken', JSON.stringify({ timestamp: '2026-01-01T00:00:00Z', level: 'info', scope: 'pi-rpc', event: 'ready' })])
    const lines: string[] = []
    expect(await run(['bun', 'cli.ts', 'health', '--log-path', logPath], {}, line => lines.push(line))).toBe(0)
    const envelope = JSON.parse(lines[0])
    expect(envelope.diagnostics.logFileExists).toBe(true)
    expect(envelope.diagnostics.schemaCounts.legacy).toBe(1)
    expect(envelope.observations.join(' ')).toContain('1 malformed')
  })
})
