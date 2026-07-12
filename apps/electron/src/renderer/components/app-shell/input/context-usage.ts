import { getModelContextWindow, type ModelDefinition } from '@config/models'

export interface ContextUsageStatus {
  inputTokens?: number
  contextWindow?: number
}

function validContextWindow(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined
}

/** Resolve a custom model's configured window when the runtime did not report one. */
export function getConnectionModelContextWindow(
  models: readonly (Pick<ModelDefinition, 'id' | 'contextWindow'> | string)[] | undefined,
  modelId: string,
): number | undefined {
  const model = models?.find(entry =>
    typeof entry === 'string' ? entry === modelId : entry.id === modelId,
  )
  return typeof model === 'string' ? undefined : validContextWindow(model?.contextWindow)
}

/**
 * Runtime usage is authoritative. Configured and built-in model windows keep
 * the indicator useful for custom Pi models when a provider omits that field.
 */
export function getContextUsagePercent(
  contextStatus: ContextUsageStatus | undefined,
  currentModel: string,
  configuredContextWindow?: number,
): { percent: number | null; inputTokens?: number; contextWindow?: number } {
  const contextWindow = validContextWindow(contextStatus?.contextWindow)
    ?? validContextWindow(configuredContextWindow)
    ?? validContextWindow(getModelContextWindow(currentModel))

  if (!contextStatus?.inputTokens || !contextWindow) {
    return {
      percent: null,
      inputTokens: contextStatus?.inputTokens,
      contextWindow,
    }
  }

  return {
    percent: Math.min(100, Math.round((contextStatus.inputTokens / contextWindow) * 100)),
    inputTokens: contextStatus.inputTokens,
    contextWindow,
  }
}
