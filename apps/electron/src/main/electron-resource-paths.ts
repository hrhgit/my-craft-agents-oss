import { existsSync } from 'node:fs'
import { posix, win32 } from 'node:path'

export interface ElectronResourcePaths {
  appResourcesPath: string
  toolResourcesPath: string
  externalResourcesPath: string
  browserExtensionPath: string
  messagingExtensionPath: string
  commandDocsPath: string
  bunBinaryPath?: string
  piRuntimePath: string
  messagingWorkerPath: string
}

export interface ResolveElectronResourcePathsOptions {
  isPackaged: boolean
  appPath: string
  resourcesPath: string
  bundledAssetsRoot: string
  sourceResourcesPath?: string
  platform?: NodeJS.Platform
}

function firstExisting(candidates: string[]): string | undefined {
  return candidates.find(candidate => existsSync(candidate))
}

/** Resolve final Electron paths without conflating app files and extraResources. */
export function resolveElectronResourcePaths(
  options: ResolveElectronResourcePathsOptions,
): ElectronResourcePaths {
  const platform = options.platform ?? process.platform
  const path = platform === 'win32' ? win32 : posix
  const join = path.join
  const executable = platform === 'win32' ? 'bun.exe' : 'bun'
  const piExecutable = platform === 'win32' ? 'pi.exe' : 'pi'

  const appResourcesPath = options.isPackaged
    ? join(options.appPath, 'dist', 'resources')
    : options.sourceResourcesPath ?? join(options.bundledAssetsRoot, '..', 'resources')
  const toolResourcesPath = options.isPackaged
    ? join(options.appPath, 'resources')
    : appResourcesPath
  const externalResourcesPath = options.resourcesPath

  return {
    appResourcesPath,
    toolResourcesPath,
    externalResourcesPath,
    browserExtensionPath: join(appResourcesPath, 'pi-extensions', 'browser.js'),
    messagingExtensionPath: join(appResourcesPath, 'pi-extensions', 'messaging.js'),
    commandDocsPath: join(appResourcesPath, 'docs', 'mortise-cli.md'),
    bunBinaryPath: firstExisting([
      process.env.MORTISE_BUN ?? '',
      join(externalResourcesPath, 'vendor', 'bun', executable),
      join(options.appPath, 'vendor', 'bun', executable),
    ].filter(Boolean)),
    piRuntimePath: join(externalResourcesPath, 'pi-runtime', piExecutable),
    messagingWorkerPath: join(externalResourcesPath, 'messaging-whatsapp-worker', 'worker.cjs'),
  }
}
