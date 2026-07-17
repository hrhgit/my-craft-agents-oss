import { describe, expect, it, mock } from 'bun:test'
import {
  createNativeViewDragOcclusionController,
  resolveNativeViewDockDragTarget,
} from '../native-view-drag-occlusion'

function dragElement(matches: Partial<Record<'tab' | 'interactive' | 'group', Element>>): Element {
  return {
    closest(selector: string) {
      if (selector === '[role="tab"]') return matches.tab ?? null
      if (selector.startsWith('button,')) return matches.interactive ?? null
      if (selector === '.flexlayout__tabset_tabbar_outer') return matches.group ?? null
      return null
    },
  } as unknown as Element
}

describe('native view dock-drag occlusion', () => {
  it('accepts resolved FlexLayout tabs and group headers but rejects dock-content drags', () => {
    const knownTab = { id: 'flexlayout-tabbutton-browser' } as HTMLElement
    const unknownTab = { id: 'flexlayout-tabbutton-unknown' } as HTMLElement
    const group = {} as HTMLElement
    const interactive = {} as HTMLElement

    expect(resolveNativeViewDockDragTarget(dragElement({ tab: knownTab }), ['browser']))
      .toEqual({ kind: 'tab', tabId: 'browser' })
    expect(resolveNativeViewDockDragTarget(dragElement({ tab: unknownTab }), ['browser']))
      .toBeNull()
    expect(resolveNativeViewDockDragTarget(dragElement({ group }), ['browser']))
      .toEqual({ kind: 'group' })
    expect(resolveNativeViewDockDragTarget(dragElement({ group, interactive }), ['browser']))
      .toBeNull()
    expect(resolveNativeViewDockDragTarget(dragElement({}), ['browser']))
      .toBeNull()
  })

  it('acquires synchronously and releases on drag completion', () => {
    const release = mock(() => {})
    const acquire = mock(() => release)
    const controller = createNativeViewDragOcclusionController(acquire)

    controller.begin()
    expect(acquire).toHaveBeenCalledTimes(1)
    expect(release).not.toHaveBeenCalled()

    controller.finish()
    controller.dispose()
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('releases a dragstart that a nested FlexLayout control cancels', () => {
    const release = mock(() => {})
    const scheduled: Array<() => void> = []
    const event = { defaultPrevented: false }
    const controller = createNativeViewDragOcclusionController(
      () => release,
      callback => scheduled.push(callback),
    )

    controller.begin(event)
    event.defaultPrevented = true
    scheduled[0]?.()

    expect(release).toHaveBeenCalledTimes(1)
  })

  it('does not let a stale canceled drag release a newer drag', () => {
    const releases = [mock(() => {}), mock(() => {})]
    const scheduled: Array<() => void> = []
    const firstEvent = { defaultPrevented: false }
    const secondEvent = { defaultPrevented: false }
    let acquireIndex = 0
    const controller = createNativeViewDragOcclusionController(
      () => releases[acquireIndex++]!,
      callback => scheduled.push(callback),
    )

    controller.begin(firstEvent)
    controller.begin(secondEvent)
    firstEvent.defaultPrevented = true
    scheduled[0]?.()

    expect(releases[0]).toHaveBeenCalledTimes(1)
    expect(releases[1]).not.toHaveBeenCalled()

    controller.finish()
    expect(releases[1]).toHaveBeenCalledTimes(1)
  })
})
