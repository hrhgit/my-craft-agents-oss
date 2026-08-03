import type { UiValidationVerificationLevel } from '@mortise/shared/ui-validation'
import type { MortiseUiRunManifest } from '../../mortise-ui/protocol.ts'

export type InteractionTarget =
  | { semanticId: string }
  | { role: string; name: string; exact?: boolean }

export type InteractionFlowStep =
  | { kind: 'action'; target: InteractionTarget; action: 'click' | 'fill' | 'check' | 'select'; value?: string | boolean; mode?: 'semantic' | 'physical'; minimumVerification?: UiValidationVerificationLevel }
  | { kind: 'assert'; predicate: Record<string, unknown> }

export interface InteractionFlow {
  id: string
  moduleId: string
  interactionId: string
  scenario: { name: string; seed?: number; params?: Record<string, unknown> }
  steps: readonly InteractionFlowStep[]
}

export type InteractionFlowRequest = <T = Record<string, unknown>>(
  run: MortiseUiRunManifest,
  command: string,
  params?: Record<string, unknown>,
) => Promise<T>

export interface InteractionFlowResult {
  flowId: string
  moduleId: string
  interactionId: string
  steps: number
}
