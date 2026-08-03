import type { UiValidationScopedStateUpdate } from '@mortise/shared/ui-validation'

export function playgroundReadyStates(): UiValidationScopedStateUpdate[] {
  return [
    { scope: 'app', phase: 'ready', detail: { entry: 'playground', hydrated: true } },
    { scope: 'workspace', phase: 'ready', detail: { selected: false, transitioning: false } },
    { scope: 'sessions', phase: 'ready', detail: { count: 0, processingCount: 0 } },
    { scope: 'route', phase: 'ready', detail: { route: 'ui-validation/app-shell-scenario-host', surface: 'validation' } },
  ]
}
