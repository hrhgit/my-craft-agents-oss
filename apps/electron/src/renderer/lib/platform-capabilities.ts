import type {
  PlatformCapabilitySnapshotV1,
  PlatformCapabilityStatusV1,
} from '@mortise/shared/protocol'

export function getPlatformCapabilityStatusFromSnapshot(
  snapshot: PlatformCapabilitySnapshotV1,
  capability: string,
): PlatformCapabilityStatusV1 {
  return snapshot.capabilities[capability]?.status ?? 'unavailable'
}

export function getPlatformCapabilityStatus(capability: string): PlatformCapabilityStatusV1 {
  return getPlatformCapabilityStatusFromSnapshot(window.electronAPI.platformCapabilities, capability)
}

export function hasPlatformCapability(capability: string): boolean {
  return getPlatformCapabilityStatus(capability) !== 'unavailable'
}

export function canOpenSeparateBrowserSurfaceFromSnapshot(
  snapshot: PlatformCapabilitySnapshotV1,
): boolean {
  return getPlatformCapabilityStatusFromSnapshot(snapshot, 'browserWindows') !== 'unavailable'
}

export function canUseNativeBrowserPanesFromSnapshot(
  snapshot: PlatformCapabilitySnapshotV1,
): boolean {
  return getPlatformCapabilityStatusFromSnapshot(snapshot, 'browserWindows') === 'supported'
    && getPlatformCapabilityStatusFromSnapshot(snapshot, 'nativeWindowLifecycle') === 'supported'
}

export function canUseAuxiliaryLayoutWindowsFromSnapshot(
  snapshot: PlatformCapabilitySnapshotV1,
): boolean {
  return getPlatformCapabilityStatusFromSnapshot(snapshot, 'nativeWindowLifecycle') === 'supported'
}

export function canOpenSeparateBrowserSurface(): boolean {
  return canOpenSeparateBrowserSurfaceFromSnapshot(window.electronAPI.platformCapabilities)
}

export function canUseNativeBrowserPanes(): boolean {
  return canUseNativeBrowserPanesFromSnapshot(window.electronAPI.platformCapabilities)
}

export function canUseAuxiliaryLayoutWindows(): boolean {
  return canUseAuxiliaryLayoutWindowsFromSnapshot(window.electronAPI.platformCapabilities)
}

export function isNativeBrowserWorkbenchToolId(toolId: string | undefined): boolean {
  return toolId === 'browser' || Boolean(toolId?.startsWith('browser-instance:'))
}
