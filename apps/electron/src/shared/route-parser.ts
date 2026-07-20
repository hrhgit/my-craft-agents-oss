/**
 * Route Parser
 *
 * Parses route strings back into structured navigation objects.
 * Used by both the navigate() function and deep link handler.
 *
 * Supports route formats:
 * - Action: action/{name}[/{id}] - Trigger side effects
 * - Compound: {filter}[/session/{sessionId}] - View routes for full navigation state
 */

import type {
  NavigationState,
  SessionFilter,
  AutomationFilter,
} from './types'
import { isValidSettingsSubpage, type SettingsSubpage } from './settings-registry'

// =============================================================================
// Route Types
// =============================================================================

export type RouteType = 'action' | 'view'

export interface ParsedRoute {
  type: RouteType
  name: string
  id?: string
  params: Record<string, string>
}

// =============================================================================
// Compound Route Types (new format)
// =============================================================================

export type NavigatorType = 'sessions' | 'skills' | 'automations' | 'settings'

export interface ParsedCompoundRoute {
  /** The navigator type */
  navigator: NavigatorType
  /** Session filter (only for sessions navigator) */
  sessionFilter?: SessionFilter
  /** Automation filter (only for automations navigator) */
  automationFilter?: AutomationFilter
  /** Details page info (null for empty state) */
  details: {
    type: string
    id: string
  } | null
}

// =============================================================================
// Compound Route Parsing
// =============================================================================

/**
 * Known prefixes that indicate a compound route
 */
const COMPOUND_ROUTE_PREFIXES = [
  'allSessions', 'flagged', 'archived', 'state', 'label', 'view', 'skills', 'automations', 'settings'
]

/**
 * Check if a route is a compound route (new format)
 */
export function isCompoundRoute(route: string): boolean {
  const firstSegment = route.split('/')[0]
  return COMPOUND_ROUTE_PREFIXES.includes(firstSegment)
}

/**
 * Parse a compound route into structured navigation
 *
 * Examples:
 *   'allSessions' -> { navigator: 'sessions', sessionFilter: { kind: 'allSessions' }, details: null }
 *   'allSessions/session/abc123' -> { navigator: 'sessions', sessionFilter: { kind: 'allSessions' }, details: { type: 'session', id: 'abc123' } }
 *   'flagged/session/abc123' -> { navigator: 'sessions', sessionFilter: { kind: 'allSessions' }, details: { type: 'session', id: 'abc123' } }
 *   'settings' -> { navigator: 'settings', details: null }  // navigator-only view
 *   'settings/shortcuts' -> { navigator: 'settings', details: { type: 'shortcuts', id: 'shortcuts' } }
 */
