export type ExtensionUIValidationStatus = 'pending' | 'busy' | 'ready' | 'error'
export type ExtensionUIVerificationLevel = 'semantic' | 'physical'

export interface ExtensionUIValidationSignalV1 {
  id: string
  label: string
  status: ExtensionUIValidationStatus
  detail?: string
}

export interface ExtensionUIValidationActionV1 {
  id: string
  label: string
  command: string
  inputSchema?: Record<string, unknown>
  disabled?: boolean
}

export interface ExtensionUIValidationScenarioV1 {
  id: string
  label: string
  command: string
  inputSchema?: Record<string, unknown>
  /** Optional command that restores the state established by `command`. */
  teardownCommand?: string
  teardownInputSchema?: Record<string, unknown>
}

/** Dynamic fields that may change without redeclaring executable commands. */
export interface ExtensionUIValidationStateV1 {
  readyWhen?: string[]
  signals?: ExtensionUIValidationSignalV1[]
  snapshot?: ExtensionUISemanticNodeV1
}

export interface ExtensionUISemanticNodeV1 {
  id: string
  role: string
  label?: string
  state?: Record<string, string | number | boolean | null>
  children?: ExtensionUISemanticNodeV1[]
}

/** A bounded, serializable validation contract owned by one contribution. */
export interface ExtensionUIValidationDefinitionV1 {
  schemaVersion: 1
  id: string
  contributionId: string
  verificationLevel: ExtensionUIVerificationLevel
  readyWhen?: string[]
  signals?: ExtensionUIValidationSignalV1[]
  actions?: ExtensionUIValidationActionV1[]
  scenarios?: ExtensionUIValidationScenarioV1[]
  snapshot?: ExtensionUISemanticNodeV1
}

export type ExtensionUIValidationDeltaV1 = {
  schemaVersion: 1
  extensionId: string
  sessionId: string
  runtimeId: string
  revision: number
} & (
  | { operation: 'upsert'; definition: ExtensionUIValidationDefinitionV1 }
  | { operation: 'remove'; definitionId: string }
  | { operation: 'reset' }
  | { operation: 'snapshot'; definitions: ExtensionUIValidationDefinitionV1[] }
)

export interface ExtensionUIValidationCapabilitiesV1 {
  schemaVersion: 1
  available: boolean
  protocolVersions: [1]
  verificationLevels: ExtensionUIVerificationLevel[]
  scenarios: boolean
  sandboxBridge: boolean
}

/** Stable, bounded identity for the shared scoped-state registry. */
export function extensionUIValidationEntityId(sessionId: string, extensionId: string, runtimeId: string, definitionId: string): string {
  const value = `${sessionId}\0${extensionId}\0${runtimeId}\0${definitionId}`
  let hash = 0xcbf29ce484222325n
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index))
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return `extension:${hash.toString(16).padStart(16, '0')}`
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const bounded = (value: unknown, max = 256): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max
const onlyKeys = (value: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(value).every(key => allowed.includes(key))

function validateJson(value: unknown, depth = 0, count = { value: 0 }): string | null {
  if (depth > 8 || ++count.value > 512) return 'JSON value is too large'
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return null
  if (typeof value === 'number') return Number.isFinite(value) ? null : 'JSON numbers must be finite'
  if (Array.isArray(value)) {
    if (value.length > 128) return 'JSON arrays are too large'
    for (const item of value) {
      const error = validateJson(item, depth + 1, count)
      if (error) return error
    }
    return null
  }
  if (!value || typeof value !== 'object') return 'Value must be JSON serializable'
  const record = value as Record<string, unknown>
  if (Object.keys(record).length > 128) return 'JSON objects are too large'
  for (const [key, item] of Object.entries(record)) {
    if (!bounded(key, 256)) return 'JSON object keys must be bounded'
    const error = validateJson(item, depth + 1, count)
    if (error) return error
  }
  return null
}

function validateSchema(value: unknown): string | null {
  if (value === undefined) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'inputSchema must be an object'
  try {
    const serialized = JSON.stringify(value)
    if (serialized.length > 32_768) return 'inputSchema is too large'
  } catch {
    return 'inputSchema must be JSON serializable'
  }
  return validateJson(value)
}

function validateSemanticNode(value: unknown, depth = 0, count = { value: 0 }, ids = new Set<string>()): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'snapshot nodes must be objects'
  if (depth > 8 || ++count.value > 256) return 'snapshot tree is too large'
  const node = value as Record<string, unknown>
  if (!onlyKeys(node, ['id', 'role', 'label', 'state', 'children'])) return 'Unsupported snapshot node field'
  if (!bounded(node.id) || !ID.test(node.id)) return 'snapshot node id must be a stable identifier'
  if (ids.has(node.id)) return 'snapshot node ids must be unique'
  ids.add(node.id)
  if (!bounded(node.role, 64)) return 'snapshot node role is required'
  if (node.label !== undefined && (typeof node.label !== 'string' || node.label.length > 512)) return 'snapshot node label is too large'
  if (node.state !== undefined) {
    if (!node.state || typeof node.state !== 'object' || Array.isArray(node.state) || Object.keys(node.state).length > 32) return 'snapshot node state must be a bounded object'
    for (const [key, item] of Object.entries(node.state as Record<string, unknown>)) {
      if (!bounded(key, 128) || !['string', 'number', 'boolean'].includes(typeof item) && item !== null) return 'snapshot node state contains an unsupported value'
    }
  }
  if (node.children !== undefined) {
    if (!Array.isArray(node.children) || node.children.length > 64) return 'snapshot node children must be a bounded array'
    for (const child of node.children) {
      const error = validateSemanticNode(child, depth + 1, count, ids)
      if (error) return error
    }
  }
  return null
}

