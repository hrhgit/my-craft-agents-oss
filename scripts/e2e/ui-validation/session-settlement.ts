import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import { requestMortiseUiHost } from '../../mortise-ui/client.ts'
import { restartMortiseUiRun, startMortiseUiRun, stopMortiseUiRun, stopMortiseUiRunDetailed } from '../../mortise-ui/controller.ts'
import type { MortiseUiFixtureMessage, MortiseUiFixtureSpec } from '../../mortise-ui/fixture.ts'
import type { MortiseUiRunManifest } from '../../mortise-ui/protocol.ts'

type TimelineName = 'normal' | 'abort' | 'compaction' | 'retry' | 'replacement'
interface Node { ref: string; semanticId?: string; actions: string[]; state?: { disabled?: boolean; busy?: boolean } }
interface Snapshot { revision: number; regions: Record<string, Node[]> }
interface FileStamp { path: string; sha256: string; size: number; mtimeMs: number }
interface ProjectionEntity { kind?: string; createdSeq?: number; lastSeq?: number; payload?: Record<string, unknown> }
interface ProjectionSnapshot { sessionId?: string; entities?: ProjectionEntity[] }
interface ProviderReceipt { at: string; timeline: TimelineName; request: number; status: number; bodySha256: string }

const workspaceId = 'settlement-workspace'
const sessionId = 'settlement-session'
const providerKey = 'opt005-scripted'
const modelId = 'opt005-model'
const allTimelines: TimelineName[] = ['normal', 'abort', 'compaction', 'retry', 'replacement']
const timelines = selectedTimelines()
const activeRuns: MortiseUiRunManifest[] = []
const retainedProfileDirs = new Set<string>()
const retainedRuns: Array<{ timeline: TimelineName; runId: string; restartRunId: string; evidence: string[]; tracePath: string }> = []

let providerTimeline: TimelineName = 'normal'
let providerRequest = 0
const providerReceipts: ProviderReceipt[] = []
let heldRequest: { request: IncomingMessage; response: ServerResponse } | undefined

const provider = createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.writeHead(404).end()
    return
  }
  const body = await readBody(request)
  const requestNumber = ++providerRequest
  if (providerTimeline === 'retry' && requestNumber === 1) {
    providerReceipts.push(receipt(providerTimeline, requestNumber, 503, body))
    response.writeHead(503, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { type: 'server_error', code: 'overloaded_error', message: 'overloaded_error' } }))
    return
  }
  if (providerTimeline === 'abort') {
    providerReceipts.push(receipt(providerTimeline, requestNumber, 200, body))
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    heldRequest = { request, response }
    request.once('close', () => { if (heldRequest?.request === request) heldRequest = undefined })
    return
  }
  providerReceipts.push(receipt(providerTimeline, requestNumber, 200, body))
  writeOpenAiAnswer(response, providerTimeline === 'compaction'
    ? 'Compacted deterministic summary preserving the accepted plan context.'
    : `Deterministic ${providerTimeline} timeline answer.`)
})

provider.listen(0, '127.0.0.1')
await once(provider, 'listening')
const providerPort = (provider.address() as AddressInfo).port

try {
  for (const timeline of timelines) {
    providerTimeline = timeline
    providerRequest = 0
    const result = await runTimeline(timeline)
    retainedRuns.push(result)
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    providerPort,
    timelines: retainedRuns,
    providerReceipts,
  })}\n`)
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    selectedTimelines: timelines,
    error: error instanceof Error ? error.message : String(error),
    providerReceipts,
    retainedProfiles: [...retainedProfileDirs],
  })}\n`)
  throw error
} finally {
  if (heldRequest) heldRequest.response.destroy()
  for (const run of [...activeRuns].reverse()) {
    if (retainedProfileDirs.has(run.profileDir)) await stopMortiseUiRunDetailed(run.runDir, { preserveProfile: true }).catch(() => undefined)
    else await stopMortiseUiRun(run.runDir).catch(() => undefined)
  }
  provider.close()
  await once(provider, 'close').catch(() => undefined)
}

