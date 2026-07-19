import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const PACKAGED_UIA_DRIVER_PATH = join('ui-validation', 'windows-uia-driver.ps1')
const SOURCE_UIA_DRIVER_PATH = join('scripts', 'mortise-ui', 'windows-uia-driver.ps1')

export function resolveWindowsUiAutomationDriverPath(options: {
  configuredPath?: string
  cwd?: string
  resourcesPath?: string
} = {}): string {
  const configuredPath = options.configuredPath ?? process.env.MORTISE_UI_WINDOWS_UIA_DRIVER_PATH
  if (configuredPath?.trim()) return resolve(configuredPath.trim())

  const resourcesPath = options.resourcesPath
    ?? (typeof process.resourcesPath === 'string' ? process.resourcesPath : undefined)
  const packagedPath = resourcesPath ? resolve(resourcesPath, PACKAGED_UIA_DRIVER_PATH) : undefined
  const sourcePath = resolve(options.cwd ?? process.cwd(), SOURCE_UIA_DRIVER_PATH)

  if (packagedPath && existsSync(packagedPath)) return packagedPath
  if (existsSync(sourcePath)) return sourcePath
  return packagedPath ?? sourcePath
}
