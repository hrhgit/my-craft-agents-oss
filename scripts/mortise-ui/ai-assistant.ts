import type { MortiseUiArtifactManifest, MortiseUiHistoryEntry, MortiseUiRunManifest } from './protocol.ts'

const DEFAULT_MAX_TARGETS = 6
const EXPANDED_MAX_TARGETS = 16
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
  disclosure: {
    targets: {
      shown: number
      total: number
      omitted: number
      selection: string
    }
    details?: {
      reason: string
      command: string
      argv: string[]
    }
  }
}

export function createSnapshotBriefing(snapshot: unknown, options: { expanded?: boolean } = {}): MortiseUiAiBriefing {
  const value = record(snapshot)
  const window = record(value.window)
  const regions = record(value.regions)
  const route = record(value.route ?? record(value.state).route)
  const candidates: Array<{ target: MortiseUiAiBriefing['targets'][number]; priority: number; order: number }> = []
  const attention: string[] = []
  let focused: string | undefined
  let order = 0

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
      const ref = string(node.ref)
      const semanticId = string(node.semanticId)
      const testId = string(node.testId)
      const target = semanticId ? { semanticId } : testId ? { testId } : ref ? { ref } : { role, ...(name ? { name, exact: true } : {}) }
      candidates.push({ target: {
        label: name || `${role} in ${region}`,
        role,
        region,
        ...(ref ? { ref } : {}),
        ...(semanticId ? { semanticId } : {}),
        ...(testId ? { testId } : {}),
        ...(Object.keys(state).length > 0 ? { state } : {}),
        actions,
        suggestedAction: { target, action: preferredAction(actions, role) },
      }, priority: targetPriority(region, role, state), order: order++ })
    }
  }

  const nativeRevision = number(value.revision)
  for (const nativeWindow of array(value.windows)) {
    const native = record(nativeWindow)
    const windowName = bounded(native.name, 160) || 'native window'
    for (const rawNode of array(native.nodes)) {
      const node = record(rawNode)
      const actions = stringArray(node.actions)
      if (node.enabled === false || actions.length === 0) continue
      const ref = string(node.ref)
      if (!ref) continue
      const name = bounded(node.name, 160)
      const role = bounded(node.role, 60) || 'unknown'
      const state = {
        ...(node.focused === true ? { focused: true } : {}),
        ...(node.enabled === false ? { disabled: true } : {}),
      }
      candidates.push({ target: {
        label: name || `${role} in ${windowName}`,
        role,
        region: `native:${windowName}`,
        ref,
        ...(Object.keys(state).length > 0 ? { state } : {}),
        actions,
        suggestedAction: {
          target: { kind: 'native', ref },
          revision: nativeRevision,
          action: preferredAction(actions, role),
          mode: 'native',
        },
      }, priority: targetPriority('main', role, state), order: order++ })
    }
  }

  for (const surface of array(value.embeddedSurfaces)) {
    const embedded = record(surface)
    const surfaceId = string(embedded.surfaceId) ?? string(embedded.instanceId) ?? 'embedded'
    for (const rawNode of array(embedded.nodes)) {
      const node = record(rawNode)
      const actions = stringArray(node.actions)
      if (actions.length === 0) continue
      const ref = string(node.ref)
      const name = bounded(node.name, 160)
      const role = bounded(node.role, 60) || 'unknown'
      const revision = number(embedded.revision)
      candidates.push({ target: {
        label: name || `${role} in ${surfaceId}`,
        role,
        region: `embedded:${surfaceId}`,
        ...(ref ? { ref } : {}),
        actions,
        suggestedAction: ref
          ? { target: { kind: 'browser', instanceId: string(embedded.instanceId) ?? surfaceId, ref }, revision, action: preferredAction(actions, role) }
          : undefined,
      }, priority: 45, order: order++ })
    }
  }

  const maxTargets = options.expanded ? EXPANDED_MAX_TARGETS : DEFAULT_MAX_TARGETS
  const targets = candidates
    .sort((left, right) => right.priority - left.priority || left.order - right.order)
    .slice(0, maxTargets)
    .map(candidate => candidate.target)
  const omittedTargetCount = Math.max(0, candidates.length - targets.length)

  const routeLabel = describeRoute(route)
  const windowTitle = bounded(window.title, 120)
  const targetSummary = candidates.length === targets.length
    ? `${targets.length} immediately actionable target${targets.length === 1 ? '' : 's'}`
    : `${candidates.length} actionable targets; ${targets.length} decision-relevant targets shown`
  const summary = [
    windowTitle ? `Window "${windowTitle}"` : 'Selected UI window',
    routeLabel ? `is on ${routeLabel}` : undefined,
    targets.length > 0 ? `with ${targetSummary}` : 'with no immediately actionable targets',
  ].filter(Boolean).join(' ')

  const nextActions: MortiseUiAiAction[] = []
  if (attention.length > 0) {
    nextActions.push({ label: 'Inspect the active attention state', reason: attention[0]!, command: 'snapshot' })
  }
  if (attention.length === 0 && targets.length === 1 && targets[0]?.suggestedAction) {
    const target = targets[0]
    const suggestedAction = string(target.suggestedAction.action) ?? target.actions[0] ?? 'Use'
    nextActions.push({
      label: `${suggestedAction} ${target.label}`,
      reason: 'This is the only currently disclosed actionable target.',
      command: 'action',
      params: target.suggestedAction,
    })
  }
  if (targets.length === 0) {
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
    disclosure: {
      targets: {
        shown: targets.length,
        total: candidates.length,
        omitted: omittedTargetCount,
        selection: 'Attention, focused state, and main-workflow targets are shown first.',
      },
      ...(omittedTargetCount > 0 || value.truncated === true ? { details: {
        reason: value.truncated === true
          ? 'The semantic source was truncated; inspect the full observation or request a narrower scope when the target is absent.'
          : `${omittedTargetCount} lower-priority actionable target${omittedTargetCount === 1 ? ' is' : 's are'} not needed for the immediate decision.`,
        command: 'snapshot',
        argv: ['--full-observation'],
      } } : {}),
    },
  }
}

