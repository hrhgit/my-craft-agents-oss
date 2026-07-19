import { createHash } from 'node:crypto'
import {
  UiValidationError,
  assertSemanticRefRevision,
  type SemanticNode,
  type SemanticSnapshot,
  type UiValidationRoute,
  type UiValidationTarget,
} from '@mortise/shared/ui-validation'

export interface WebSemanticDescriptor {
  selector: string
  source?: 'dom' | 'accessibility' | 'business'
  semanticId?: string
  testId?: string
  role: string
  name: string
  value?: string
  description?: string
  states?: SemanticNode['states']
  bounds?: SemanticNode['bounds']
  actions?: SemanticNode['actions']
  actionModes?: SemanticNode['actionModes']
}

export interface ResolvedWebTarget {
  node: SemanticNode
  descriptor: WebSemanticDescriptor
}

export interface WebWaitBaseline {
  revision: number
  latestSeq: number
}

export interface WebWaitObservation<T = unknown> {
  matched: boolean
  value: T
}

export interface BoundedWebEventRead<T> {
  latestSeq: number
  events: T[]
  droppedBeforeSeq?: number
}

export interface WebAccessibilityNode {
  role?: { value?: unknown }
  name?: { value?: unknown }
  value?: { value?: unknown }
  description?: { value?: unknown }
  properties?: Array<{ name?: unknown; value?: { value?: unknown } }>
}

export function buildWebAccessibilityDescriptor(
  node: WebAccessibilityNode,
  location: { selector: string; testId?: string; bounds?: SemanticNode['bounds'] },
): WebSemanticDescriptor {
  const role = boundedAccessibilityString(node.role?.value, 100).toLocaleLowerCase()
  const name = boundedAccessibilityString(node.name?.value, 500)
  const description = boundedAccessibilityString(node.description?.value, 1_000)
  const rawValue = boundedAccessibilityString(node.value?.value, 1_000)
  const properties = new Map((node.properties ?? []).flatMap(property =>
    typeof property.name === 'string' ? [[property.name, property.value?.value] as const] : []))
  const checked = properties.get('checked')
  const sensitive = /password|secret|token|api.?key|credential/i.test(name)
  return {
    source: 'accessibility',
    selector: location.selector,
    ...(location.testId ? { testId: location.testId } : {}),
    role,
    name,
    ...(rawValue ? { value: sensitive ? '[REDACTED]' : rawValue } : {}),
    ...(description ? { description } : {}),
    states: {
      ...(typeof properties.get('disabled') === 'boolean' ? { disabled: properties.get('disabled') as boolean } : {}),
      ...(checked === true || checked === false || checked === 'mixed' ? { checked } : {}),
      ...(typeof properties.get('selected') === 'boolean' ? { selected: properties.get('selected') as boolean } : {}),
      ...(typeof properties.get('expanded') === 'boolean' ? { expanded: properties.get('expanded') as boolean } : {}),
      ...(typeof properties.get('focused') === 'boolean' ? { focused: properties.get('focused') as boolean } : {}),
      ...(typeof properties.get('busy') === 'boolean' ? { busy: properties.get('busy') as boolean } : {}),
    },
    ...(location.bounds ? { bounds: location.bounds } : {}),
  }
}

function boundedAccessibilityString(value: unknown, max: number): string {
  return typeof value === 'string'
    ? value.slice(0, max)
    : typeof value === 'number' || typeof value === 'boolean'
      ? String(value).slice(0, max)
      : ''
}

export function readBoundedWebEvents<T extends { seq: number }>(
  events: readonly T[],
  latestSeq: number,
  afterSeq = 0,
): BoundedWebEventRead<T> {
  const firstAvailableSeq = events[0]?.seq ?? latestSeq + 1
  return {
    latestSeq,
    events: events.filter(event => event.seq > afterSeq),
    ...(afterSeq + 1 < firstAvailableSeq ? { droppedBeforeSeq: firstAvailableSeq } : {}),
  }
}

