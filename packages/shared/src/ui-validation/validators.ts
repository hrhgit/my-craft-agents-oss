import { UiValidationError } from './errors.ts'
import { parseSemanticRef } from './semantic.ts'
import { UI_VALIDATION_MAX_STABLE_FOR_MS, UI_VALIDATION_MAX_WAIT_MS } from './timeouts.ts'
import {
  UI_VALIDATION_PROTOCOL_VERSION,
  type SemanticNode,
  type SemanticSnapshot,
  type UiValidationActionRequest,
  type UiValidationEvidenceCaptureRequest,
  type UiValidationEvidenceKind,
  type UiValidationFaultSetRequest,
  type UiValidationRequestEnvelope,
  type UiValidationScenarioApplyRequest,
  type UiValidationTarget,
  type UiValidationRendererAction,
  type UiValidationWaitRequest,
} from './types.ts'

type UnknownRecord = Record<string, unknown>

const RENDERER_ACTIONS = new Set(['click', 'fill', 'select', 'press', 'drag', 'shortcut', 'clipboard', 'ime', 'rich-text'])
const NATIVE_ACTIONS = new Set(['click', 'fill', 'select', 'focus', 'minimize', 'maximize', 'restore', 'close'])
const MODIFIERS = new Set(['shift', 'control', 'alt', 'meta'])
const EVIDENCE_KINDS = new Set<UiValidationEvidenceKind>([
  'screenshot', 'semantic-snapshot', 'events', 'console', 'page-errors', 'network-summary', 'driver-info', 'runtime-log', 'state-manifest', 'trace',
])

export function parseUiValidationRequestEnvelope(input: unknown): UiValidationRequestEnvelope {
  const value = record(input, 'request envelope')
  if (value.v !== UI_VALIDATION_PROTOCOL_VERSION) {
    throw new UiValidationError('UNSUPPORTED_VERSION', `Unsupported UI validation protocol version: ${String(value.v)}`, {
      details: { supported: [UI_VALIDATION_PROTOCOL_VERSION] },
    })
  }
  if (value.kind !== 'request') invalid('kind must be "request"')
  if (value.id !== undefined && value.requestId !== undefined && value.id !== value.requestId) invalid('id and requestId must match')
  return {
    v: UI_VALIDATION_PROTOCOL_VERSION,
    kind: 'request',
    id: nonEmptyString(value.id ?? value.requestId, 'id', 256),
    requestId: nonEmptyString(value.requestId ?? value.id, 'requestId', 256),
    runId: nonEmptyString(value.runId, 'runId', 256),
    method: nonEmptyString(value.method, 'method', 256),
    ...(value.params === undefined ? {} : { params: value.params }),
  }
}

