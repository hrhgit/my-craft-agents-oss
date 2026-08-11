import { requestMortiseUiHost } from './client.ts'
import { startMortiseUiRun, stopMortiseUiRun } from './controller.ts'
import type { MortiseUiRunManifest, MortiseUiSurface, MortiseUiWindowMode } from './protocol.ts'
import { INTERACTION_FLOWS } from '../e2e/ui-flows/catalog.ts'
import { UI_FLOW_HOST_START_WAIT_MS } from '../e2e/ui-flows/config.ts'
import { runInteractionFlows } from '../e2e/ui-flows/runner.ts'
import type { InteractionFlow, InteractionFlowRequest, InteractionFlowResult } from '../e2e/ui-flows/types.ts'

export interface InteractionFlowBatchOptions {
  surface?: MortiseUiSurface
  moduleIds?: readonly string[]
  flowIds?: readonly string[]
  label?: string
  windowMode?: MortiseUiWindowMode
  runRoot?: string
  adapterCommand?: string[]
  waitMs?: number
  expectedBuildId?: string
  skipBuild?: boolean
  keep?: boolean
}

interface InteractionFlowBatchDependencies {
  start: typeof startMortiseUiRun
  stop: typeof stopMortiseUiRun
  request: InteractionFlowRequest
}

export interface InteractionFlowBatchResult {
  run: MortiseUiRunManifest
  surface: MortiseUiSurface
  flows: InteractionFlowResult[]
  lifecycle: {
    hostStarts: 1
    scenarioResets: number
    hostStopped: boolean
  }
}

const defaultDependencies: InteractionFlowBatchDependencies = {
  start: startMortiseUiRun,
  stop: stopMortiseUiRun,
  request: async <T>(run: MortiseUiRunManifest, command: string, params: Record<string, unknown> = {}) => {
    const response = await requestMortiseUiHost<T>({ ...run, command, params, timeoutMs: 60_000 })
    if (!response.ok) throw new Error(`${command}: ${response.error.code}: ${response.error.message}`)
    return command === 'ui.action'
      ? { ...(response.result as object), verificationLevel: response.verificationLevel } as T
      : response.result
  },
}

export function selectInteractionFlows(filters: {
  moduleIds?: readonly string[]
  flowIds?: readonly string[]
} = {}): readonly InteractionFlow[] {
  const moduleIds = new Set(filters.moduleIds ?? [])
  const flowIds = new Set(filters.flowIds ?? [])
  const selected = INTERACTION_FLOWS.filter(flow =>
    (moduleIds.size === 0 || moduleIds.has(flow.moduleId))
    && (flowIds.size === 0 || flowIds.has(flow.id)))
  if (selected.length === 0) throw new Error('No interaction flows matched the requested filters')
  return selected
}

export function listInteractionFlows(filters: {
  moduleIds?: readonly string[]
  flowIds?: readonly string[]
} = {}): Array<Pick<InteractionFlow, 'id' | 'moduleId' | 'interactionId'>> {
  return selectInteractionFlows(filters).map(({ id, moduleId, interactionId }) => ({ id, moduleId, interactionId }))
}

export async function runInteractionFlowBatch(
  options: InteractionFlowBatchOptions = {},
  dependencies: InteractionFlowBatchDependencies = defaultDependencies,
): Promise<InteractionFlowBatchResult> {
  const surface = options.surface ?? 'electron'
  const flows = selectInteractionFlows(options)
  let run = await dependencies.start({
    surface,
    expectedBuildId: options.expectedBuildId,
    label: options.label ?? `flows-${surface}`,
    profileMode: 'fixture',
    windowMode: options.windowMode ?? (surface === 'electron' ? 'background' : 'foreground'),
    adapterCommand: options.adapterCommand,
    runRoot: options.runRoot,
    waitMs: options.waitMs ?? UI_FLOW_HOST_START_WAIT_MS,
    ...(options.skipBuild ? { extraEnv: { MORTISE_UI_SKIP_BUILD: '1' } } : {}),
  })
  let results: InteractionFlowResult[]
  try {
    results = await runInteractionFlows({ run, flows, request: dependencies.request })
  } finally {
    if (!options.keep) {
      run = await dependencies.stop(run.runDir)
      if (run.status !== 'stopped') throw new Error(`Interaction flow host did not stop cleanly: ${run.error ?? run.status}`)
    }
  }
  return {
    run,
    surface,
    flows: results,
    lifecycle: { hostStarts: 1, scenarioResets: flows.length, hostStopped: options.keep !== true },
  }
}