export function validateExtensionUIValidationDefinitionV1(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'Validation definition must be an object'
  const item = value as Record<string, unknown>
  if (item.schemaVersion !== 1) return 'Unsupported validation definition schema version'
  if (!onlyKeys(item, ['schemaVersion', 'id', 'contributionId', 'verificationLevel', 'readyWhen', 'signals', 'actions', 'scenarios', 'snapshot'])) return 'Unsupported validation definition field'
  for (const key of ['id', 'contributionId'] as const) if (!bounded(item[key]) || !ID.test(item[key] as string)) return `${key} must be a stable identifier`
  if (!['semantic', 'physical'].includes(String(item.verificationLevel))) return 'Unsupported verification level'
  const unique = (values: unknown[], kind: string): string | null => {
    const ids = new Set<string>()
    for (const value of values) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return `${kind} entries must be objects`
      const id = (value as Record<string, unknown>).id
      if (!bounded(id) || !ID.test(id)) return `${kind} id must be a stable identifier`
      if (ids.has(id)) return `${kind} ids must be unique`
      ids.add(id)
    }
    return null
  }
  if (item.readyWhen !== undefined) {
    if (!Array.isArray(item.readyWhen) || item.readyWhen.length > 32 || item.readyWhen.some(id => !bounded(id) || !ID.test(id))) return 'readyWhen must contain bounded signal identifiers'
  }
  if (item.signals !== undefined) {
    if (!Array.isArray(item.signals) || item.signals.length > 64) return 'signals must be a bounded array'
    const error = unique(item.signals, 'signal'); if (error) return error
    for (const value of item.signals) {
      const signal = value as Record<string, unknown>
      if (!onlyKeys(signal, ['id', 'label', 'status', 'detail']) || !bounded(signal.label, 512) || !['pending', 'busy', 'ready', 'error'].includes(String(signal.status))) return 'Invalid validation signal'
      if (signal.detail !== undefined && (typeof signal.detail !== 'string' || signal.detail.length > 2_000)) return 'Validation signal detail is too large'
    }
  }
  if (item.actions !== undefined) {
    if (!Array.isArray(item.actions) || item.actions.length > 64) return 'actions must be a bounded array'
    const error = unique(item.actions, 'action'); if (error) return error
    for (const value of item.actions) {
      const action = value as Record<string, unknown>
      if (!onlyKeys(action, ['id', 'label', 'command', 'inputSchema', 'disabled']) || !bounded(action.label, 512) || !bounded(action.command) || (action.disabled !== undefined && typeof action.disabled !== 'boolean')) return 'Invalid validation action'
      const schemaError = validateSchema(action.inputSchema); if (schemaError) return schemaError
    }
  }
  if (item.scenarios !== undefined) {
    if (!Array.isArray(item.scenarios) || item.scenarios.length > 32) return 'scenarios must be a bounded array'
    const error = unique(item.scenarios, 'scenario'); if (error) return error
    for (const value of item.scenarios) {
      const scenario = value as Record<string, unknown>
      if (!onlyKeys(scenario, ['id', 'label', 'command', 'inputSchema', 'teardownCommand', 'teardownInputSchema']) || !bounded(scenario.label, 512) || !bounded(scenario.command)) return 'Invalid validation scenario'
      const schemaError = validateSchema(scenario.inputSchema); if (schemaError) return schemaError
      if (scenario.teardownCommand !== undefined && !bounded(scenario.teardownCommand)) return 'Invalid validation scenario teardown command'
      if (scenario.teardownInputSchema !== undefined && scenario.teardownCommand === undefined) return 'teardownInputSchema requires teardownCommand'
      const teardownSchemaError = validateSchema(scenario.teardownInputSchema); if (teardownSchemaError) return teardownSchemaError
    }
  }
  if (item.readyWhen) {
    const signals = new Set(((item.signals ?? []) as Array<{ id: string }>).map(signal => signal.id))
    const readyIds = item.readyWhen as string[]
    if (new Set(readyIds).size !== readyIds.length) return 'readyWhen signal ids must be unique'
    if (readyIds.some(id => !signals.has(id))) return 'readyWhen references an unknown signal'
  }
  return item.snapshot === undefined ? null : validateSemanticNode(item.snapshot)
}

export function validateExtensionUIValidationDeltaV1(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'Validation delta must be an object'
  const item = value as Record<string, unknown>
  if (item.schemaVersion !== 1) return 'Unsupported validation delta schema version'
  for (const key of ['extensionId', 'sessionId', 'runtimeId'] as const) if (!bounded(item[key])) return `${key} must be a non-empty bounded string`
  if (!Number.isSafeInteger(item.revision) || Number(item.revision) < 1) return 'revision must be a positive safe integer'
  if (item.operation === 'upsert') return validateExtensionUIValidationDefinitionV1(item.definition)
  if (item.operation === 'remove') return bounded(item.definitionId) ? null : 'definitionId must be a bounded string'
  if (item.operation === 'reset') return null
  if (item.operation === 'snapshot') {
    if (!Array.isArray(item.definitions) || item.definitions.length > 128) return 'definitions must be a bounded array'
    const ids = new Set<string>()
    for (const definition of item.definitions) {
      const error = validateExtensionUIValidationDefinitionV1(definition); if (error) return error
      const id = (definition as ExtensionUIValidationDefinitionV1).id
      if (ids.has(id)) return 'definition ids must be unique'
      ids.add(id)
    }
    return null
  }
  return 'Unsupported validation operation'
}
