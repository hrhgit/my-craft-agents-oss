import * as React from 'react'
import { useDismissibleLayerOpenState } from './DismissibleLayerContext'
import { useModalOpenState } from './ModalContext'

export interface NativeViewOcclusionRegistry {
  acquire: () => () => void
  subscribe: (listener: () => void) => () => void
  isOccluded: () => boolean
}

export function createNativeViewOcclusionRegistry(): NativeViewOcclusionRegistry {
  const requests = new Set<symbol>()
  const listeners = new Set<() => void>()

  const notify = () => {
    for (const listener of listeners) listener()
  }

  return {
    acquire() {
      const request = Symbol('native-view-occlusion')
      const wasOccluded = requests.size > 0
      requests.add(request)
      if (!wasOccluded) notify()

      let released = false
      return () => {
        if (released) return
        released = true
        const wasOccluded = requests.size > 0
        requests.delete(request)
        if (wasOccluded && requests.size === 0) notify()
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    isOccluded() {
      return requests.size > 0
    },
  }
}

const transientOcclusionRegistry = createNativeViewOcclusionRegistry()

export function acquireNativeViewOcclusion(): () => void {
  return transientOcclusionRegistry.acquire()
}

export function subscribeNativeViewOcclusion(listener: () => void): () => void {
  return transientOcclusionRegistry.subscribe(listener)
}

export function isNativeViewOcclusionRequested(): boolean {
  return transientOcclusionRegistry.isOccluded()
}

export function useNativeViewOccluded(): boolean {
  const modalOpen = useModalOpenState()
  const dismissibleLayerOpen = useDismissibleLayerOpenState()
  const transientOcclusionRequested = React.useSyncExternalStore(
    transientOcclusionRegistry.subscribe,
    transientOcclusionRegistry.isOccluded,
    () => false,
  )
  return modalOpen || dismissibleLayerOpen || transientOcclusionRequested
}
