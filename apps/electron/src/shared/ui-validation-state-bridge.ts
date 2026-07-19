import type { UiValidationScopedStateUpdate } from '@mortise/shared/ui-validation'

export interface UiValidationRendererStateBatch {
  version: 1
  states: UiValidationScopedStateUpdate[]
}

export interface UiValidationRendererBridgeApi {
  publishState(batch: UiValidationRendererStateBatch): void
  dispose(): void
}