export function parseUiValidationActionRequest(input: unknown): UiValidationActionRequest {
  const value = record(input, 'action request')
  const action = nonEmptyString(value.action, 'action')
  const target = parseTarget(value.target)
  const isNative = 'kind' in target && target.kind === 'native'
  const isBrowser = 'kind' in target && target.kind === 'browser'
  const isExtension = 'kind' in target && target.kind === 'extension'
  if (isNative && !NATIVE_ACTIONS.has(action)) invalid(`Unsupported native action: ${action}`)
  if (isBrowser && !['click', 'fill', 'select'].includes(action)) invalid(`Unsupported BrowserView action: ${action}`)
  if (isExtension && !/^[a-z][a-z0-9._-]{0,127}$/.test(action)) invalid('Extension action must be a stable bounded identifier')
  if (!isNative && !isBrowser && !isExtension && !RENDERER_ACTIONS.has(action)) invalid(`Unsupported renderer action: ${action}`)
  if (isNative && value.mode !== 'native') invalid('Native targets require mode native')
  if (!isNative && value.mode === 'native') invalid('mode native requires a native target')
  if (isBrowser && value.mode !== undefined && value.mode !== 'physical') invalid('BrowserView targets support only physical mode')
  if (isExtension && value.mode !== undefined && value.mode !== 'semantic') invalid('Extension targets support only semantic mode')
  if (!isNative && !isBrowser && !isExtension && value.mode !== undefined && value.mode !== 'semantic' && value.mode !== 'physical') invalid('Renderer mode must be semantic or physical')
  const result: Record<string, unknown> = { target, action }
  if (value.mode !== undefined) result.mode = value.mode
  if (value.revision !== undefined) result.revision = nonNegativeInteger(value.revision, 'revision')
  if (value.value !== undefined) result.value = string(value.value, 'value', 100_000)
  if (value.key !== undefined) result.key = nonEmptyString(value.key, 'key', 128)
  if (value.timeoutMs !== undefined) result.timeoutMs = positiveInteger(value.timeoutMs, 'timeoutMs', UI_VALIDATION_MAX_WAIT_MS)
  if (value.waitUntil !== undefined) {
    const waitUntil = record(value.waitUntil, 'waitUntil')
    result.waitUntil = parseUiValidationWaitRequest(waitUntil.predicate === undefined
      ? { ...waitUntil, predicate: waitUntil }
      : waitUntil)
  }
  if (value.input !== undefined) {
    if (!isExtension) invalid('input is supported only for extension actions')
    result.input = record(value.input, 'input')
  }
  if (value.modifiers !== undefined) {
    if (!Array.isArray(value.modifiers) || value.modifiers.some(item => typeof item !== 'string' || !MODIFIERS.has(item))) {
      invalid('modifiers contains an unsupported value')
    }
    result.modifiers = value.modifiers as UiValidationActionRequest['modifiers']
  }
  if (value.to !== undefined) {
    const to = record(value.to, 'to')
    result.to = { x: finiteNumber(to.x, 'to.x'), y: finiteNumber(to.y, 'to.y') }
  }
  if (['fill', 'select', 'clipboard', 'ime', 'rich-text'].includes(action) && result.value === undefined) invalid(`${action} requires value`)
  if ((action === 'press' || action === 'shortcut') && result.key === undefined) invalid(`${action} requires key`)
  if (action === 'drag' && result.to === undefined) invalid('drag requires to')
  return result as unknown as UiValidationActionRequest
}

export function parseSemanticSnapshot(input: unknown): SemanticSnapshot {
  const value = record(input, 'semantic snapshot')
  const revision = nonNegativeInteger(value.revision, 'revision')
  if (!Array.isArray(value.nodes)) invalid('nodes must be an array')
  const seenRefs = new Set<string>()
  const nodes = value.nodes.map((rawNode, index) => {
    const node = record(rawNode, `nodes[${index}]`)
    const ref = nonEmptyString(node.ref, `nodes[${index}].ref`)
    const parsed = parseSemanticRef(ref)
    if (parsed.revision !== revision) invalid(`nodes[${index}].ref revision does not match snapshot revision`)
    if (seenRefs.has(ref)) invalid(`Duplicate semantic ref: ${ref}`)
    seenRefs.add(ref)
    return {
      ref,
      nodeId: nonEmptyString(node.nodeId, `nodes[${index}].nodeId`),
      role: nonEmptyString(node.role, `nodes[${index}].role`),
      name: string(node.name, `nodes[${index}].name`),
      ...(node.testId === undefined ? {} : { testId: nonEmptyString(node.testId, `nodes[${index}].testId`) }),
      ...(node.value === undefined ? {} : { value: string(node.value, `nodes[${index}].value`) }),
      ...(node.description === undefined ? {} : { description: string(node.description, `nodes[${index}].description`) }),
      ...(node.states === undefined ? {} : { states: parseNodeStates(node.states, `nodes[${index}].states`) }),
      ...(node.bounds === undefined ? {} : { bounds: parseBounds(node.bounds, `nodes[${index}].bounds`) }),
      ...(node.children === undefined ? {} : { children: stringArray(node.children, `nodes[${index}].children`) }),
      ...(node.actions === undefined ? {} : { actions: parseNodeActions(node.actions, `nodes[${index}].actions`) }),
      ...(node.actionModes === undefined ? {} : { actionModes: parseActionModes(node.actionModes, `nodes[${index}].actionModes`) }),
    }
  })
  return {
    revision,
    windowId: nonEmptyString(value.windowId, 'windowId'),
    scope: nonEmptyString(value.scope, 'scope'),
    nodes,
    ...(value.focusRef === undefined ? {} : { focusRef: nonEmptyString(value.focusRef, 'focusRef') }),
    ...(value.route === undefined ? {} : { route: parseRoute(value.route, 'route') }),
  }
}

