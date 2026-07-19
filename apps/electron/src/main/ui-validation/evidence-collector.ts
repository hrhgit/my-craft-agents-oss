import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { WebContents } from 'electron'
import type { UiValidationEventReadResult, UiValidationScopedStateSnapshot } from '@mortise/shared/ui-validation'
import type { UiDriverSnapshot, UiDriverWindowSelector, UiVerificationLevel } from './electron-surface-driver'
import { observeWebRequests } from '../web-request-observer-hub'

const MAX_DIAGNOSTIC_ENTRIES = 1_000
const MAX_NETWORK_ENTRIES = 2_000
const MAX_RUNTIME_LOG_BYTES = 512_000

export interface EvidenceCollectorSources {
  artifactsDir: string
  runId: string
  runtimeLogPath: string
  secrets?: readonly string[]
  snapshot(selector: UiDriverWindowSelector): Promise<UiDriverSnapshot>
  screenshot(selector: UiDriverWindowSelector, path: string): Promise<void | {
    artifacts?: Array<{ kind: string; path: string; mimeType: string }>
    surfaces?: Array<Record<string, unknown>>
  }>
  state(webContentsId?: number): UiValidationScopedStateSnapshot
  events(options?: { afterSeq?: number; limit?: number }): UiValidationEventReadResult
  driver: Record<string, unknown>
  mainProcessDiagnostics?: () => Promise<unknown>
}

export interface EvidenceCaptureContext {
  label: string
  selector: UiDriverWindowSelector
  afterSeq?: number
  route?: unknown
  scenario?: unknown
  seed?: number
  viewport?: unknown
  verificationLevel: UiVerificationLevel
  clocks: { application: string; applicationDomains?: string[]; os: string; network: string }
}

export interface EvidenceArtifact {
  kind: string
  path: string
  mimeType: string
  sizeBytes: number
  sha256: string
}

export interface EvidenceCaptureResult {
  bundleDir: string
  artifacts: EvidenceArtifact[]
  revision: number
  seqRange: { from: number; to: number }
}

type EvidenceRecordKind = 'console' | 'page-error' | 'network'

interface NetworkRecord {
  timestamp: number
  completedAt?: number
  durationMs?: number
  requestId?: number
  webContentsId?: number
  method?: string
  url?: string
  resourceType?: string
  status?: number
  fromCache?: boolean
  error?: string
}

export class ElectronEvidenceCollector {
  private readonly consoleEntries: unknown[] = []
  private readonly pageErrors: unknown[] = []
  private readonly networkEntries: NetworkRecord[] = []
  private readonly networkStarted = new Map<string, NetworkRecord>()
  private readonly cleanup = new Set<() => void>()
  private readonly trackedWebContents = new Set<number>()
  private readonly observedSessions = new Map<object, Set<number>>()
  private readonly previousSnapshots = new Map<number, UiDriverSnapshot>()
  private started = false
  private startSeq = 0

  constructor(private readonly sources: EvidenceCollectorSources) {}

  start(contents: readonly WebContents[] = []): void {
    if (!this.started) {
      this.started = true
      this.startSeq = this.sources.events().latestSeq
    }
    for (const webContents of contents) this.trackWebContents(webContents)
  }

