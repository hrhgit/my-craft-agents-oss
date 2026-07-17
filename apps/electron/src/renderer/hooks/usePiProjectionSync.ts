import { useEffect, useRef } from 'react'
import { useStore } from 'jotai'
import {
  applyPiProjectionEventAtom,
  applyPiProjectionSnapshotAtom,
  piProjectionAtomFamily,
} from '@/atoms/pi-projection'
import type { PiProjectionEventV1 } from '@craft-agent/shared/protocol'
import type { PiProjectionState } from '@/atoms/pi-projection'
import { useWorkspaceElectronApi } from '@/context/WorkspaceElectronApiContext'

export type PiProjectionEventApplied = (
  event: PiProjectionEventV1,
  previous: PiProjectionState,
  current: PiProjectionState,
) => void

/** Owns the projection transport independently from the legacy session reducer. */
export function usePiProjectionSync(
  activeSessionId: string | null,
  onEventApplied?: PiProjectionEventApplied,
): void {
  const store = useStore()
  const electronApi = useWorkspaceElectronApi()
  const recovering = useRef(new Map<string, Promise<void>>())
  const onEventAppliedRef = useRef(onEventApplied)
  onEventAppliedRef.current = onEventApplied

  useEffect(() => {
    const recover = (sessionId: string): Promise<void> => {
      const existing = recovering.current.get(sessionId)
      if (existing) return existing
      const request = electronApi.getPiProjectionSnapshot(sessionId)
        .then((snapshot) => {
          if (snapshot) store.set(applyPiProjectionSnapshotAtom, snapshot)
        })
        .catch((error) => {
          console.error(`[PiProjection] Snapshot recovery failed for ${sessionId}:`, error)
        })
        .finally(() => {
          recovering.current.delete(sessionId)
        })
      recovering.current.set(sessionId, request)
      return request
    }

    const cleanup = electronApi.onPiProjectionEvent((event) => {
      const sessionAtom = piProjectionAtomFamily(event.sessionId)
      const previous = store.get(sessionAtom)
      store.set(applyPiProjectionEventAtom, event)
      const current = store.get(sessionAtom)
      onEventAppliedRef.current?.(event, previous, current)
      if (current.syncState === 'desynced') {
        void recover(event.sessionId)
      }
    })
    return cleanup
  }, [store, electronApi])

  useEffect(() => {
    if (!activeSessionId) return
    let cancelled = false
    void electronApi.getPiProjectionSnapshot(activeSessionId)
      .then((snapshot) => {
        if (!cancelled && snapshot) store.set(applyPiProjectionSnapshotAtom, snapshot)
      })
      .catch((error) => {
        if (!cancelled) console.error(`[PiProjection] Initial snapshot failed for ${activeSessionId}:`, error)
      })
    return () => { cancelled = true }
  }, [activeSessionId, store, electronApi])

  useEffect(() => {
    if (!activeSessionId) return
    let cancelled = false
    const cleanup = electronApi.onReconnected((isStale) => {
      if (!isStale) return
      void electronApi.getPiProjectionSnapshot(activeSessionId)
        .then((snapshot) => {
          if (!cancelled && snapshot) store.set(applyPiProjectionSnapshotAtom, snapshot)
        })
        .catch((error) => {
          if (!cancelled) console.error(`[PiProjection] Reconnect recovery failed for ${activeSessionId}:`, error)
        })
    })
    return () => {
      cancelled = true
      cleanup()
    }
  }, [activeSessionId, store, electronApi])
}
