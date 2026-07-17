import * as React from 'react'
import {
  FrozenUiValidationClock,
  UiScenarioRegistry,
  UiScenarioPrimitiveRegistry,
  UiValidationError,
  UiValidationFaultRegistry,
  UiValidationServiceOverrideRegistry,
  type UiValidationClock,
  type UiValidationFaultSetRequest,
  type UiValidationScenarioApplyResult,
} from '@craft-agent/shared/ui-validation'
import type { Message, PermissionRequest, Session, TransportConnectionState } from '../../shared/types'
import { TooltipProvider } from '@craft-agent/ui'
import { TransportConnectionBanner } from '@/components/app-shell/TransportConnectionBanner'
import { StreamingMarkdown } from '@/components/markdown'
import { AdminApprovalRequest } from '@/components/app-shell/input/structured/AdminApprovalRequest'
import { ExtensionContributionZone } from '@/components/extensions/ExtensionContributionZone'
import { extensionContributionStore } from '@/components/extensions/useExtensionContributions'
import { PermissionsDataTable } from '@/components/info'
import { SettingsCard, SettingsRow, SettingsSection } from '@/components/settings'
import { Button } from '@/components/ui/button'
import { AppShell } from '@/components/app-shell/AppShell'
import { createPlaygroundAppShellContext, PLAYGROUND_WORKSPACE } from '@/playground/PlaygroundAppShellProvider'
import { createEmptySession } from '@/event-processor/helpers'
import { ScenarioSessionProjectionBoundary } from './scenario-session-projection'
import { NavigationProvider } from '@/contexts/NavigationContext'
import { navigate, routes } from '@/lib/navigate'
import { ActionRegistryProvider } from '@/actions'
import { FocusProvider } from '@/context/FocusContext'
import { DismissibleLayerProvider } from '@/context/DismissibleLayerContext'
import { ModalProvider } from '@/context/ModalContext'
import { SplashScreen } from '@/components/SplashScreen'

export const APP_SHELL_SCENARIO_BRIDGE_KEY = '__CRAFT_UI_VALIDATION_APP_SHELL_SCENARIOS_V1__'
const SCENARIO_SESSION_ID = 'ui-validation-scenario-session'
const SCENARIO_RUNTIME_ID = 'ui-validation-scenario-runtime'
const SCENARIO_EXTENSION_ID = 'ui-validation-example-extension'

type ScenarioView =
  | 'idle'
  | 'app-loading'
  | 'transport'
  | 'session-empty'
  | 'session-streaming'
  | 'tool-approval'
  | 'extension'
  | 'permissions'
  | 'settings'

type ExtensionPhase = 'loading' | 'ready' | 'error' | 'reloading'

export interface AppShellScenarioState {
  revision: number
  activeScenario?: string
  view: ScenarioView
  transport?: TransportConnectionState
  stream: { text: string; active: boolean }
  approval: { resolved?: 'approved' | 'cancelled' }
  extension: { phase: ExtensionPhase; reloads: number }
  route: 'chat' | 'settings.permissions' | 'settings.app'
  lastEvent: string
  serviceEvents: Array<{ operation: string; outcome: 'completed' | 'failed' | 'disconnected' | 'dropped' }>
}

type ScenarioEvent =
  | { type: 'reset' }
  | { type: 'show.app-loading' }
  | { type: 'show.transport'; state: TransportConnectionState }
  | { type: 'transport.retrying' }
  | { type: 'show.empty-session' }
  | { type: 'show.streaming'; text: string }
  | { type: 'stream.completed' }
  | { type: 'stream.failed' }
  | { type: 'show.tool-approval' }
  | { type: 'approval.resolved'; result: 'approved' | 'cancelled' }
  | { type: 'show.extension'; phase: ExtensionPhase }
  | { type: 'extension.reloaded' }
  | { type: 'show.permissions' }
  | { type: 'show.settings' }
  | { type: 'service.outcome'; operation: string; outcome: 'completed' | 'failed' | 'disconnected' | 'dropped' }