  trackWebContents(webContents: WebContents): void {
    if (this.trackedWebContents.has(webContents.id)) return
    this.trackedWebContents.add(webContents.id)
    const onConsole = (_event: unknown, level: number, message: string, line: number, sourceId: string) => {
      this.record('console', { timestamp: Date.now(), webContentsId: webContents.id, level, message, line, sourceId })
    }
    const onGone = (_event: unknown, details: unknown) => this.record('page-error', { timestamp: Date.now(), webContentsId: webContents.id, type: 'render-process-gone', details })
    const onFailed = (_event: unknown, errorCode: number, errorDescription: string, validatedURL: string, isMainFrame: boolean) => {
      this.record('page-error', { timestamp: Date.now(), webContentsId: webContents.id, type: 'did-fail-load', errorCode, errorDescription, url: validatedURL, isMainFrame })
    }
    webContents.on('console-message', onConsole)
    webContents.on('render-process-gone', onGone)
    webContents.on('did-fail-load', onFailed)
    const removeListeners = () => {
      webContents.removeListener('console-message', onConsole)
      webContents.removeListener('render-process-gone', onGone)
      webContents.removeListener('did-fail-load', onFailed)
      this.trackedWebContents.delete(webContents.id)
      sessionIds?.delete(webContents.id)
    }
    this.cleanup.add(removeListeners)
    webContents.once('destroyed', removeListeners)

    let sessionIds: Set<number> | undefined
    let ids = this.observedSessions.get(webContents.session)
    if (!ids) {
      ids = new Set()
      this.observedSessions.set(webContents.session, ids)
      const sessionIds = ids
      const unsubscribe = observeWebRequests(webContents.session, {
        beforeRequest: details => {
          if (details.webContentsId === undefined || !sessionIds.has(details.webContentsId)) return
          const entry: NetworkRecord = {
            timestamp: Date.now(), requestId: details.id, webContentsId: details.webContentsId,
            method: details.method, url: details.url, resourceType: String(details.resourceType),
          }
          this.networkStarted.set(networkKey(details.webContentsId, details.id ?? 0), entry)
        },
        completed: details => {
          if (details.webContentsId === undefined || !sessionIds.has(details.webContentsId)) return
          const key = networkKey(details.webContentsId, details.id ?? 0)
          const started = this.networkStarted.get(key)
          this.networkStarted.delete(key)
          this.record('network', {
            ...(started ?? { timestamp: Date.now(), requestId: details.id, webContentsId: details.webContentsId }),
            completedAt: Date.now(), durationMs: started ? Date.now() - started.timestamp : undefined,
            method: details.method, url: details.url, resourceType: String(details.resourceType),
            status: details.statusCode, fromCache: details.fromCache,
          })
        },
        errorOccurred: details => {
          if (details.webContentsId === undefined || !sessionIds.has(details.webContentsId)) return
          const key = networkKey(details.webContentsId, details.id ?? 0)
          const started = this.networkStarted.get(key)
          this.networkStarted.delete(key)
          this.record('network', {
            ...(started ?? { timestamp: Date.now(), requestId: details.id, webContentsId: details.webContentsId }),
            completedAt: Date.now(), durationMs: started ? Date.now() - started.timestamp : undefined,
            method: details.method, url: details.url, resourceType: String(details.resourceType), error: details.error,
          })
        },
      })
      this.cleanup.add(unsubscribe)
    }
    sessionIds = ids
    ids.add(webContents.id)
  }

  record(kind: EvidenceRecordKind, value: unknown): void {
    const redacted = redactValue(value, this.sources.secrets)
    if (kind === 'console') boundedPush(this.consoleEntries, redacted, MAX_DIAGNOSTIC_ENTRIES)
    else if (kind === 'page-error') boundedPush(this.pageErrors, redacted, MAX_DIAGNOSTIC_ENTRIES)
    else boundedPush(this.networkEntries, redacted as NetworkRecord, MAX_NETWORK_ENTRIES)
  }

