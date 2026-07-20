import { MAX_OUTPUT_BYTES, type CliEnvelope, type EvidenceItem, type LogReadResult, type NormalizedLogEvent, type QueryOptions } from './types.ts'

const TERMINAL_SUFFIXES = ['finished', 'responded', 'timed_out', 'cancelled', 'failed', 'rejected', 'route_rejected', 'ready', 'close']
const START_SUFFIXES = ['requested', 'started', 'begin', 'open']
const IMPORTANT_LEVELS = new Set(['error', 'fatal', 'warn', 'warning'])

function epoch(timestamp: string): number { const value = Date.parse(timestamp); return Number.isNaN(value) ? 0 : value }
function matchesTime(timestamp: string, bound: string | undefined, direction: 'since' | 'until'): boolean {
  if (!bound) return true
  return direction === 'since' ? epoch(timestamp) >= epoch(bound) : epoch(timestamp) <= epoch(bound)
}
function eventEndsWith(event: string, values: string[]): boolean { return values.some(value => event === value || event.endsWith(`.${value}`) || event.endsWith(`_${value}`)) }
function lifecycleKey(item: NormalizedLogEvent): string | undefined {
  const correlation = item.correlation
  const value = correlation.requestId ?? correlation.toolUseId ?? correlation.browserInstanceId ?? correlation.traceId ?? correlation.runtimeId
  return value ? `${item.scope}:${value}` : undefined
}

function evidence(item: NormalizedLogEvent, detail: boolean, raw: boolean): EvidenceItem {
  const base: EvidenceItem = {
    eventId: item.eventId,
    timestamp: item.timestamp,
    level: item.level,
    scope: item.scope,
    event: item.event,
    correlation: item.correlation,
  }
  if (raw) return { ...base, raw: item.raw }
  if (detail) {
    const { raw: _raw, source: _source, ...expanded } = item
    return { ...base, detail: expanded }
  }
  return base
}

function continuation(options: QueryOptions, nextOffset: number): { command: string; argv: string[] } {
  const argv = ['--offset', String(nextOffset), '--limit', String(options.limit)]
  if (options.detail) argv.push('--detail')
  if (options.raw) argv.push('--raw')
  if (options.command === 'trace' && options.traceValue) argv.unshift(options.traceValue)
  if (options.command === 'show' && options.eventId) argv.unshift('--event-id', options.eventId)
  for (const [flag, value] of [['--since', options.since], ['--until', options.until], ['--level', options.level], ['--scope', options.scope], ['--event', options.event]] as Array<[string, string | undefined]>) {
    if (value) argv.push(flag, value)
  }
  for (const [key, value] of Object.entries(options.correlation ?? {})) if (value) argv.push(`--${key}`, value)
  return { command: options.command, argv }
}

function boundedEnvelope(envelope: CliEnvelope, all: NormalizedLogEvent[], options: QueryOptions): CliEnvelope {
  while (Buffer.byteLength(JSON.stringify(envelope), 'utf8') > MAX_OUTPUT_BYTES && envelope.evidence.length > 0) {
    envelope.evidence.pop()
    envelope.disclosure.shown -= 1
    envelope.disclosure.omitted += 1
  }
  if (envelope.disclosure.omitted > 0) {
    envelope.disclosure.reason = envelope.evidence.length < Math.min(options.limit, all.length - options.offset)
      ? `Results were capped at ${MAX_OUTPUT_BYTES} bytes.`
      : `Results were limited to ${options.limit} items.`
    envelope.disclosure.continuation = continuation(options, options.offset + envelope.disclosure.shown)
  }
  return envelope
}

