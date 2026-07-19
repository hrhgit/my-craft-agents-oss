import type { MortiseUiArtifactManifest, MortiseUiHistoryEntry, MortiseUiRunManifest } from './protocol.ts'

const MAX_TARGETS = 24
const MAX_ATTENTION = 12

type JsonRecord = Record<string, unknown>

export interface MortiseUiAiAction {
  label: string
  reason: string
  command: string
  params?: JsonRecord
}

export interface MortiseUiAiBriefing {
  summary: string
  context: JsonRecord
  attention: string[]
  targets: Array<{
    label: string
    role: string
    region: string
    ref?: string
    semanticId?: string
    testId?: string
    state?: JsonRecord
    actions: string[]
    suggestedAction?: JsonRecord
  }>
  nextActions: MortiseUiAiAction[]
}

export function createSnapshotBriefing(snapshot: unknown): MortiseUiAiBriefing {
  const value = record(snapshot)
  const window = record(value.window)
  const regions = record(value.regions)
  const route = record(value.route ?? record(value.state).route)
  const targets: MortiseUiAiBriefing['targets'] = []
  const attention: string[] = []
  let focused: string | undefined

  for (const [region, rawNodes] of Object.entries(regions)) {
    if (!Array.isArray(rawNodes)) continue
    for (const rawNode of rawNodes) {
      const node = record(rawNode)
      const name = bounded(node.name, 160)
      const role = bounded(node.role, 60) || 'unknown'
      const state = record(node.state ?? node.states)
      const actions = stringArray(node.actions)
      if (state.focused === true) focused = name || role
      if (role === 'alert' || role === 'alertdialog' || role === 'dialog' || state.busy === true) {
        attention.push(describeAttention(role, name, state))
      }
      if (state.disabled === true || actions.length === 0) continue
      if (targets.length >= MAX_TARGETS) continue
      const ref = string(node.ref)
      const semanticId = string(node.semanticId)
      const testId = string(node.testId)
      const target = semanticId ? { semanticId } : testId ? { testId } : ref ? { ref } : { role, ...(name ? { name, exact: true } : {}) }
      targets.push({
        label: name || `${role} in ${region}`,
        role,
        region,
        ...(ref ? { ref } : {}),
        ...(semanticId ? { semanticId } : {}),
        ...(testId ? { testId } : {}),
        ...(Object.keys(state).length > 0 ? { state } : {}),
        actions,
        suggestedAction: { target, action: preferredAction(actions) },
      })
    }
  }

  for (const surface of array(value.embeddedSurfaces)) {
    const embedded = record(surface)
    const surfaceId = string(embedded.surfaceId) ?? string(embedded.instanceId) ?? 'embedded'
    for (const rawNode of array(embedded.nodes)) {
      const node = record(rawNode)
      const actions = stringArray(node.actions)
      if (actions.length === 0 || targets.length >= MAX_TARGETS) continue
      const ref = string(node.ref)
      const name = bounded(node.name, 160)
      const role = bounded(node.role, 60) || 'unknown'
      targets.push({
        label: name || `${role} in ${surfaceId}`,
        role,
        region: `embedded:${surfaceId}`,
        ...(ref ? { ref } : {}),
        actions,
        suggestedAction: ref
          ? { target: { kind: 'browser', instanceId: string(embedded.instanceId) ?? surfaceId, ref }, action: preferredAction(actions) }
          : undefined,
      })
    }
  }

  if (value.truncated === true) attention.push('The semantic snapshot was truncated; request a narrower window or surface when the target is absent.')
  const routeLabel = describeRoute(route)
  const windowTitle = bounded(window.title, 120)
  const summary = [
    windowTitle ? `Window "${windowTitle}"` : 'Selected UI window',
    routeLabel ? `is on ${routeLabel}` : undefined,
    targets.length > 0 ? `with ${targets.length} immediately actionable target${targets.length === 1 ? '' : 's'}` : 'with no immediately actionable targets',
  ].filter(Boolean).join(' ')

  const nextActions: MortiseUiAiAction[] = []
  if (attention.length > 0) {
    nextActions.push({ label: 'Inspect the active attention state', reason: attention[0]!, command: 'snapshot' })
  }
  for (const target of targets.slice(0, 6)) {
    if (!target.suggestedAction) continue
    nextActions.push({
      label: `${target.actions[0] ?? 'Use'} ${target.label}`,
      reason: `${target.role} is currently enabled in ${target.region}.`,
      command: 'action',
      params: target.suggestedAction,
    })
  }
  if (nextActions.length === 0) {
    nextActions.push({ label: 'Wait for semantic readiness', reason: 'No actionable target is currently available.', command: 'wait', params: { predicate: { kind: 'semantic-ready' } } })
  }

  return {
    summary,
    context: {
      revision: number(value.revision),
      window: {
        title: windowTitle,
        role: string(window.role),
        workspaceId: string(window.workspaceId),
        sessionId: string(window.sessionId),
      },
      route: Object.keys(route).length > 0 ? route : undefined,
      focused,
    },
    attention: [...new Set(attention)].slice(0, MAX_ATTENTION),
    targets,
    nextActions,
  }
}