function parseActionModes(value: unknown, field: string): NonNullable<SemanticNode['actionModes']> {
  const modes = record(value, field)
  const unexpected = Object.keys(modes).find(key => key !== 'semantic' && key !== 'physical')
  if (unexpected) invalid(`${field}.${unexpected} is unsupported`)
  return {
    ...(modes.semantic === undefined ? {} : { semantic: parseNodeActions(modes.semantic, `${field}.semantic`) }),
    ...(modes.physical === undefined ? {} : { physical: parseNodeActions(modes.physical, `${field}.physical`) }),
  }
}

function parseNodeActions(value: unknown, field: string): UiValidationRendererAction[] {
  if (!Array.isArray(value) || value.length > RENDERER_ACTIONS.size) invalid(`${field} must be a bounded action array`)
  const actions = value.map((item, index) => {
    const action = nonEmptyString(item, `${field}[${index}]`)
    if (!RENDERER_ACTIONS.has(action)) invalid(`${field}[${index}] is unsupported`)
    return action as UiValidationRendererAction
  })
  if (new Set(actions).size !== actions.length) invalid(`${field} actions must be unique`)
  return actions
}

export function parseUiValidationWaitRequest(input: unknown): UiValidationWaitRequest {
  const value = record(input, 'wait request')
  const predicate = record(value.predicate, 'predicate')
  const kind = nonEmptyString(predicate.kind, 'predicate.kind')
  if (!['app-phase', 'route', 'node', 'text', 'session-state', 'state', 'event', 'rpc-idle', 'render-idle', 'semantic-ready'].includes(kind)) {
    invalid(`Unsupported wait predicate kind: ${kind}`)
  }
  let parsedPredicate: UiValidationWaitRequest['predicate']
  if (kind === 'app-phase') {
    const phase = nonEmptyString(predicate.phase, 'predicate.phase')
    if (!['booting', 'loading', 'ready', 'busy', 'error', 'disposed'].includes(phase)) invalid(`Unsupported app phase: ${phase}`)
    parsedPredicate = { kind, phase: phase as Extract<UiValidationWaitRequest['predicate'], { kind: 'app-phase' }>['phase'] }
  } else if (kind === 'route') {
    parsedPredicate = { kind, route: parsePartialRoute(predicate.route, 'predicate.route') }
  } else if (kind === 'node') {
    const state = predicate.state === undefined ? undefined : nonEmptyString(predicate.state, 'predicate.state')
    if (state && !['disabled', 'checked', 'selected', 'expanded', 'busy', 'focused', 'hidden'].includes(state)) invalid(`Unsupported semantic node state: ${state}`)
    const equals = predicate.equals
    if (equals !== undefined && equals !== 'mixed' && typeof equals !== 'boolean') invalid('predicate.equals must be boolean or mixed')
    parsedPredicate = {
      kind,
      target: parseTarget(predicate.target),
      ...(state === undefined ? {} : { state: state as NonNullable<Extract<UiValidationWaitRequest['predicate'], { kind: 'node' }>['state']> }),
      ...(equals === undefined ? {} : { equals: equals as boolean | 'mixed' }),
    }
  } else if (kind === 'text') {
    parsedPredicate = {
      kind,
      value: nonEmptyString(predicate.value, 'predicate.value', 100_000),
      ...(predicate.exact === undefined ? {} : { exact: boolean(predicate.exact, 'predicate.exact') }),
    }
  } else if (kind === 'session-state') {
    parsedPredicate = {
      kind,
      sessionId: nonEmptyString(predicate.sessionId, 'predicate.sessionId'),
      state: nonEmptyString(predicate.state, 'predicate.state'),
    }
  } else if (kind === 'state') {
    const scope = nonEmptyString(predicate.scope, 'predicate.scope')
    if (!['app', 'transport', 'workspace', 'sessions', 'route', 'session', 'extension', 'native-driver'].includes(scope)) {
      invalid(`Unsupported state scope: ${scope}`)
    }
    const phase = predicate.phase === undefined ? undefined : nonEmptyString(predicate.phase, 'predicate.phase')
    if (phase && !['booting', 'loading', 'ready', 'busy', 'error', 'disposed'].includes(phase)) invalid(`Unsupported state phase: ${phase}`)
    parsedPredicate = {
      kind,
      scope: scope as Extract<UiValidationWaitRequest['predicate'], { kind: 'state' }>['scope'],
      ...(phase === undefined ? {} : { phase: phase as Extract<UiValidationWaitRequest['predicate'], { kind: 'state' }>['phase'] }),
      ...(predicate.windowId === undefined ? {} : { windowId: nonEmptyString(predicate.windowId, 'predicate.windowId') }),
      ...(predicate.entityId === undefined ? {} : { entityId: nonEmptyString(predicate.entityId, 'predicate.entityId') }),
      ...(predicate.detail === undefined ? {} : { detail: record(predicate.detail, 'predicate.detail') }),
    }
  } else if (kind === 'event') {
    parsedPredicate = { kind, type: nonEmptyString(predicate.type, 'predicate.type') }
  } else {
    parsedPredicate = { kind: kind as 'rpc-idle' | 'render-idle' | 'semantic-ready' }
  }
  return {
    predicate: parsedPredicate,
    ...(value.timeoutMs === undefined ? {} : { timeoutMs: positiveInteger(value.timeoutMs, 'timeoutMs', UI_VALIDATION_MAX_WAIT_MS) }),
    ...(value.stableForMs === undefined ? {} : { stableForMs: nonNegativeInteger(value.stableForMs, 'stableForMs', UI_VALIDATION_MAX_STABLE_FOR_MS) }),
    ...(value.afterSeq === undefined ? {} : { afterSeq: nonNegativeInteger(value.afterSeq, 'afterSeq') }),
  }
}

