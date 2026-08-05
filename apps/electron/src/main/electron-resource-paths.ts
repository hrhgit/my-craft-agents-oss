import { existsSync } from 'node:fs'
import { posix, win32 } from 'node:path'

export interface ElectronResourcePaths {
  appResourcesPath: string
  toolResourcesPath: string
  externalResourcesPath: string
  bundledPiExtensionsPath: string
  browserExtensionPath: string
  messagingExtensionPath: string
  commandDocsPath: string
  bunBinaryPath?: string
  messagingWorkerPath: string
}

export interface ResolveElectronResourcePathsOptions {
  isPackaged: boolean
  appPath: string
  resourcesPath: string
  bundledAssetsRoot: string
  sourceResourcesPath?: string
  sourceRuntimePath?: string
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

  const appResourcesPath = options.isPackaged
    ? join(options.appPath, 'dist', 'resources')
    : options.sourceResourcesPath ?? join(options.bundledAssetsRoot, '..', 'resources')
  const toolResourcesPath = options.isPackaged
    ? join(options.appPath, 'resources')
    : appResourcesPath
  const externalResourcesPath = options.resourcesPath
  const sourceBunPath = options.sourceRuntimePath
    ? join(options.sourceRuntimePath, 'bun', executable)
    : undefined
  if (sourceBunPath && !existsSync(sourceBunPath)) {
    throw new Error(`Immutable Electron Bun runtime is missing: ${sourceBunPath}`)
  }

  return {
    appResourcesPath,
    toolResourcesPath,
    externalResourcesPath,
    bundledPiExtensionsPath: join(appResourcesPath, 'pi-extensions'),
    browserExtensionPath: join(appResourcesPath, 'pi-extensions', 'browser.js'),
    messagingExtensionPath: join(appResourcesPath, 'pi-extensions', 'messaging.js'),
    commandDocsPath: join(appResourcesPath, 'docs', 'mortise-cli.md'),
    bunBinaryPath: sourceBunPath ?? firstExisting([
      process.env.MORTISE_BUN ?? '',
      join(externalResourcesPath, 'vendor', 'bun', executable),
      join(options.appPath, 'vendor', 'bun', executable),
    ].filter(Boolean)),
    messagingWorkerPath: options.sourceRuntimePath
      ? join(options.sourceRuntimePath, 'messaging-whatsapp-worker', 'worker.cjs')
      : join(externalResourcesPath, 'messaging-whatsapp-worker', 'worker.cjs'),
  }
}
