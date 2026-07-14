import {
  UI_VALIDATION_STATE_SCOPES,
  type UiValidationAppPhase,
  type UiValidationScopedState,
  type UiValidationScopedWait,
} from '@craft-agent/shared/ui-validation'

const PHASES: readonly UiValidationAppPhase[] = ['booting', 'loading', 'ready', 'busy', 'error', 'disposed']

export type ParsedStateCondition =
  | { kind: 'state'; predicate: UiValidationScopedWait }
  | { kind: 'event'; type: string }
  | { kind: 'snapshot' }

export function semanticReadyAppGate(windowId: number): UiValidationScopedWait {
  return { scope: 'app', phase: 'ready', windowId: String(windowId) }
}

export function parseStateCondition(condition: Record<string, unknown>, windowId?: number): ParsedStateCondition {
  const scopedWindowId = windowId === undefined ? undefined : String(windowId)
  if (condition.kind === 'ready') {
    return { kind: 'state', predicate: { scope: 'app', phase: 'ready', windowId: scopedWindowId } }
  }
  if (condition.kind === 'app-phase') {
    return { kind: 'state', predicate: { scope: 'app', phase: requiredPhase(condition.phase), windowId: scopedWindowId } }
  }
  if (condition.kind === 'rpc-idle') {
    return { kind: 'state', predicate: { scope: 'transport', phase: 'ready', windowId: scopedWindowId } }
  }
  if (condition.kind === 'render-idle') {
    return { kind: 'state', predicate: { scope: 'route', phase: 'ready', windowId: scopedWindowId } }
  }
  if (condition.kind === 'session-state') {
    const entityId = requiredBoundedString(condition.sessionId, 'sessionId')
    return { kind: 'state', predicate: { scope: 'session', phase: requiredPhase(condition.state), entityId, windowId: scopedWindowId } }
  }
  if (condition.kind === 'state') {
    const scope = condition.scope
    if (typeof scope !== 'string' || !UI_VALIDATION_STATE_SCOPES.includes(scope as never)) throw new Error('Unknown UI state scope.')
    const detail = condition.detail
    if (detail !== undefined && (!detail || typeof detail !== 'object' || Array.isArray(detail))) throw new Error('State detail predicate must be an object.')
    return {
      kind: 'state',
      predicate: {
        scope: scope as UiValidationScopedWait['scope'],
        ...(condition.phase === undefined ? {} : { phase: requiredPhase(condition.phase) }),
        ...(typeof condition.entityId === 'string' ? { entityId: requiredBoundedString(condition.entityId, 'entityId') } : {}),
        ...(detail ? { detail: detail as Record<string, unknown> } : {}),
        ...(scopedWindowId ? { windowId: scopedWindowId } : {}),
      },
    }
  }
  if (condition.kind === 'route') {
    const route = routeFromCondition(condition.route ?? condition)
    return { kind: 'state', predicate: { scope: 'route', phase: 'ready', windowId: scopedWindowId, detail: route } }
  }
  if (condition.kind === 'event') {
    return { kind: 'event', type: requiredBoundedString(condition.type, 'type') }
  }
  return { kind: 'snapshot' }
}

export function expectedRendererRoute(params: Record<string, unknown>): string | undefined {
  const raw = typeof params.route === 'string' ? params.route : typeof params.url === 'string' ? params.url : undefined
  if (!raw) return undefined
  if (!raw.startsWith('craftagents://')) return normalizeRoutePath(raw)
  try {
    const url = new URL(raw)
    return normalizeRoutePath(`${url.hostname}${url.pathname}`)
  } catch {
    return undefined
  }
}

function normalizeRoutePath(raw: string): string | undefined {
  const path = raw.split(/[?#]/, 1)[0]!.replace(/^\/+|\/+$/g, '')
  const segments = path.split('/').filter(Boolean)
  if (segments[0] === 'workspace' && segments.length >= 3) return segments.slice(2).join('/')
  return path || undefined
}

export function stateObservation(state: UiValidationScopedState): { matched: true; observed: UiValidationScopedState } {
  return { matched: true, observed: state }
}

function routeFromCondition(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') return { route: value }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('route predicate must be a string or object.')
  const route = value as Record<string, unknown>
  const detail: Record<string, unknown> = {}
  for (const key of ['route', 'surface', 'sessionId', 'section']) {
    if (typeof route[key] === 'string') detail[key] = route[key]
  }
  if (Object.keys(detail).length === 0) throw new Error('route predicate has no supported fields.')
  return detail
}

function requiredPhase(value: unknown): UiValidationAppPhase {
  if (typeof value !== 'string' || !PHASES.includes(value as UiValidationAppPhase)) throw new Error('Unknown UI state phase.')
  return value as UiValidationAppPhase
}

function requiredBoundedString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 300) throw new Error(`${field} must be a bounded non-empty string.`)
  return value
}
