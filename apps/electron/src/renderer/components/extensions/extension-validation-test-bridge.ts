import type {
  ExtensionUIValidationActionV1,
  ExtensionUIValidationDefinitionV1,
  ExtensionUIValidationScenarioV1,
} from '@mortise/shared/protocol'
import { extensionValidationStore, type RegisteredExtensionValidation } from './extension-validation-store'

export const EXTENSION_VALIDATION_TEST_BRIDGE_KEY = '__MORTISE_UI_VALIDATION_EXTENSION_BRIDGE_V1__'

export type ExtensionValidationBridgeErrorCode =
  | 'NOT_READY'
  | 'TARGET_NOT_FOUND'
  | 'AMBIGUOUS_TARGET'
  | 'DISABLED'
  | 'UNSUPPORTED'

export class ExtensionValidationBridgeError extends Error {
  constructor(readonly code: ExtensionValidationBridgeErrorCode, message: string) {
    super(message)
    this.name = 'ExtensionValidationBridgeError'
  }
}

export interface ExtensionValidationSelector {
  sessionId: string
  extensionId: string
  runtimeId?: string
  definitionId: string
}

export interface ExtensionValidationExecutionRequest extends ExtensionValidationSelector {
  kind: 'action' | 'scenario'
  id: string
  phase?: 'setup' | 'teardown'
  input?: unknown
}

export interface ExtensionValidationReadiness {
  ready: boolean
  phase: 'loading' | 'busy' | 'ready' | 'error'
  waitingFor: string[]
  errors: string[]
}

export interface ExtensionValidationTestBridgeV1 {
  schemaVersion: 1
  snapshot(filter?: { sessionId?: string; extensionId?: string }): Array<RegisteredExtensionValidation & { readiness: ExtensionValidationReadiness }>
  readiness(selector: ExtensionValidationSelector): ExtensionValidationReadiness
  execute(request: ExtensionValidationExecutionRequest): Promise<{
    invoked: true
    extensionId: string
    definitionId: string
    kind: 'action' | 'scenario'
    id: string
    phase?: 'setup' | 'teardown'
  }>
}

type InvokeExtensionCommand = (
  sessionId: string,
  command: string,
  args: Record<string, unknown> | undefined,
  ownerExtensionId: string,
) => Promise<{ invoked: boolean; error?: string }>

export function extensionValidationReadiness(definition: ExtensionUIValidationDefinitionV1): ExtensionValidationReadiness {
  const signals = new Map((definition.signals ?? []).map(signal => [signal.id, signal]))
  const required = definition.readyWhen ?? []
  const errors = required
    .map(id => signals.get(id))
    .filter(signal => signal?.status === 'error')
    .map(signal => signal?.detail || signal?.label || signal?.id || 'unknown')
  const waitingFor = required.filter(id => signals.get(id)?.status !== 'ready')
  if (errors.length > 0) return { ready: false, phase: 'error', waitingFor, errors }
  if (waitingFor.some(id => signals.get(id)?.status === 'busy')) return { ready: false, phase: 'busy', waitingFor, errors: [] }
  if (waitingFor.length > 0) return { ready: false, phase: 'loading', waitingFor, errors: [] }
  return { ready: true, phase: 'ready', waitingFor: [], errors: [] }
}

function resolve(selector: ExtensionValidationSelector): RegisteredExtensionValidation {
  const matches = extensionValidationStore.listAll().filter(item => item.sessionId === selector.sessionId
    && item.extensionId === selector.extensionId
    && (selector.runtimeId === undefined || item.runtimeId === selector.runtimeId)
    && item.definition.id === selector.definitionId)
  if (matches.length === 0) throw new ExtensionValidationBridgeError('TARGET_NOT_FOUND', 'Extension validation definition was not found.')
  if (matches.length > 1) throw new ExtensionValidationBridgeError('AMBIGUOUS_TARGET', 'More than one extension runtime matches; provide runtimeId.')
  return matches[0]!
}

function ensureBoundedInput(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ExtensionValidationBridgeError('UNSUPPORTED', 'Extension validation input must be an object.')
  }
  let serialized: string
  try { serialized = JSON.stringify(value) } catch { throw new ExtensionValidationBridgeError('UNSUPPORTED', 'Extension validation input must be JSON serializable.') }
  if (serialized.length > 32_768) throw new ExtensionValidationBridgeError('UNSUPPORTED', 'Extension validation input is too large.')
  return value as Record<string, unknown>
}

