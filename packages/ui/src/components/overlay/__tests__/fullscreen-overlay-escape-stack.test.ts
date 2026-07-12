import { afterEach, describe, expect, it, mock } from 'bun:test'
import {
  handleFullscreenEscapeWithStack,
  shouldDismissFullscreenOverlayFromTarget,
} from '../FullscreenOverlayBase'
import { setDismissibleLayerBridge } from '../../../lib/dismissible-layer-bridge'

afterEach(() => {
  setDismissibleLayerBridge(null)
})

describe('handleFullscreenEscapeWithStack', () => {
  it('returns false when no stack bridge is registered', () => {
    expect(handleFullscreenEscapeWithStack()).toBe(false)
  })

  it('delegates escape handling to the shared dismissible layer stack', () => {
    const handleEscape = mock(() => true)

    setDismissibleLayerBridge({
      registerLayer: () => () => {},
      hasOpenLayers: () => true,
      getTopLayer: () => ({ id: 'island-1', type: 'island', priority: 200 }),
      closeTop: () => true,
      handleEscape,
    })

    const handled = handleFullscreenEscapeWithStack()
    expect(handled).toBe(true)
    expect(handleEscape).toHaveBeenCalledTimes(1)
  })
})

describe('shouldDismissFullscreenOverlayFromTarget', () => {
  it('dismisses clicks that are not inside a marked content boundary', () => {
    expect(shouldDismissFullscreenOverlayFromTarget({ closest: () => null } as unknown as EventTarget)).toBe(true)
  })

  it('keeps the overlay open for clicks inside a marked content boundary', () => {
    expect(shouldDismissFullscreenOverlayFromTarget({ closest: () => ({}) } as unknown as EventTarget)).toBe(false)
  })
})
