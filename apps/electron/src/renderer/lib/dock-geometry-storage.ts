import * as storage from './local-storage'

export interface DockGeometryStorageTarget {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface DockGeometryStorage<T> {
  readonly key: string
  readonly persistence: 'persistent' | 'window-session'
  read(fallback: T): T
  write(value: T): void
  remove(): void
}

export function createDockGeometryStorage<T>(
  scope: string,
  layoutWindowId: string,
  targets: {
    persistent?: DockGeometryStorageTarget
    windowSession?: DockGeometryStorageTarget
  } = {},
): DockGeometryStorage<T> {
  const persistence = layoutWindowId === 'primary' ? 'persistent' : 'window-session'
  const target = persistence === 'persistent'
    ? targets.persistent ?? localStorage
    : targets.windowSession ?? sessionStorage
  const key = storage.getKeyString(storage.KEYS.unifiedDockGeometry, scope)
  return {
    key,
    persistence,
    read(fallback) {
      try {
        const raw = target.getItem(key)
        return raw === null ? fallback : JSON.parse(raw) as T
      } catch {
        return fallback
      }
    },
    write(value) {
      try {
        target.setItem(key, JSON.stringify(value))
      } catch (error) {
        console.warn(`[dockGeometryStorage] Failed to set ${key}:`, error)
      }
    },
    remove() {
      target.removeItem(key)
    },
  }
}