export function parseCompoundRoute(route: string): ParsedCompoundRoute | null {
  const segments = route.split('/').filter(Boolean)
  if (segments.length === 0) return null

  const first = segments[0]

  // Settings navigator
  if (first === 'settings') {
    const subpage = segments[1]
    if (subpage === undefined) {
      // Bare `settings` route — navigator-only view (compact) / App fallback (desktop).
      return { navigator: 'settings', details: null }
    }
    if (!isValidSettingsSubpage(subpage)) return null
    return {
      navigator: 'settings',
      details: { type: subpage, id: subpage },
    }
  }

  // Skills navigator
  if (first === 'skills') {
    if (segments.length === 1) {
      return { navigator: 'skills', details: null }
    }

    // skills/skill/{skillSlug}
    if (segments[1] === 'skill' && segments[2]) {
      return {
        navigator: 'skills',
        details: { type: 'skill', id: segments[2] },
      }
    }

    return null
  }

  // Automations navigator - supports type filters (scheduled, event, agentic)
  if (first === 'automations') {
    if (segments.length === 1) {
      return { navigator: 'automations', details: null }
    }

    // Check for type filter: automations/scheduled, automations/event, automations/agentic
    const validAutomationTypes = ['scheduled', 'event', 'agentic']
    if (validAutomationTypes.includes(segments[1])) {
      const automationType = segments[1] as 'scheduled' | 'event' | 'agentic'
      const automationFilter: AutomationFilter = { kind: 'type', automationType }

      // Check for automation selection within filtered view: automations/scheduled/automation/{automationId}
      if (segments[2] === 'automation' && segments[3]) {
        return {
          navigator: 'automations',
          automationFilter,
          details: { type: 'automation', id: segments[3] },
        }
      }

      // Just the filter, no selection
      return { navigator: 'automations', automationFilter, details: null }
    }

    // Unfiltered automation selection: automations/automation/{automationId}
    if (segments[1] === 'automation' && segments[2]) {
      return {
        navigator: 'automations',
        details: { type: 'automation', id: segments[2] },
      }
    }

    return null
  }

  // Sessions navigator. Retired organization routes still resolve to All Sessions.
  let sessionFilter: SessionFilter
  let detailsStartIndex: number

  switch (first) {
    case 'allSessions':
      sessionFilter = { kind: 'allSessions' }
      detailsStartIndex = 1
      break
    case 'flagged':
      sessionFilter = { kind: 'allSessions' }
      detailsStartIndex = 1
      break
    case 'archived':
      sessionFilter = { kind: 'allSessions' }
      detailsStartIndex = 1
      break
    case 'state':
      if (!segments[1]) return null
      sessionFilter = { kind: 'allSessions' }
      detailsStartIndex = 2
      break
    case 'label':
      if (!segments[1]) return null
      sessionFilter = { kind: 'allSessions' }
      detailsStartIndex = 2
      break
    case 'view':
      if (!segments[1]) return null
      sessionFilter = { kind: 'allSessions' }
      detailsStartIndex = 2
      break
    default:
      return null
  }

  // Check for details
  if (segments.length > detailsStartIndex) {
    const detailsType = segments[detailsStartIndex]
    const detailsId = segments[detailsStartIndex + 1]
    if (detailsType === 'session' && detailsId) {
      return {
        navigator: 'sessions',
        sessionFilter,
        details: { type: 'session', id: detailsId },
      }
    }
    if (detailsType === 'new' && detailsId) {
      const draftId = safeDecodeURIComponent(detailsId)
      if (draftId === null) return null
      return {
        navigator: 'sessions',
        sessionFilter,
        details: { type: 'new', id: draftId },
      }
    }
  }

  return {
    navigator: 'sessions',
    sessionFilter,
    details: null,
  }
}

/**
 * Build a compound route string from parsed state
 */
export function buildCompoundRoute(parsed: ParsedCompoundRoute): string {
  if (parsed.navigator === 'settings') {
    if (!parsed.details) return 'settings'
    return `settings/${parsed.details.type}`
  }

  if (parsed.navigator === 'skills') {
    if (!parsed.details) return 'skills'
    return `skills/skill/${parsed.details.id}`
  }

  if (parsed.navigator === 'automations') {
    // Build base from filter (automations, automations/scheduled, automations/event, automations/agentic)
    let base = 'automations'
    if (parsed.automationFilter?.kind === 'type') {
      base = `automations/${parsed.automationFilter.automationType}`
    }
    if (!parsed.details) return base
    return `${base}/automation/${parsed.details.id}`
  }

  // Sessions navigator
  const filter = parsed.sessionFilter
  if (!filter) return 'allSessions'
  const base = 'allSessions'

  if (!parsed.details) return base
  if (parsed.details.type === 'new') return `${base}/new/${encodeURIComponent(parsed.details.id)}`
  return `${base}/session/${parsed.details.id}`
}

// =============================================================================
// Route Parsing
// =============================================================================

/**
 * Parse a route string into structured navigation
 *
 * Examples:
 *   'allSessions' -> { type: 'view', name: 'allSessions', params: {} }
 *   'allSessions/session/abc123' -> { type: 'view', name: 'session', id: 'abc123', params: { filter: 'allSessions' } }
 *   'settings/shortcuts' -> { type: 'view', name: 'shortcuts', params: {} }
 *   'action/new-session' -> { type: 'action', name: 'new-session', params: {} }
 */
