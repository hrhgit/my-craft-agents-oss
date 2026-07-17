import { useEffect } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { useModalRegistry } from '@/context/ModalContext'
import { useDismissibleLayerRegistry } from '@/context/DismissibleLayerContext'
import {
  activeDockTabIdAtom,
  activeDockTabProtectionAtom,
  closePanelAtom,
  focusedPanelIdAtom,
  panelStackAtom,
  requestDockTabCloseAtom,
} from '@/atoms/panel-stack'
import type { WindowCloseRequest } from '../../shared/types'
import { flushWindowCloseState } from '@/lib/window-close-flush'
import { resolveKeyboardCloseTarget } from '@/lib/window-close-target'

/**
 * Hook to handle window close requests with source-aware behavior.
 *
 * - `window-button` closes the window directly.
 * - `keyboard-shortcut` (Cmd/Ctrl+W) uses layered dismissal:
 *   1. Close top modal
 *   2. Else close the active unprotected dock tab
 *   3. Else close the focused legacy panel
 *   4. Else close window
 * - `unknown` follows layered dismissal as a safe fallback.
 *
 * The main process starts a fallback timeout on each close request.
 * cancelCloseWindow() clears it (window stays open).
 * confirmCloseWindow() clears it and destroys the window.
 *
 * This hook should be called once at the app root level.
 */
export function useWindowCloseHandler() {
  const { hasOpenLayers, closeTop } = useDismissibleLayerRegistry()
  const { hasOpenModals, closeTopModal } = useModalRegistry()
  const panelStack = useAtomValue(panelStackAtom)
  const focusedPanelId = useAtomValue(focusedPanelIdAtom)
  const activeDockTabId = useAtomValue(activeDockTabIdAtom)
  const activeDockTabProtection = useAtomValue(activeDockTabProtectionAtom)
  const closePanel = useSetAtom(closePanelAtom)
  const requestDockTabClose = useSetAtom(requestDockTabCloseAtom)

  useEffect(() => {
    const confirmAfterFlush = () => {
      void flushWindowCloseState()
        .then(() => window.electronAPI.confirmCloseWindow())
        .catch(error => {
          console.error('[WindowClose] State flush failed; close cancelled:', error)
          window.electronAPI.cancelCloseWindow()
        })
    }
    const cleanup = window.electronAPI.onCloseRequested((request: WindowCloseRequest) => {
      if (request.source === 'window-button') {
        confirmAfterFlush()
        return
      }

      if (hasOpenLayers()) {
        closeTop()
        window.electronAPI.cancelCloseWindow()
        return
      }

      // Backward-compatible fallback for legacy modals not yet migrated.
      if (hasOpenModals()) {
        closeTopModal()
        window.electronAPI.cancelCloseWindow()
        return
      }

      const target = resolveKeyboardCloseTarget({
        activeDockTabId,
        activeDockTabProtection,
        focusedPanelId,
        panelStack,
      })
      switch (target.kind) {
        case 'blocked-dock-tab':
          window.electronAPI.cancelCloseWindow()
          return
        case 'dock-tab':
          requestDockTabClose(target.tabId)
          window.electronAPI.cancelCloseWindow()
          return
        case 'panel':
          closePanel(target.panelId)
          window.electronAPI.cancelCloseWindow()
          return
        case 'window':
          confirmAfterFlush()
      }
    })

    return cleanup
  }, [
    activeDockTabId,
    activeDockTabProtection,
    closePanel,
    closeTop,
    closeTopModal,
    focusedPanelId,
    hasOpenLayers,
    hasOpenModals,
    panelStack,
    requestDockTabClose,
  ])
}