async function runTimeline(timeline: TimelineName) {
  const evidence: string[] = []
  const fixtureSpec = buildFixture(timeline)
  let run: MortiseUiRunManifest | undefined
  try {
    run = await startMortiseUiRun({
      surface: 'electron', profileMode: 'fixture', fixtureSpec, waitMs: 600_000,
      label: `opt005-${timeline}`,
      profileSetup: profile => writeProviderConfig(profile.root),
      ...(process.env.MORTISE_UI_SKIP_BUILD === '1' ? { extraEnv: { MORTISE_UI_SKIP_BUILD: '1' } } : {}),
    })
    activeRuns.push(run)
    await openSession(run)

    const before = stamps(run, false)
    if (timeline === 'normal') await submitAndWait(run, 'Run the normal completion timeline.')
    if (timeline === 'abort') await runAbort(run)
    if (timeline === 'compaction') await submitAndWait(run, '/compact Preserve the plan execution context.')
    if (timeline === 'retry') await submitAndWait(run, 'Trigger the automatic retry timeline.')
    if (timeline === 'replacement') await runReplacement(run)

    await settle(run)
    const complete = stamps(run)
    await Bun.sleep(1_000)
    assertSameStamps(stamps(run), complete, `${timeline}: canonical files changed after the UI became ready`)
    const trace = buildTrace(run, timeline, before, complete)
    validateTrace(timeline, trace)
    const tracePath = join(run.artifactsDir, 'session-settlement-timeline.json')
    writeFileSync(tracePath, `${JSON.stringify(trace, null, 2)}\n`, 'utf8')
    evidence.push((await ok<{ bundleDir: string }>(run, 'evidence.capture', { label: `opt005-${timeline}` })).bundleDir)

    const originalRunId = run.runId
    run = await restartMortiseUiRun(run.runDir, { waitMs: 600_000 })
    activeRuns.push(run)
    await openSession(run)
    await settle(run)
    assertSameStamps(stamps(run), complete, `${timeline}: canonical files changed after same-profile restart`)
    evidence.push((await ok<{ bundleDir: string }>(run, 'evidence.capture', { label: `opt005-${timeline}-restart` })).bundleDir)
    await stopMortiseUiRun(run.runDir)
    return { timeline, runId: originalRunId, restartRunId: run.runId, evidence, tracePath }
  } catch (error) {
    if (!run) throw error
    retainedProfileDirs.add(run.profileDir)
    const captured = await ok<{ bundleDir: string }>(run, 'evidence.capture', { label: `opt005-${timeline}-failure` }).catch(() => undefined)
    const diagnostics = failureDiagnostics(run, timeline, error, captured?.bundleDir)
    const diagnosticsPath = join(run.artifactsDir, 'session-settlement-failure.json')
    writeFileSync(diagnosticsPath, `${JSON.stringify(diagnostics, null, 2)}\n`, 'utf8')
    await stopMortiseUiRunDetailed(run.runDir, { preserveProfile: true }).catch(() => undefined)
    throw new Error(`${timeline} timeline failed; retained profile ${run.profileDir}; diagnostics ${diagnosticsPath}: ${diagnostics.error}`)
  }
}

function selectedTimelines(): TimelineName[] {
  const requested: string[] = []
  const args = Bun.argv.slice(2)
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === '--timeline') requested.push(...String(args[++index] ?? '').split(','))
    else if (arg.startsWith('--timeline=')) requested.push(...arg.slice('--timeline='.length).split(','))
  }
  if (requested.length === 0 && process.env.MORTISE_UI_SETTLEMENT_TIMELINES) {
    requested.push(...process.env.MORTISE_UI_SETTLEMENT_TIMELINES.split(','))
  }
  if (requested.length === 0) return allTimelines
  const normalized = [...new Set(requested.map(item => item.trim()).filter(Boolean))]
  const invalid = normalized.filter(item => !allTimelines.includes(item as TimelineName))
  if (invalid.length > 0) throw new Error(`Unknown settlement timeline(s): ${invalid.join(', ')}. Expected: ${allTimelines.join(', ')}`)
  return normalized as TimelineName[]
}