export function parseUiValidationScenarioApplyRequest(input: unknown): UiValidationScenarioApplyRequest {
  const value = record(input, 'scenario request')
  const result: UiValidationScenarioApplyRequest = { name: nonEmptyString(value.name, 'name', 256) }
  if (value.reset !== undefined) result.reset = boolean(value.reset, 'reset')
  if (value.seed !== undefined) result.seed = nonNegativeInteger(value.seed, 'seed', 0xffff_ffff)
  if (value.locale !== undefined) result.locale = nonEmptyString(value.locale, 'locale', 64)
  if (value.theme !== undefined) {
    if (!['light', 'dark', 'system'].includes(String(value.theme))) scenarioInvalid('theme must be light, dark, or system')
    result.theme = value.theme as UiValidationScenarioApplyRequest['theme']
  }
  if (value.viewport !== undefined) {
    const viewport = record(value.viewport, 'viewport')
    result.viewport = {
      width: positiveInteger(viewport.width, 'viewport.width', 16_384),
      height: positiveInteger(viewport.height, 'viewport.height', 16_384),
      ...(viewport.deviceScaleFactor === undefined ? {} : { deviceScaleFactor: positiveNumber(viewport.deviceScaleFactor, 'viewport.deviceScaleFactor', 8) }),
    }
  }
  if (value.clock !== undefined) {
    const clock = record(value.clock, 'clock')
    if (clock.mode === 'real') result.clock = { mode: 'real' }
    else if (clock.mode === 'frozen') {
      const now = nonEmptyString(clock.now, 'clock.now')
      if (Number.isNaN(Date.parse(now))) scenarioInvalid('clock.now must be an ISO-compatible date')
      result.clock = { mode: 'frozen', now }
    } else scenarioInvalid('clock.mode must be real or frozen')
  }
  if (value.fixture !== undefined) result.fixture = record(value.fixture, 'fixture')
  return result
}