export async function waitForWebCondition<T>(options: {
  baseline(): Promise<WebWaitBaseline>
  evaluate(): Promise<WebWaitObservation<T>>
  waitForChange(baseline: WebWaitBaseline, timeoutMs: number, signal?: AbortSignal): Promise<void>
  timeoutMs: number
  stableForMs?: number
  signal?: AbortSignal
  now?: () => number
}): Promise<{ observed: T; elapsedMs: number }> {
  const now = options.now ?? Date.now
  const startedAt = now()
  const stableForMs = options.stableForMs ?? 0
  let matchedSince: number | undefined
  while (true) {
    if (options.signal?.aborted) throw abortedWait(options.signal)
    // Capture the baseline before evaluating. waitForChange rechecks it after
    // subscribing, closing the check-to-subscribe race without polling.
    const baseline = await options.baseline()
    const observed = await options.evaluate()
    if (options.signal?.aborted) throw abortedWait(options.signal)
    const currentTime = now()
    if (observed.matched) {
      matchedSince ??= currentTime
      if (currentTime - matchedSince >= stableForMs) {
        return { observed: observed.value, elapsedMs: currentTime - startedAt }
      }
    } else {
      matchedSince = undefined
    }
    const elapsed = currentTime - startedAt
    const remaining = options.timeoutMs - elapsed
    if (remaining <= 0) throw new UiValidationError('TIMEOUT', `Condition was not met within ${options.timeoutMs}ms.`)
    const stableRemaining = matchedSince === undefined ? remaining : stableForMs - (currentTime - matchedSince)
    await options.waitForChange(baseline, Math.min(remaining, stableRemaining), options.signal)
  }
}

function abortedWait(signal: AbortSignal): UiValidationError {
  return new UiValidationError('ABORTED', 'WebUI validation wait was aborted.', {
    details: signal.reason === undefined ? undefined : { reason: String(signal.reason) },
    retryable: true,
  })
}

export function semanticNodeId(descriptor: WebSemanticDescriptor): string {
  if (descriptor.semanticId) return `business.${descriptor.semanticId.replace(/[^A-Za-z0-9._-]/g, '_')}`
  return `web.${createHash('sha256').update(`${descriptor.testId ?? ''}\0${descriptor.selector}`).digest('hex').slice(0, 20)}`
}

export function buildWebSemanticSnapshot(args: {
  revision: number
  descriptors: WebSemanticDescriptor[]
  route?: UiValidationRoute
  focusedSelector?: string
}): { snapshot: SemanticSnapshot; descriptorsByNodeId: Map<string, WebSemanticDescriptor> } {
  const descriptorsByNodeId = new Map<string, WebSemanticDescriptor>()
  const selectorToNodeId = new Map<string, string>()
  const preferred = new Map<string, WebSemanticDescriptor>()
  for (const descriptor of args.descriptors) {
    const current = preferred.get(descriptor.selector)
    if (!current) {
      preferred.set(descriptor.selector, descriptor)
      continue
    }
    const currentPriority = descriptorPriority(current)
    const nextPriority = descriptorPriority(descriptor)
    if (nextPriority > currentPriority) {
      preferred.set(descriptor.selector, {
        ...current,
        ...descriptor,
        states: { ...current.states, ...descriptor.states },
        ...(descriptor.bounds ?? current.bounds ? { bounds: descriptor.bounds ?? current.bounds } : {}),
      })
    }
  }
  for (const descriptor of preferred.values()) {
    const nodeId = semanticNodeId(descriptor)
    descriptorsByNodeId.set(nodeId, descriptor)
    selectorToNodeId.set(descriptor.selector, nodeId)
  }
  const nodes = [...descriptorsByNodeId].map(([nodeId, descriptor]) => ({
    ref: `r${args.revision}:${nodeId}`,
    nodeId,
    ...(descriptor.semanticId ? { semanticId: descriptor.semanticId } : {}),
    ...(descriptor.testId ? { testId: descriptor.testId } : {}),
    role: descriptor.role,
    name: descriptor.name,
    ...(descriptor.value === undefined ? {} : { value: descriptor.value }),
    ...(descriptor.description === undefined ? {} : { description: descriptor.description }),
    ...(descriptor.states === undefined ? {} : { states: descriptor.states }),
    ...(descriptor.bounds === undefined ? {} : { bounds: descriptor.bounds }),
    actions: descriptor.actions ?? webActionsForRole(descriptor.role, descriptor.states?.disabled === true),
    ...(descriptor.actionModes ? { actionModes: descriptor.actionModes } : {}),
  }))
  const focusedNodeId = args.focusedSelector ? selectorToNodeId.get(args.focusedSelector) : undefined
  return {
    snapshot: {
      revision: args.revision,
      windowId: 'webui-main',
      scope: 'webui',
      ...(args.route ? { route: args.route } : {}),
      ...(focusedNodeId ? { focusRef: `r${args.revision}:${focusedNodeId}` } : {}),
      nodes,
    },
    descriptorsByNodeId,
  }
}

