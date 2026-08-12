// IMPORTANT: keep `mock-utils` as the FIRST local import. It installs the
// mock `window.electronAPI` as a top-level side effect on import, so that
// any renderer module that reads `window.electronAPI.*` at module-load time
// (e.g. `SessionFilesSection.tsx`'s top-level `getRuntimeEnvironment()`
// call) finds the mock in place before its own module is evaluated.
import './playground/mock-utils'

import React from 'react'
import ReactDOM from 'react-dom/client'
import { Provider as JotaiProvider } from 'jotai'
import { setupI18n } from '@mortise/shared/i18n'
import { initReactI18next } from 'react-i18next'
import { ThemeProvider } from './context/ThemeContext'
import { PlaygroundApp } from './playground/PlaygroundApp'
import { EscapeInterruptProvider } from './context/EscapeInterruptContext'
import { PlaygroundAppShellProvider } from './playground/PlaygroundAppShellProvider'
import { installPlaygroundCloseHandler } from './ui-validation/playground-close-handler'
import { playgroundReadyStates } from './ui-validation/playground-ready-state'
import './index.css'

const PlaygroundToaster = React.lazy(async () => {
  const { Toaster } = await import('./components/ui/sonner')
  return { default: Toaster }
})

if (__MORTISE_UI_VALIDATION_BUILD__) {
  void Promise.all([
    import('./ui-validation/app-shell-scenario-service'),
    import('./ui-validation/bridge'),
  ]).then(([scenarioBridge, semanticBridge]) => {
    const disposeScenarioBridge = scenarioBridge.installAppShellScenarioBridge()
    semanticBridge.installUiSemanticBridge()
    const stateBridge = window.electronAPI.uiValidation
    if (stateBridge) {
      stateBridge.publishState({ version: 1, states: playgroundReadyStates() })
    }
    const cleanup = installPlaygroundCloseHandler(window.electronAPI, () => {
      disposeScenarioBridge?.()
      stateBridge?.dispose()
    })
    window.addEventListener('beforeunload', cleanup, { once: true })
  })
}

// Initialize i18n before any React rendering. `useTranslation()` reads from
// the shared global instance, so we don't need an <I18nextProvider>.
setupI18n([initReactI18next])

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <JotaiProvider>
      <ThemeProvider>
        <EscapeInterruptProvider>
          <PlaygroundAppShellProvider>
            <PlaygroundApp />
            <React.Suspense fallback={null}>
              <PlaygroundToaster />
            </React.Suspense>
          </PlaygroundAppShellProvider>
        </EscapeInterruptProvider>
      </ThemeProvider>
    </JotaiProvider>
  </React.StrictMode>
)