  async capture(context: EvidenceCaptureContext): Promise<EvidenceCaptureResult> {
    if (!this.started) this.start()
    const evidenceId = `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`
    const bundleDir = resolve(this.sources.artifactsDir, evidenceId)
    await mkdir(bundleDir, { recursive: true })
    const afterSeq = context.afterSeq ?? this.startSeq
    const events = this.sources.events({ afterSeq })
    const seqRange = {
      from: events.events[0]?.seq ?? events.latestSeq,
      to: events.latestSeq,
    }
    const artifacts: EvidenceArtifact[] = []
    const addJson = async (kind: string, name: string, value: unknown) => {
      const path = join(bundleDir, name)
      await atomicWrite(path, JSON.stringify(redactValue(value, this.sources.secrets), null, 2))
      artifacts.push(await artifact(kind, path, 'application/json'))
    }

    let snapshot: UiDriverSnapshot | undefined
    try {
      snapshot = await this.sources.snapshot(context.selector)
      const previous = this.previousSnapshots.get(snapshot.window.webContentsId)
      this.previousSnapshots.set(snapshot.window.webContentsId, structuredClone(snapshot))
      await addJson('semantic-snapshot', 'snapshot.full.json', snapshot)
      await addJson('semantic-snapshot', 'snapshot.incremental.json', previous
        ? incrementalSnapshot(previous, snapshot)
        : { sinceRevision: 0, revision: snapshot.revision, full: true, resetRequired: true, snapshot })
    } catch (error) {
      await addJson('semantic-snapshot-error', 'snapshot.error.json', errorRecord(error))
    }
    const webContentsId = snapshot?.window.webContentsId ?? context.selector.webContentsId
    const state = this.sources.state(webContentsId)
    const screenshotPath = join(bundleDir, 'screenshot.png')
    try {
      const captured = await this.sources.screenshot(context.selector, screenshotPath)
      if (captured && captured.artifacts?.length) {
        for (const item of captured.artifacts) artifacts.push(await artifact(item.kind, item.path, item.mimeType))
      } else {
        artifacts.push(await artifact('screenshot', screenshotPath, 'image/png'))
      }
      if (captured?.surfaces?.length) await addJson('screenshot-metadata', 'screenshot-surfaces.json', captured.surfaces)
    } catch (error) {
      await addJson('screenshot-error', 'screenshot.error.json', errorRecord(error))
    }
    await addJson('state', 'ui-state.json', state)
    await addJson('events', 'events.json', events)
    await addJson('console', 'console.json', this.consoleEntries)
    await addJson('page-error', 'page-errors.json', this.pageErrors)
    await addJson('network', 'network-summary.json', networkSummary(this.networkEntries, webContentsId))
    if (this.sources.mainProcessDiagnostics) {
      try {
        await addJson('driver-info', 'main-process.json', await this.sources.mainProcessDiagnostics())
      } catch (error) {
        await addJson('driver-info-error', 'main-process.error.json', errorRecord(error))
      }
    }
    const runtimePath = join(bundleDir, 'runtime.log')
    await atomicWrite(runtimePath, redactText(await readLogTail(this.sources.runtimeLogPath), this.sources.secrets))
    artifacts.push(await artifact('runtime-log', runtimePath, 'text/plain'))

    const manifestPath = join(bundleDir, 'manifest.json')
    const manifest = {
      protocolVersion: 1,
      runId: this.sources.runId,
      label: context.label,
      createdAt: new Date().toISOString(),
      revision: Math.max(snapshot?.revision ?? 0, state.revision),
      seqRange,
      window: snapshot?.window ?? { webContentsId: webContentsId ?? null, unavailable: true },
      route: context.route ?? null,
      scenario: context.scenario ?? null,
      seed: context.seed ?? null,
      viewport: context.viewport ?? snapshot?.window.bounds ?? null,
      verificationLevel: context.verificationLevel,
      clocks: context.clocks,
      driver: this.sources.driver,
      networkCapture: { source: 'electron-session-web-request-multiplexer', requestBodiesCaptured: false },
      artifacts,
    }
    await atomicWrite(manifestPath, JSON.stringify(redactValue(manifest, this.sources.secrets), null, 2))
    artifacts.push(await artifact('state-manifest', manifestPath, 'application/json'))
    return {
      bundleDir,
      artifacts,
      revision: Math.max(snapshot?.revision ?? 0, state.revision),
      seqRange,
    }
  }

  dispose(): void {
    for (const cleanup of this.cleanup) cleanup()
    this.cleanup.clear()
    this.trackedWebContents.clear()
    this.observedSessions.clear()
    this.networkStarted.clear()
    this.started = false
  }
}

function networkKey(webContentsId: number | undefined, requestId: number): string {
  return `${webContentsId ?? 0}:${requestId}`
}

function networkSummary(entries: readonly NetworkRecord[], webContentsId?: number): unknown {
  const selected = webContentsId === undefined ? [...entries] : entries.filter(entry => entry.webContentsId === webContentsId)
  const byStatus: Record<string, number> = {}
  const byResourceType: Record<string, number> = {}
  const byOrigin: Record<string, number> = {}
  for (const entry of selected) {
    const status = entry.error ? 'error' : String(entry.status ?? 'unknown')
    byStatus[status] = (byStatus[status] ?? 0) + 1
    const resourceType = entry.resourceType ?? 'unknown'
    byResourceType[resourceType] = (byResourceType[resourceType] ?? 0) + 1
    const origin = urlOrigin(entry.url)
    byOrigin[origin] = (byOrigin[origin] ?? 0) + 1
  }
  return { captured: true, count: selected.length, byStatus, byResourceType, byOrigin, requests: selected }
}

