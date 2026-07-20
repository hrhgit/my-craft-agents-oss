import type { UiValidationRoute, UiValidationScopedWait } from '@mortise/shared/ui-validation'
import { isValidSettingsSubpage } from '../../shared/settings-registry'
import { routes } from '../../shared/routes'
import { ElectronUiDriverError } from './electron-surface-driver'

export interface UiValidationResolvedRoute {
  route: UiValidationRoute
  deepLinkRoute?: string
  ready: UiValidationScopedWait
  dependencies: UiValidationScopedWait[]
}

export function resolveUiValidationRoute(input: unknown, windowId?: string): UiValidationResolvedRoute {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('open requires a typed route object.')
  const outer = input as Record<string, unknown>
  const raw = outer.route && typeof outer.route === 'object' && !Array.isArray(outer.route)
    ? outer.route as Record<string, unknown>
    : outer
  const surface = requiredString(raw.surface, 'route.surface')
  const workspaceId = optionalString(raw.workspaceId, 'route.workspaceId')
  const sessionId = optionalString(raw.sessionId, 'route.sessionId')
  const section = optionalString(raw.section, 'route.section')
  let deepLinkRoute: string | undefined
  if (surface === 'chat') {
    rejectKeys(raw, ['surface', 'workspaceId', 'sessionId'])
    deepLinkRoute = routes.view.allSessions(sessionId)
  } else if (surface === 'settings') {
    rejectKeys(raw, ['surface', 'workspaceId', 'section'])
    if (section && !isValidSettingsSubpage(section)) throw invalid(`Unknown settings section ${section}.`)
    deepLinkRoute = section && isValidSettingsSubpage(section) ? routes.view.settings(section) : routes.view.settings()
  } else if (surface === 'skills') {
    rejectKeys(raw, ['surface', 'workspaceId', 'section'])
    deepLinkRoute = routes.view.skills(section)
  } else if (surface === 'automations') {
    rejectKeys(raw, ['surface', 'workspaceId', 'section'])
    if (section && !['scheduled', 'event', 'agentic'].includes(section)) throw invalid('Automations section must be scheduled, event, or agentic.')
    deepLinkRoute = routes.view.automations(section ? { type: section as 'scheduled' | 'event' | 'agentic' } : undefined)
  } else if (surface === 'workspace-picker') {
    rejectKeys(raw, ['surface'])
  } else {
    throw invalid(`Unknown route surface ${surface}.`)
  }
  const route: UiValidationRoute = {
    surface,
    ...(workspaceId ? { workspaceId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(section ? { section } : {}),
  }
  const scoped = (wait: UiValidationScopedWait): UiValidationScopedWait => ({
    ...wait,
    ...(windowId ? { windowId } : {}),
  })
  const dependencies: UiValidationScopedWait[] = [
    scoped({ scope: 'app', phase: 'ready' }),
    scoped({ scope: 'transport', phase: 'ready' }),
    ...(surface === 'workspace-picker' ? [] : [scoped({
      scope: 'workspace',
      phase: 'ready',
      ...(workspaceId ? { entityId: workspaceId } : {}),
    })]),
    ...(surface === 'chat' ? [
      scoped({ scope: 'sessions', phase: 'ready' }),
      ...(sessionId ? [scoped({ scope: 'session', phase: 'ready', entityId: sessionId })] : []),
    ] : []),
  ]
  return {
    route,
    ...(deepLinkRoute ? { deepLinkRoute } : {}),
    dependencies,
    ready: surface === 'workspace-picker'
      ? scoped({ scope: 'workspace', phase: 'ready', detail: { selected: false } })
      : {
          scope: 'route',
          phase: 'ready',
          ...(windowId ? { windowId } : {}),
          detail: {
            surface,
            ...(sessionId ? { sessionId } : {}),
            ...(section ? { section } : {}),
          },
        },
  }
}

function rejectKeys(value: Record<string, unknown>, allowed: string[]): void {
  const unexpected = Object.keys(value).find(key => !allowed.includes(key))
  if (unexpected) throw invalid(`Unsupported route parameter ${unexpected}.`)
}

function requiredString(value: unknown, label: string): string {
  const result = optionalString(value, label)
  if (!result) throw invalid(`${label} is required.`)
  return result
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0 || value.length > 500) throw invalid(`${label} must be a bounded non-empty string.`)
  return value
}

function invalid(message: string): ElectronUiDriverError { return new ElectronUiDriverError('UNSUPPORTED', message) }
