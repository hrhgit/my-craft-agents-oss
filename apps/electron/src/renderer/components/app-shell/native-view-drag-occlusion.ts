import { acquireNativeViewOcclusion } from '@/context/NativeViewOcclusionContext'
import { resolveFlexLayoutTabId } from './unified-dock-model'

type DragStartEvent = Pick<Event, 'defaultPrevented'>
type ScheduleMicrotask = (callback: () => void) => void

export interface NativeViewDragOcclusionController {
  begin: (event?: DragStartEvent) => void
  finish: () => void
  dispose: () => void
}

export type NativeViewDockDragTarget =
  | { kind: 'tab'; tabId: string }
  | { kind: 'group' }

export function resolveNativeViewDockDragTarget(
  target: Element,
  tabIds: string[],
): NativeViewDockDragTarget | null {
  const tab = target.closest<HTMLElement>('[role="tab"]')
  if (tab) {
    const tabId = resolveFlexLayoutTabId(tab.id, tabIds)
    return tabId ? { kind: 'tab', tabId } : null
  }

  if (target.closest('button, input, textarea, select, [contenteditable="true"]')) return null
  return target.closest('.flexlayout__tabset_tabbar_outer') ? { kind: 'group' } : null
}

export function createNativeViewDragOcclusionController(
  acquire: () => () => void = acquireNativeViewOcclusion,
  scheduleMicrotask: ScheduleMicrotask = queueMicrotask,
): NativeViewDragOcclusionController {
  let release: (() => void) | null = null
  let epoch = 0

  const finish = () => {
    epoch += 1
    const currentRelease = release
    release = null
    currentRelease?.()
  }

  const begin = (event?: DragStartEvent) => {
    finish()
    if (event?.defaultPrevented) return

    release = acquire()
    const startEpoch = epoch

    if (event) {
      scheduleMicrotask(() => {
        if (event.defaultPrevented && epoch === startEpoch) finish()
      })
    }
  }

  return {
    begin,
    finish,
    dispose: finish,
  }
}
