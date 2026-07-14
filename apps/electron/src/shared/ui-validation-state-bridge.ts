import type { UiValidationScopedStateUpdate } from '@craft-agent/shared/ui-validation'

export interface UiValidationRendererStateBatch {
  version: 1
  states: UiValidationScopedStateUpdate[]
}

export interface UiValidationRendererBridgeApi {
  publishState(batch: UiValidationRendererStateBatch): void
  dispose(): void
}