function buildFixture(timeline: TimelineName): MortiseUiFixtureSpec {
  const messages: MortiseUiFixtureMessage[] = timeline === 'compaction'
    ? Array.from({ length: 12 }, (_, index) => ([
        { role: 'user' as const, content: `Compaction context ${index + 1}: ${'input '.repeat(35)}` },
        { role: 'assistant' as const, content: `Compaction answer ${index + 1}: ${'result '.repeat(35)}` },
      ])).flat()
    : [
        { role: 'user', content: 'Existing canonical user turn.' },
        { role: 'assistant', content: 'Existing canonical assistant answer.' },
      ]
  return {
    version: 1,
    active: { workspaceId, sessionId },
    workspaces: [{
      id: workspaceId,
      name: `OPT-005 ${timeline}`,
      sessions: [{
        id: sessionId,
        name: `OPT-005 ${timeline} timeline`,
        messages,
        ...(timeline === 'compaction' ? {
          pendingPlanExecution: {
            planPath: 'plans/accepted-plan.md',
            draftInputSnapshot: 'Execute the accepted plan after compaction.',
            awaitingCompaction: true,
            executionDispatched: false,
          },
          files: [{ path: 'plans/accepted-plan.md', content: '# Accepted plan\n\n1. Preserve compaction settlement ordering.\n' }],
        } : {}),
      }],
    }],
  }
}

function writeProviderConfig(profileDir: string): void {
  const dir = join(profileDir, 'mortise-config', 'agent')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'settings.json'), `${JSON.stringify({
    defaultProvider: providerKey,
    defaultModel: modelId,
    retry: { enabled: true, maxRetries: 2, baseDelayMs: 25, provider: { maxRetries: 0, maxRetryDelayMs: 25 } },
  }, null, 2)}\n`, 'utf8')
  writeFileSync(join(dir, 'models.json'), `${JSON.stringify({
    providers: {
      [providerKey]: {
        baseUrl: `http://127.0.0.1:${providerPort}/v1`,
        api: 'openai-completions',
        models: [{ id: modelId, name: 'OPT-005 Scripted Model', input: ['text'], contextWindow: 32_768, maxTokens: 2_048 }],
      },
    },
  }, null, 2)}\n`, 'utf8')
  writeFileSync(join(dir, 'auth.json'), `${JSON.stringify({ [providerKey]: { type: 'api_key', key: 'opt005-local-key' } }, null, 2)}\n`, 'utf8')
}

async function openSession(run: MortiseUiRunManifest): Promise<void> {
  await act(run, `navigation.session_${workspaceId}_${sessionId}`, 'click')
  await ok(run, 'ui.wait', { predicate: { kind: 'state', scope: 'session', entityId: sessionId, phase: 'ready' }, timeoutMs: 60_000 })
}

async function submitAndWait(run: MortiseUiRunManifest, value: string): Promise<void> {
  await act(run, `composer.${sessionId}.input`, 'fill', value)
  await act(run, `composer.${sessionId}.send`, 'click')
  await ok(run, 'ui.wait', { predicate: { kind: 'state', scope: 'session', entityId: sessionId, phase: 'ready' }, stableForMs: 250, timeoutMs: 120_000 })
}

async function runAbort(run: MortiseUiRunManifest): Promise<void> {
  await act(run, `composer.${sessionId}.input`, 'fill', 'Hold this real Pi stream until Stop is clicked.')
  await act(run, `composer.${sessionId}.send`, 'click')
  await waitForAction(run, `composer.${sessionId}.stop`, 'click')
  await act(run, `composer.${sessionId}.stop`, 'click')
  await ok(run, 'ui.wait', { predicate: { kind: 'state', scope: 'session', entityId: sessionId, phase: 'ready' }, stableForMs: 250, timeoutMs: 120_000 })
}

async function runReplacement(run: MortiseUiRunManifest): Promise<void> {
  await submitAndWait(run, 'Establish the first real Pi runtime before replacement.')
  const before = hostInstances(run)
  if (before.length === 0) throw new Error('replacement: runtime.log has no ready Pi host instance')
  killPiGlobalHostDescendant(run)
  await waitForRuntimeEvent(run, 'host.exit', 60_000)
  await submitAndWait(run, 'Recover through a replacement real Pi runtime.')
  const after = hostInstances(run)
  if (new Set(after).size < 2) throw new Error(`replacement: expected two Pi host identities, found ${JSON.stringify(after)}`)
}

interface DescendantProcess {
  ProcessId: number
  Name?: string
  CommandLine?: string
}

function killPiGlobalHostDescendant(run: MortiseUiRunManifest): number {
  if (process.platform !== 'win32') throw new Error('replacement: GlobalHost process selection currently requires Windows')
  if (!run.hostPid) throw new Error('replacement: Electron host PID is unavailable')
  const cliPath = currentPiCliPath(run)
  const script = `$root=${run.hostPid}; $all=Get-CimInstance Win32_Process; $ids=@($root); $changed=$true; while($changed){$changed=$false; foreach($p in $all){if(($ids -contains [int]$p.ParentProcessId)-and -not($ids -contains [int]$p.ProcessId)){$ids+=[int]$p.ProcessId;$changed=$true}}}; $all | Where-Object { ($ids -contains [int]$_.ProcessId) -and [int]$_.ProcessId -ne $root } | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress`
  const listed = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' })
  if (listed.status !== 0) {
    throw new Error(`replacement: descendant enumeration failed: ${boundedText(listed.stderr || listed.stdout)}`)
  }
  const output = listed.stdout.trim()
  const parsed = output
    ? JSON.parse(output) as DescendantProcess | DescendantProcess[]
    : []
  const processes = (Array.isArray(parsed) ? parsed : [parsed]).sort((left, right) => left.ProcessId - right.ProcessId)
  const normalizedCliPath = cliPath.replaceAll('/', '\\').toLowerCase()
  const candidates = processes.filter(item => {
    const commandLine = (item.CommandLine ?? '').replaceAll('/', '\\')
    return commandLine.toLowerCase().includes(normalizedCliPath) && /(?:^|\s)--mode\s+rpc(?:\s|$)/i.test(commandLine)
  })
  if (candidates.length !== 1) {
    throw new Error(`replacement: expected exactly one Pi GlobalHost descendant ${JSON.stringify({
      cliPath,
      hostPid: run.hostPid,
      candidateCount: candidates.length,
      candidates: processDiagnostics(candidates),
      descendants: processDiagnostics(processes),
    })}`)
  }
  const target = candidates[0]!
  const killed = spawnSync('taskkill.exe', ['/PID', String(target.ProcessId), '/T', '/F'], { encoding: 'utf8' })
  if (killed.status !== 0) throw new Error(`replacement: taskkill failed for ${target.ProcessId}: ${boundedText(killed.stderr || killed.stdout)}`)
  return target.ProcessId
}

function currentPiCliPath(run: MortiseUiRunManifest): string {
  const startups = runtimeLog(run).filter(entry => entry.scope === 'pi-rpc' && entry.event === 'startup.begin')
  for (let index = startups.length - 1; index >= 0; index -= 1) {
    const data = startups[index]!.data
    if (data && typeof data === 'object' && typeof (data as Record<string, unknown>).cliPath === 'string') {
      return (data as Record<string, unknown>).cliPath as string
    }
  }
  throw new Error('replacement: runtime.log has no startup.begin.data.cliPath for the current Pi GlobalHost')
}

function processDiagnostics(processes: DescendantProcess[]): Array<{ processId: number; name?: string; commandLine?: string }> {
  return processes.slice(0, 20).map(item => ({
    processId: item.ProcessId,
    ...(item.Name ? { name: item.Name } : {}),
    ...(item.CommandLine ? { commandLine: boundedText(item.CommandLine, 500) } : {}),
  }))
}

function boundedText(value: string, maxChars = 2_000): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`
}

