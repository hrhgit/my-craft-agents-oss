export const UI_VALIDATION_PROTOCOL_VERSION = 1 as const

export type UiValidationAppPhase =
  | 'booting'
  | 'loading'
  | 'ready'
  | 'busy'
  | 'error'
  | 'disposed'

export type UiValidationVerificationLevel =
  | 'scenario-verified'
  | 'renderer-verified'
  | 'native-verified'

export interface UiValidationRoute {
  surface: 'chat' | 'settings' | 'sources' | 'skills' | 'automations' | 'workspace-picker' | 'unknown'
  workspaceId?: string
  sessionId?: string
  section?: string
}

export interface UiValidationPendingState {
  rpc: number
  render: number
  transitions: number
}

export interface UiValidationAppState {
  phase: UiValidationAppPhase
  revision: number
  hydrated: boolean
  windowId?: string
  workspaceId?: string
  route?: UiValidationRoute
  pending: UiValidationPendingState
  lastError?: UiValidationErrorPayload
}

export type UiValidationErrorCode =
  | 'NOT_READY'
  | 'STALE_REF'
  | 'TARGET_NOT_FOUND'
  | 'AMBIGUOUS_TARGET'
  | 'DISABLED'
  | 'UNSUPPORTED'
  | 'TIMEOUT'
  | 'WINDOW_GONE'
  | 'DRIVER_DISCONNECTED'
  | 'INVALID_REQUEST'
  | 'UNSUPPORTED_VERSION'
  | 'METHOD_NOT_FOUND'
  | 'ABORTED'
  | 'EVENTS_DROPPED'
  | 'SCENARIO_INVALID'
  | 'FAULT_INVALID'
  | 'EVIDENCE_CAPTURE_FAILED'
  | 'INTERNAL_ERROR'

export interface UiValidationErrorPayload {
  code: UiValidationErrorCode
  message: string
  details?: Record<string, unknown>
  retryable?: boolean
}

export interface UiValidationRequestEnvelope {
  v: typeof UI_VALIDATION_PROTOCOL_VERSION
  kind: 'request'
  id: string
  requestId: string
  runId: string
  method: string
  params?: unknown
}

export interface UiValidationSuccessEnvelope<T = unknown> {
  v: typeof UI_VALIDATION_PROTOCOL_VERSION
  kind: 'response'
  id: string
  requestId: string
  runId: string
  seq: number
  revision: number
  verificationLevel: UiValidationVerificationLevel
  ok: true
  result: T
}

export interface UiValidationFailureEnvelope {
  v: typeof UI_VALIDATION_PROTOCOL_VERSION
  kind: 'response'
  id: string
  requestId: string
  runId: string
  seq: number
  revision: number
  verificationLevel: UiValidationVerificationLevel
  ok: false
  error: UiValidationErrorPayload
}

export type UiValidationResponseEnvelope<T = unknown> =
  | UiValidationSuccessEnvelope<T>
  | UiValidationFailureEnvelope

export interface UiValidationEvent<T = unknown> {
  v: typeof UI_VALIDATION_PROTOCOL_VERSION
  kind: 'event'
  seq: number
  type: string
  timestamp: number
  revision: number
  payload: T
}

export interface UiValidationEventReadResult {
  events: UiValidationEvent[]
  latestSeq: number
  droppedBeforeSeq?: number
}

export type SemanticNodeState = {
  disabled?: boolean
  checked?: boolean | 'mixed'
  selected?: boolean
  expanded?: boolean
  busy?: boolean
  focused?: boolean
  hidden?: boolean
}

export interface SemanticNodeBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface SemanticNode {
  ref: string
  nodeId: string
  semanticId?: string
  testId?: string
  role: string
  name: string
  value?: string
  description?: string
  states?: SemanticNodeState
  bounds?: SemanticNodeBounds
  children?: string[]
  actions?: UiValidationRendererAction[]
  actionModes?: {
    semantic?: UiValidationRendererAction[]
    physical?: UiValidationRendererAction[]
  }
}

export interface SemanticSnapshot {
  revision: number
  windowId: string
  scope: string
  route?: UiValidationRoute
  focusRef?: string
  nodes: SemanticNode[]
}

export type UiValidationTarget =
  | { ref: string }
  | { semanticId: string }
  | { testId: string }
  | { role: string; name?: string; exact?: boolean }
  | { kind: 'native'; ref: string }
  | { kind: 'browser'; instanceId: string; ref: string }
  | {
      kind: 'extension'
      sessionId: string
      extensionId: string
      runtimeId?: string
      definitionId?: string
    }

export type UiValidationRendererAction =
  | 'click'
  | 'fill'
  | 'select'
  | 'press'
  | 'drag'
  | 'shortcut'
  | 'clipboard'
  | 'ime'
  | 'rich-text'

export type UiValidationNativeAction =
  | 'click'
  | 'fill'
  | 'select'
  | 'focus'
  | 'minimize'
  | 'maximize'
  | 'restore'
  | 'close'

export type UiValidationAction = UiValidationRendererAction | UiValidationNativeAction

export type UiValidationActionMode = 'semantic' | 'physical' | 'native'

