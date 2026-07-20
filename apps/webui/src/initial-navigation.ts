import { routes } from '../../electron/src/shared/routes'

export function resolveInitialWebUiSearch(search: string): string {
  const params = new URLSearchParams(search)
  const hasExplicitTarget = params.has('route')
    || params.has('panels')
    || params.has('sessionId')
    || params.get('__mortiseUiScenarioHost') === '1'
  if (!hasExplicitTarget) params.set('route', routes.view.newConversation())
  const next = params.toString()
  return next ? `?${next}` : ''
}
