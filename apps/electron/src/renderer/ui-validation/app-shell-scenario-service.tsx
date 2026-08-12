import * as React from 'react'
import { useTranslation } from 'react-i18next'
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
} from '@mortise/shared/ui-validation'
import type { Message, Session, TransportConnectionState } from '../../shared/types'
import type { PiProjectionSnapshotV1 } from '@mortise/shared/protocol'
import { TooltipProvider } from '@mortise/ui'
const ScenarioTransportConnectionBanner = React.lazy(async () => {
  const module = await import('@/components/app-shell/TransportConnectionBanner')
  return { default: module.TransportConnectionBanner }
})
import { StreamingMarkdown } from '@/components/markdown'
import { ExtensionContributionZone } from '@/components/extensions/ExtensionContributionZone'
import { extensionContributionStore } from '@/components/extensions/useExtensionContributions'
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

export const APP_SHELL_SCENARIO_BRIDGE_KEY = '__MORTISE_UI_VALIDATION_APP_SHELL_SCENARIOS_V1__'
const SCENARIO_SESSION_ID = 'ui-validation-scenario-session'
const SCENARIO_RUNTIME_ID = 'ui-validation-scenario-runtime'
const SCENARIO_EXTENSION_ID = 'ui-validation-example-extension'

type ScenarioView =
  | 'idle'
  | 'app-loading'
  | 'transport'
  | 'session-empty'
  | 'session-streaming'
  | 'session-reasoning-result'
  | 'session-queued'
  | 'extension'
  | 'settings'

type ExtensionPhase = 'loading' | 'ready' | 'error' | 'reloading'

export interface AppShellScenarioState {
  revision: number
  activeScenario?: string
  view: ScenarioView
  transport?: TransportConnectionState
  stream: { text: string; active: boolean }
  extension: { phase: ExtensionPhase; reloads: number }
  route: 'chat' | 'settings.app'
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
  | { type: 'show.reasoning-result' }
  | { type: 'show.queued' }
  | { type: 'stream.completed' }
  | { type: 'stream.failed' }
  | { type: 'show.extension'; phase: ExtensionPhase }
  | { type: 'extension.reloaded' }
  | { type: 'show.settings' }
  | { type: 'service.outcome'; operation: string; outcome: 'completed' | 'failed' | 'disconnected' | 'dropped' }

const INITIAL_STATE: AppShellScenarioState = {
  revision: 0,
  view: 'idle',
  stream: { text: '', active: false },
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
    case 'show.reasoning-result': return { ...INITIAL_STATE, revision, view: 'session-reasoning-result', lastEvent: event.type }
    case 'show.queued': return { ...INITIAL_STATE, revision, view: 'session-queued', lastEvent: event.type }
    case 'stream.completed': return { ...state, revision, stream: { ...state.stream, active: false }, lastEvent: event.type }
    case 'stream.failed': return { ...state, revision, stream: { ...state.stream, active: false }, lastEvent: event.type }
    case 'show.extension': return { ...INITIAL_STATE, revision, view: 'extension', extension: { ...state.extension, phase: event.phase }, lastEvent: event.type }
    case 'extension.reloaded': return { ...state, revision, extension: { phase: 'ready', reloads: state.extension.reloads + 1 }, lastEvent: event.type }
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

  async reset(): Promise<AppShellScenarioState> {
    await this.scenarios.reset(this)
    this.faults.clear()
    return this.state
  }

  advance(ms: number): number {
    const clock = this.scenarios.activeClock
    if (!(clock instanceof FrozenUiValidationClock)) throw new UiValidationError('UNSUPPORTED', 'Active scenario does not use a frozen application clock.')
    return clock.advance(ms)
  }

  async retryTransport(): Promise<void> {
    const clock = this.activeClock()
    try {
      await this.services.invoke('transport.connect', this, {}, clock)
    } catch {
      if (!this.isCurrentClock(clock)) return
      this.dispatch({ type: 'show.transport', state: transport('failed') })
      this.dispatch({ type: 'service.outcome', operation: 'transport.connect', outcome: 'failed' })
    }
  }

  async reloadExtension(): Promise<void> {
    const clock = this.activeClock()
    this.dispatch({ type: 'show.extension', phase: 'reloading' })
    try {
      await this.services.invoke('extension.reload', this, {}, clock)
    } catch {
      if (!this.isCurrentClock(clock)) return
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

  private commitForClock(clock: UiValidationClock, event: ScenarioEvent): boolean {
    if (!this.isCurrentClock(clock)) return false
    this.dispatch(event)
    return true
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
    register('session.reasoning-result', none, () => ({ type: 'show.reasoning-result' }))
    register('session.queued', none, () => ({ type: 'show.queued' }))
    register('extension.phase', validateExtensionPhase, phase => ({ type: 'show.extension', phase }))
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
        if (!service.isCurrentClock(clock)) return
        if (effect?.kind === 'drop') return service.recordServiceOutcomeForClock(clock, 'transport.connect', 'dropped')
        if (effect?.kind === 'disconnect') {
          service.commitForClock(clock, { type: 'show.transport', state: transport('failed') })
          return service.recordServiceOutcomeForClock(clock, 'transport.connect', 'disconnected')
        }
        await clock.delay(100, undefined, 'retry')
        service.commitForClock(clock, { type: 'transport.retrying' })
        return service.recordServiceOutcomeForClock(clock, 'transport.connect', 'completed')
      },
    })
    this.services.register({
      id: 'session.stream', validate: noInput,
      invoke: async (service, _input, clock) => {
        const effect = await service.faults.consume('session.stream', { sessionId: SCENARIO_SESSION_ID }, clock)
        if (!service.isCurrentClock(clock)) return
        if (effect?.kind === 'drop') return service.recordServiceOutcomeForClock(clock, 'session.stream', 'dropped')
        if (effect?.kind === 'disconnect') {
          service.commitForClock(clock, { type: 'stream.failed' })
          return service.recordServiceOutcomeForClock(clock, 'session.stream', 'disconnected')
        }
        await clock.delay(1_000, undefined, 'scheduler')
        service.commitForClock(clock, { type: 'stream.completed' })
        return service.recordServiceOutcomeForClock(clock, 'session.stream', 'completed')
      },
    })
    this.services.register({
      id: 'extension.reload', validate: noInput,
      invoke: async (service, _input, clock) => {
        const effect = await service.faults.consume('extension.reload', { extensionId: SCENARIO_EXTENSION_ID }, clock)
        if (!service.isCurrentClock(clock)) return
        if (effect?.kind === 'drop') return service.recordServiceOutcomeForClock(clock, 'extension.reload', 'dropped')
        if (effect?.kind === 'disconnect') {
          service.commitForClock(clock, { type: 'show.extension', phase: 'error' })
          return service.recordServiceOutcomeForClock(clock, 'extension.reload', 'disconnected')
        }
        await clock.delay(250, undefined, 'debounce')
        service.commitForClock(clock, { type: 'extension.reloaded' })
        return service.recordServiceOutcomeForClock(clock, 'extension.reload', 'completed')
      },
    })
  }

