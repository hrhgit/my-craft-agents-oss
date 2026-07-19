import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveElectronResourcePaths } from '../electron-resource-paths'
import { prepareWorkspaceServerEntry } from '../workspace-server-spawner'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('resolveElectronResourcePaths', () => {
  it('keeps packaged app resources and extraResources as separate roots', () => {
    const paths = resolveElectronResourcePaths({
      isPackaged: true,
      appPath: 'C:\\Mortise\\resources\\app',
      resourcesPath: 'C:\\Mortise\\resources',
      bundledAssetsRoot: 'C:\\Mortise\\resources\\app\\dist',
      platform: 'win32',
    })

    expect(paths.browserExtensionPath).toBe('C:\\Mortise\\resources\\app\\dist\\resources\\pi-extensions\\browser.js')
    expect(paths.commandDocsPath).toBe('C:\\Mortise\\resources\\app\\dist\\resources\\docs\\mortise-cli.md')
    expect(paths.piRuntimePath).toBe('C:\\Mortise\\resources\\pi-runtime\\pi.exe')
    expect(paths.messagingWorkerPath).toBe('C:\\Mortise\\resources\\messaging-whatsapp-worker\\worker.cjs')
  })

  it('keeps source-development assets beside the build output', () => {
    const paths = resolveElectronResourcePaths({
      isPackaged: false,
      appPath: 'E:\\repo\\apps\\electron',
      resourcesPath: 'E:\\electron\\resources',
      bundledAssetsRoot: 'E:\\repo\\apps\\electron\\dist',
      platform: 'win32',
    })

    expect(paths.appResourcesPath).toBe('E:\\repo\\apps\\electron\\resources')
    expect(paths.toolResourcesPath).toBe(paths.appResourcesPath)
  })

  it('pins source-development assets to an immutable validation capsule', () => {
    const paths = resolveElectronResourcePaths({
      isPackaged: false,
      appPath: 'E:\\repo\\output\\mortise-ui-builds\\build\\app',
      resourcesPath: 'E:\\electron\\resources',
      bundledAssetsRoot: 'E:\\repo\\output\\mortise-ui-builds\\build\\app\\dist',
      sourceResourcesPath: 'E:\\repo\\output\\mortise-ui-builds\\build\\app\\dist\\resources',
      platform: 'win32',
    })

    expect(paths.appResourcesPath).toBe('E:\\repo\\output\\mortise-ui-builds\\build\\app\\dist\\resources')
    expect(paths.browserExtensionPath).toContain('mortise-ui-builds\\build\\app\\dist\\resources\\pi-extensions')
  })

  it('stages packaged workspace code in a versioned user cache', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-workspace-entry-'))
    temporaryDirectories.push(root)
    const source = join(root, 'installed', 'workspace-server.mjs')
    const cache = join(root, 'user-data')
    mkdirSync(join(root, 'installed'), { recursive: true })
    writeFileSync(source, 'console.log("ready")\n')

    const first = prepareWorkspaceServerEntry(source, {
      isPackaged: true,
      runtimeCachePath: cache,
      version: '1.2.3',
    })
    const second = prepareWorkspaceServerEntry(source, {
      isPackaged: true,
      runtimeCachePath: cache,
      version: '1.2.3',
    })

    expect(first).toBe(second)
    expect(first).toContain(join('workspace-server', '1.2.3'))
    expect(readFileSync(first, 'utf8')).toBe('console.log("ready")\n')
  })
})
