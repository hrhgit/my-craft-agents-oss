/**
 * Web UI App — thin wrapper that:
 * 1. Fetches WS config from the server
 * 2. Creates the web API adapter + sets window.electronAPI
 * 3. Delegates to the Electron renderer's App component
 *
 * Mobile responsiveness is handled by container queries and isAutoCompact
 * in the shared renderer components — no webui-specific layout hacks needed.
 */

import React, { useState, useEffect, useRef, lazy, Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import { createWebApi } from './adapter/web-api'
import type { WsRpcClient } from '@mortise/server-core/transport/client'
import { errorMessage } from '@mortise/shared/utils/text'
import { waitForInitialConnection } from './connection'
import { resolveInitialWebUiSearch } from './initial-navigation'

if (__MORTISE_UI_VALIDATION_BUILD__) {
  Object.defineProperty(window, '__MORTISE_EXTENSION_UI_VALIDATION__', {
    value: Object.freeze({ schemaVersion: 1, available: true }),
    configurable: false,
    enumerable: false,
  })
}

// Lazy-load the Electron App after window.electronAPI is set up.
// This prevents any Electron component from accessing window.electronAPI
// before the web adapter is ready.
const ElectronApp = lazy(() => import('@/App'))
const ScenarioAppShellHost = __MORTISE_UI_VALIDATION_BUILD__
  ? lazy(() => import('@/ui-validation/app-shell-scenario-service').then(module => ({ default: module.ScenarioAppShellHost })))
  : null

type Phase = 'loading' | 'error' | 'ready'

function LoadingScreen() {
  const { t } = useTranslation()

  return (
    <div className="flex flex-col items-center justify-center h-screen font-sans text-foreground/50 gap-3">
      <div className="animate-spin w-6 h-6 border-2 border-current border-t-transparent rounded-full" />
      <p className="text-[13px]">{t("webui.connectingToServer")}</p>
    </div>
  )
}

function ErrorScreen({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useTranslation()

  return (
    <div className="flex flex-col items-center justify-center h-screen font-sans text-foreground/50 gap-3">
      <p className="text-base font-medium text-destructive">{t("webui.connectionFailed")}</p>
      <p className="text-[13px] max-w-md text-center">{message}</p>
      <div className="flex gap-2 mt-2">
        <button
          onClick={onRetry}
          className="px-4 py-1.5 rounded-md bg-background shadow-minimal text-[13px] text-foreground/70 cursor-pointer"
        >
          {t("common.retry")}
        </button>
        <button
          onClick={() => {
            fetch('/api/auth/logout', { method: 'POST' }).then(() => {
              window.location.href = '/login'
            })
          }}
          className="px-4 py-1.5 rounded-md bg-background shadow-minimal text-[13px] text-foreground/70 cursor-pointer"
        >
          {t("webui.logOut")}
        </button>
      </div>
    </div>
  )
}

export default function App() {
  const [phase, setPhase] = useState<Phase>('loading')
  const [error, setError] = useState('')
  const clientRef = useRef<WsRpcClient | null>(null)
  const initRef = useRef(false)

  const initialize = async () => {
    setPhase('loading')
    setError('')

    try {
      // 1. Fetch WS URL from the server (cookie auth)
      const configRes = await fetch('/api/config', { credentials: 'same-origin' })
      if (!configRes.ok) {
        if (configRes.status === 401) {
          // Session expired — redirect to login
          window.location.href = '/login'
          return
        }
        throw new Error(`Failed to fetch config: ${configRes.status}`)
      }

      const { wsUrl } = await configRes.json() as { wsUrl: string }
      if (!wsUrl) throw new Error('Server did not return a WebSocket URL')

      // 2. Determine workspace — check URL params first
      const initialSearch = resolveInitialWebUiSearch(window.location.search)
      if (initialSearch !== window.location.search) {
        const url = new URL(window.location.href)
        url.search = initialSearch
        history.replaceState(history.state, '', url)
      }
      const params = new URLSearchParams(initialSearch)
      let workspaceId = params.get('workspace') ?? undefined

      // If no workspace in URL, fetch the default from the server
      // so we can include it in the WebSocket handshake
      if (!workspaceId) {
        try {
          const wsRes = await fetch('/api/config/workspaces', { credentials: 'same-origin' })
          if (wsRes.ok) {
            const { defaultWorkspaceId } = await wsRes.json() as { defaultWorkspaceId?: string }
            if (defaultWorkspaceId) workspaceId = defaultWorkspaceId
          }
        } catch {
          // Non-fatal — workspace will be set via switchWorkspace later
        }
      }

      // 3. Create web API adapter
      // Destroy previous client on retry
      if (clientRef.current) {
        clientRef.current.destroy()
      }

      const { api, client } = createWebApi({ serverUrl: wsUrl, workspaceId })
      clientRef.current = client

      // 4. Set window.electronAPI — must happen before any Electron component mounts
      ;(window as any).electronAPI = api
      if (__MORTISE_UI_VALIDATION_BUILD__) {
        const validationHost = window.__mortiseUiValidation as typeof window.__mortiseUiValidation & {
          publishState?: (batch: import('@/../shared/ui-validation-state-bridge').UiValidationRendererStateBatch) => void
          dispose?: () => void
        }
        if (validationHost?.publishState) {
          api.uiValidation = {
            publishState: batch => validationHost.publishState?.(batch),
            dispose: () => validationHost.dispose?.(),
          }
        }
        const semanticBridge = await import('@/ui-validation/bridge')
        semanticBridge.installUiSemanticBridge()
        if (new URLSearchParams(window.location.search).get('__mortiseUiScenarioHost') === '1') {
          const scenarioBridge = await import('@/ui-validation/app-shell-scenario-service')
          scenarioBridge.installAppShellScenarioBridge()
        }
      }

      // 5. Connect the WebSocket client
      client.connect()
      await waitForInitialConnection(client)

      setPhase('ready')
    } catch (err) {
      const msg = errorMessage(err)
      setError(msg)
      setPhase('error')
    }
  }

  useEffect(() => {
    if (!initRef.current) {
      initRef.current = true
      initialize()
    }

    return () => {
      // Cleanup on unmount
      clientRef.current?.destroy()
    }
  }, [])

  if (phase === 'loading') return <LoadingScreen />
  if (phase === 'error') return <ErrorScreen message={error} onRetry={initialize} />

  const validationScenarioHost = __MORTISE_UI_VALIDATION_BUILD__
    && new URLSearchParams(window.location.search).get('__mortiseUiScenarioHost') === '1'

  return (
    <Suspense fallback={<LoadingScreen />}>
      {validationScenarioHost && ScenarioAppShellHost ? <ScenarioAppShellHost /> : <ElectronApp />}
    </Suspense>
  )
}
