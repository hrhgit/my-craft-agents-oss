export interface WindowsUiValidationLaunch {
  platform: NodeJS.Platform
  validationBuild: boolean
  testHostEnabled: boolean
  directScenarioHost?: boolean
  windowMode: string | undefined
}

export function isWindowsForegroundUiValidationHost(options: WindowsUiValidationLaunch): boolean {
  if (options.platform !== 'win32'
    || !options.validationBuild
    || !options.testHostEnabled
    || options.directScenarioHost === false
    || options.windowMode !== 'foreground') return false

  return true
}
