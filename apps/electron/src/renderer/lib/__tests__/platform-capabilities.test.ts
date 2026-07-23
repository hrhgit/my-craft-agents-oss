import { describe, expect, it } from 'bun:test'
import { createPlatformCapabilitySnapshotV1 } from '@mortise/shared/protocol'
import {
  canOpenSeparateBrowserSurfaceFromSnapshot,
  canUseAuxiliaryLayoutWindowsFromSnapshot,
  canUseNativeBrowserPanesFromSnapshot,
  isNativeBrowserWorkbenchToolId,
} from '../platform-capabilities'

const electron = createPlatformCapabilitySnapshotV1('electron', {
  browserWindows: { status: 'supported' },
  nativeWindowLifecycle: { status: 'supported' },
})

const web = createPlatformCapabilitySnapshotV1('web', {
  browserWindows: { status: 'degraded', reason: 'New tabs replace native windows.' },
  nativeWindowLifecycle: { status: 'unavailable' },
})

describe('renderer platform feature policy', () => {
  it('keeps native browser panes and auxiliary layout windows on Electron', () => {
    expect(canOpenSeparateBrowserSurfaceFromSnapshot(electron)).toBe(true)
    expect(canUseNativeBrowserPanesFromSnapshot(electron)).toBe(true)
    expect(canUseAuxiliaryLayoutWindowsFromSnapshot(electron)).toBe(true)
  })

  it('degrades separate windows to browser tabs without exposing native operations on WebUI', () => {
    expect(canOpenSeparateBrowserSurfaceFromSnapshot(web)).toBe(true)
    expect(canUseNativeBrowserPanesFromSnapshot(web)).toBe(false)
    expect(canUseAuxiliaryLayoutWindowsFromSnapshot(web)).toBe(false)
  })

  it('identifies native browser launcher and instance tools for platform filtering', () => {
    expect(isNativeBrowserWorkbenchToolId('browser')).toBe(true)
    expect(isNativeBrowserWorkbenchToolId('browser-instance:abc')).toBe(true)
    expect(isNativeBrowserWorkbenchToolId('files')).toBe(false)
    expect(isNativeBrowserWorkbenchToolId('extension:example')).toBe(false)
  })
})