interface UiValidationActionRequestBase {
  /** Semantic invokes a command-backed handler, physical sends renderer input, and native uses the platform driver. */
  revision?: number
  value?: string
  key?: string
  modifiers?: Array<'shift' | 'control' | 'alt' | 'meta'>
  to?: { x: number; y: number }
  timeoutMs?: number
  waitUntil?: UiValidationWaitRequest
}

export interface UiValidationRendererActionRequest extends UiValidationActionRequestBase {
  target: Exclude<UiValidationTarget, { kind: 'native' | 'browser' | 'extension' }>
  action: UiValidationRendererAction
  mode?: 'semantic' | 'physical'
}

export interface UiValidationBrowserActionRequest extends UiValidationActionRequestBase {
  target: Extract<UiValidationTarget, { kind: 'browser' }>
  action: Extract<UiValidationRendererAction, 'click' | 'fill' | 'select'>
  mode?: 'physical'
}

export interface UiValidationNativeActionRequest extends UiValidationActionRequestBase {
  target: Extract<UiValidationTarget, { kind: 'native' }>
  action: UiValidationNativeAction
  mode: 'native'
}

export interface UiValidationExtensionActionRequest extends UiValidationActionRequestBase {
  target: Extract<UiValidationTarget, { kind: 'extension' }>
  action: string
  mode?: 'semantic'
  input?: Record<string, unknown>
}

export type UiValidationActionRequest =
  | UiValidationRendererActionRequest
  | UiValidationBrowserActionRequest
  | UiValidationNativeActionRequest
  | UiValidationExtensionActionRequest

export interface UiValidationActionResult {
  actionId: string
  beforeRevision: number
  afterRevision: number
  targetResolved: {
    ref?: string
    nodeId?: string
    semanticId?: string
    testId?: string
    role?: string
    name?: string
    kind?: 'native' | 'browser' | 'extension'
    instanceId?: string
    sessionId?: string
    extensionId?: string
    runtimeId?: string
    definitionId?: string
  }
  eventSeqs: number[]
  settledBy: string[]
  observed?: Record<string, unknown>
  warnings: string[]
  mode: UiValidationActionMode
  verificationLevel: UiValidationVerificationLevel
  stateChanges?: UiValidationEvent[]
  explicit?: unknown
}

export type UiValidationWaitPredicate =
  | { kind: 'app-phase'; phase: UiValidationAppPhase }
  | { kind: 'route'; route: Partial<UiValidationRoute> }
  | { kind: 'node'; target: UiValidationTarget; state?: keyof SemanticNodeState; equals?: boolean | 'mixed' }
  | { kind: 'text'; value: string; exact?: boolean }
  | { kind: 'session-state'; sessionId: string; state: string }
  | {
      kind: 'state'
      scope: 'app' | 'transport' | 'workspace' | 'sessions' | 'route' | 'session' | 'extension' | 'native-driver'
      phase?: UiValidationAppPhase
      windowId?: string
      entityId?: string
      detail?: Record<string, unknown>
    }
  | { kind: 'event'; type: string }
  | { kind: 'rpc-idle' }
  | { kind: 'render-idle' }
  | { kind: 'semantic-ready' }

export interface UiValidationWaitRequest {
  predicate: UiValidationWaitPredicate
  timeoutMs?: number
  stableForMs?: number
  afterSeq?: number
}

export interface UiValidationWaitResult {
  matchedAtSeq: number
  revision: number
  elapsedMs: number
  observed?: unknown
}

export interface UiValidationViewport {
  width: number
  height: number
  deviceScaleFactor?: number
}

export type UiValidationClockConfig =
  | { mode: 'real' }
  | { mode: 'frozen'; now: string }

export interface UiValidationScenarioApplyRequest {
  name: string
  reset?: boolean
  seed?: number
  viewport?: UiValidationViewport
  locale?: string
  theme?: 'light' | 'dark' | 'system'
  clock?: UiValidationClockConfig
  fixture?: Record<string, unknown>
}

export interface UiValidationScenarioApplyResult {
  scenarioId: string
  name: string
  seed: number
  revision: number
  aliases: Record<string, string>
}

export type UiValidationFaultEffect =
  | { kind: 'delay'; ms: number }
  | { kind: 'error'; code: string; message?: string }
  | { kind: 'disconnect' }
  | { kind: 'drop' }

export interface UiValidationFaultSetRequest {
  point: string
  effect: UiValidationFaultEffect
  times?: number
  scope?: Record<string, string>
}

export interface UiValidationFaultRecord extends UiValidationFaultSetRequest {
  faultId: string
  remaining: number
}

export type UiValidationEvidenceKind =
  | 'screenshot'
  | 'semantic-snapshot'
  | 'events'
  | 'console'
  | 'page-errors'
  | 'network-summary'
  | 'driver-info'
  | 'runtime-log'
  | 'state-manifest'
  | 'trace'

export interface UiValidationEvidenceCaptureRequest {
  label: string
  include: UiValidationEvidenceKind[]
  afterSeq?: number
  redact?: boolean
}

export interface UiValidationEvidenceArtifact {
  kind: UiValidationEvidenceKind
  path: string
  sha256: string
  mimeType: string
  sizeBytes: number
}

export interface UiValidationEvidenceCaptureResult {
  bundleDir: string
  artifacts: UiValidationEvidenceArtifact[]
  seqRange: { from: number; to: number }
  revision: number
}