/** Validate the safe, commonly used JSON Schema subset accepted by extension scenarios. */
function validateInput(schema: Record<string, unknown> | undefined, input: Record<string, unknown> | undefined): void {
  if (!schema) return
  const value = input ?? {}
  if (schema.type !== undefined && schema.type !== 'object') {
    throw new ExtensionValidationBridgeError('UNSUPPORTED', 'Validation input schemas must describe an object.')
  }
  const required = Array.isArray(schema.required) ? schema.required : []
  for (const key of required) {
    if (typeof key !== 'string' || !(key in value)) throw new ExtensionValidationBridgeError('UNSUPPORTED', `Missing required input property ${String(key)}.`)
  }
  const properties = schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
    ? schema.properties as Record<string, unknown>
    : {}
  if (schema.additionalProperties === false) {
    const extra = Object.keys(value).find(key => !(key in properties))
    if (extra) throw new ExtensionValidationBridgeError('UNSUPPORTED', `Unknown input property ${extra}.`)
  }
  for (const [key, propertySchema] of Object.entries(properties)) {
    if (!(key in value) || !propertySchema || typeof propertySchema !== 'object' || Array.isArray(propertySchema)) continue
    const rule = propertySchema as Record<string, unknown>
    const actual = value[key]
    const actualType = Array.isArray(actual) ? 'array' : actual === null ? 'null' : typeof actual
    if (typeof rule.type === 'string' && actualType !== rule.type) throw new ExtensionValidationBridgeError('UNSUPPORTED', `Input property ${key} must be ${rule.type}.`)
    if (typeof actual === 'string' && typeof rule.maxLength === 'number' && actual.length > rule.maxLength) throw new ExtensionValidationBridgeError('UNSUPPORTED', `Input property ${key} is too long.`)
    if (Array.isArray(rule.enum) && !rule.enum.some(item => Object.is(item, actual))) throw new ExtensionValidationBridgeError('UNSUPPORTED', `Input property ${key} is not an allowed value.`)
  }
}

function commandFor(request: ExtensionValidationExecutionRequest, item: RegisteredExtensionValidation): {
  command: string
  schema?: Record<string, unknown>
  action?: ExtensionUIValidationActionV1
  scenario?: ExtensionUIValidationScenarioV1
} {
  if (request.kind === 'action') {
    const action = item.definition.actions?.find(candidate => candidate.id === request.id)
    if (!action) throw new ExtensionValidationBridgeError('TARGET_NOT_FOUND', 'Extension validation action was not found.')
    if (action.disabled) throw new ExtensionValidationBridgeError('DISABLED', 'Extension validation action is disabled.')
    return { command: action.command, schema: action.inputSchema, action }
  }
  const scenario = item.definition.scenarios?.find(candidate => candidate.id === request.id)
  if (!scenario) throw new ExtensionValidationBridgeError('TARGET_NOT_FOUND', 'Extension validation scenario was not found.')
  const phase = request.phase ?? 'setup'
  if (phase === 'teardown' && !scenario.teardownCommand) {
    throw new ExtensionValidationBridgeError('UNSUPPORTED', 'This extension scenario does not declare teardown.')
  }
  return phase === 'teardown'
    ? { command: scenario.teardownCommand!, schema: scenario.teardownInputSchema, scenario }
    : { command: scenario.command, schema: scenario.inputSchema, scenario }
}

export function createExtensionValidationTestBridge(invoke: InvokeExtensionCommand): ExtensionValidationTestBridgeV1 {
  return {
    schemaVersion: 1,
    snapshot(filter = {}) {
      return extensionValidationStore.listAll()
        .filter(item => (filter.sessionId === undefined || item.sessionId === filter.sessionId)
          && (filter.extensionId === undefined || item.extensionId === filter.extensionId))
        .map(item => ({ ...item, readiness: extensionValidationReadiness(item.definition) }))
    },
    readiness(selector) {
      return extensionValidationReadiness(resolve(selector).definition)
    },
    async execute(request) {
      const item = resolve(request)
      if (!extensionValidationReadiness(item.definition).ready && request.kind === 'action') {
        throw new ExtensionValidationBridgeError('NOT_READY', 'Extension validation definition is not ready for actions.')
      }
      const declared = commandFor(request, item)
      const input = ensureBoundedInput(request.input)
      validateInput(declared.schema, input)
      const result = await invoke(item.sessionId, declared.command, input, item.commandOwnerExtensionId)
      if (!result.invoked) throw new ExtensionValidationBridgeError('UNSUPPORTED', result.error || 'Extension command was not invoked.')
      return {
        invoked: true,
        extensionId: item.extensionId,
        definitionId: item.definition.id,
        kind: request.kind,
        id: request.id,
        ...(request.kind === 'scenario' ? { phase: request.phase ?? 'setup' } : {}),
      }
    },
  }
}

/** Install only when the preload has proven this is a source Test Host renderer. */
export function installExtensionValidationTestBridge(): (() => void) | undefined {
  if (typeof window === 'undefined' || window.electronAPI?.uiValidationTestHost?.enabled !== true) return undefined
  const invoke = window.electronAPI.invokeExtensionCommand
  if (typeof invoke !== 'function') return undefined
  const target = window as unknown as Record<string, unknown>
  const bridge = createExtensionValidationTestBridge((sessionId, command, args, owner) => invoke(sessionId, command, args, owner))
  Object.defineProperty(target, EXTENSION_VALIDATION_TEST_BRIDGE_KEY, { configurable: true, enumerable: false, writable: false, value: bridge })
  return () => { delete target[EXTENSION_VALIDATION_TEST_BRIDGE_KEY] }
}