const INITIAL_STATE: AppShellScenarioState = {
  revision: 0,
  view: 'idle',
  stream: { text: '', active: false },
  approval: {},
  extension: { phase: 'ready', reloads: 0 },
  route: 'chat',
  lastEvent: 'reset',
  serviceEvents: [],
}

function reduceScenario(state: AppShellScenarioState, event: ScenarioEvent): AppShellScenarioState {
  const revision = state.revision + 1
  switch (event.type) {
    case 'reset': return { ...INITIAL_STATE, revision, lastEvent: event.type }
    case 'show.app-loading': return { ...INITIAL_STATE, revision, view: 'app-loading', lastEvent: event.type }
    case 'show.transport': return { ...INITIAL_STATE, revision, view: 'transport', transport: event.state, lastEvent: event.type }
    case 'transport.retrying': return state.transport ? { ...state, revision, transport: { ...state.transport, status: 'reconnecting', attempt: state.transport.attempt + 1 }, lastEvent: event.type } : state
    case 'show.empty-session': return { ...INITIAL_STATE, revision, view: 'session-empty', lastEvent: event.type }
    case 'show.streaming': return { ...INITIAL_STATE, revision, view: 'session-streaming', stream: { text: event.text, active: true }, lastEvent: event.type }
    case 'stream.completed': return { ...state, revision, stream: { ...state.stream, active: false }, lastEvent: event.type }
    case 'stream.failed': return { ...state, revision, stream: { ...state.stream, active: false }, lastEvent: event.type }
    case 'show.tool-approval': return { ...INITIAL_STATE, revision, view: 'tool-approval', lastEvent: event.type }
    case 'approval.resolved': return { ...state, revision, approval: { resolved: event.result }, lastEvent: event.type }
    case 'show.extension': return { ...INITIAL_STATE, revision, view: 'extension', extension: { ...state.extension, phase: event.phase }, lastEvent: event.type }
    case 'extension.reloaded': return { ...state, revision, extension: { phase: 'ready', reloads: state.extension.reloads + 1 }, lastEvent: event.type }
    case 'show.permissions': return { ...INITIAL_STATE, revision, view: 'permissions', route: 'settings.permissions', lastEvent: event.type }
    case 'show.settings': return { ...INITIAL_STATE, revision, view: 'settings', route: 'settings.app', lastEvent: event.type }
    case 'service.outcome': return { ...state, revision, serviceEvents: [...state.serviceEvents.slice(-31), { operation: event.operation, outcome: event.outcome }], lastEvent: `${event.operation}.${event.outcome}` }
  }
}

export class AppShellScenarioService {
  readonly scenarios = new UiScenarioRegistry<AppShellScenarioService>()
  readonly primitives = new UiScenarioPrimitiveRegistry<AppShellScenarioService>()
  readonly services = new UiValidationServiceOverrideRegistry<AppShellScenarioService>()
  readonly faults = new UiValidationFaultRegistry()
  private state: AppShellScenarioState = structuredClone(INITIAL_STATE)
  private readonly listeners = new Set<() => void>()

  constructor() {
    this.faults.register({ id: 'transport.connect', validateScope: scope => exactScope(scope, 'surface', 'app-shell') })
    this.faults.register({ id: 'session.stream', validateScope: scope => exactScope(scope, 'sessionId', SCENARIO_SESSION_ID) })
    this.faults.register({ id: 'extension.reload', validateScope: scope => exactScope(scope, 'extensionId', SCENARIO_EXTENSION_ID) })
    this.registerPrimitives()
    this.registerServiceOverrides()
    this.registerScenarios()
  }