export function createRunBriefing(args: {
  manifest: MortiseUiRunManifest
  processAlive: boolean
  host?: unknown
  artifacts?: MortiseUiArtifactManifest
  artifactError?: string
}, options: { includeRecentActivity?: boolean; recentActivityLimit?: number; maxNextActions?: number } = {}): JsonRecord {
  const { manifest, processAlive } = args
  const hostEnvelope = record(args.host)
  const hostResult = hostEnvelope.ok === true ? record(hostEnvelope.result) : record(args.host)
  const ready = hostResult.ready === true || (manifest.status === 'ready' && processAlive)
  const history = manifest.history ?? []
  const last = history.at(-1)
  const artifactCount = args.artifacts?.artifacts.length ?? 0
  const attention: string[] = []
  if (args.artifactError) attention.push(`Evidence manifest is unavailable: ${bounded(args.artifactError, 240)}`)
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
    ...(options.includeRecentActivity ? { recentActivity: history.slice(-(options.recentActivityLimit ?? 5)) } : {}),
    lastActivity: last,
    evidence: { artifactCount, manifestPath: `${manifest.artifactsDir}\\manifest.json` },
    nextActions: nextActions.slice(0, options.maxNextActions ?? 2).map(action => ({ ...action, run: manifest.runId })),
  }
}

export function createActionObservation(actionResult: unknown, snapshotResult: unknown, includeFullObservation = false): JsonRecord {
  const action = record(actionResult)
  const snapshot = record(snapshotResult)
  const briefing = createSnapshotBriefing(snapshot)
  const changes = record(snapshot.changes)
  const added = array(changes.added)
  const updated = array(changes.updated)
  const removed = array(changes.removed)
  const stateChanges = array(action.stateChanges)
  const observed = includeFullObservation ? snapshot : {
      revision: snapshot.revision,
      window: compactWindow(snapshot.window),
      route: snapshot.route,
      truncated: snapshot.truncated,
    }
  return {
    action: includeFullObservation ? action : compactAction(action),
    observed,
    semanticDelta: {
      added: added.length,
      updated: updated.length,
      removed: removed.length,
      fullSnapshot: snapshot.full !== false,
      stateChanges: stateChanges.length,
      ...(includeFullObservation && Object.keys(changes).length > 0 ? { changes } : {}),
      ...(includeFullObservation && stateChanges.length > 0 ? { stateChangeDetails: stateChanges } : {}),
    },
    briefing,
    ...(!includeFullObservation && (Object.keys(changes).length > 0 || stateChanges.length > 0) ? { disclosure: {
      omitted: ['node-level semantic changes', 'raw post-action snapshot'],
      reason: 'The default result contains the outcome and decision-relevant post-action state; raw changes are useful only for deeper verification or diagnosis.',
      command: 'action',
      argv: ['--full-observation'],
    } } : {}),
  }
}

