import { describe, expect, it } from 'bun:test'
import {
  createDockGeometryStorage,
  type DockGeometryStorageTarget,
} from '../dock-geometry-storage'

function memoryStorage(): DockGeometryStorageTarget & { size(): number } {
  const values = new Map<string, string>()
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: key => { values.delete(key) },
    size: () => values.size,
  }
}

describe('dock geometry storage ownership', () => {
  it('keeps primary geometry persistent and reloadable', () => {
    const persistent = memoryStorage()
    const windowSession = memoryStorage()
    const first = createDockGeometryStorage<{ revision: number }>(
      'workspace-a:primary',
      'primary',
      { persistent, windowSession },
    )
    first.write({ revision: 7 })

    const reload = createDockGeometryStorage<{ revision: number }>(
      'workspace-a:primary',
      'primary',
      { persistent, windowSession: memoryStorage() },
    )
    expect(reload.persistence).toBe('persistent')
    expect(reload.read({ revision: 0 })).toEqual({ revision: 7 })
  })

  it('does not grow persistent storage with random auxiliary window ids', () => {
    const persistent = memoryStorage()
    createDockGeometryStorage('workspace-a:primary', 'primary', {
      persistent,
      windowSession: memoryStorage(),
    }).write({ owner: 'primary' })

    for (let index = 0; index < 200; index += 1) {
      const windowSession = memoryStorage()
      const auxiliary = createDockGeometryStorage(
        `workspace-a:aux:${index}`,
        `aux:${index}`,
        { persistent, windowSession },
      )
      auxiliary.write({ owner: `aux:${index}` })
      const reload = createDockGeometryStorage(
        `workspace-a:aux:${index}`,
        `aux:${index}`,
        { persistent, windowSession },
      )
      expect(reload.read(null)).toEqual({ owner: `aux:${index}` })
      expect(windowSession.size()).toBe(1)
    }

    expect(persistent.size()).toBe(1)
  })
})
