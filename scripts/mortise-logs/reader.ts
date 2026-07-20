import { createHash } from 'node:crypto'
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { CORRELATION_KEYS, type LogCorrelation, type LogReadResult, type NormalizedLogEvent } from './types.ts'
import { sanitizeForDisclosure } from './redaction.ts'

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function correlationFrom(record: Record<string, unknown>, payload: Record<string, unknown>): LogCorrelation {
  const direct = object(record.correlation)
  const correlation: LogCorrelation = {}
  for (const key of CORRELATION_KEYS) {
    const value = direct[key] ?? payload[key] ?? record[key]
    if (typeof value === 'string' && value.length > 0) correlation[key] = value
  }
  return correlation
}

function legacyId(file: string, line: number, rawLine: string): string {
  const hash = createHash('sha256').update(`${file}:${line}:${rawLine}`).digest('hex').slice(0, 20)
  return `legacy-${hash}`
}

function normalize(record: Record<string, unknown>, file: string, line: number, rawLine: string): NormalizedLogEvent {
  const isV1 = record.schemaVersion === 1 && typeof record.eventId === 'string'
  const payload = object(isV1 ? record.data : record.meta)
  const timestamp = text(record.timestamp, new Date(0).toISOString())
  const sanitizedRaw = sanitizeForDisclosure(record) as Record<string, unknown>
  return {
    schemaVersion: isV1 ? 1 : 0,
    eventId: isV1 ? record.eventId as string : legacyId(file, line, rawLine),
    timestamp,
    level: text(record.level, 'unknown').toLowerCase(),
    scope: text(record.scope, 'unknown'),
    event: text(record.event, text(record.message, 'unknown')),
    correlation: correlationFrom(record, payload),
    ...(Object.keys(payload).length > 0 ? { data: sanitizeForDisclosure(payload) } : {}),
    ...(number(record.processId) !== undefined ? { processId: number(record.processId) } : {}),
    ...(typeof record.processRole === 'string' ? { processRole: record.processRole } : {}),
    ...(typeof record.processInstanceId === 'string' ? { processInstanceId: record.processInstanceId } : {}),
    ...(typeof record.productVersion === 'string' ? { productVersion: record.productVersion } : {}),
    ...(typeof record.buildId === 'string' ? { buildId: record.buildId } : {}),
    ...(typeof record.backendKind === 'string' ? { backendKind: record.backendKind } : {}),
    source: { file: basename(file), line, legacy: !isV1 },
    raw: sanitizedRaw,
  }
}

export function runtimeLogFiles(logPath: string): string[] {
  return [5, 4, 3, 2, 1].map(index => `${logPath}.${index}`).concat(logPath).filter(existsSync)
}

export function readRuntimeLogs(logPath: string): LogReadResult {
  const directory = dirname(logPath)
  let logDirectoryWritable = false
  try {
    accessSync(directory, constants.W_OK)
    logDirectoryWritable = true
  } catch {}
  const result: LogReadResult = {
    logPath,
    logFileExists: existsSync(logPath),
    logDirectoryExists: existsSync(directory),
    logDirectoryWritable,
    files: [],
    events: [],
    malformedLines: 0,
    unreadableFiles: [],
    schemaCounts: {},
  }
  for (const file of runtimeLogFiles(logPath)) {
    let contents: string
    try {
      contents = readFileSync(file, 'utf8')
    } catch (error) {
      result.unreadableFiles.push({ path: file, error: error instanceof Error ? error.message : String(error) })
      continue
    }
    let records = 0
    let malformedLines = 0
    const lines = contents.split(/\r?\n/)
    for (let index = 0; index < lines.length; index += 1) {
      const rawLine = lines[index]
      if (!rawLine.trim()) continue
      try {
        const parsed = JSON.parse(rawLine)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('record is not an object')
        const normalized = normalize(parsed as Record<string, unknown>, file, index + 1, rawLine)
        result.events.push(normalized)
        records += 1
        const schema = normalized.schemaVersion === 1 ? 'v1' : 'legacy'
        result.schemaCounts[schema] = (result.schemaCounts[schema] ?? 0) + 1
      } catch {
        malformedLines += 1
        result.malformedLines += 1
      }
    }
    result.files.push({ path: file, bytes: statSync(file).size, records, malformedLines })
  }
  result.events.sort((left, right) => {
    const delta = Date.parse(left.timestamp) - Date.parse(right.timestamp)
    return Number.isNaN(delta) || delta === 0 ? left.eventId.localeCompare(right.eventId) : delta
  })
  return result
}