function baseEnvelope(summary: string, observations: string[], selected: NormalizedLogEvent[], all: NormalizedLogEvent[], options: QueryOptions): CliEnvelope {
  const omitted = Math.max(0, all.length - options.offset - selected.length)
  const envelope: CliEnvelope = {
    schemaVersion: 1,
    summary,
    observations,
    evidence: selected.map(item => evidence(item, options.detail, options.raw)),
    disclosure: {
      shown: selected.length,
      omitted,
      reason: omitted > 0 ? `Results were limited to ${options.limit} items.` : 'All matching results are shown.',
      continuation: omitted > 0 ? continuation(options, options.offset + selected.length) : null,
    },
    nextActions: [],
  }
  return boundedEnvelope(envelope, all, options)
}

function applyFilters(events: NormalizedLogEvent[], options: QueryOptions): NormalizedLogEvent[] {
  return events.filter(item => {
    if (!matchesTime(item.timestamp, options.since, 'since') || !matchesTime(item.timestamp, options.until, 'until')) return false
    if (options.level && item.level !== options.level.toLowerCase()) return false
    if (options.scope && item.scope !== options.scope) return false
    if (options.event && item.event !== options.event) return false
    for (const [key, value] of Object.entries(options.correlation ?? {})) if (value && item.correlation[key as keyof typeof item.correlation] !== value) return false
    return true
  })
}

function page(events: NormalizedLogEvent[], options: QueryOptions): NormalizedLogEvent[] {
  return events.slice(options.offset, options.offset + options.limit)
}

function recentEvents(events: NormalizedLogEvent[]): { events: NormalizedLogEvent[]; gaps: NormalizedLogEvent[] } {
  const important = events.filter(item => IMPORTANT_LEVELS.has(item.level) || /(timed_out|route_rejected|pending|cancelled|failed|rejected)/i.test(item.event))
  const latestStart = new Map<string, NormalizedLogEvent>()
  const latestTerminal = new Map<string, NormalizedLogEvent>()
  for (const item of events) {
    const key = lifecycleKey(item)
    if (!key) continue
    if (eventEndsWith(item.event, START_SUFFIXES)) latestStart.set(key, item)
    if (eventEndsWith(item.event, TERMINAL_SUFFIXES)) latestTerminal.set(key, item)
  }
  const gaps = [...latestStart.entries()]
    .filter(([key, start]) => !latestTerminal.has(key) || epoch(start.timestamp) > epoch(latestTerminal.get(key)!.timestamp))
    .map(([, start]) => start)
  return { events: [...new Map(important.concat(gaps).map(item => [item.eventId, item])).values()].sort((a, b) => epoch(b.timestamp) - epoch(a.timestamp)), gaps }
}