export function parseUiValidationFaultSetRequest(input: unknown): UiValidationFaultSetRequest {
  const value = record(input, 'fault request')
  const point = nonEmptyString(value.point, 'point', 256)
  if (!/^[a-z][a-z0-9.-]*$/.test(point)) faultInvalid('point must be a dotted lowercase identifier')
  const effect = record(value.effect, 'effect')
  let parsedEffect: UiValidationFaultSetRequest['effect']
  if (effect.kind === 'delay') parsedEffect = { kind: 'delay', ms: positiveInteger(effect.ms, 'effect.ms', 300_000) }
  else if (effect.kind === 'error') parsedEffect = {
    kind: 'error',
    code: nonEmptyString(effect.code, 'effect.code', 128),
    ...(effect.message === undefined ? {} : { message: string(effect.message, 'effect.message', 10_000) }),
  }
  else if (effect.kind === 'disconnect' || effect.kind === 'drop') parsedEffect = { kind: effect.kind }
  else faultInvalid('effect.kind must be delay, error, disconnect, or drop')
  return {
    point,
    effect: parsedEffect!,
    ...(value.times === undefined ? {} : { times: positiveInteger(value.times, 'times', 10_000) }),
    ...(value.scope === undefined ? {} : { scope: stringRecord(value.scope, 'scope') }),
  }
}

export function parseUiValidationEvidenceCaptureRequest(input: unknown): UiValidationEvidenceCaptureRequest {
  const value = record(input, 'evidence request')
  if (!Array.isArray(value.include) || value.include.length === 0) invalid('include must be a non-empty array')
  const include = value.include.map((kind, index) => {
    if (typeof kind !== 'string' || !EVIDENCE_KINDS.has(kind as UiValidationEvidenceKind)) invalid(`Unsupported evidence kind at include[${index}]`)
    return kind as UiValidationEvidenceKind
  })
  return {
    label: nonEmptyString(value.label, 'label', 256),
    include: [...new Set(include)],
    ...(value.afterSeq === undefined ? {} : { afterSeq: nonNegativeInteger(value.afterSeq, 'afterSeq') }),
    ...(value.redact === undefined ? {} : { redact: boolean(value.redact, 'redact') }),
  }
}

function parseTarget(input: unknown): UiValidationTarget {
  const target = record(input, 'target')
  if (target.kind === 'native') {
    const unexpected = Object.keys(target).find(key => key !== 'kind' && key !== 'ref')
    if (unexpected) invalid(`target.${unexpected} is unsupported for a native target`)
    return { kind: 'native', ref: nonEmptyString(target.ref, 'target.ref') }
  }
  if (target.kind === 'browser') {
    const unexpected = Object.keys(target).find(key => !['kind', 'instanceId', 'ref'].includes(key))
    if (unexpected) invalid(`target.${unexpected} is unsupported for a BrowserView target`)
    return {
      kind: 'browser',
      instanceId: nonEmptyString(target.instanceId, 'target.instanceId'),
      ref: nonEmptyString(target.ref, 'target.ref'),
    }
  }
  if (target.kind === 'extension') {
    const unexpected = Object.keys(target).find(key => !['kind', 'sessionId', 'extensionId', 'runtimeId', 'definitionId'].includes(key))
    if (unexpected) invalid(`target.${unexpected} is unsupported for an extension target`)
    return {
      kind: 'extension',
      sessionId: nonEmptyString(target.sessionId, 'target.sessionId'),
      extensionId: nonEmptyString(target.extensionId, 'target.extensionId'),
      ...(target.runtimeId === undefined ? {} : { runtimeId: nonEmptyString(target.runtimeId, 'target.runtimeId') }),
      ...(target.definitionId === undefined ? {} : { definitionId: nonEmptyString(target.definitionId, 'target.definitionId') }),
    }
  }
  if (target.kind !== undefined) invalid('target.kind must be native, browser, or extension')
  const keys = ['ref', 'semanticId', 'testId', 'role'].filter(key => target[key] !== undefined)
  if (keys.length !== 1) invalid('target must specify exactly one of ref, semanticId, testId, or role')
  if (target.ref !== undefined) return { ref: nonEmptyString(target.ref, 'target.ref') }
  if (target.semanticId !== undefined) return { semanticId: nonEmptyString(target.semanticId, 'target.semanticId') }
  if (target.testId !== undefined) return { testId: nonEmptyString(target.testId, 'target.testId') }
  return {
    role: nonEmptyString(target.role, 'target.role'),
    ...(target.name === undefined ? {} : { name: string(target.name, 'target.name') }),
    ...(target.exact === undefined ? {} : { exact: boolean(target.exact, 'target.exact') }),
  }
}

function parseBounds(input: unknown, label: string): { x: number; y: number; width: number; height: number } {
  const value = record(input, label)
  return {
    x: finiteNumber(value.x, `${label}.x`),
    y: finiteNumber(value.y, `${label}.y`),
    width: nonNegativeNumber(value.width, `${label}.width`),
    height: nonNegativeNumber(value.height, `${label}.height`),
  }
}

