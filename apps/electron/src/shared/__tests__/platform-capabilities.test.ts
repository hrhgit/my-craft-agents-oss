import { describe, expect, it } from 'bun:test'
import { isPlatformCapabilitySnapshotV1 } from '@mortise/shared/protocol'
import {
  ELECTRON_PLATFORM_CAPABILITIES,
  publishElectronPlatformCapabilities,
} from '../platform-capabilities'

describe('Electron platform capability contract', () => {
  it('publishes the complete immutable Electron capability snapshot', () => {
    expect(ELECTRON_PLATFORM_CAPABILITIES.schemaVersion).toBe(1)
    expect(ELECTRON_PLATFORM_CAPABILITIES.platform).toBe('electron')
    expect(isPlatformCapabilitySnapshotV1(ELECTRON_PLATFORM_CAPABILITIES)).toBe(true)
    expect(Object.keys(ELECTRON_PLATFORM_CAPABILITIES.capabilities)).toEqual([
      'externalUrls',
      'browserWindows',
      'browserNotifications',
      'fileSystemShell',
      'nativeFileDialogs',
      'nativeWindowLifecycle',
      'autoUpdate',
      'nativeMenu',
      'appBadge',
      'gitBashConfiguration',
      'localSkillManagement',
      'powerSaveBlocker',
    ])
    expect(Object.values(ELECTRON_PLATFORM_CAPABILITIES.capabilities).every(
      descriptor => descriptor.status === 'supported',
    )).toBe(true)
    expect(Object.isFrozen(ELECTRON_PLATFORM_CAPABILITIES)).toBe(true)
    expect(Object.isFrozen(ELECTRON_PLATFORM_CAPABILITIES.capabilities)).toBe(true)
    expect(Object.values(ELECTRON_PLATFORM_CAPABILITIES.capabilities).every(Object.isFrozen)).toBe(true)
  })

  it('installs a non-writable preload API property', () => {
    const api = {}
    publishElectronPlatformCapabilities(api)

    expect((api as { platformCapabilities: unknown }).platformCapabilities).toBe(ELECTRON_PLATFORM_CAPABILITIES)
    expect(Object.getOwnPropertyDescriptor(api, 'platformCapabilities')).toMatchObject({
      enumerable: true,
      configurable: false,
      writable: false,
    })
    expect(() => {
      ;(api as { platformCapabilities: unknown }).platformCapabilities = null
    }).toThrow()
  })
})
