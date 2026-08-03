import type { UiValidationVerificationLevel } from '@mortise/shared/ui-validation'
import type { MortiseUiRunManifest } from '../../mortise-ui/protocol.ts'
import type { InteractionFlow, InteractionFlowRequest, InteractionFlowResult } from './types.ts'

const verificationRank: Record<UiValidationVerificationLevel, number> = {
  'scenario-verified': 0,
  'renderer-verified': 1,
  'native-verified': 2,
}

export async function runInteractionFlows(args: {
  run: MortiseUiRunManifest
  flows: readonly InteractionFlow[]
  request: InteractionFlowRequest
}): Promise<InteractionFlowResult[]> {
  const results: InteractionFlowResult[] = []
  for (const flow of args.flows) {
    await args.request(args.run, 'scenario.reset')
    await args.request(args.run, 'scenario.apply', {
      name: flow.scenario.name,
      ...(flow.scenario.seed === undefined ? {} : { seed: flow.scenario.seed }),
      ...flow.scenario.params,
    })
    for (const [stepIndex, step] of flow.steps.entries()) {
      try {
        if (step.kind === 'assert') {
          await args.request(args.run, 'ui.assert', { predicate: step.predicate })
          continue
        }
        const response = await args.request<{ verificationLevel?: UiValidationVerificationLevel }>(args.run, 'ui.action', {
          target: step.target,
          action: step.action,
          mode: step.mode ?? 'semantic',
          ...(step.value === undefined ? {} : { value: step.value }),
        })
        const actual = response.verificationLevel
        if (step.minimumVerification && (!actual || verificationRank[actual] < verificationRank[step.minimumVerification])) {
          throw new Error(`expected ${step.minimumVerification}, received ${actual ?? 'none'}`)
        }
      } catch (error) {
        throw new Error(`${flow.id} step ${stepIndex + 1} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    results.push({ flowId: flow.id, moduleId: flow.moduleId, interactionId: flow.interactionId, steps: flow.steps.length })
  }
  return results
}