function parseRoute(input: unknown, label: string): NonNullable<SemanticSnapshot['route']> {
  const route = parsePartialRoute(input, label)
  if (!route.surface) invalid(`${label}.surface is required`)
  return route as NonNullable<SemanticSnapshot['route']>
}

function parsePartialRoute(input: unknown, label: string): Partial<NonNullable<SemanticSnapshot['route']>> {
  const value = record(input, label)
  const result: Partial<NonNullable<SemanticSnapshot['route']>> = {}
  if (value.surface !== undefined) {
    const surface = nonEmptyString(value.surface, `${label}.surface`)
    if (!['chat', 'settings', 'sources', 'skills', 'automations', 'workspace-picker', 'unknown'].includes(surface)) invalid(`Unsupported route surface: ${surface}`)
    result.surface = surface as NonNullable<SemanticSnapshot['route']>['surface']
  }
  for (const key of ['workspaceId', 'sessionId', 'section'] as const) {
    if (value[key] !== undefined) result[key] = nonEmptyString(value[key], `${label}.${key}`)
  }
  return result
}

function parseNodeStates(input: unknown, label: string): NonNullable<SemanticSnapshot['nodes'][number]['states']> {
  const value = record(input, label)
  const result: NonNullable<SemanticSnapshot['nodes'][number]['states']> = {}
  for (const key of ['disabled', 'selected', 'expanded', 'busy', 'focused', 'hidden'] as const) {
    if (value[key] !== undefined) result[key] = boolean(value[key], `${label}.${key}`)
  }
  if (value.checked !== undefined) {
    if (value.checked !== 'mixed' && typeof value.checked !== 'boolean') invalid(`${label}.checked must be boolean or mixed`)
    result.checked = value.checked
  }
  return result
}

function record(input: unknown, label: string): UnknownRecord {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid(`${label} must be an object`)
  return input as UnknownRecord
}
function string(input: unknown, label: string, max = 100_000): string {
  if (typeof input !== 'string' || input.length > max) invalid(`${label} must be a string of at most ${max} characters`)
  return input
}
function nonEmptyString(input: unknown, label: string, max = 10_000): string {
  const value = string(input, label, max)
  if (!value.trim()) invalid(`${label} must be non-empty`)
  return value
}
function boolean(input: unknown, label: string): boolean {
  if (typeof input !== 'boolean') invalid(`${label} must be a boolean`)
  return input
}
function finiteNumber(input: unknown, label: string): number {
  if (typeof input !== 'number' || !Number.isFinite(input)) invalid(`${label} must be a finite number`)
  return input
}
function positiveNumber(input: unknown, label: string, max: number): number {
  const value = finiteNumber(input, label)
  if (value <= 0 || value > max) invalid(`${label} must be greater than 0 and at most ${max}`)
  return value
}
function nonNegativeNumber(input: unknown, label: string): number {
  const value = finiteNumber(input, label)
  if (value < 0) invalid(`${label} must be non-negative`)
  return value
}
function positiveInteger(input: unknown, label: string, max: number): number {
  const value = nonNegativeInteger(input, label, max)
  if (value === 0) invalid(`${label} must be positive`)
  return value
}
function nonNegativeInteger(input: unknown, label: string, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0 || input > max) invalid(`${label} must be a non-negative safe integer at most ${max}`)
  return input
}
function stringArray(input: unknown, label: string): string[] {
  if (!Array.isArray(input) || input.some(item => typeof item !== 'string')) invalid(`${label} must be a string array`)
  return input as string[]
}
function stringRecord(input: unknown, label: string): Record<string, string> {
  const value = record(input, label)
  if (Object.values(value).some(item => typeof item !== 'string')) invalid(`${label} values must be strings`)
  return value as Record<string, string>
}
function invalid(message: string): never { throw new UiValidationError('INVALID_REQUEST', message) }
function scenarioInvalid(message: string): never { throw new UiValidationError('SCENARIO_INVALID', message) }
function faultInvalid(message: string): never { throw new UiValidationError('FAULT_INVALID', message) }