  // useSyncExternalStore requires referential stability until a dispatch.
  // Reducer transitions replace the state object, so exposing this immutable
  // snapshot is safe and avoids render loops in both WebUI and Electron.
  getSnapshot = (): AppShellScenarioState => this.state
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }

  dispatch(event: ScenarioEvent): void {
    this.state = reduceScenario(this.state, event)
    for (const listener of this.listeners) listener()
  }

  async apply(input: unknown): Promise<UiValidationScenarioApplyResult> {
    const result = await this.scenarios.apply(this, input)
    this.state = { ...this.state, activeScenario: result.scenarioId }
    this.emit()
    return result
  }

  async reset(): Promise<void> {
    await this.scenarios.reset(this)
    this.faults.clear()
    this.dispatch({ type: 'reset' })
  }

  advance(ms: number): number {
    const clock = this.scenarios.activeClock
    if (!(clock instanceof FrozenUiValidationClock)) throw new UiValidationError('UNSUPPORTED', 'Active scenario does not use a frozen application clock.')
    return clock.advance(ms)
  }

  async retryTransport(): Promise<void> {
    try {
      await this.services.invoke('transport.connect', this, {}, this.activeClock())
    } catch {
      this.dispatch({ type: 'show.transport', state: transport('failed') })
      this.dispatch({ type: 'service.outcome', operation: 'transport.connect', outcome: 'failed' })
    }
  }

  async reloadExtension(): Promise<void> {
    this.dispatch({ type: 'show.extension', phase: 'reloading' })
    try {
      await this.services.invoke('extension.reload', this, {}, this.activeClock())
    } catch {
      this.dispatch({ type: 'show.extension', phase: 'error' })
      this.dispatch({ type: 'service.outcome', operation: 'extension.reload', outcome: 'failed' })
    }
  }

  private activeClock(): UiValidationClock {
    const clock = this.scenarios.activeClock
    if (!clock) throw new UiValidationError('NOT_READY', 'No AppShell scenario is active.')
    return clock
  }

  private isCurrentClock(clock: UiValidationClock): boolean {
    return this.scenarios.activeClock === clock
  }

  private emit(): void { for (const listener of this.listeners) listener() }

  private registerPrimitives(): void {
    const register = <Value,>(id: string, validate: (input: unknown) => Value, event: (value: Value) => ScenarioEvent) => {
      this.primitives.register({ id, validate, apply: (service, value) => service.dispatch(event(value)) })
    }
    const none = (input: unknown): undefined => {
      if (input !== undefined) throw new UiValidationError('SCENARIO_INVALID', 'This state primitive does not accept input.')
      return undefined
    }
    register('app.loading', none, () => ({ type: 'show.app-loading' }))
    register('transport.state', validateTransportPhase, status => ({ type: 'show.transport', state: transport(status) }))
    register('session.empty', none, () => ({ type: 'show.empty-session' }))
    register('session.streaming', validateStreamText, text => ({ type: 'show.streaming', text }))
    register('tool.approval', none, () => ({ type: 'show.tool-approval' }))
    register('extension.phase', validateExtensionPhase, phase => ({ type: 'show.extension', phase }))
    register('route.permissions', none, () => ({ type: 'show.permissions' }))
    register('route.settings', none, () => ({ type: 'show.settings' }))
  }

  private registerServiceOverrides(): void {
    const noInput = (input: unknown): Record<string, never> => {
      if (typeof input !== 'object' || input === null || Object.keys(input).length !== 0) throw new UiValidationError('SCENARIO_INVALID', 'Service operation input must be empty.')
      return {}
    }
    this.services.register({
      id: 'transport.connect', validate: noInput,
      invoke: async (service, _input, clock) => {
        const effect = await service.faults.consume('transport.connect', { surface: 'app-shell' }, clock)
        if (effect?.kind === 'drop') return service.recordServiceOutcome('transport.connect', 'dropped')
        if (effect?.kind === 'disconnect') {
          service.dispatch({ type: 'show.transport', state: transport('failed') })
          return service.recordServiceOutcome('transport.connect', 'disconnected')
        }
        await clock.delay(100, undefined, 'retry')
        service.dispatch({ type: 'transport.retrying' })
        return service.recordServiceOutcome('transport.connect', 'completed')
      },
    })
    this.services.register({
      id: 'session.stream', validate: noInput,
      invoke: async (service, _input, clock) => {
        const effect = await service.faults.consume('session.stream', { sessionId: SCENARIO_SESSION_ID }, clock)
        if (effect?.kind === 'drop') return service.recordServiceOutcome('session.stream', 'dropped')
        if (effect?.kind === 'disconnect') {
          service.dispatch({ type: 'stream.failed' })
          return service.recordServiceOutcome('session.stream', 'disconnected')
        }
        await clock.delay(1_000, undefined, 'scheduler')
        service.dispatch({ type: 'stream.completed' })
        return service.recordServiceOutcome('session.stream', 'completed')
      },
    })
    this.services.register({
      id: 'extension.reload', validate: noInput,
      invoke: async (service, _input, clock) => {
        const effect = await service.faults.consume('extension.reload', { extensionId: SCENARIO_EXTENSION_ID }, clock)
        if (effect?.kind === 'drop') return service.recordServiceOutcome('extension.reload', 'dropped')
        if (effect?.kind === 'disconnect') {
          service.dispatch({ type: 'show.extension', phase: 'error' })
          return service.recordServiceOutcome('extension.reload', 'disconnected')
        }
        await clock.delay(250, undefined, 'debounce')
        service.dispatch({ type: 'extension.reloaded' })
        return service.recordServiceOutcome('extension.reload', 'completed')
      },
    })
  }

  private recordServiceOutcome(operation: string, outcome: 'completed' | 'failed' | 'disconnected' | 'dropped'): void {
    this.dispatch({ type: 'service.outcome', operation, outcome })
  }

  private registerScenarios(): void {
    const fixed = (id: string, primitive: string, value?: unknown, after?: (clock: UiValidationClock) => void) => this.scenarios.register({
      id,
      kind: 'app-shell',
      validate: request => { if (request.fixture !== undefined) throw new UiValidationError('SCENARIO_INVALID', 'AppShell scenarios do not accept arbitrary fixtures.') },
      setup: async (_context, _request, clock) => { await this.primitives.apply(primitive, this, value, clock); after?.(clock); return { aliases: { root: 'scenario.app-shell' } } },
      reset: () => this.dispatch({ type: 'reset' }),
    })
    fixed('app.loading', 'app.loading')
    fixed('transport.reconnect', 'transport.state', 'reconnecting')
    fixed('transport.error', 'transport.state', 'failed')
    fixed('session.empty', 'session.empty')
    fixed('session.streaming', 'session.streaming', 'The validation stream uses the production markdown renderer.\n\n- first block\n- second block', clock => { void this.completeStream(clock) })
    fixed('tool.approval', 'tool.approval')
    fixed('extension.loading', 'extension.phase', 'loading')
    fixed('extension.ready', 'extension.phase', 'ready')
    fixed('extension.error', 'extension.phase', 'error')
    fixed('extension.reload', 'extension.phase', 'reloading', clock => { void this.completeExtensionReload(clock) })
    fixed('settings.permissions', 'route.permissions')
    fixed('settings.app', 'route.settings')
  }

  private async completeStream(clock: UiValidationClock): Promise<void> {
    try {
      await this.services.invoke('session.stream', this, {}, clock)
    } catch {
      if (!this.isCurrentClock(clock)) return
      this.dispatch({ type: 'stream.failed' })
      this.recordServiceOutcome('session.stream', 'failed')
    }
  }

  private async completeExtensionReload(clock: UiValidationClock): Promise<void> {
    try {
      await this.services.invoke('extension.reload', this, {}, clock)
    } catch {
      if (!this.isCurrentClock(clock)) return
      this.dispatch({ type: 'show.extension', phase: 'error' })
      this.recordServiceOutcome('extension.reload', 'failed')
    }
  }
}

