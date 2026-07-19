import type { UiValidationScopedState, UiValidationScopedStateUpdate } from '@mortise/shared/ui-validation'

export function rendererStatesMissingFromBatch(
  existing: readonly UiValidationScopedState[],
  incoming: readonly UiValidationScopedStateUpdate[],
): UiValidationScopedState[] {
  const incomingStateKeys = new Set(incoming.map(rendererStateKey))
  return existing.filter(state =>
    state.scope !== 'native-driver'
    && state.phase !== 'disposed'
    && !incomingStateKeys.has(rendererStateKey(state)),
  )
}

function rendererStateKey(state: Pick<UiValidationScopedStateUpdate, 'scope' | 'entityId'>): string {
  return `${state.scope}\u0000${state.entityId ?? '*'}`
}
