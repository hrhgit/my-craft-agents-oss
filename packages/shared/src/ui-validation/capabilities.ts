import { UiValidationError } from './errors.ts'
import { UI_VALIDATION_APP_SHELL_SCENARIO_IDS } from './runtime.ts'
import { UI_VALIDATION_PROTOCOL_VERSION } from './types.ts'

export type UiValidationCapabilityKind = 'route' | 'scenario' | 'action'
export type UiValidationCapabilitySurface = 'electron' | 'webui'

export interface UiValidationCapabilityDefinition {
  kind: UiValidationCapabilityKind
  id: string
  description: string
  inputSchema: Record<string, unknown>
  verificationLevel: 'scenario-verified' | 'renderer-verified' | 'native-verified'
  surfaces: UiValidationCapabilitySurface[]
  modes?: ReadonlyArray<'semantic' | 'physical' | 'native'>
}

export interface UiValidationCapabilitiesQuery {
  operation?: 'list' | 'describe'
  kind?: UiValidationCapabilityKind
  id?: string
}

const objectSchema = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: 'object',
  properties,
  ...(required.length > 0 ? { required } : {}),
  additionalProperties: false,
})

const route = (id: string, description: string, properties: Record<string, unknown> = {}): UiValidationCapabilityDefinition => ({
  kind: 'route', id, description, verificationLevel: 'scenario-verified', surfaces: ['electron', 'webui'],
  inputSchema: objectSchema({ route: objectSchema({ surface: { const: id }, ...properties }, ['surface']) }, ['route']),
})

const scenarioSchema = objectSchema({
  name: { type: 'string' },
  seed: { type: 'integer', minimum: 0 },
  clock: objectSchema({ mode: { enum: ['real', 'frozen'] }, now: { type: ['string', 'number'] } }, ['mode']),
  viewport: objectSchema({ width: { type: 'integer', minimum: 240 }, height: { type: 'integer', minimum: 240 } }, ['width', 'height']),
  locale: { type: 'string', maxLength: 64 },
  theme: { enum: ['light', 'dark', 'system'] },
}, ['name'])

const rendererActions = ['click', 'fill', 'select', 'press', 'drag', 'shortcut', 'clipboard', 'ime', 'rich-text'] as const
const nativeActions = ['click', 'fill', 'select', 'focus', 'minimize', 'maximize', 'restore', 'close'] as const

const rendererTargetSchema = {
  oneOf: [
    objectSchema({ ref: { type: 'string', minLength: 1 } }, ['ref']),
    objectSchema({ semanticId: { type: 'string', minLength: 1 } }, ['semanticId']),
    objectSchema({ testId: { type: 'string', minLength: 1 } }, ['testId']),
    objectSchema({ role: { type: 'string', minLength: 1 }, name: { type: 'string' }, exact: { type: 'boolean' } }, ['role']),
  ],
}

function actionSchema(id: string, native: boolean): Record<string, unknown> {
  const required = ['target', 'action']
  if (native) required.push('mode')
  if (['fill', 'select', 'clipboard', 'ime', 'rich-text'].includes(id)) required.push('value')
  if (id === 'press' || id === 'shortcut') required.push('key')
  if (id === 'drag') required.push('to')
  return objectSchema({
    revision: { type: 'integer', minimum: 0 },
    target: native ? objectSchema({ kind: { const: 'native' }, ref: { type: 'string', minLength: 1 } }, ['kind', 'ref']) : rendererTargetSchema,
    action: { const: id },
    mode: native ? { const: 'native' } : { enum: ['semantic', 'physical'] },
    value: { type: 'string', maxLength: 100_000 },
    key: { type: 'string', minLength: 1, maxLength: 128 },
    modifiers: { type: 'array', uniqueItems: true, items: { enum: ['shift', 'control', 'alt', 'meta'] }, maxItems: 4 },
    to: objectSchema({ x: { type: 'number' }, y: { type: 'number' } }, ['x', 'y']),
    timeoutMs: { type: 'integer', minimum: 1, maximum: 300_000 },
    waitUntil: { type: 'object' },
  }, required)
}

