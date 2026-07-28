import {
  createPlatformCapabilitySnapshotV1,
  type PlatformCapabilityDescriptorV1,
  type PlatformCapabilitySnapshotV1,
} from '@mortise/shared/protocol'

const ELECTRON_CAPABILITY_DEFINITIONS = {
  externalUrls: { status: 'supported' },
  browserWindows: { status: 'supported' },
  browserNotifications: { status: 'supported' },
  fileSystemShell: { status: 'supported' },
  nativeFileDialogs: { status: 'supported' },
  nativeWindowLifecycle: { status: 'supported' },
  autoUpdate: { status: 'supported' },
  nativeMenu: { status: 'supported' },
  appBadge: { status: 'supported' },
  gitBashConfiguration: { status: 'supported' },
  localSkillManagement: { status: 'supported' },
  powerSaveBlocker: { status: 'supported' },
} satisfies Record<string, PlatformCapabilityDescriptorV1>

export const ELECTRON_PLATFORM_CAPABILITIES = createPlatformCapabilitySnapshotV1(
  'electron',
  ELECTRON_CAPABILITY_DEFINITIONS,
)

export type ElectronPlatformCapabilityName = keyof typeof ELECTRON_CAPABILITY_DEFINITIONS

export function publishElectronPlatformCapabilities(api: object): void {
  Object.defineProperty(api, 'platformCapabilities', {
    value: ELECTRON_PLATFORM_CAPABILITIES,
    enumerable: true,
    configurable: false,
    writable: false,
  })
}

export interface ElectronPlatformCapabilityBridge {
  readonly platformCapabilities: PlatformCapabilitySnapshotV1
}