export function selectRelevantCapabilities(catalogValue: unknown, briefing: MortiseUiAiBriefing): JsonRecord {
  const catalog = record(catalogValue)
  const items = array(catalog.items).map(record)
  const currentActions = new Set(briefing.targets.flatMap(target => target.actions))
  const currentRoute = string(record(briefing.context.route).surface)
  const relevant = items.filter(item => {
    const kind = string(item.kind)
    const id = string(item.id)
    if (kind === 'route') return id === currentRoute
    if (kind === 'action' && id) return currentActions.has(id) || currentActions.has(id.replace(/^native\./, ''))
    return false
  })
  return {
    protocolVersion: catalog.protocolVersion,
    operation: 'relevant',
    summary: `${relevant.length} of ${items.length} capabilities are relevant to the current UI observation.`,
    currentActions: [...currentActions].sort(),
    items: relevant.map(item => ({
      kind: item.kind,
      id: item.id,
      description: item.description,
      verificationLevel: item.verificationLevel,
      surfaces: item.surfaces,
      modes: item.modes,
      describe: { command: 'capabilities describe', argv: ['--kind', item.kind, '--id', item.id] },
    })),
    disclosure: {
      shown: relevant.length,
      total: items.length,
      omitted: Math.max(0, items.length - relevant.length),
      reason: 'Only the current route and actions advertised by the selected targets are needed to compose the next interaction.',
      details: { command: 'capabilities list', argv: [], purpose: 'Inspect navigation alternatives, scenarios, extension discovery, or actions not currently available.' },
    },
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

function preferredAction(actions: string[], role: string): string {
  if (['textbox', 'searchbox'].includes(role) && actions.includes('fill')) return 'fill'
  if (['combobox', 'listbox'].includes(role) && actions.includes('select')) return 'select'
  for (const action of ['click', 'fill', 'select', 'press']) if (actions.includes(action)) return action
  return actions[0] ?? 'click'
}

function targetPriority(region: string, role: string, state: JsonRecord): number {
  if (role === 'alertdialog' || role === 'dialog' || role === 'alert') return 100
  if (state.busy === true) return 95
  if (state.focused === true) return 90
  if (state.selected === true || state.checked === true || state.expanded === true) return 80
  if (region === 'notification') return 75
  if (region === 'main') return 60
  if (region === 'navigation') return 50
  if (region === 'sidebar') return 40
  return 30
}

function compactWindow(value: unknown): JsonRecord | undefined {
  const window = record(value)
  if (Object.keys(window).length === 0) return undefined
  return {
    title: string(window.title),
    role: string(window.role),
    workspaceId: string(window.workspaceId),
    sessionId: string(window.sessionId),
  }
}

function compactAction(action: JsonRecord): JsonRecord {
  return {
    actionId: action.actionId,
    beforeRevision: action.beforeRevision,
    afterRevision: action.afterRevision,
    targetResolved: action.targetResolved,
    settledBy: action.settledBy,
    warnings: action.warnings,
    mode: action.mode,
  }
}

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
}

function array(value: unknown): unknown[] { return Array.isArray(value) ? value : [] }
function string(value: unknown): string | undefined { return typeof value === 'string' && value.length > 0 ? value : undefined }
function number(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined }
function bounded(value: unknown, max: number): string { return typeof value === 'string' ? value.slice(0, max) : '' }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [] }