function stamps(run: MortiseUiRunManifest, requireProjection = true): FileStamp[] {
  const jsonl = findSessionJsonl(run.profileDir)
  const projection = findProjection(run.profileDir, requireProjection)
  return [jsonl, ...(projection ? [projection] : [])].map(stamp)
}

function stamp(path: string): FileStamp {
  const data = readFileSync(path)
  const stat = statSync(path)
  return { path, sha256: createHash('sha256').update(data).digest('hex'), size: stat.size, mtimeMs: stat.mtimeMs }
}

function assertSameStamps(actual: FileStamp[], expected: FileStamp[], message: string): void {
  const stable = actual.map(item => ({ ...item, path: item.path.replace(/\\/g, '/') }))
  const baseline = expected.map(item => ({ ...item, path: item.path.replace(/\\/g, '/') }))
  if (JSON.stringify(stable) !== JSON.stringify(baseline)) throw new Error(`${message}: ${JSON.stringify({ expected: baseline, actual: stable })}`)
}

function findSessionJsonl(profileDir: string): string {
  const matches = walk(join(profileDir, 'mortise-config', 'agent', 'sessions'), path => path.endsWith('.jsonl')).filter(path => {
    const first = readFileSync(path, 'utf8').split(/\r?\n/, 1)[0]
    if (!first) return false
    const header = JSON.parse(first) as { id?: string; mortise?: { id?: string } }
    return header.id === sessionId || header.mortise?.id === sessionId
  })
  if (matches.length !== 1) throw new Error(`Expected one canonical JSONL for ${sessionId}, found ${matches.length}`)
  return matches[0]!
}

