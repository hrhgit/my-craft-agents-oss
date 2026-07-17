import { describe, expect, it, mock } from 'bun:test'
import { createDismissibleLayerRegistry } from '../DismissibleLayerContext'

describe('createDismissibleLayerRegistry', () => {
  it('notifies subscribers when the open-layer boundary changes', () => {
    const registry = createDismissibleLayerRegistry()
    const snapshots: boolean[] = []
    const unsubscribe = registry.subscribe?.(() => snapshots.push(registry.hasOpenLayers()))

    const unregister = registry.registerLayer({ id: 'popover', type: 'radix-popover', close: () => {} })
    unregister()
    unsubscribe?.()

    expect(snapshots).toEqual([true, false])
  })

  it('closes highest-priority open layer first', () => {
    const registry = createDismissibleLayerRegistry()
    const closeLow = mock(() => {})
    const closeHigh = mock(() => {})

    registry.registerLayer({ id: 'low', type: 'modal', priority: 1, close: closeLow })
    registry.registerLayer({ id: 'high', type: 'island', priority: 10, close: closeHigh })

    const handled = registry.closeTop()
    expect(handled).toBe(true)
    expect(closeHigh).toHaveBeenCalledTimes(1)
    expect(closeLow).not.toHaveBeenCalled()
  })

  it('uses back action before close when top layer can go back', () => {
    const registry = createDismissibleLayerRegistry()
    const back = mock(() => true)
    const close = mock(() => {})

    registry.registerLayer({
      id: 'island',
      type: 'island',
      priority: 5,
      close,
      canBack: () => true,
      back,
    })

    const handled = registry.handleEscape()
    expect(handled).toBe(true)
    expect(back).toHaveBeenCalledTimes(1)
    expect(close).not.toHaveBeenCalled()
  })

  it('falls back to close when back returns false', () => {
    const registry = createDismissibleLayerRegistry()
    const back = mock(() => false)
    const close = mock(() => {})

    registry.registerLayer({
      id: 'island',
      type: 'island',
      priority: 5,
      close,
      canBack: () => true,
      back,
    })

    const handled = registry.handleEscape()
    expect(handled).toBe(true)
    expect(back).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
  })
})