export function parseRoute(route: string): ParsedRoute | null {
  try {
    // Check if this is a compound route (preferred format)
    if (isCompoundRoute(route)) {
      const compound = parseCompoundRoute(route)
      if (compound) {
        return convertCompoundToViewRoute(compound)
      }
    }

    // Parse action routes: action/{name}[/{id}]
    const [pathPart, queryPart] = route.split('?')
    const segments = pathPart.split('/').filter(Boolean)

    if (segments.length < 2) {
      return null
    }

    const type = segments[0]
    if (type !== 'action') {
      return null
    }

    const name = segments[1]
    const id = segments[2]

    // Parse query params
    const params: Record<string, string> = {}
    if (queryPart) {
      const searchParams = new URLSearchParams(queryPart)
      searchParams.forEach((value, key) => {
        params[key] = value
      })
    }

    return { type: 'action', name, id, params }
  } catch {
    return null
  }
}

/**
 * Convert a parsed compound route to ParsedRoute format (type: 'view')
 */
function convertCompoundToViewRoute(compound: ParsedCompoundRoute): ParsedRoute {
  // Settings
  if (compound.navigator === 'settings') {
    const subpage = compound.details?.type || 'app'
    if (subpage === 'app') {
      return { type: 'view', name: 'settings', params: {} }
    }
    return { type: 'view', name: subpage, params: {} }
  }

  // Skills
  if (compound.navigator === 'skills') {
    if (!compound.details) {
      return { type: 'view', name: 'skills', params: {} }
    }
    return { type: 'view', name: 'skill-info', id: compound.details.id, params: {} }
  }

  // Automations
  if (compound.navigator === 'automations') {
    if (!compound.details) {
      return { type: 'view', name: 'automations', params: {} }
    }
    return { type: 'view', name: 'automation-info', id: compound.details.id, params: {} }
  }

  // Sessions
  if (compound.sessionFilter) {
    const filter = compound.sessionFilter
    if (compound.details) {
      return {
        type: 'view',
        name: compound.details.type === 'new' ? 'new-conversation' : 'session',
        id: compound.details.id,
        params: { filter: 'allSessions' },
      }
    }
    return {
      type: 'view',
      name: 'allSessions',
      params: {},
    }
  }

  return { type: 'view', name: 'allSessions', params: {} }
}

// =============================================================================
// NavigationState Parsing (new unified system)
// =============================================================================

/**
 * Parse a route string directly to NavigationState (the unified state)
 *
 * This is the preferred way to parse routes - returns the unified state that
 * determines all 3 panels (sidebar, navigator, main content).
 *
 * Supports:
 * - Compound routes: allSessions, allSessions/session/abc, skills, settings/shortcuts
 * Returns null for action routes (they don't map to a navigation state) and invalid routes.
 */
export function parseRouteToNavigationState(route: string): NavigationState | null {
  // Parse compound routes
  if (isCompoundRoute(route)) {
    const compound = parseCompoundRoute(route)
    if (compound) {
      return convertCompoundToNavigationState(compound)
    }
  }

  // Parse as route (may be action or view)
  const parsed = parseRoute(route)
  if (!parsed) return null

  // Actions don't map to navigation state
  if (parsed.type === 'action') return null

  // Convert view routes to NavigationState
  return convertParsedRouteToNavigationState(parsed)
}

/**
 * Convert a ParsedCompoundRoute to NavigationState
 */
function convertCompoundToNavigationState(compound: ParsedCompoundRoute): NavigationState {
  // Settings
  if (compound.navigator === 'settings') {
    if (!compound.details) {
      return { navigator: 'settings', subpage: null }
    }
    return { navigator: 'settings', subpage: compound.details.type as SettingsSubpage }
  }

  // Skills
  if (compound.navigator === 'skills') {
    if (!compound.details) {
      return { navigator: 'skills', details: null }
    }
    return {
      navigator: 'skills',
      details: { type: 'skill', skillSlug: compound.details.id },
    }
  }

  // Automations - include filter if present
  if (compound.navigator === 'automations') {
    if (!compound.details) {
      return {
        navigator: 'automations',
        filter: compound.automationFilter,
        details: null,
      }
    }
    return {
      navigator: 'automations',
      filter: compound.automationFilter,
      details: { type: 'automation', automationId: compound.details.id },
    }
  }

  // Sessions
  const filter = compound.sessionFilter || { kind: 'allSessions' as const }
  if (compound.details) {
    if (compound.details.type === 'new') {
      return {
        navigator: 'sessions',
        filter,
        details: { type: 'new', draftId: compound.details.id },
      }
    }
    return {
      navigator: 'sessions',
      filter,
      details: { type: 'session', sessionId: compound.details.id },
    }
  }
  return {
    navigator: 'sessions',
    filter,
    details: null,
  }
}

