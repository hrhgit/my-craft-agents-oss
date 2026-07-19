import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { useAtomValue } from 'jotai'
import type { UiValidationAppPhase, UiValidationScopedStateUpdate } from '@mortise/shared/ui-validation'
import type { TransportConnectionState } from '../../shared/types'
import { focusedPanelRouteAtom, focusedSessionIdAtom } from '@/atoms/panel-stack'
import { sessionMetaMapAtom } from '@/atoms/sessions'
import { extensionUIValidationEntityId } from '@mortise/shared/protocol'
import { extensionValidationStore } from '@/components/extensions/extension-validation-store'
import { extensionValidationReadiness } from '@/components/extensions/extension-validation-test-bridge'
import type { RegisteredExtensionValidation } from '@/components/extensions/extension-validation-store'

export interface UiValidationRendererStateInput {
  appState: 'loading' | 'onboarding' | 'reauth' | 'workspace-picker' | 'ready'
  sessionsLoaded: boolean
  sessionLoadError: string | null
  splashHidden: boolean
  workspaceId: string | null
  workspaceTransitioning: boolean
  transport: TransportConnectionState | null
}

export function useUiValidationStateBridge(input: UiValidationRendererStateInput): void {
  const route = useAtomValue(focusedPanelRouteAtom)
  const focusedSessionId = useAtomValue(focusedSessionIdAtom)
  const sessionMetaMap = useAtomValue(sessionMetaMapAtom)
  const extensionVersion = useSyncExternalStore(extensionValidationStore.subscribe, extensionValidationStore.getVersion, extensionValidationStore.getVersion)
  const states = useMemo(() => [...deriveRendererValidationStates(input, {
    route,
    focusedSessionId,
    sessions: [...sessionMetaMap.values()].map(session => ({
      id: session.id,
      workspaceId: session.workspaceId,
      isProcessing: session.isProcessing === true,
      hasUnread: session.hasUnread === true,
    })),
  }), ...extensionValidationStore.listAll().map(extensionValidationScopedState)], [input.appState, input.sessionsLoaded, input.sessionLoadError, input.splashHidden, input.workspaceId, input.workspaceTransitioning, input.transport, route, focusedSessionId, sessionMetaMap, extensionVersion])

  useEffect(() => {
    const bridge = window.electronAPI.uiValidation
    if (!bridge) return
    bridge.publishState({ version: 1, states })
  }, [states])

  useEffect(() => {
    const bridge = window.electronAPI.uiValidation
    if (!bridge) return
    return () => bridge.dispose()
  }, [])
}

export function extensionValidationScopedState(item: RegisteredExtensionValidation): UiValidationScopedStateUpdate {
  const readiness = extensionValidationReadiness(item.definition)
  return {
    scope: 'extension',
    entityId: extensionUIValidationEntityId(item.sessionId, item.extensionId, item.runtimeId, item.definition.id),
    phase: readiness.phase,
    detail: {
      extensionId: item.extensionId,
      commandOwnerExtensionId: item.commandOwnerExtensionId,
      sessionId: item.sessionId,
      runtimeId: item.runtimeId,
      definitionId: item.definition.id,
      definitionRevision: item.revision,
      contributionId: item.definition.contributionId,
      waitingFor: readiness.waitingFor,
    },
    ...(readiness.errors.length > 0 ? { error: { code: 'EXTENSION_NOT_READY', message: readiness.errors.join('; ') } } : {}),
  }
}

interface RendererStateSources {
  route: string | null
  focusedSessionId: string | null
  sessions: Array<{ id: string; workspaceId: string; isProcessing: boolean; hasUnread: boolean }>
}

