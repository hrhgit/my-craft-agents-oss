#!/usr/bin/env bun
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { readRuntimeLogs } from './reader.ts'
import { queryLogs } from './query.ts'
import { CORRELATION_KEYS, DEFAULT_RESULT_LIMIT, MAX_RESULT_LIMIT, type CliEnvelope, type LogCorrelation, type QueryOptions } from './types.ts'

function value(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  const result = args[index + 1]
  if (!result || result.startsWith('--')) throw new CliError('INVALID_ARGUMENT', `${name} requires a value`)
  return result
}

function integer(args: string[], name: string, fallback: number): number {
  const input = value(args, name)
  if (input === undefined) return fallback
  const result = Number(input)
  if (!Number.isSafeInteger(result)) throw new CliError('INVALID_ARGUMENT', `${name} must be an integer`)
  return result
}

function parseDate(input: string | undefined, name: string): string | undefined {
  if (!input) return undefined
  const parsed = Date.parse(input)
  if (Number.isNaN(parsed)) throw new CliError('INVALID_ARGUMENT', `${name} must be an ISO-8601 timestamp`)
  return new Date(parsed).toISOString()
}

class CliError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

export function resolveRuntimeLogPath(env: NodeJS.ProcessEnv = process.env): string {
  const configDir = env.MORTISE_CONFIG_DIR || join(homedir(), '.mortise')
  return join(configDir, 'logs', 'runtime.log')
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): QueryOptions & { tail: boolean; once: boolean; intervalMs: number } {
  const args = argv.slice(2)
  const commandToken = args[0]?.startsWith('--') ? undefined : args[0]
  const command = (commandToken ?? 'recent') as QueryOptions['command'] | 'tail'
  if (!['recent', 'search', 'trace', 'show', 'health', 'tail'].includes(command)) throw new CliError('INVALID_ARGUMENT', `Unknown command: ${command}`)
  const valueFlags = new Set(['--limit', '--offset', '--log-path', '--since', '--until', '--level', '--scope', '--event', '--event-id', '--id', '--interval-ms', ...CORRELATION_KEYS.map(key => `--${key}`)])
  const booleanFlags = new Set(['--detail', '--raw', '--once'])
  const positionalCount = commandToken ? (command === 'trace' && args[1] && !args[1].startsWith('--') ? 2 : 1) : 0
  for (let index = positionalCount; index < args.length; index += 1) {
    const token = args[index]
    if (booleanFlags.has(token)) continue
    if (!valueFlags.has(token)) throw new CliError('INVALID_ARGUMENT', `Unknown argument: ${token}`)
    if (!args[index + 1] || args[index + 1].startsWith('--')) throw new CliError('INVALID_ARGUMENT', `${token} requires a value`)
    index += 1
  }
  const limit = integer(args, '--limit', DEFAULT_RESULT_LIMIT)
  const offset = integer(args, '--offset', 0)
  if (limit < 1 || limit > MAX_RESULT_LIMIT) throw new CliError('INVALID_ARGUMENT', `--limit must be between 1 and ${MAX_RESULT_LIMIT}`)
  if (offset < 0) throw new CliError('INVALID_ARGUMENT', '--offset must be zero or greater')
  const detail = args.includes('--detail')
  const raw = args.includes('--raw')
  if (detail && raw) throw new CliError('INVALID_ARGUMENT', '--detail and --raw are mutually exclusive')
  const correlation: LogCorrelation = {}
  for (const key of CORRELATION_KEYS) {
    const item = value(args, `--${key}`)
    if (item) correlation[key] = item
  }
  const traceValue = command === 'trace' ? (commandToken ? args[1] : undefined) ?? value(args, '--id') : undefined
  const eventId = command === 'show' ? value(args, '--event-id') : undefined
  if (command === 'trace' && (!traceValue || traceValue.startsWith('--'))) throw new CliError('INVALID_ARGUMENT', 'trace requires a correlation value or --id')
  if (command === 'show' && !eventId) throw new CliError('INVALID_ARGUMENT', 'show requires --event-id')
  const intervalMs = integer(args, '--interval-ms', 1_000)
  if (intervalMs < 100 || intervalMs > 60_000) throw new CliError('INVALID_ARGUMENT', '--interval-ms must be between 100 and 60000')
  return {
    command: command === 'tail' ? 'search' : command,
    tail: command === 'tail',
    once: args.includes('--once'),
    intervalMs,
    logPath: resolve(value(args, '--log-path') ?? resolveRuntimeLogPath(env)),
    limit,
    offset,
    detail,
    raw,
    since: parseDate(value(args, '--since'), '--since'),
    until: parseDate(value(args, '--until'), '--until'),
    level: value(args, '--level'),
    scope: value(args, '--scope'),
    event: value(args, '--event'),
    eventId,
    correlation,
    traceValue,
  }
}

function errorEnvelope(error: unknown): CliEnvelope {
  const code = error instanceof CliError ? error.code : 'INTERNAL_ERROR'
  const message = error instanceof Error ? error.message : String(error)
  return {
    schemaVersion: 1,
    summary: 'The log query could not be completed.',
    observations: [],
    evidence: [],
    disclosure: { shown: 0, omitted: 0, reason: 'No log events were disclosed because the command failed.', continuation: null },
    nextActions: [],
    error: { code, message },
  }
}

export async function run(argv = process.argv, env: NodeJS.ProcessEnv = process.env, write: (line: string) => void = line => process.stdout.write(line)): Promise<number> {
  try {
    const options = parseArgs(argv, env)
    if (!options.tail) {
      const envelope = queryLogs(readRuntimeLogs(options.logPath), options)
      write(`${JSON.stringify(envelope)}\n`)
      return envelope.error ? 2 : 0
    }
    let seen = new Set<string>()
    const emit = (): void => {
      const read = readRuntimeLogs(options.logPath)
      const fresh = read.events.filter(item => !seen.has(item.eventId))
      seen = new Set(read.events.map(item => item.eventId))
      const envelope = queryLogs({ ...read, events: fresh }, { ...options, command: 'search', offset: 0 })
      envelope.summary = `${fresh.length} newly observed event(s) are shown.`
      write(`${JSON.stringify(envelope)}\n`)
    }
    emit()
    if (options.once) return 0
    await new Promise<void>(resolveDone => {
      const timer = setInterval(emit, options.intervalMs)
      const stop = (): void => { clearInterval(timer); resolveDone() }
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
    })
    return 0
  } catch (error) {
    write(`${JSON.stringify(errorEnvelope(error))}\n`)
    return error instanceof CliError ? 1 : 3
  }
}

if (import.meta.main) process.exitCode = await run()
