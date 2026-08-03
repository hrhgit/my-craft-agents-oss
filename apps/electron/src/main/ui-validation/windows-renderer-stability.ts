export interface WindowsUiValidationLaunch {
  platform: NodeJS.Platform
  validationBuild: boolean
  testHostEnabled: boolean
  windowMode: string | undefined
}

export function isWindowsForegroundUiValidationHost(options: WindowsUiValidationLaunch): boolean {
  if (options.platform !== 'win32'
    || !options.validationBuild
    || !options.testHostEnabled
    || options.windowMode !== 'foreground') return false

  return true
}