/**
 * Convert a ParsedRoute (view type) to NavigationState
 */
function convertParsedRouteToNavigationState(parsed: ParsedRoute): NavigationState | null {
  // Only handle view routes (compound routes converted to view type)
  if (parsed.type !== 'view') {
    return null
  }

  switch (parsed.name) {
    case 'settings':
      return { navigator: 'settings', subpage: 'app' }
    case 'workspace':
      return { navigator: 'settings', subpage: 'workspace' }
    case 'permissions':
      return { navigator: 'settings', subpage: 'permissions' }
    case 'labels':
      return { navigator: 'sessions', filter: { kind: 'allSessions' }, details: null }
    case 'shortcuts':
      return { navigator: 'settings', subpage: 'shortcuts' }
    case 'preferences':
      return { navigator: 'settings', subpage: 'preferences' }
    case 'skills':
      return { navigator: 'skills', details: null }
    case 'skill-info':
      if (parsed.id) {
        return {
          navigator: 'skills',
          details: {
            type: 'skill',
            skillSlug: parsed.id,
          },
        }
      }
      return { navigator: 'skills', details: null }
    case 'automations':
      return { navigator: 'automations', details: null }
    case 'automation-info':
      if (parsed.id) {
        return {
          navigator: 'automations',
          details: {
            type: 'automation',
            automationId: parsed.id,
          },
        }
      }
      return { navigator: 'automations', details: null }
    case 'session':
      if (parsed.id) {
        return {
          navigator: 'sessions',
          filter: { kind: 'allSessions' },
          details: { type: 'session', sessionId: parsed.id },
        }
      }
      return { navigator: 'sessions', filter: { kind: 'allSessions' }, details: null }
    case 'allSessions':
      return {
        navigator: 'sessions',
        filter: { kind: 'allSessions' },
        details: null,
      }
    case 'flagged':
    case 'archived':
    case 'state':
    case 'label':
    case 'view':
      return { navigator: 'sessions', filter: { kind: 'allSessions' }, details: null }
    case 'new-conversation':
      return {
        navigator: 'sessions',
        filter: { kind: 'allSessions' },
        details: { type: 'new', draftId: parsed.id || 'default' },
      }
    default:
      return null
  }
}

/**
 * Convert NavigationState to ParsedCompoundRoute
 */
function navigationStateToCompoundRoute(state: NavigationState): ParsedCompoundRoute {
  if (state.navigator === 'settings') {
    if (state.subpage === null) {
      return { navigator: 'settings', details: null }
    }
    return {
      navigator: 'settings',
      details: { type: state.subpage, id: state.subpage },
    }
  }

  if (state.navigator === 'skills') {
    return {
      navigator: 'skills',
      details: state.details?.type === 'skill' ? { type: 'skill', id: state.details.skillSlug } : null,
    }
  }

  if (state.navigator === 'automations') {
    return {
      navigator: 'automations',
      automationFilter: state.filter ?? undefined,
      details: state.details ? { type: 'automation', id: state.details.automationId } : null,
    }
  }

  // Sessions
  return {
    navigator: 'sessions',
    sessionFilter: state.filter,
    details: state.details
      ? state.details.type === 'session'
        ? { type: 'session', id: state.details.sessionId }
        : { type: 'new', id: state.details.draftId }
      : null,
  }
}

function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

/**
 * Build a route string from NavigationState
 */
export function buildRouteFromNavigationState(state: NavigationState): string {
  return buildCompoundRoute(navigationStateToCompoundRoute(state))
}