function transport(status: 'reconnecting' | 'failed'): TransportConnectionState {
  return {
    mode: 'remote', status, url: 'wss://validation.invalid', attempt: status === 'reconnecting' ? 2 : 4, updatedAt: 1,
    lastError: { kind: 'network', message: status === 'failed' ? 'Injected connection failure' : 'Connection interrupted' },
    ...(status === 'reconnecting' ? { nextRetryInMs: 1_000 } : {}),
  }
}

function validateTransportPhase(input: unknown): 'reconnecting' | 'failed' {
  if (input !== 'reconnecting' && input !== 'failed') throw new UiValidationError('SCENARIO_INVALID', 'Transport state must be reconnecting or failed.')
  return input
}

function validateExtensionPhase(input: unknown): ExtensionPhase {
  if (input !== 'loading' && input !== 'ready' && input !== 'error' && input !== 'reloading') throw new UiValidationError('SCENARIO_INVALID', 'Extension phase is invalid.')
  return input
}

function validateStreamText(input: unknown): string {
  if (typeof input !== 'string' || input.length === 0 || input.length > 20_000) throw new UiValidationError('SCENARIO_INVALID', 'Stream text must be a bounded non-empty string.')
  return input
}

function exactScope(scope: Readonly<Record<string, string>>, key: string, value: string): boolean {
  const keys = Object.keys(scope)
  return keys.length === 1 && keys[0] === key && scope[key] === value
}