function descriptorPriority(descriptor: WebSemanticDescriptor): number {
  if (descriptor.source === 'business' || descriptor.semanticId) return 3
  if (descriptor.source === 'accessibility') return 2
  return 1
}

function webActionsForRole(role: string, disabled: boolean): NonNullable<SemanticNode['actions']> {
  if (disabled) return []
  if (role === 'textbox' || role === 'searchbox') return ['click', 'fill', 'press']
  if (role === 'combobox' || role === 'listbox') return ['click', 'select', 'press', 'shortcut']
  if (['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'option'].includes(role)) return ['click', 'press', 'shortcut']
  if (['row', 'treeitem', 'listitem'].includes(role)) return ['click']
  return []
}

export function resolveWebTarget(
  target: UiValidationTarget,
  snapshot: SemanticSnapshot,
  descriptorsByNodeId: Map<string, WebSemanticDescriptor>,
): ResolvedWebTarget {
  let matches: SemanticNode[]
  if ('ref' in target) {
    const nodeId = assertSemanticRefRevision(target.ref, snapshot.revision)
    matches = snapshot.nodes.filter(node => node.nodeId === nodeId)
  } else if ('semanticId' in target) {
    matches = snapshot.nodes.filter(node => node.semanticId === target.semanticId)
  } else if ('testId' in target) {
    matches = snapshot.nodes.filter(node => node.testId === target.testId)
  } else if ('kind' in target) {
    throw new UiValidationError('UNSUPPORTED', 'Extension and native targets are not renderer semantic nodes.')
  } else {
    matches = snapshot.nodes.filter(node => {
      if (node.role !== target.role) return false
      if (target.name === undefined) return true
      return target.exact === false
        ? node.name.toLocaleLowerCase().includes(target.name.toLocaleLowerCase())
        : node.name === target.name
    })
  }
  if (matches.length === 0) throw new UiValidationError('TARGET_NOT_FOUND', 'No semantic node matched the target.')
  if (matches.length > 1) {
    throw new UiValidationError('AMBIGUOUS_TARGET', 'The semantic target matched more than one node.', {
      details: { count: matches.length, refs: matches.slice(0, 10).map(node => node.ref) },
    })
  }
  const node = matches[0]!
  const descriptor = descriptorsByNodeId.get(node.nodeId)
  if (!descriptor) throw new UiValidationError('STALE_REF', 'The semantic target is no longer present.', { retryable: true })
  return { node, descriptor }
}

export function routeFromParams(params: Record<string, unknown>): { route: UiValidationRoute; query: URLSearchParams } {
  const raw = typeof params.route === 'object' && params.route !== null ? params.route as Record<string, unknown> : params
  const surface = raw.surface
  if (!['chat', 'settings', 'sources', 'skills', 'automations', 'workspace-picker'].includes(String(surface))) {
    throw new UiValidationError('INVALID_REQUEST', 'app.open requires a registered route surface.')
  }
  const route: UiValidationRoute = {
    surface: surface as UiValidationRoute['surface'],
    ...(typeof raw.workspaceId === 'string' ? { workspaceId: raw.workspaceId } : {}),
    ...(typeof raw.sessionId === 'string' ? { sessionId: raw.sessionId } : {}),
    ...(typeof raw.section === 'string' ? { section: raw.section } : {}),
  }
  const query = new URLSearchParams()
  if (route.workspaceId) query.set('workspace', route.workspaceId)
  if (route.sessionId) query.set('session', route.sessionId)
  return { route, query }
}
