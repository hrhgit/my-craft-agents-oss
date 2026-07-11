import type { CapabilityProvider } from '../types.ts'

export const BROWSER_OPERATION_NAMES = [
  'snapshot', 'click', 'click-at', 'drag', 'fill', 'type', 'select', 'screenshot',
  'screenshot-region', 'wait', 'key', 'scroll', 'console', 'network', 'downloads',
  'resize', 'challenge',
] as const

export type BrowserOperation = typeof BROWSER_OPERATION_NAMES[number]
export type BrowserOperationAdapter = (
  operation: BrowserOperation,
  input: Record<string, unknown>,
  route: { sessionId: string; signal: AbortSignal },
) => Promise<unknown>

function objectInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Browser operation input must be an object')
  return input as Record<string, unknown>
}

function requiredString(value: Record<string, unknown>, key: string, max = 10_000): string {
  const field = value[key]
  if (typeof field !== 'string' || !field.trim() || field.length > max) throw new Error(`${key} must be a non-empty string up to ${max} characters`)
  return field
}

function optionalNumber(value: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const field = value[key]
  if (field === undefined) return undefined
  if (typeof field !== 'number' || !Number.isFinite(field) || field < min || field > max) throw new Error(`${key} is out of range`)
  return field
}

function requiredNumber(value: Record<string, unknown>, key: string, min: number, max: number): number {
  const result = optionalNumber(value, key, min, max)
  if (result === undefined) throw new Error(`${key} is required`)
  return result
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const unexpected = Object.keys(value).find(key => !keys.includes(key))
  if (unexpected) throw new Error(`Unexpected browser operation field: ${unexpected}`)
}

function validate(operation: BrowserOperation, input: unknown): Record<string, unknown> {
  const value = objectInput(input)
  requiredString(value, 'instanceId', 200)
  const base = ['instanceId']
  switch (operation) {
    case 'snapshot': case 'challenge': onlyKeys(value, base); break
    case 'click':
      onlyKeys(value, [...base, 'ref', 'waitFor', 'timeoutMs'])
      requiredString(value, 'ref', 500)
      if (value.waitFor !== undefined && !['none', 'navigation', 'network-idle'].includes(String(value.waitFor))) throw new Error('waitFor is invalid')
      optionalNumber(value, 'timeoutMs', 0, 60_000)
      break
    case 'click-at':
      onlyKeys(value, [...base, 'x', 'y']); requiredNumber(value, 'x', 0, 100_000); requiredNumber(value, 'y', 0, 100_000); break
    case 'drag':
      onlyKeys(value, [...base, 'x1', 'y1', 'x2', 'y2'])
      for (const key of ['x1', 'y1', 'x2', 'y2']) requiredNumber(value, key, 0, 100_000)
      break
    case 'fill': case 'select':
      onlyKeys(value, [...base, 'ref', 'value']); requiredString(value, 'ref', 500); requiredString(value, 'value'); break
    case 'type':
      onlyKeys(value, [...base, 'text']); requiredString(value, 'text'); break
    case 'screenshot':
      onlyKeys(value, [...base, 'format', 'jpegQuality', 'annotate'])
      if (value.format !== undefined && !['png', 'jpeg'].includes(String(value.format))) throw new Error('format is invalid')
      optionalNumber(value, 'jpegQuality', 1, 100)
      if (value.annotate !== undefined && typeof value.annotate !== 'boolean') throw new Error('annotate must be a boolean')
      break
    case 'screenshot-region':
      onlyKeys(value, [...base, 'x', 'y', 'width', 'height', 'ref', 'padding', 'format', 'jpegQuality'])
      if (value.ref === undefined) {
        for (const key of ['x', 'y', 'width', 'height']) requiredNumber(value, key, 0, 100_000)
      } else requiredString(value, 'ref', 500)
      optionalNumber(value, 'padding', 0, 1_000); optionalNumber(value, 'jpegQuality', 1, 100)
      break
    case 'wait':
      onlyKeys(value, [...base, 'kind', 'value', 'timeoutMs'])
      if (!['selector', 'text', 'url', 'network-idle'].includes(requiredString(value, 'kind', 30))) throw new Error('kind is invalid')
      if (value.value !== undefined) requiredString(value, 'value')
      optionalNumber(value, 'timeoutMs', 0, 60_000)
      break
    case 'key':
      onlyKeys(value, [...base, 'key', 'modifiers']); requiredString(value, 'key', 100)
      if (value.modifiers !== undefined && (!Array.isArray(value.modifiers) || value.modifiers.some(item => !['shift', 'control', 'alt', 'meta'].includes(String(item))))) throw new Error('modifiers are invalid')
      break
    case 'scroll':
      onlyKeys(value, [...base, 'direction', 'amount'])
      if (!['up', 'down', 'left', 'right'].includes(requiredString(value, 'direction', 10))) throw new Error('direction is invalid')
      optionalNumber(value, 'amount', 1, 100_000)
      break
    case 'console':
      onlyKeys(value, [...base, 'level', 'limit']); optionalNumber(value, 'limit', 1, 500); break
    case 'network':
      onlyKeys(value, [...base, 'status', 'method', 'resourceType', 'limit']); optionalNumber(value, 'limit', 1, 500); break
    case 'downloads':
      onlyKeys(value, [...base, 'action', 'limit', 'timeoutMs']); optionalNumber(value, 'limit', 1, 100); optionalNumber(value, 'timeoutMs', 0, 60_000); break
    case 'resize':
      onlyKeys(value, [...base, 'width', 'height']); requiredNumber(value, 'width', 320, 10_000); requiredNumber(value, 'height', 240, 10_000); break
  }
  return value
}

export function createBrowserOperationsProvider(adapter: BrowserOperationAdapter): CapabilityProvider {
  const operations = new Set<string>(BROWSER_OPERATION_NAMES)
  return {
    capability: 'browser.operate',
    async invoke(operation, input, context) {
      if (!operations.has(operation)) throw new Error(`Unsupported browser.operate operation: ${operation}`)
      return adapter(operation as BrowserOperation, validate(operation as BrowserOperation, input), {
        sessionId: context.request.sessionId,
        signal: context.signal,
      })
    },
  }
}