function findProjection(profileDir: string, required = true): string | undefined {
  const matches = walk(join(profileDir, 'mortise-config', 'agent', 'sessions'), path => path.endsWith('pi-projection-v1.json')).filter(path => {
    try { return (JSON.parse(readFileSync(path, 'utf8')) as ProjectionSnapshot).sessionId === sessionId } catch { return false }
  })
  if (!required && matches.length === 0) return undefined
  if (matches.length !== 1) throw new Error(`Expected one Pi projection for ${sessionId}, found ${matches.length}`)
  return matches[0]!
}

function walk(root: string, include: (path: string) => boolean): string[] {
  const result: string[] = []
  const visit = (dir: string) => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (include(path)) result.push(path)
    }
  }
  visit(root)
  return result.sort()
}

function buildTrace(run: MortiseUiRunManifest, timeline: TimelineName, before: FileStamp[], complete: FileStamp[]) {
  const projection = JSON.parse(readFileSync(findProjection(run.profileDir)!, 'utf8')) as ProjectionSnapshot
  const lifecycle = (projection.entities ?? [])
    .filter(entity => entity.kind && /turn_|agent_|compaction_|runtime_error/.test(entity.kind))
    .sort((a, b) => (a.createdSeq ?? a.lastSeq ?? 0) - (b.createdSeq ?? b.lastSeq ?? 0))
    .map(entity => ({ kind: entity.kind, seq: entity.createdSeq ?? entity.lastSeq, payload: entity.payload }))
  return {
    schemaVersion: 1,
    timeline,
    runId: run.runId,
    buildId: run.buildId,
    providerRequests: providerReceipts.filter(item => item.timeline === timeline),
    lifecycle,
    runtime: runtimeEntries(run),
    before,
    complete,
    renderer: { semanticSnapshot: 'captured by evidence.capture', readyAt: new Date().toISOString() },
  }
}

function validateTrace(timeline: TimelineName, trace: ReturnType<typeof buildTrace>): void {
  const kinds = trace.lifecycle.map(item => item.kind)
  if (timeline === 'normal' && (!kinds.includes('agent_start') || !kinds.includes('agent_settled') || kinds.includes('runtime_error'))) throw new Error(`normal: incomplete lifecycle ${JSON.stringify(kinds)}`)
  if (timeline === 'abort') {
    const required = ['turn_end', 'agent_end', 'agent_settled'] as const
    const missing = required.filter(kind => !trace.lifecycle.some(item => item.kind === kind && item.payload?.status === 'aborted'))
    if (missing.length > 0 || kinds.includes('runtime_error')) {
      throw new Error(`abort: incomplete aborted projection lifecycle ${JSON.stringify({ missing, lifecycle: trace.lifecycle })}`)
    }
  }
  if (timeline === 'compaction' && (!kinds.includes('compaction_start') || !kinds.includes('compaction_end'))) throw new Error(`compaction: incomplete lifecycle ${JSON.stringify(kinds)}`)
  if (timeline === 'retry' && trace.providerRequests.length < 2) throw new Error(`retry: expected at least two provider requests, found ${trace.providerRequests.length}`)
  if (timeline === 'replacement' && new Set(trace.runtime.filter(item => item.event === 'host.ready').map(item => item.hostInstanceId)).size < 2) throw new Error('replacement: runtime trace lacks two host identities')
}

function failureDiagnostics(run: MortiseUiRunManifest, timeline: TimelineName, error: unknown, evidenceBundle?: string) {
  const projectionPath = findProjection(run.profileDir, false)
  const projection = projectionPath
    ? JSON.parse(readFileSync(projectionPath, 'utf8')) as ProjectionSnapshot
    : undefined
  const runtime = runtimeLog(run)
  return {
    schemaVersion: 1,
    timeline,
    error: error instanceof Error ? error.stack ?? error.message : String(error),
    run: {
      runId: run.runId,
      buildId: run.buildId,
      runDir: run.runDir,
      profileDir: run.profileDir,
      stdoutPath: run.stdoutPath,
      stderrPath: run.stderrPath,
      evidenceBundle,
    },
    providerReceipts: providerReceipts.filter(item => item.timeline === timeline),
    projectionRuntimeErrors: (projection?.entities ?? []).filter(entity => entity.kind === 'runtime_error'),
    runtimeLog: runtime.filter(entry => entry.scope === 'pi-rpc' || entry.scope === 'session').slice(-100),
    hostStdoutTail: readTextTail(run.stdoutPath),
    hostStderrTail: readTextTail(run.stderrPath),
  }
}

