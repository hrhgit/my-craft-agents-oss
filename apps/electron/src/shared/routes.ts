/**
 * Route Registry
 *
 * Type-safe route definitions for navigation throughout the app.
 * All navigation should use these route builders instead of hardcoded strings.
 *
 * Route Formats:
 * - action/{name}[/{id}] - Trigger side effects
 * - {filter}[/session/{sessionId}] - Compound view routes for full navigation state
 *
 * Usage:
 *   import { routes } from '@/shared/routes'
 *   navigate(routes.action.newSession())
 *   navigate(routes.view.allSessions())
 *   navigate(routes.view.settings('shortcuts'))
 */

import type { SettingsSubpage } from './settings-registry'
import type { PermissionMode } from '@mortise/shared/agent/mode-types'

// Helper to build query strings from params
function toQueryString(params?: Record<string, string | undefined>): string {
  if (!params) return ''
  const filtered = Object.entries(params).filter(([, v]) => v !== undefined)
  if (filtered.length === 0) return ''
  const searchParams = new URLSearchParams(
    filtered as [string, string][]
  )
  return `?${searchParams.toString()}`
}

/**
 * Route definitions with type-safe builders
 */
export const routes = {
  // ============================================
  // Action Routes - Trigger actions
  // ============================================
  action: {
    /**
     * Create a new session
     * @param input - Optional initial message to pre-fill or send
     * @param name - Optional session name
     * @param send - If true and input is provided, immediately sends the message
     */
    newSession: (params?: { input?: string; name?: string; send?: boolean }) =>
      `action/new-session${toQueryString(params ? { ...params, send: params.send ? 'true' : undefined } : undefined)}` as const,

    /** Rename a session */
    renameSession: (sessionId: string, name: string) =>
      `action/rename-session/${sessionId}?name=${encodeURIComponent(name)}` as const,

    /** Delete a session (with confirmation) */
    deleteSession: (sessionId: string) =>
      `action/delete-session/${sessionId}` as const,

    /** Start OAuth flow for a source */
    oauth: (sourceSlug: string) => `action/oauth/${sourceSlug}` as const,

    /** Open add source UI */
    addSource: () => 'action/add-source' as const,

    // Note: test-source route can be added when API support is available
    // testSource: (sourceSlug: string) => `action/test-source/${sourceSlug}` as const,

    /** Delete a source */
    deleteSource: (sourceSlug: string) =>
      `action/delete-source/${sourceSlug}` as const,

    /** Set permission mode for a session */
    setPermissionMode: (
      sessionId: string,
      mode: PermissionMode
    ) => `action/set-mode/${sessionId}?mode=${mode}` as const,

    /** Copy text to clipboard */
    copyToClipboard: (text: string) =>
      `action/copy?text=${encodeURIComponent(text)}` as const,
  },

  // ============================================
  // View Routes - Compound sidebar/navigator/details routes
  // ============================================
  view: {
    /** All sessions view (sessions navigator, allSessions filter) */
    allSessions: (sessionId?: string) =>
      sessionId ? `allSessions/session/${sessionId}` as const : 'allSessions' as const,

    /** Sources view (sources navigator) - supports type filtering */
    sources: (params?: { sourceSlug?: string; type?: 'api' | 'mcp' | 'local' }) => {
      const { sourceSlug, type } = params ?? {}
      // Build base from filter type
      const base = type ? `sources/${type}` : 'sources'
      if (sourceSlug) {
        return `${base}/source/${sourceSlug}` as const
      }
      return base as 'sources' | `sources/${'api' | 'mcp' | 'local'}`
    },

    /** API sources view (sources navigator, api filter) */
    sourcesApi: (sourceSlug?: string) =>
      sourceSlug
        ? `sources/api/source/${sourceSlug}` as const
        : 'sources/api' as const,

    /** MCP sources view (sources navigator, mcp filter) */
    sourcesMcp: (sourceSlug?: string) =>
      sourceSlug
        ? `sources/mcp/source/${sourceSlug}` as const
        : 'sources/mcp' as const,

    /** Local folder sources view (sources navigator, local filter) */
    sourcesLocal: (sourceSlug?: string) =>
      sourceSlug
        ? `sources/local/source/${sourceSlug}` as const
        : 'sources/local' as const,

    /** Skills view (skills navigator). Pass a slug string for a local skill detail view. */
    skills: (skillSlug?: string) => {
      if (!skillSlug) return 'skills' as const
      return `skills/skill/${skillSlug}` as const
    },

    /** Automations view (automations navigator) - supports type filtering */
    automations: (params?: { automationId?: string; type?: 'scheduled' | 'event' | 'agentic' }) => {
      const { automationId, type } = params ?? {}
      const base = type ? `automations/${type}` : 'automations'
      if (automationId) return `${base}/automation/${automationId}` as const
      return base as 'automations' | `automations/${'scheduled' | 'event' | 'agentic'}`
    },

    /** Scheduled automations view (automations navigator, scheduled filter) */
    automationsScheduled: (automationId?: string) =>
      automationId ? `automations/scheduled/automation/${automationId}` as const : 'automations/scheduled' as const,

    /** Event-based automations view (automations navigator, event filter) */
    automationsEvent: (automationId?: string) =>
      automationId ? `automations/event/automation/${automationId}` as const : 'automations/event' as const,

    /** Agentic automations view (automations navigator, agentic filter) */
    automationsAgentic: (automationId?: string) =>
      automationId ? `automations/agentic/automation/${automationId}` as const : 'automations/agentic' as const,

    /** Settings view (settings navigator) - uses SettingsSubpage from registry */
    settings: (subpage?: SettingsSubpage) =>
      subpage
        ? `settings/${subpage}` as const
        : 'settings' as const,
  },
} as const

/**
 * Type representing any valid route string
 */
export type ActionRoute = ReturnType<(typeof routes.action)[keyof typeof routes.action]>
export type ViewRoute = ReturnType<(typeof routes.view)[keyof typeof routes.view]>
export type Route = ActionRoute | ViewRoute