export function queryLogs(read: LogReadResult, options: QueryOptions): CliEnvelope {
  if (options.command === 'health') {
    const observations = [
      `${read.files.length} runtime log file(s) were readable.`,
      `${read.events.length} valid event(s) were parsed.`,
      `${read.malformedLines} malformed or incomplete line(s) were skipped.`,
      `${read.unreadableFiles.length} log file(s) could not be read.`,
      `The log directory is ${read.logDirectoryWritable ? '' : 'not '}writable by this process.`,
    ]
    return {
      schemaVersion: 1,
      summary: !read.logFileExists && read.files.length === 0
        ? 'No runtime log file exists at the configured path.'
        : read.unreadableFiles.length > 0 || read.malformedLines > 0
          ? 'Runtime logs are readable with reported degradation.'
          : 'Runtime logs are readable.',
      observations,
      evidence: [],
      disclosure: { shown: 0, omitted: 0, reason: 'Health reports aggregate file metadata and does not disclose event payloads.', continuation: null },
      nextActions: read.events.length > 0 ? [{ command: 'recent', argv: [], purpose: 'Inspect recent failures and lifecycle gaps.' }] : [],
      diagnostics: { logPath: read.logPath, logFileExists: read.logFileExists, logDirectoryExists: read.logDirectoryExists, logDirectoryWritable: read.logDirectoryWritable, files: read.files, unreadableFiles: read.unreadableFiles, schemaCounts: read.schemaCounts },
    }
  }

  if (read.files.length === 0) {
    const unreadable = read.unreadableFiles.length > 0
    return {
      schemaVersion: 1,
      summary: unreadable ? 'Runtime logs could not be read.' : 'No runtime log files exist at the configured path.',
      observations: unreadable
        ? [`${read.unreadableFiles.length} retained log file(s) could not be read.`]
        : ['Neither runtime.log nor a retained rotation was found.'],
      evidence: [],
      disclosure: { shown: 0, omitted: 0, reason: 'No events were available for disclosure.', continuation: null },
      nextActions: [{ command: 'health', argv: [], purpose: 'Inspect the configured path and file accessibility facts.' }],
      error: {
        code: unreadable ? 'LOG_UNREADABLE' : 'LOG_NOT_FOUND',
        message: unreadable ? 'No retained runtime log file could be read.' : `No runtime log exists at ${read.logPath}.`,
      },
    }
  }

  const sourceWarnings = [
    ...(read.malformedLines > 0 ? [`${read.malformedLines} malformed or incomplete retained line(s) were excluded.`] : []),
    ...(read.unreadableFiles.length > 0 ? [`${read.unreadableFiles.length} retained log file(s) could not be read.`] : []),
  ]

  if (options.command === 'show') {
    const all = read.events.filter(item => item.eventId === options.eventId)
    const selected = page(all, options)
    const result = baseEnvelope(all.length ? `Found event ${options.eventId}.` : `No event matched ${options.eventId}.`, (all.length ? ['One event matched the supplied event ID.'] : ['No parsed event has the supplied event ID.']).concat(sourceWarnings), selected, all, { ...options, detail: options.raw ? false : true })
    if (!all.length) result.error = { code: 'NOT_FOUND', message: `No event matched ${options.eventId}.` }
    return result
  }

  if (options.command === 'trace') {
    const value = options.traceValue as string
    const all = applyFilters(read.events.filter(item => Object.values(item.correlation).includes(value)), options)
    const selected = page(all, options)
    const result = baseEnvelope(all.length ? `${all.length} event(s) share correlation value ${value}.` : `No event contains correlation value ${value}.`, (all.length ? [`The first and last matching events are ${all[0].event} and ${all[all.length - 1].event}.`] : ['No parsed event contains the supplied correlation value.']).concat(sourceWarnings), selected, all, options)
    if (!all.length) result.error = { code: 'NOT_FOUND', message: `No event contains correlation value ${value}.` }
    return result
  }

  if (options.command === 'recent') {
    const filtered = applyFilters(read.events, options)
    const recent = recentEvents(filtered)
    const selected = page(recent.events, options)
    const observations = [
      `${recent.events.length} recent error, timeout, pending, rejection, cancellation, or lifecycle-gap event(s) matched.`,
      `${recent.gaps.length} started lifecycle event(s) have no terminal event with the same available correlation key in the retained logs.`,
      ...sourceWarnings,
    ]
    const result = baseEnvelope(recent.events.length ? 'Recent operational exceptions and lifecycle gaps are shown newest first.' : 'No recent operational exceptions or lifecycle gaps matched.', observations, selected, recent.events, options)
    if (selected[0]) {
      const correlation = Object.values(selected[0].correlation)[0]
      result.nextActions.push(correlation
        ? { command: 'trace', argv: [correlation], purpose: 'Inspect the most recent event correlation timeline.' }
        : { command: 'show', argv: ['--event-id', selected[0].eventId], purpose: 'Inspect the most recent event without disclosing unrelated records.' })
    }
    return result
  }

  const all = applyFilters(read.events, options)
  const selected = page(all, options)
  const result = baseEnvelope(`${all.length} event(s) matched the supplied filters.`, sourceWarnings.length ? sourceWarnings : ['All retained lines were parsed successfully.'], selected, all, options)
  if (selected.length) result.nextActions.push({ command: 'show', argv: ['--event-id', selected[0].eventId], purpose: 'Expand one event without disclosing unrelated records.' })
  return result
}
