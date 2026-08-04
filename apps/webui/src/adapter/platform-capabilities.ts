import {
  createCapabilityUnavailableErrorDataV1,
  createPlatformCapabilitySnapshotV1,
  type CapabilityUnavailableErrorDataV1,
  type PlatformCapabilityDescriptorV1,
} from '@mortise/shared/protocol'
import type { ElectronAPI } from '../../../electron/src/shared/types'

const WEBUI_CAPABILITY_DEFINITIONS = {
  externalUrls: { status: 'supported' },
  browserWindows: { status: 'degraded', reason: 'New tabs replace independent native windows.' },
  browserNotifications: { status: 'degraded', reason: 'Requires browser notification permission.' },
  fileSystemShell: { status: 'unavailable', reason: 'Browsers cannot open or reveal server filesystem paths.' },
  nativeFileDialogs: { status: 'unavailable', reason: 'Browser pickers cannot return server filesystem paths.' },
  nativeWindowLifecycle: { status: 'unavailable', reason: 'The browser owns tab and window lifecycle.' },
  autoUpdate: { status: 'unavailable', reason: 'WebUI is updated by its server deployment.' },
  nativeMenu: { status: 'unavailable', reason: 'WebUI has no application menu process.' },
  appBadge: { status: 'unavailable', reason: 'Native dock and taskbar badges are desktop-only.' },
  gitBashConfiguration: { status: 'unavailable', reason: 'Git Bash configuration belongs to the desktop host.' },
  localSkillManagement: { status: 'unavailable', reason: 'Local skill discovery and shell actions require the desktop host.' },
  powerSaveBlocker: { status: 'unavailable', reason: 'A web page cannot control system sleep policy.' },
} satisfies Record<string, PlatformCapabilityDescriptorV1>

export const WEBUI_PLATFORM_CAPABILITIES = createPlatformCapabilitySnapshotV1(
  'web',
  WEBUI_CAPABILITY_DEFINITIONS,
)

export type WebPlatformCapabilityName = keyof typeof WEBUI_CAPABILITY_DEFINITIONS

export const WEBUI_UNSUPPORTED_OPERATION_CAPABILITIES = Object.freeze({
  openFile: 'fileSystemShell',
  showInFolder: 'fileSystemShell',
  openWorkspaceFolder: 'fileSystemShell',
  openFileDialog: 'nativeFileDialogs',
  openFolderDialog: 'nativeFileDialogs',
  setTrafficLightsVisible: 'nativeWindowLifecycle',
  closeWindow: 'nativeWindowLifecycle',
  confirmCloseWindow: 'nativeWindowLifecycle',
  cancelCloseWindow: 'nativeWindowLifecycle',
  openWorkspace: 'nativeWindowLifecycle',
  checkForUpdates: 'autoUpdate',
  getUpdateInfo: 'autoUpdate',
  installUpdate: 'autoUpdate',
  dismissUpdate: 'autoUpdate',
  getDismissedUpdateVersion: 'autoUpdate',
  menuQuit: 'nativeMenu',
  menuMinimize: 'nativeMenu',
  menuMaximize: 'nativeMenu',
  menuZoomIn: 'nativeMenu',
  menuZoomOut: 'nativeMenu',
  menuZoomReset: 'nativeMenu',
  menuToggleDevTools: 'nativeMenu',
  refreshBadge: 'appBadge',
  setDockIconWithBadge: 'appBadge',
  browseForGitBash: 'gitBashConfiguration',
  checkGitBash: 'gitBashConfiguration',
  setGitBashPath: 'gitBashConfiguration',
  discoverSkills: 'localSkillManagement',
  importSkills: 'localSkillManagement',
  openSkillInEditor: 'localSkillManagement',
  openSkillInFinder: 'localSkillManagement',
  setKeepAwakeWhileRunning: 'powerSaveBlocker',
  getKeepAwakeWhileRunning: 'powerSaveBlocker',
  removeWorkspace: 'nativeWindowLifecycle',
} satisfies Partial<Record<keyof ElectronAPI, WebPlatformCapabilityName>>)

export class WebCapabilityUnavailableError extends Error {
  readonly data: CapabilityUnavailableErrorDataV1
  readonly code: CapabilityUnavailableErrorDataV1['code']
  readonly platform: CapabilityUnavailableErrorDataV1['platform']
  readonly capability: WebPlatformCapabilityName

  constructor(capability: WebPlatformCapabilityName) {
    const definition = WEBUI_CAPABILITY_DEFINITIONS[capability]
    const detail = 'reason' in definition ? definition.reason : undefined
    const data = createCapabilityUnavailableErrorDataV1('web', capability, detail)
    super(data.message)
    this.name = 'WebCapabilityUnavailableError'
    this.data = data
    this.code = data.code
    this.platform = data.platform
    this.capability = capability
  }
}

export function unsupportedWebCapability(capability: WebPlatformCapabilityName): Promise<never> {
  return Promise.reject(new WebCapabilityUnavailableError(capability))
}

export function createUnsupportedWebApiOverrides(): Partial<ElectronAPI> {
  return Object.fromEntries(
    Object.entries(WEBUI_UNSUPPORTED_OPERATION_CAPABILITIES).map(([operation, capability]) => [
      operation,
      () => unsupportedWebCapability(capability),
    ]),
  ) as Partial<ElectronAPI>
}

export function attachWebPlatformCapabilities<T extends object>(api: T): T & Pick<ElectronAPI, 'platformCapabilities'> {
  Object.defineProperty(api, 'platformCapabilities', {
    value: WEBUI_PLATFORM_CAPABILITIES,
    enumerable: true,
    configurable: false,
    writable: false,
  })
  return api as T & Pick<ElectronAPI, 'platformCapabilities'>
}