export const appShellScenarioService = new AppShellScenarioService()

export interface AppShellScenarioBridgeV1 {
  schemaVersion: 1
  list(): ReturnType<UiScenarioRegistry<AppShellScenarioService>['list']>
  snapshot(): AppShellScenarioState & {
    faults: ReturnType<UiValidationFaultRegistry['list']>
    primitives: string[]
    services: string[]
    clock: ReturnType<UiValidationClock['describe']> | { mode: 'none'; virtualizedDomains: []; nonVirtualizedDomains: ['os', 'network']; pending: {} }
  }
  apply(input: unknown): Promise<UiValidationScenarioApplyResult>
  reset(): Promise<void>
  clock: { advance(ms: number): number }
  fault: { set(input: UiValidationFaultSetRequest): ReturnType<UiValidationFaultRegistry['set']>; clear(faultId?: string): void }
}

export function installAppShellScenarioBridge(): (() => void) | undefined {
  if (typeof window === 'undefined' || (window.electronAPI?.uiValidationTestHost?.enabled !== true && window.__craftUiValidation === undefined)) return undefined
  const bridge: AppShellScenarioBridgeV1 = {
    schemaVersion: 1,
    list: () => appShellScenarioService.scenarios.list(),
    snapshot: () => {
      const clock = appShellScenarioService.scenarios.activeClock
      return {
        ...appShellScenarioService.getSnapshot(),
        faults: appShellScenarioService.faults.list(),
        primitives: appShellScenarioService.primitives.list(),
        services: appShellScenarioService.services.list(),
        clock: clock?.describe() ?? { mode: 'none', virtualizedDomains: [], nonVirtualizedDomains: ['os', 'network'], pending: {} },
      }
    },
    apply: input => appShellScenarioService.apply(input),
    reset: () => appShellScenarioService.reset(),
    clock: Object.freeze({ advance: (ms: number) => appShellScenarioService.advance(ms) }),
    fault: Object.freeze({ set: (input: UiValidationFaultSetRequest) => appShellScenarioService.faults.set(input), clear: (faultId?: string) => appShellScenarioService.faults.clear(faultId) }),
  }
  const target = window as unknown as Record<string, unknown>
  Object.defineProperty(target, APP_SHELL_SCENARIO_BRIDGE_KEY, { configurable: true, enumerable: false, writable: false, value: bridge })
  return () => { delete target[APP_SHELL_SCENARIO_BRIDGE_KEY] }
}

