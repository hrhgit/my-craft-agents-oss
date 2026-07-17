import {
  parseUiValidationActionRequest,
  parseUiValidationWaitRequest,
  type UiValidationActionRequest,
  type UiValidationWaitRequest,
} from '@craft-agent/shared/ui-validation'

export function parseElectronActionParams(params: Record<string, unknown>): UiValidationActionRequest {
  const target = isRecord(params.target)
    ? params.target
    : typeof params.ref === 'string'
      ? { ref: params.ref }
      : typeof params.semanticId === 'string'
        ? { semanticId: params.semanticId }
        : typeof params.testId === 'string'
          ? { testId: params.testId }
          : undefined
  return parseUiValidationActionRequest({ ...params, target })
}

export function parseElectronWaitParams(params: Record<string, unknown>): UiValidationWaitRequest {
  return parseUiValidationWaitRequest({
    ...params,
    predicate: isRecord(params.predicate) ? params.predicate : params,
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