function urlOrigin(value?: string): string {
  if (!value) return 'unknown'
  try { return new URL(value).origin } catch { return 'invalid' }
}

function incrementalSnapshot(previous: UiDriverSnapshot, current: UiDriverSnapshot): unknown {
  const flatten = (snapshot: UiDriverSnapshot) => new Map([
    ...Object.entries(snapshot.regions).flatMap(([region, nodes]) => nodes.map(node => [`renderer:${stableNodeId(node.ref)}`, { region, node }] as const)),
    ...(snapshot.embeddedSurfaces ?? []).flatMap(surface => surface.nodes.map(node => [
      `${surface.surfaceId}:${stableNodeId(node.ref)}`,
      { region: `embedded:${surface.surfaceId}`, node },
    ] as const)),
  ])
  const before = flatten(previous)
  const after = flatten(current)
  const added: unknown[] = []
  const updated: unknown[] = []
  const removed: unknown[] = []
  for (const [id, value] of after) {
    const old = before.get(id)
    if (!old) added.push({ id, region: value.region, ...value.node })
    else if (JSON.stringify(withoutRef(old)) !== JSON.stringify(withoutRef(value))) updated.push({ id, region: value.region, ...value.node })
  }
  for (const [id, value] of before) if (!after.has(id)) removed.push({ id, ref: value.node.ref })
  return { sinceRevision: previous.revision, revision: current.revision, full: false, changes: { added, updated, removed } }
}

function withoutRef(value: { region: string; node: UiDriverSnapshot['regions'][keyof UiDriverSnapshot['regions']][number] }): unknown {
  const { ref: _ref, ...node } = value.node
  return { region: value.region, ...node }
}

function stableNodeId(ref: string): string {
  const separator = ref.indexOf(':')
  return separator < 0 ? ref : ref.slice(separator + 1)
}

async function artifact(kind: string, path: string, mimeType: string): Promise<EvidenceArtifact> {
  const bytes = await readFile(path)
  const info = await stat(path)
  return { kind, path, mimeType, sizeBytes: info.size, sha256: createHash('sha256').update(bytes).digest('hex') }
}

async function atomicWrite(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, value, 'utf8')
  await rename(temporary, path)
}

async function readLogTail(path: string): Promise<string> {
  try {
    const bytes = await readFile(path)
    return bytes.subarray(Math.max(0, bytes.length - MAX_RUNTIME_LOG_BYTES)).toString('utf8')
  } catch (error) {
    return `runtime log unavailable: ${error instanceof Error ? error.message : String(error)}`
  }
}

const SENSITIVE_KEY = /(?:token|secret|password|credential|authorization|api[-_]?key|private[-_]?key|secret[-_]?input|input[-_]?secret)/i

export function redactValue(value: unknown, secrets: readonly string[] = []): unknown {
  if (typeof value === 'string') return redactText(value, secrets)
  if (Array.isArray(value)) return value.map(item => redactValue(item, secrets))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactValue(item, secrets),
  ]))
}

export function redactText(value: string, secrets: readonly string[] = []): string {
  let result = redactUrlInText(value)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
    .replace(/((?:"?)(?:token|secret|password|credential|authorization|api[-_]?key|private[-_]?key)"?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi, '$1[REDACTED]')
  for (const secret of secrets) if (secret) result = result.replaceAll(secret, '[REDACTED]')
  return result.slice(0, 100_000)
}

function errorRecord(error: unknown): Record<string, unknown> {
  return { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) }
}

function redactUrlInText(value: string): string {
  return value.replace(/\b(?:https?|wss?|file):\/\/[^\s"'<>]+/gi, match => redactUrl(match))
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value)
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, '[REDACTED]')
    if (url.username) url.username = '[REDACTED]'
    if (url.password) url.password = '[REDACTED]'
    return url.toString()
  } catch {
    return value
  }
}

function boundedPush<T>(target: T[], value: T, limit: number): void {
  target.push(value)
  if (target.length > limit) target.splice(0, target.length - limit)
}
