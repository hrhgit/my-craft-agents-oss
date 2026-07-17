import { describe, expect, it, mock } from 'bun:test'
import { createNativeViewOcclusionRegistry } from '../NativeViewOcclusionContext'

describe('createNativeViewOcclusionRegistry', () => {
  it('holds the occlusion boundary until every request is released', () => {
    const registry = createNativeViewOcclusionRegistry()
    const snapshots: boolean[] = []
    registry.subscribe(() => snapshots.push(registry.isOccluded()))

    const releaseFirst = registry.acquire()
    const releaseSecond = registry.acquire()
    expect(registry.isOccluded()).toBe(true)

    releaseFirst()
    expect(registry.isOccluded()).toBe(true)
    releaseSecond()
    expect(registry.isOccluded()).toBe(false)

    expect(snapshots).toEqual([true, false])
  })

  it('makes release idempotent', () => {
    const registry = createNativeViewOcclusionRegistry()
    const listener = mock(() => {})
    registry.subscribe(listener)

    const release = registry.acquire()
    release()
    release()

    expect(listener).toHaveBeenCalledTimes(2)
    expect(registry.isOccluded()).toBe(false)
  })
})