function readTextTail(path: string, maxChars = 64 * 1024): string {
  if (!existsSync(path)) return ''
  const text = readFileSync(path, 'utf8')
  return text.length <= maxChars ? text : text.slice(-maxChars)
}

function runtimeLog(run: MortiseUiRunManifest): Array<Record<string, unknown>> {
  const path = join(run.profileDir, 'mortise-config', 'logs', 'runtime.log')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line) as Record<string, unknown>] } catch { return [] }
  })
}

function runtimeEntries(run: MortiseUiRunManifest) {
  return runtimeLog(run).filter(entry => entry.scope === 'pi-rpc' || entry.scope === 'session').map(entry => {
    const data = entry.data && typeof entry.data === 'object' ? entry.data as Record<string, unknown> : {}
    return { timestamp: entry.timestamp, scope: entry.scope, event: entry.event, hostInstanceId: data.hostInstanceId, runtimeId: data.runtimeId, sessionId: data.sessionId }
  })
}

function hostInstances(run: MortiseUiRunManifest): string[] {
  return runtimeEntries(run).filter(item => item.event === 'host.ready' && typeof item.hostInstanceId === 'string').map(item => item.hostInstanceId as string)
}

async function waitForRuntimeEvent(run: MortiseUiRunManifest, event: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (runtimeEntries(run).some(item => item.event === event)) return
    await Bun.sleep(100)
  }
  throw new Error(`Timed out waiting for runtime event ${event}`)
}

async function settle(run: MortiseUiRunManifest): Promise<void> {
  await ok(run, 'ui.wait', { predicate: { kind: 'rpc-idle' }, stableForMs: 250, timeoutMs: 60_000 })
  await ok(run, 'ui.wait', { predicate: { kind: 'render-idle' }, stableForMs: 250, timeoutMs: 60_000 })
}

async function waitForAction(run: MortiseUiRunManifest, semanticId: string, action: string): Promise<void> {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const snapshot = await ok<Snapshot>(run, 'ui.snapshot')
    if (nodes(snapshot).some(node => node.semanticId === semanticId && node.actions.includes(action))) return
    await Bun.sleep(100)
  }
  throw new Error(`Timed out waiting for ${semanticId} (${action})`)
}

async function act(run: MortiseUiRunManifest, semanticId: string, action: string, value?: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const snapshot = await ok<Snapshot>(run, 'ui.snapshot')
    const target = nodes(snapshot).find(node => node.semanticId === semanticId && node.actions.includes(action))
    if (!target) throw new Error(`Semantic action target is unavailable: ${semanticId} (${action})`)
    try {
      await ok(run, 'ui.action', { revision: snapshot.revision, target: { ref: target.ref }, action, mode: 'physical', ...(value === undefined ? {} : { value }) })
      return
    } catch (error) {
      if (!String(error).includes('STALE_REF') || attempt === 2) throw error
    }
  }
}

function nodes(snapshot: Snapshot): Node[] { return Object.values(snapshot.regions).flat() }

async function ok<T>(run: MortiseUiRunManifest, command: string, params: Record<string, unknown> = {}): Promise<T> {
  const response = await requestMortiseUiHost<T>({ ...run, command, params, timeoutMs: 120_000 })
  if (!response.ok) throw new Error(`${command} failed: ${response.error.code}: ${response.error.message}`)
  return response.result
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

function receipt(timeline: TimelineName, request: number, status: number, body: string): ProviderReceipt {
  return { at: new Date().toISOString(), timeline, request, status, bodySha256: createHash('sha256').update(body).digest('hex') }
}

function writeOpenAiAnswer(response: ServerResponse, text: string): void {
  const id = `chatcmpl-${Date.now()}`
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 0, model: modelId, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })}\n\n`)
  response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 0, model: modelId, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 32, completion_tokens: 8 } })}\n\n`)
  response.end('data: [DONE]\n\n')
}
