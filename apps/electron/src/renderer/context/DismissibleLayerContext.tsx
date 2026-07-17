import React, { createContext, useContext, useMemo } from 'react'
import {
  setDismissibleLayerBridge,
  type DismissibleLayerBridge,
  type DismissibleLayerRegistration,
} from '@/lib/dismissible-layer-bridge'

export interface DismissibleLayer extends Required<Pick<DismissibleLayerRegistration, 'id' | 'type' | 'priority' | 'close'>> {
  isOpen: boolean
  canBack?: () => boolean
  back?: () => boolean
  order: number
}

interface DismissibleLayerContextValue extends DismissibleLayerBridge {}

const DismissibleLayerContext = createContext<DismissibleLayerContextValue | null>(null)

export interface DismissibleLayerRegistry extends DismissibleLayerBridge {
  registerLayer: (layer: DismissibleLayerRegistration) => () => void
}

export function createDismissibleLayerRegistry(): DismissibleLayerRegistry {
  const layers = new Map<string, DismissibleLayer>()
  const listeners = new Set<() => void>()
  let orderSeed = 0

  const notify = () => {
    for (const listener of listeners) listener()
  }

  const getOrderedOpenLayers = (): DismissibleLayer[] => {
    const open = Array.from(layers.values()).filter((layer) => layer.isOpen)
    open.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority
      return b.order - a.order
    })
    return open
  }

  const registerLayer = (layer: DismissibleLayerRegistration) => {
    const order = ++orderSeed
    layers.set(layer.id, {
      id: layer.id,
      type: layer.type,
      priority: layer.priority ?? 0,
      isOpen: layer.isOpen ?? true,
      close: layer.close,
      canBack: layer.canBack,
      back: layer.back,
      order,
    })
    notify()

    return () => {
      layers.delete(layer.id)
      notify()
    }
  }

  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  const hasOpenLayers = () => getOrderedOpenLayers().length > 0

  const getTopLayer = () => {
    const top = getOrderedOpenLayers()[0]
    if (!top) return null

    return {
      id: top.id,
      type: top.type,
      priority: top.priority,
    }
  }

  const closeTop = () => {
    const top = getOrderedOpenLayers()[0]
    if (!top) return false
    top.close()
    return true
  }

  const handleEscape = () => {
    const top = getOrderedOpenLayers()[0]
    if (!top) return false

    if (top.canBack?.() && top.back) {
      const wentBack = top.back()
      if (wentBack) return true
    }

    top.close()
    return true
  }

  return {
    registerLayer,
    subscribe,
    hasOpenLayers,
    getTopLayer,
    closeTop,
    handleEscape,
  }
}

export function DismissibleLayerProvider({ children }: { children: React.ReactNode }) {
  const registry = useMemo(() => createDismissibleLayerRegistry(), [])

  React.useEffect(() => {
    setDismissibleLayerBridge(registry)
    return () => setDismissibleLayerBridge(null)
  }, [registry])

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (event.defaultPrevented) return

      const handled = registry.handleEscape()
      if (!handled) return

      event.preventDefault()
      event.stopPropagation()
    }

    // Bubble phase: let inputs/inner controls consume Escape first.
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [registry])

  return (
    <DismissibleLayerContext.Provider value={registry}>
      {children}
    </DismissibleLayerContext.Provider>
  )
}

export function useDismissibleLayerRegistry() {
  const context = useContext(DismissibleLayerContext)
  if (!context) {
    throw new Error('useDismissibleLayerRegistry must be used within a DismissibleLayerProvider')
  }
  return context
}

export function useRegisterDismissibleLayer(layer: DismissibleLayerRegistration | null) {
  const { registerLayer } = useDismissibleLayerRegistry()

  React.useEffect(() => {
    if (!layer) return
    const unregister = registerLayer(layer)
    return unregister
  }, [layer, registerLayer])
}

export function useDismissibleLayerOpenState(): boolean {
  const registry = useContext(DismissibleLayerContext)
  return React.useSyncExternalStore(
    registry?.subscribe ?? (() => () => {}),
    () => registry?.hasOpenLayers() ?? false,
    () => false,
  )
}

export function useDismissibleRootState(
  props: {
    open?: boolean
    defaultOpen?: boolean
    onOpenChange?: (open: boolean) => void
  },
  type: DismissibleLayerRegistration['type'],
  priority: number,
): { open: boolean; onOpenChange: (open: boolean) => void } {
  const registry = useContext(DismissibleLayerContext)
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(props.defaultOpen ?? false)
  const open = props.open ?? uncontrolledOpen
  const id = React.useId()
  const onOpenChange = React.useCallback((nextOpen: boolean) => {
    if (props.open === undefined) setUncontrolledOpen(nextOpen)
    props.onOpenChange?.(nextOpen)
  }, [props.onOpenChange, props.open])

  React.useLayoutEffect(() => {
    if (!registry || !open) return
    return registry.registerLayer({
      id: `primitive-${id}`,
      type,
      priority,
      close: () => onOpenChange(false),
    })
  }, [id, onOpenChange, open, priority, registry, type])

  return { open, onOpenChange }
}