export function createRunBriefing(args: {
  manifest: MortiseUiRunManifest
  processAlive: boolean
  host?: unknown
  artifacts?: MortiseUiArtifactManifest
}): JsonRecord {
  const { manifest, processAlive } = args
  const hostEnvelope = record(args.host)
  const hostResult = hostEnvelope.ok === true ? record(hostEnvelope.result) : record(args.host)
  const ready = hostResult.ready === true || (manifest.status === 'ready' && processAlive)
  const history = manifest.history ?? []
  const last = history.at(-1)
  const artifactCount = args.artifacts?.artifacts.length ?? 0
  const attention: string[] = []
  if (manifest.cleanupError) attention.push(`Cleanup is incomplete: ${manifest.cleanupError}`)
  if (manifest.error) attention.push(manifest.error)
  if (hostEnvelope.ok === false) attention.push(`Host reported ${bounded(record(hostEnvelope.error).message, 300) || 'an error'}.`)
  if (!processAlive && (manifest.status === 'starting' || manifest.status === 'ready')) attention.push('The recorded process is no longer alive.')

  const nextActions: MortiseUiAiAction[] = []
  if (ready) {
    nextActions.push({ label: 'Observe the current UI', reason: 'The run is ready for semantic inspection.', command: 'snapshot' })
    nextActions.push({ label: 'Discover relevant capabilities', reason: 'Use the current surface catalog before composing an unfamiliar action.', command: 'capabilities list' })
  } else if (manifest.status === 'starting' && processAlive) {
    nextActions.push({ label: 'Check readiness again', reason: 'The adapter is running but the UI is not ready yet.', command: 'status' })
  } else if (manifest.status === 'failed') {
    nextActions.push({ label: 'Inspect failure evidence', reason: 'The run failed and can be diagnosed offline.', command: 'evidence' })
    if (manifest.cleanupError) nextActions.push({ label: 'Retry cleanup', reason: 'The disposable profile was not removed.', command: 'stop' })
  } else if (manifest.status === 'stopped') {
    nextActions.push({ label: 'Inspect retained evidence', reason: 'The UI is stopped but its validation artifacts remain available.', command: 'evidence' })
  }

  return {
    summary: `${manifest.label ? `Run ${manifest.label}` : `Run ${manifest.runId}`} is ${ready ? 'ready' : manifest.status}${processAlive ? ' with a live process' : ''}.`,
    identity: { runId: manifest.runId, label: manifest.label, surface: manifest.surface },
    state: {
      status: manifest.status,
      processAlive,
      ready,
      windowMode: manifest.windowMode,
      profileMode: manifest.profileMode,
      lastRevision: manifest.lastRevision ?? 0,
      lastResponseSeq: manifest.lastResponseSeq ?? 0,
      verificationLevel: manifest.verificationLevel ?? 'scenario-verified',
    },
    attention,
    recentActivity: history.slice(-8),
    lastActivity: last,
    evidence: { artifactCount, manifestPath: `${manifest.artifactsDir}\\manifest.json` },
    nextActions: nextActions.map(action => ({ ...action, run: manifest.runId })),
  }
}

export function createActionObservation(actionResult: unknown, snapshotResult: unknown): JsonRecord {
  const action = record(actionResult)
  const snapshot = record(snapshotResult)
  const briefing = createSnapshotBriefing(snapshot)
  const changes = record(snapshot.changes)
  const added = array(changes.added)
  const updated = array(changes.updated)
  const removed = array(changes.removed)
  return {
    action,
    observed: snapshot,
    semanticDelta: {
      added: added.length,
      updated: updated.length,
      removed: removed.length,
      fullSnapshot: snapshot.full !== false,
      ...(Object.keys(changes).length > 0 ? { changes } : {}),
    },
    briefing,
  }
}

export function historyEntry(command: string, response: { ok: boolean; seq?: number; revision?: number; result?: unknown; error?: unknown }): MortiseUiHistoryEntry {
  const error = record(response.error)
  const result = record(response.result)
  const action = record(result.action ?? result)
  const target = record(action.targetResolved)
  return {
    at: new Date().toISOString(),
    command,
    outcome: response.ok ? 'succeeded' : 'failed',
    ...(typeof response.seq === 'number' ? { seq: response.seq } : {}),
    ...(typeof response.revision === 'number' ? { revision: response.revision } : {}),
    ...(response.ok ? {} : { errorCode: string(error.code), summary: bounded(error.message, 300) }),
    ...(response.ok && string(target.name) ? { summary: `${command} completed on ${string(target.role) ?? 'target'} "${string(target.name)}".` } : {}),
  }
}

function describeRoute(route: JsonRecord): string | undefined {
  const surface = string(route.surface)
  if (!surface) return undefined
  const details = [string(route.section), string(route.workspaceId), string(route.sessionId)].filter(Boolean)
  return details.length > 0 ? `${surface} (${details.join(', ')})` : surface
}

function describeAttention(role: string, name: string, state: JsonRecord): string {
  if (state.busy === true) return `${name || role} is busy.`
  if (role === 'dialog' || role === 'alertdialog') return `${name || 'A dialog'} requires attention.`
  return `${name || role} is visible.`
}

function preferredAction(actions: string[]): string {
  for (const action of ['click', 'fill', 'select', 'press']) if (actions.includes(action)) return action
  return actions[0] ?? 'click'
}

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
}

function array(value: unknown): unknown[] { return Array.isArray(value) ? value : [] }
function string(value: unknown): string | undefined { return typeof value === 'string' && value.length > 0 ? value : undefined }
function number(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined }
function bounded(value: unknown, max: number): string { return typeof value === 'string' ? value.slice(0, max) : '' }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [] }
