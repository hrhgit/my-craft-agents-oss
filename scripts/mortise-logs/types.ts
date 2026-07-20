export const MORTISE_LOGS_SCHEMA_VERSION = 1 as const
export const DEFAULT_RESULT_LIMIT = 20
export const MAX_RESULT_LIMIT = 100
export const MAX_OUTPUT_BYTES = 256 * 1024

export const CORRELATION_KEYS = [
  'traceId',
  'sessionId',
  'runtimeId',
  'clientId',
  'toolUseId',
  'requestId',
  'browserInstanceId',
] as const

export type CorrelationKey = typeof CORRELATION_KEYS[number]
export type LogCorrelation = Partial<Record<CorrelationKey, string>>

export interface NormalizedLogEvent {
  schemaVersion: number
  eventId: string
  timestamp: string
  level: string
  scope: string
  event: string
  correlation: LogCorrelation
  data?: unknown
  processId?: number
  processRole?: string
  processInstanceId?: string
  productVersion?: string
  buildId?: string
  backendKind?: string
  source: {
    file: string
    line: number
    legacy: boolean
  }
  raw: Record<string, unknown>
}

export interface LogReadResult {
  logPath: string
  logFileExists: boolean
  logDirectoryExists: boolean
  logDirectoryWritable: boolean
  files: Array<{ path: string; bytes: number; records: number; malformedLines: number }>
  events: NormalizedLogEvent[]
  malformedLines: number
  unreadableFiles: Array<{ path: string; error: string }>
  schemaCounts: Record<string, number>
}

export interface EvidenceItem {
  eventId: string
  timestamp: string
  level: string
  scope: string
  event: string
  correlation: LogCorrelation
  detail?: Omit<NormalizedLogEvent, 'raw' | 'source'>
  raw?: Record<string, unknown>
}

export interface CliEnvelope {
  schemaVersion: 1
  summary: string
  observations: string[]
  evidence: EvidenceItem[]
  disclosure: {
    shown: number
    omitted: number
    reason: string
    continuation: { command: string; argv: string[] } | null
  }
  nextActions: Array<{ command: string; argv: string[]; purpose: string }>
  diagnostics?: Record<string, unknown>
  error?: { code: string; message: string }
}

export interface QueryOptions {
  command: 'recent' | 'search' | 'trace' | 'show' | 'health'
  logPath: string
  limit: number
  offset: number
  detail: boolean
  raw: boolean
  since?: string
  until?: string
  level?: string
  scope?: string
  event?: string
  eventId?: string
  correlation?: LogCorrelation
  traceValue?: string
}