const definitions: UiValidationCapabilityDefinition[] = [
  route('chat', 'Open the conversation surface.', { workspaceId: { type: 'string' }, sessionId: { type: 'string' } }),
  route('settings', 'Open a settings section.', { section: { type: 'string', maxLength: 128 } }),
  route('sources', 'Open data sources.'),
  route('skills', 'Open skills.'),
  route('automations', 'Open automations.'),
  route('workspace-picker', 'Open the workspace picker.'),
  ...UI_VALIDATION_APP_SHELL_SCENARIO_IDS.map(id => ({
    kind: 'scenario' as const,
    id,
    description: `Apply the registered ${id} AppShell scenario using real production components.`,
    inputSchema: { ...scenarioSchema, properties: { ...(scenarioSchema.properties as Record<string, unknown>), name: { const: id } } },
    verificationLevel: 'scenario-verified' as const,
    surfaces: ['electron', 'webui'] as UiValidationCapabilitySurface[],
    modes: ['semantic'] as const,
  })),
  ...rendererActions.map(id => ({
    kind: 'action' as const,
    id,
    description: `Perform the ${id} renderer interaction on a revision-bound semantic target.`,
    inputSchema: actionSchema(id, false),
    verificationLevel: 'renderer-verified' as const,
    surfaces: ['electron', 'webui'] as UiValidationCapabilitySurface[],
    modes: ['semantic', 'physical'] as Array<'semantic' | 'physical'>,
  })),
  ...nativeActions.map(id => ({
    kind: 'action' as const,
    id: `native.${id}`,
    description: `Perform the ${id} operation through the platform native adapter.`,
    inputSchema: actionSchema(id, true),
    verificationLevel: 'native-verified' as const,
    surfaces: ['electron'] as UiValidationCapabilitySurface[],
    modes: ['native'] as const,
  })),
]

export function queryUiValidationCapabilities(surface: UiValidationCapabilitySurface, query: UiValidationCapabilitiesQuery = {}): {
  protocolVersion: typeof UI_VALIDATION_PROTOCOL_VERSION
  operation: 'list' | 'describe'
  kinds: UiValidationCapabilityKind[]
  items: UiValidationCapabilityDefinition[]
  runtimeDiscovery: Record<string, unknown>
} {
  const operation = query.operation ?? 'list'
  if (operation !== 'list' && operation !== 'describe') throw new UiValidationError('INVALID_REQUEST', 'Capability operation must be list or describe.')
  if (query.kind !== undefined && !['route', 'scenario', 'action'].includes(query.kind)) throw new UiValidationError('INVALID_REQUEST', 'Capability kind must be route, scenario, or action.')
  if (operation === 'describe' && (!query.kind || !query.id)) throw new UiValidationError('INVALID_REQUEST', 'Capability describe requires kind and id.')
  const items = definitions.filter(item => item.surfaces.includes(surface) && (!query.kind || item.kind === query.kind) && (!query.id || item.id === query.id))
  if (operation === 'describe' && items.length === 0) throw new UiValidationError('TARGET_NOT_FOUND', `Capability ${query.kind}:${query.id} was not found on ${surface}.`)
  return {
    protocolVersion: UI_VALIDATION_PROTOCOL_VERSION,
    operation,
    kinds: ['route', 'scenario', 'action'],
    items,
    runtimeDiscovery: {
      extensionDefinitions: {
        method: 'ui.snapshot',
        description: 'Returns host-validated readiness, actions, scenarios, and input schemas contributed by a running extension.',
        identitySource: 'app.status result.state.states entries with scope extension',
        inputSchema: objectSchema({ target: objectSchema({
          kind: { const: 'extension' }, sessionId: { type: 'string', minLength: 1 }, extensionId: { type: 'string', minLength: 1 },
          runtimeId: { type: 'string', minLength: 1 }, definitionId: { type: 'string', minLength: 1 },
        }, ['kind', 'sessionId', 'extensionId']) }, ['target']),
      },
    },
  }
}