export function ScenarioAppShellHost() {
  const state = React.useSyncExternalStore(appShellScenarioService.subscribe, appShellScenarioService.getSnapshot, appShellScenarioService.getSnapshot)
  React.useEffect(() => {
    if (state.view !== 'extension') return
    extensionContributionStore.apply({
      schemaVersion: 1, extensionId: SCENARIO_EXTENSION_ID, sessionId: SCENARIO_SESSION_ID, runtimeId: SCENARIO_RUNTIME_ID,
      workspaceId: PLAYGROUND_WORKSPACE.id, revision: state.revision, operation: 'upsert', contribution: {
        schemaVersion: 1, id: 'scenario-status', surface: 'composer.above',
        content: { type: 'row', gap: 'small', children: [
          { type: 'icon', name: state.extension.phase === 'error' ? 'alert-circle' : state.extension.phase === 'ready' ? 'check' : 'loader', label: state.extension.phase },
          { type: 'text', text: `Extension ${state.extension.phase}`, tone: state.extension.phase === 'error' ? 'danger' : state.extension.phase === 'ready' ? 'success' : 'muted' },
          { type: 'button', label: 'Reload', action: { kind: 'command', command: 'scenario-extension-reload' }, disabled: state.extension.phase === 'reloading' },
        ] },
      },
    })
    return () => extensionContributionStore.resetRuntime(
      SCENARIO_SESSION_ID,
      SCENARIO_RUNTIME_ID,
      PLAYGROUND_WORKSPACE.id,
    )
  }, [state.extension.phase, state.revision, state.view])

  if (['transport', 'session-empty', 'session-streaming', 'tool-approval', 'extension', 'permissions', 'settings'].includes(state.view)) {
    return <RealScenarioAppShell state={state} />
  }

  return (
    <main className="flex h-full min-h-[420px] w-full flex-col bg-background text-foreground" data-testid="scenario.app-shell" data-scenario={state.activeScenario ?? 'none'}>
      <header className="flex h-12 shrink-0 items-center border-b px-4 text-sm font-medium">Craft Scenario AppShell</header>
      {state.view === 'transport' && state.transport && <TransportConnectionBanner state={state.transport} onRetry={() => void appShellScenarioService.retryTransport()} />}
      <section className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
        {state.view === 'idle' && <p className="text-sm text-muted-foreground">No scenario applied</p>}
        {state.view === 'app-loading' && <SplashScreen isExiting={false} />}
        {state.view === 'session-empty' && <div className="text-center"><h2 className="text-base font-medium">No sessions yet</h2><p className="mt-1 text-sm text-muted-foreground">Create a session to start working.</p></div>}
        {state.view === 'session-streaming' && <article className="w-full max-w-2xl"><StreamingMarkdown content={state.stream.text} isStreaming={state.stream.active} /></article>}
        {state.view === 'tool-approval' && <div className="h-80 w-full max-w-xl"><AdminApprovalRequest request={{ appName: 'Scenario tool', reason: 'Validate the production approval card', command: 'craft scenario --verify', impact: 'No real command is executed.' }} onApprove={() => appShellScenarioService.dispatch({ type: 'approval.resolved', result: 'approved' })} onCancel={() => appShellScenarioService.dispatch({ type: 'approval.resolved', result: 'cancelled' })} /></div>}
        {state.view === 'extension' && <div className="w-full max-w-xl"><ExtensionContributionZone sessionId={SCENARIO_SESSION_ID} surface="composer.above" hydrateRuntime={false} /></div>}
        {state.view === 'permissions' && <div className="w-full max-w-3xl"><SettingsSection title="Permissions"><PermissionsDataTable data={[{ access: 'allowed', type: 'bash', pattern: 'git status', comment: 'Read-only repository inspection' }, { access: 'blocked', type: 'tool', pattern: 'arbitrary-state-write', comment: 'Scenario safety boundary' }]} searchable /></SettingsSection></div>}
        {state.view === 'settings' && <div className="w-full max-w-2xl"><SettingsSection title="Application"><SettingsCard><SettingsRow label="Browser tools" description="Controlled scenario setting"><Button size="sm" variant="outline">Enabled</Button></SettingsRow><SettingsRow label="Keep awake" description="Uses production settings layout"><span className="text-sm text-muted-foreground">Off</span></SettingsRow></SettingsCard></SettingsSection></div>}
      </section>
      <footer className="border-t px-4 py-2 text-xs text-muted-foreground">{state.lastEvent} · revision {state.revision}</footer>
    </main>
  )
}