  private recordServiceOutcome(operation: string, outcome: 'completed' | 'failed' | 'disconnected' | 'dropped'): void {
    this.dispatch({ type: 'service.outcome', operation, outcome })
  }

  private recordServiceOutcomeForClock(clock: UiValidationClock, operation: string, outcome: 'completed' | 'failed' | 'disconnected' | 'dropped'): void {
    this.commitForClock(clock, { type: 'service.outcome', operation, outcome })
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
    fixed('session.reasoning-result', 'session.reasoning-result')
    fixed('session.streaming', 'session.streaming', 'The validation stream uses the production markdown renderer.\n\n- first block\n- second block', clock => { void this.completeStream(clock) })
    fixed('session.queued', 'session.queued')
    fixed('extension.loading', 'extension.phase', 'loading')
    fixed('extension.ready', 'extension.phase', 'ready')
    fixed('extension.error', 'extension.phase', 'error')
    fixed('extension.reload', 'extension.phase', 'reloading', clock => { void this.completeExtensionReload(clock) })
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
  reset(): Promise<AppShellScenarioState>
  clock: { advance(ms: number): number }
  fault: { set(input: UiValidationFaultSetRequest): ReturnType<UiValidationFaultRegistry['set']>; clear(faultId?: string): void }
}

export function installAppShellScenarioBridge(): (() => void) | undefined {
  if (typeof window === 'undefined' || (window.electronAPI?.uiValidationTestHost?.enabled !== true && window.__mortiseUiValidation === undefined)) return undefined
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
  const { t } = useTranslation()
  const state = React.useSyncExternalStore(appShellScenarioService.subscribe, appShellScenarioService.getSnapshot, appShellScenarioService.getSnapshot)
  React.useEffect(() => {
    if (state.view !== 'extension') return
    extensionContributionStore.apply({
      schemaVersion: 1, extensionId: SCENARIO_EXTENSION_ID, sessionId: SCENARIO_SESSION_ID, runtimeId: SCENARIO_RUNTIME_ID,
      workspaceId: PLAYGROUND_WORKSPACE.id, revision: state.revision, operation: 'upsert', contribution: {
        schemaVersion: 1, id: 'scenario-status', surface: 'composer.above',
        content: { type: 'row', gap: 'small', children: [
          { type: 'icon', name: state.extension.phase === 'error' ? 'alert-circle' : state.extension.phase === 'ready' ? 'check' : 'loader', label: state.extension.phase },
          { type: 'text', text: t('scenario.extensionStatus', { phase: state.extension.phase }), tone: state.extension.phase === 'error' ? 'danger' : state.extension.phase === 'ready' ? 'success' : 'muted' },
          { type: 'button', label: t('scenario.reload'), action: { kind: 'command', command: 'scenario-extension-reload' }, disabled: state.extension.phase === 'reloading' },
        ] },
      },
    })
    return () => extensionContributionStore.resetRuntime(
      SCENARIO_SESSION_ID,
      SCENARIO_RUNTIME_ID,
      PLAYGROUND_WORKSPACE.id,
    )
  }, [state.extension.phase, state.revision, state.view, t])

  if (['transport', 'session-empty', 'session-streaming', 'session-reasoning-result', 'session-queued', 'extension', 'settings'].includes(state.view)) {
    return <RealScenarioAppShell state={state} />
  }

  return (
    <main className="flex h-full min-h-[420px] w-full flex-col bg-background text-foreground" data-testid="scenario.app-shell" data-scenario={state.activeScenario ?? 'none'}>
      <header className="flex h-12 shrink-0 items-center border-b px-4 text-sm font-medium">{t('scenario.hostTitle')}</header>
      {state.view === 'transport' && state.transport && (
        <React.Suspense fallback={null}>
          <ScenarioTransportConnectionBanner state={state.transport} onRetry={() => void appShellScenarioService.retryTransport()} />
        </React.Suspense>
      )}
      <section className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
        {state.view === 'idle' && <p className="text-sm text-muted-foreground">{t('scenario.noScenarioApplied')}</p>}
        {state.view === 'app-loading' && <SplashScreen isExiting={false} />}
        {state.view === 'session-empty' && <div className="text-center"><h2 className="text-base font-medium">{t('scenario.noSessionsYet')}</h2><p className="mt-1 text-sm text-muted-foreground">{t('scenario.createSessionHint')}</p></div>}
        {state.view === 'session-streaming' && <article className="w-full max-w-2xl"><StreamingMarkdown content={state.stream.text} isStreaming={state.stream.active} /></article>}
        {state.view === 'extension' && <div className="w-full max-w-xl"><ExtensionContributionZone sessionId={SCENARIO_SESSION_ID} surface="composer.above" hydrateRuntime={false} /></div>}
        {state.view === 'settings' && <div className="w-full max-w-2xl"><SettingsSection title={t('scenario.settingsApplication')}><SettingsCard><SettingsRow label={t('scenario.settingsBrowserTools')} description={t('scenario.controlledScenarioSetting')}><Button size="sm" variant="outline">{t('scenario.enabled')}</Button></SettingsRow><SettingsRow label={t('scenario.keepAwake')} description={t('scenario.usesProductionSettingsLayout')}><span className="text-sm text-muted-foreground">{t('scenario.off')}</span></SettingsRow></SettingsCard></SettingsSection></div>}
      </section>
      <footer className="border-t px-4 py-2 text-xs text-muted-foreground">{state.lastEvent} · revision {state.revision}</footer>
    </main>
  )
}

export function createReasoningResultProjection(): PiProjectionSnapshotV1 {
  const startedAt = 1_786_163_200_000
  return {
    schemaVersion: 1,
    sessionId: SCENARIO_SESSION_ID,
    runtimeId: SCENARIO_RUNTIME_ID,
    lastSeq: 8,
    entities: [
      {
        entityId: 'content:user:reasoning-result', entityType: 'content_block', entityVersion: 1,
        createdSeq: 1, createdAt: startedAt, updatedAt: startedAt,
        turnId: 'scenario-reasoning-turn', kind: 'user_text',
        payload: {
          role: 'user', messageId: 'scenario-reasoning-user',
          text: '请整理这段信息流。', streaming: false, timestamp: startedAt,
        },
        lastEventId: 'scenario-user-text', lastSeq: 1,
      },
      {
        entityId: 'content:thinking:reasoning-result:0', entityType: 'content_block', entityVersion: 1,
        createdSeq: 2, createdAt: startedAt + 1_000, updatedAt: startedAt + 1_000,
        turnId: 'scenario-reasoning-turn', kind: 'thinking_end',
        payload: {
          role: 'assistant', contentKind: 'thinking', messageId: 'scenario-reasoning-thinking',
          contentIndex: 0, text: '思考一：先梳理信息之间的关系。', streaming: false,
          isIntermediate: true, isFinal: false,
          timestamp: startedAt + 90_000,
        },
        lastEventId: 'scenario-thinking-end', lastSeq: 2,
      },
      {
        entityId: 'tool:reasoning-read', entityType: 'tool_run', entityVersion: 2,
        createdSeq: 3, createdAt: startedAt - 20_000, updatedAt: startedAt - 19_500,
        turnId: 'scenario-reasoning-turn', kind: 'tool_execution_end',
        payload: {
          toolCallId: 'reasoning-read', toolName: 'Read', input: { file_path: 'src/first.ts' },
          result: '工具一：读取完成。', status: 'completed',
          timestamp: startedAt - 20_000, startedAt: startedAt - 20_000, completedAt: startedAt - 19_500,
        },
        lastEventId: 'scenario-tool-one-end', lastSeq: 3,
      },
      {
        entityId: 'content:thinking:reasoning-result:1', entityType: 'content_block', entityVersion: 1,
        createdSeq: 4, createdAt: startedAt + 2_000, updatedAt: startedAt + 2_000,
        turnId: 'scenario-reasoning-turn', kind: 'thinking_end',
        payload: {
          role: 'assistant', contentKind: 'thinking', messageId: 'scenario-reasoning-thinking-2',
          contentIndex: 0, text: '思考二：根据工具结果继续核对。', streaming: false,
          isIntermediate: true, isFinal: false,
          timestamp: startedAt + 60_000,
        },
        lastEventId: 'scenario-thinking-two-end', lastSeq: 4,
      },
      {
        entityId: 'tool:reasoning-write', entityType: 'tool_run', entityVersion: 2,
        createdSeq: 5, createdAt: startedAt - 40_000, updatedAt: startedAt - 39_250,
        turnId: 'scenario-reasoning-turn', kind: 'tool_execution_end',
        payload: {
          toolCallId: 'reasoning-write', toolName: 'Write', input: { file_path: 'src/second.ts' },
          result: '工具二：写入完成。', status: 'completed',
          timestamp: startedAt - 40_000, startedAt: startedAt - 40_000, completedAt: startedAt - 39_250,
        },
        lastEventId: 'scenario-tool-two-end', lastSeq: 5,
      },
      {
        entityId: 'content:text:reasoning-result:0', entityType: 'content_block', entityVersion: 1,
        createdSeq: 6, createdAt: startedAt + 5_000, updatedAt: startedAt + 5_000,
        turnId: 'scenario-reasoning-turn', kind: 'assistant_text',
        payload: {
          role: 'assistant', messageId: 'scenario-reasoning-result', contentIndex: 0,
          text: '这是唯一渲染为卡片的最终结果。', streaming: false,
          isIntermediate: false, isFinal: true, stopReason: 'stop', timestamp: startedAt + 5_000,
        },
        lastEventId: 'scenario-result-end', lastSeq: 6,
      },
      {
        entityId: 'turn:scenario-reasoning-turn', entityType: 'turn', entityVersion: 1,
        createdSeq: 7, createdAt: startedAt, updatedAt: startedAt + 6_000,
        turnId: 'scenario-reasoning-turn', kind: 'turn_end',
        payload: { status: 'completed', stopReason: 'stop' },
        lastEventId: 'scenario-turn-end', lastSeq: 7,
      },
      {
        entityId: 'agent:reasoning-result', entityType: 'conversation', entityVersion: 1,
        createdSeq: 8, createdAt: startedAt, updatedAt: startedAt + 7_000,
        kind: 'agent_end', payload: { status: 'completed' },
        lastEventId: 'scenario-agent-end', lastSeq: 8,
      },
    ],
  }
}

function RealScenarioAppShell({ state }: { state: AppShellScenarioState }) {
  const [draft, setDraft] = React.useState('')
  const [queuedMessageWithdrawn, setQueuedMessageWithdrawn] = React.useState(false)
  const needsSession = state.view === 'session-streaming' || state.view === 'session-reasoning-result' || state.view === 'session-queued' || state.view === 'extension'
  const messages = React.useMemo<Message[]>(() => state.view === 'session-streaming' ? [{
    id: 'scenario-stream-message',
    role: 'assistant',
    content: state.stream.text,
    timestamp: 1,
    isStreaming: state.stream.active,
    isPending: state.stream.active,
    turnId: 'scenario-stream-turn',
  }] : state.view === 'session-queued' ? [{
    id: 'scenario-active-assistant',
    role: 'assistant',
    content: '正在处理当前请求，排队消息会在这一轮结束后发送。',
    timestamp: 1_785_830_400_000,
    isPending: true,
    isStreaming: true,
    turnId: 'scenario-active-turn',
  }] : [], [state.stream.active, state.stream.text, state.view])
  const session = React.useMemo<Session>(() => ({
    ...createEmptySession(SCENARIO_SESSION_ID, PLAYGROUND_WORKSPACE.id, PLAYGROUND_WORKSPACE.name),
    name: 'Validation session',
    messages,
    isProcessing: (state.view === 'extension' && state.extension.phase === 'loading') || (state.view === 'session-streaming' && state.stream.active) || state.view === 'session-queued',
  }), [messages, state.extension.phase, state.stream.active, state.view])

  const piProjection = React.useMemo<PiProjectionSnapshotV1 | undefined>(() => {
    if (state.view === 'session-reasoning-result') return createReasoningResultProjection()
    if (state.view !== 'session-queued') return undefined
    const entities: PiProjectionSnapshotV1['entities'] = [{
      entityId: 'runtime:scenario-queued',
      entityType: 'conversation',
      entityVersion: 1,
      createdSeq: 1,
      kind: 'agent_start',
      payload: {},
      lastEventId: 'scenario-queued-agent-start',
      lastSeq: 1,
    }]
    if (!queuedMessageWithdrawn) entities.push({
      entityId: 'content:user:scenario-queued-message',
      entityType: 'content_block',
      entityVersion: 1,
      createdSeq: 2,
      createdAt: 1_785_830_400_000,
      updatedAt: 1_785_830_400_000,
      kind: 'user_text',
      payload: {
        role: 'user', messageId: 'scenario-queued-message', clientMutationId: 'scenario-queued-message',
        text: '继续完善排队消息的展示与编辑交互', streaming: false, queueStatus: 'queued',
        source: 'host', timestamp: 1_785_830_400_000,
      },
      lastEventId: 'scenario-queued-user',
      lastSeq: 2,
    })
    return {
      schemaVersion: 1,
      sessionId: SCENARIO_SESSION_ID,
      runtimeId: SCENARIO_RUNTIME_ID,
      lastSeq: 2,
      entities,
    }
  }, [queuedMessageWithdrawn, state.view])

  const projection = React.useMemo(() => ({
    sessions: needsSession ? [session] : [],
    ...(needsSession ? { loadedSessionId: session.id } : {}),
    ...(piProjection ? { piProjection } : {}),
  }), [needsSession, piProjection, session])

  React.useEffect(() => {
    const route = state.view === 'settings'
      ? routes.view.settings('app')
      : routes.view.allSessions(needsSession ? SCENARIO_SESSION_ID : undefined)
    navigate(route)
  }, [needsSession, state.view])

  const contextValue = React.useMemo(() => createPlaygroundAppShellContext({
    isCompactMode: false,
    getDraft: () => draft,
    onInputChange: (_sessionId, value) => setDraft(value),
    withdrawQueuedMessage: async () => setQueuedMessageWithdrawn(true),
    onCreateSession: async () => session,
    onDeleteSession: async () => false,
  }), [draft, session])

  return (
    <div className="flex h-full min-h-[560px] w-full flex-col bg-background text-foreground" data-testid="scenario.real-app-shell" data-scenario={state.activeScenario ?? 'none'}>
      <ScenarioSessionProjectionBoundary projection={projection} />
      {state.view === 'transport' && state.transport && (
        <React.Suspense fallback={null}>
          <ScenarioTransportConnectionBanner state={state.transport} onRetry={() => void appShellScenarioService.retryTransport()} />
        </React.Suspense>
      )}
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
                  onCreateAndSendFirstTurn={async () => ({
                    session,
                    messageId: 'scenario-first-turn',
                    publication: 'published',
                  })}
                  onDeleteSession={async () => false}
                  onInputChange={(_sessionId, value) => setDraft(value)}
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
