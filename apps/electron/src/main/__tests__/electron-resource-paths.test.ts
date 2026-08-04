import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveImmutableRuntimeLayout } from '@mortise/session-tools-core/runtime'
import { resolveElectronResourcePaths } from '../electron-resource-paths'
import { buildWorkspaceServerChildEnv, prepareWorkspaceServerEntry, resolveWorkspaceServerEntry } from '../workspace-server-spawner'

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

    expect(paths.bundledPiExtensionsPath).toBe('C:\\Mortise\\resources\\app\\dist\\resources\\pi-extensions')
    expect(paths.browserExtensionPath).toBe('C:\\Mortise\\resources\\app\\dist\\resources\\pi-extensions\\browser.js')
    expect(paths.permissionsExtensionPath).toBe('C:\\Mortise\\resources\\app\\dist\\resources\\pi-extensions\\permissions.js')
    expect(paths.commandDocsPath).toBe('C:\\Mortise\\resources\\app\\dist\\resources\\docs\\mortise-cli.md')
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
    expect(paths.bundledPiExtensionsPath).toBe('E:\\repo\\apps\\electron\\resources\\pi-extensions')
  })

  it('pins source-development assets to an immutable validation capsule', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-electron-resources-'))
    temporaryDirectories.push(root)
    const appPath = join(root, 'app')
    const sourceResourcesPath = join(appPath, 'dist', 'resources')
    const sourceRuntimePath = join(appPath, 'dist', 'packaging-inputs', 'runtime')
    const bunPath = join(sourceRuntimePath, 'bun', process.platform === 'win32' ? 'bun.exe' : 'bun')
    mkdirSync(join(bunPath, '..'), { recursive: true })
    writeFileSync(bunPath, 'capsule bun')
    const paths = resolveElectronResourcePaths({
      isPackaged: false,
      appPath,
      resourcesPath: join(root, 'electron-resources'),
      bundledAssetsRoot: join(appPath, 'dist'),
      sourceResourcesPath,
      sourceRuntimePath,
      platform: process.platform,
    })

    expect(paths.appResourcesPath).toBe(sourceResourcesPath)
    expect(paths.bundledPiExtensionsPath).toBe(join(sourceResourcesPath, 'pi-extensions'))
    expect(paths.browserExtensionPath).toContain(join('dist', 'resources', 'pi-extensions'))
    expect(paths.messagingWorkerPath).toBe(join(sourceRuntimePath, 'messaging-whatsapp-worker', 'worker.cjs'))
    expect(paths.bunBinaryPath).toBe(bunPath)
  })

  it('does not let external Bun override an immutable runtime', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-electron-bun-'))
    temporaryDirectories.push(root)
    const sourceRuntimePath = join(root, 'runtime')
    const capsuleBun = join(sourceRuntimePath, 'bun', process.platform === 'win32' ? 'bun.exe' : 'bun')
    const externalBun = join(root, 'external', process.platform === 'win32' ? 'bun.exe' : 'bun')
    for (const path of [capsuleBun, externalBun]) {
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, 'bun')
    }
    const previous = process.env.MORTISE_BUN
    process.env.MORTISE_BUN = externalBun
    try {
      const paths = resolveElectronResourcePaths({
        isPackaged: false,
        appPath: join(root, 'app'),
        resourcesPath: join(root, 'resources'),
        bundledAssetsRoot: join(root, 'app', 'dist'),
        sourceRuntimePath,
      })
      expect(paths.bunBinaryPath).toBe(capsuleBun)
      rmSync(capsuleBun, { force: true })
      expect(() => resolveElectronResourcePaths({
        isPackaged: false,
        appPath: join(root, 'app'),
        resourcesPath: join(root, 'resources'),
        bundledAssetsRoot: join(root, 'app', 'dist'),
        sourceRuntimePath,
      })).toThrow('Immutable Electron Bun runtime is missing')
    } finally {
      if (previous === undefined) delete process.env.MORTISE_BUN
      else process.env.MORTISE_BUN = previous
    }
  })

  it('preserves immutable runtime roots in the workspace-server child', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-workspace-runtime-env-'))
    temporaryDirectories.push(root)
    const immutableRuntime = createImmutableLayout(root)
    const env = buildWorkspaceServerChildEnv({
      isPackaged: false,
      appPath: join(root, 'electron-app'),
      resourcesPath: join(root, 'electron-resources'),
      bundledAssetsRoot: join(root, 'capsule', 'app', 'dist'),
      version: '0.1.0',
      immutableRuntime,
    }, 'token', '1234')

    expect(env.MORTISE_APP_ROOT).toBe(immutableRuntime.appRootPath)
    expect(env.MORTISE_RESOURCES_PATH).toBe(immutableRuntime.resourcesPath)
    expect(env.MORTISE_RUNTIME_BUNDLE_PATH).toBe(immutableRuntime.runtimePath)
    expect(env.MORTISE_RUNTIME_APP_ROOT).toBe(immutableRuntime.appRootPath)
    expect(env.MORTISE_RUNTIME_RESOURCES_DIR).toBe(immutableRuntime.resourcesPath)
    expect(env.MORTISE_RUNTIME_ELECTRON_PATH).toBe(immutableRuntime.electronRuntimePath)
    expect(env.MORTISE_RUNTIME_NODE_PATH).toBe(immutableRuntime.nodeRuntimePath)
    expect(env.MORTISE_RUNTIME_IMMUTABLE).toBe('1')
  })

  it('fails closed before workspace-server launch when the immutable layout is incomplete', () => {
    expect(() => resolveImmutableRuntimeLayout({
      env: { MORTISE_RUNTIME_IMMUTABLE: '1' },
      requireAssets: false,
    })).toThrow('MORTISE_RUNTIME_APP_ROOT')
  })

  it('clears inherited immutable roots for ordinary source and packaged children', () => {
    const names = [
      'MORTISE_RUNTIME_APP_ROOT',
      'MORTISE_RUNTIME_RESOURCES_DIR',
      'MORTISE_RUNTIME_RESOURCES_BASE',
      'MORTISE_RUNTIME_BUNDLE_PATH',
      'MORTISE_RUNTIME_ELECTRON_PATH',
      'MORTISE_RUNTIME_NODE_PATH',
      'MORTISE_RUNTIME_IMMUTABLE',
    ] as const
    const previous = new Map(names.map(name => [name, process.env[name]]))
    for (const name of names) process.env[name] = `stale-${name}`
    try {
      for (const isPackaged of [false, true]) {
        const env = buildWorkspaceServerChildEnv({
          isPackaged,
          appPath: 'E:\\electron-app',
          resourcesPath: 'E:\\electron-resources',
          bundledAssetsRoot: 'E:\\electron-app\\dist',
          version: '0.1.0',
          nodeBinary: 'E:\\electron\\electron.exe',
        }, 'token', '1234')
        for (const name of names) expect(env[name]).toBeUndefined()
      }
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })

  it('preserves build provenance while replacing inherited runtime layout roots', () => {
    const provenance = {
      MORTISE_BUILD_ID: 'build-id',
      MORTISE_BUILD_SOURCE_ID: 'source-id',
      MORTISE_BUILD_DIR: 'E:\\capsule\\build',
    } as const
    const previous = new Map(Object.keys(provenance).map(name => [name, process.env[name]]))
    Object.assign(process.env, provenance)
    try {
      const env = buildWorkspaceServerChildEnv({
        isPackaged: false,
        appPath: 'E:\\electron-app',
        resourcesPath: 'E:\\electron-resources',
        bundledAssetsRoot: 'E:\\electron-app\\dist',
        version: '0.1.0',
      }, 'token', '1234')
      expect(env).toMatchObject(provenance)
      expect(env.MORTISE_RUNTIME_IMMUTABLE).toBeUndefined()
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })

  it('derives immutable workspace code from the capsule instead of an inherited override', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-workspace-entry-authority-'))
    temporaryDirectories.push(root)
    const appRoot = join(root, 'capsule-app')
    const canonicalEntry = join(appRoot, 'dist', 'workspace-server.mjs')
    const externalEntry = join(root, 'external-workspace-server.mjs')
    mkdirSync(join(canonicalEntry, '..'), { recursive: true })
    writeFileSync(canonicalEntry, 'canonical', 'utf8')
    writeFileSync(externalEntry, 'external', 'utf8')
    const immutableRuntime = createImmutableLayout(root, appRoot)
    const previous = process.env.MORTISE_WORKSPACE_SERVER_ENTRY
    process.env.MORTISE_WORKSPACE_SERVER_ENTRY = externalEntry
    try {
      expect(resolveWorkspaceServerEntry({
        isPackaged: false,
        appPath: appRoot,
        resourcesPath: join(root, 'resources'),
        bundledAssetsRoot: join(appRoot, 'dist'),
        version: '0.1.0',
        immutableRuntime,
      })).toBe(canonicalEntry)
    } finally {
      if (previous === undefined) delete process.env.MORTISE_WORKSPACE_SERVER_ENTRY
      else process.env.MORTISE_WORKSPACE_SERVER_ENTRY = previous
    }
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

function createImmutableLayout(root: string, appRoot = join(root, 'capsule-app')) {
  const resourcesBasePath = join(appRoot, 'dist')
  const resourcesPath = join(resourcesBasePath, 'resources')
  const runtimePath = join(resourcesBasePath, 'packaging-inputs', 'runtime')
  const electronRuntimePath = process.platform === 'win32'
    ? join(runtimePath, 'electron', 'electron.exe')
    : process.platform === 'darwin'
      ? join(runtimePath, 'electron', 'Electron.app', 'Contents', 'MacOS', 'Electron')
      : join(runtimePath, 'electron', 'electron')
  mkdirSync(resourcesPath, { recursive: true })
  mkdirSync(join(electronRuntimePath, '..'), { recursive: true })
  writeFileSync(electronRuntimePath, 'runtime', 'utf8')
  const layout = resolveImmutableRuntimeLayout({
    env: {
      MORTISE_RUNTIME_IMMUTABLE: '1',
      MORTISE_RUNTIME_APP_ROOT: appRoot,
      MORTISE_RUNTIME_RESOURCES_DIR: resourcesPath,
      MORTISE_RUNTIME_RESOURCES_BASE: resourcesBasePath,
      MORTISE_RUNTIME_BUNDLE_PATH: runtimePath,
      MORTISE_RUNTIME_ELECTRON_PATH: electronRuntimePath,
      MORTISE_RUNTIME_NODE_PATH: electronRuntimePath,
    },
    requireAssets: false,
  })
  if (!layout) throw new Error('Expected immutable runtime fixture')
  return layout
}