function RealScenarioAppShell({ state }: { state: AppShellScenarioState }) {
  const needsSession = state.view === 'session-streaming' || state.view === 'tool-approval' || state.view === 'extension'
  const messages = React.useMemo<Message[]>(() => state.view === 'session-streaming' ? [{
    id: 'scenario-stream-message',
    role: 'assistant',
    content: state.stream.text,
    timestamp: 1,
    isStreaming: state.stream.active,
    isPending: state.stream.active,
    turnId: 'scenario-stream-turn',
  }] : [], [state.stream.active, state.stream.text, state.view])
  const session = React.useMemo<Session>(() => ({
    ...createEmptySession(SCENARIO_SESSION_ID, PLAYGROUND_WORKSPACE.id, PLAYGROUND_WORKSPACE.name),
    name: 'Validation session',
    messages,
    isProcessing: (state.view === 'extension' && state.extension.phase === 'loading') || (state.view === 'session-streaming' && state.stream.active),
  }), [messages, state.extension.phase, state.stream.active, state.view])

  const projection = React.useMemo(() => ({
    sessions: needsSession ? [session] : [],
    ...(needsSession ? { loadedSessionId: session.id } : {}),
  }), [needsSession, session])

  React.useEffect(() => {
    const route = state.view === 'permissions'
      ? routes.view.settings('permissions')
      : state.view === 'settings'
        ? routes.view.settings('app')
        : routes.view.allSessions(needsSession ? SCENARIO_SESSION_ID : undefined)
    navigate(route)
  }, [needsSession, state.view])

  const pendingPermissions = React.useMemo(() => {
    const result = new Map<string, PermissionRequest[]>()
    if (state.view === 'tool-approval' && !state.approval.resolved) {
      result.set(SCENARIO_SESSION_ID, [{
        sessionId: SCENARIO_SESSION_ID, requestId: 'scenario-approval', toolName: 'admin_approval', type: 'admin_approval',
        description: 'Validate the production approval flow', appName: 'Scenario tool',
        reason: 'Validate the production approval card', command: 'craft scenario --verify',
        impact: 'No real command is executed.',
      }])
    }
    return result
  }, [state.approval.resolved, state.view])

  const contextValue = React.useMemo(() => createPlaygroundAppShellContext({
    isCompactMode: false,
    pendingPermissions,
    onCreateSession: async () => session,
    onRespondToPermission: (_sessionId, _requestId, allowed) => appShellScenarioService.dispatch({ type: 'approval.resolved', result: allowed ? 'approved' : 'cancelled' }),
    onDeleteSession: async () => false,
  }), [pendingPermissions, session])

  return (
    <div className="flex h-full min-h-[560px] w-full flex-col bg-background text-foreground" data-testid="scenario.real-app-shell" data-scenario={state.activeScenario ?? 'none'}>
      <ScenarioSessionProjectionBoundary projection={projection} />
      {state.view === 'transport' && state.transport && <TransportConnectionBanner state={state.transport} onRetry={() => void appShellScenarioService.retryTransport()} />}
      <div className="min-h-0 flex-1">
        <ActionRegistryProvider>
        <FocusProvider>
          <DismissibleLayerProvider>
            <ModalProvider>
              <TooltipProvider delayDuration={0}>
                <NavigationProvider
                  workspaceId={PLAYGROUND_WORKSPACE.id}
                  workspaceSlug={PLAYGROUND_WORKSPACE.slug}
                  onSwitchWorkspaceBySlug={async () => undefined}
                  onCreateSession={async () => session}
                  onInputChange={() => undefined}
                  getDraft={() => ''}
                  onAutoDeleteEmptySession={async () => undefined}
                  isReady
                  isSessionsReady
                  remoteWorkspaceId={null}
                  workspaceSwitchDestination={null}
                  onWorkspaceSwitchDestinationConsumed={() => undefined}
                >
                  <AppShell contextValue={contextValue} defaultLayout={[20, 32, 48]} />
                </NavigationProvider>
              </TooltipProvider>
            </ModalProvider>
          </DismissibleLayerProvider>
        </FocusProvider>
        </ActionRegistryProvider>
      </div>
    </div>
  )
}