export function deriveRendererValidationStates(
  input: UiValidationRendererStateInput,
  sources: RendererStateSources,
): UiValidationScopedStateUpdate[] {
  const appPhase: UiValidationAppPhase = input.sessionLoadError
    ? 'error'
    : input.appState !== 'ready'
      ? input.appState === 'loading' ? 'loading' : 'ready'
      : input.sessionsLoaded && input.splashHidden ? 'ready' : 'loading'
  const transportPhase = transportStatePhase(input.transport)
  const effectiveRoute = input.appState === 'workspace-picker' ? 'workspace-picker' : sources.route
  const sessions = sources.sessions.filter(session => !input.workspaceId || session.workspaceId === input.workspaceId)
  const processingCount = sessions.filter(session => session.isProcessing).length
  const states: UiValidationScopedStateUpdate[] = [
    {
      scope: 'app',
      phase: appPhase,
      detail: { appState: input.appState, hydrated: input.appState === 'ready' && input.sessionsLoaded, splashHidden: input.splashHidden },
      ...(input.sessionLoadError ? { error: { code: 'SESSION_LOAD_FAILED', message: input.sessionLoadError } } : {}),
    },
    {
      scope: 'transport',
      phase: transportPhase,
      detail: input.transport ? {
        mode: input.transport.mode,
        status: input.transport.status,
        attempt: input.transport.attempt,
        nextRetryInMs: input.transport.nextRetryInMs,
      } : { status: 'initializing' },
      ...(input.transport?.lastError ? { error: { code: input.transport.lastError.code, message: input.transport.lastError.message } } : {}),
    },
    {
      scope: 'workspace',
      phase: input.workspaceTransitioning ? 'busy' : input.workspaceId ? (appPhase === 'error' ? 'error' : appPhase) : input.appState === 'workspace-picker' ? 'ready' : 'loading',
      ...(input.workspaceId ? { entityId: input.workspaceId } : {}),
      detail: { selected: Boolean(input.workspaceId), transitioning: input.workspaceTransitioning },
    },
    {
      scope: 'sessions',
      phase: input.sessionLoadError ? 'error' : !input.sessionsLoaded ? 'loading' : processingCount > 0 ? 'busy' : 'ready',
      detail: { count: sessions.length, processingCount },
      ...(input.sessionLoadError ? { error: { code: 'SESSION_LOAD_FAILED', message: input.sessionLoadError } } : {}),
    },
    {
      scope: 'route',
      phase: appPhase !== 'ready' || !effectiveRoute ? 'loading' : 'ready',
      detail: { route: effectiveRoute, ...routeDetail(effectiveRoute) },
    },
    ...sessions.map<UiValidationScopedStateUpdate>(session => ({
      scope: 'session',
      entityId: session.id,
      phase: session.isProcessing ? 'busy' : 'ready',
      detail: {
        workspaceId: session.workspaceId,
        focused: session.id === sources.focusedSessionId,
        processing: session.isProcessing,
        unread: session.hasUnread,
      },
    })),
  ]
  return states
}

function transportStatePhase(state: TransportConnectionState | null): UiValidationAppPhase {
  switch (state?.status) {
    case 'connected': return 'ready'
    case 'connecting':
    case 'reconnecting': return 'busy'
    case 'failed':
    case 'disconnected': return 'error'
    case 'idle': return state.mode === 'local' ? 'ready' : 'loading'
    default: return 'loading'
  }
}

function routeDetail(route: string | null): Record<string, unknown> {
  if (!route) return { surface: 'unknown' }
  const segments = route.split('/')
  const sessionIndex = segments.indexOf('session')
  const surface = route.startsWith('settings') ? 'settings'
    : route.startsWith('sources') ? 'sources'
      : route.startsWith('skills') ? 'skills'
        : route.startsWith('automations') ? 'automations'
          : route.startsWith('allSessions') ? 'chat'
            : route === 'workspace-picker' ? 'workspace-picker'
            : 'unknown'
  return {
    surface,
    ...(sessionIndex >= 0 && segments[sessionIndex + 1] ? { sessionId: segments[sessionIndex + 1] } : {}),
    ...(surface === 'settings' && segments[1] ? { section: segments[1] } : {}),
  }
}
