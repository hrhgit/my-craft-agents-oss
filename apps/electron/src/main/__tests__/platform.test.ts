import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { immutableRuntimeRequiredAppPaths } from '@mortise/session-tools-core/runtime'
import { resolveElectronRuntimeContext } from '../platform'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('resolveElectronRuntimeContext', () => {
  it('binds every root and executable to the selected capsule', () => {
    const fixture = createCapsule()
    expect(resolveElectronRuntimeContext({
      isPackaged: false,
      getAppPath: () => fixture.appRootPath,
    } as Electron.App, {
      env: fixture.env,
      expectedExecutablePath: fixture.executablePath,
    })).toMatchObject({
      appRootPath: fixture.appRootPath,
      resourcesPath: join(fixture.appRootPath, 'dist', 'resources'),
      resourcesBasePath: join(fixture.appRootPath, 'dist'),
      immutableRuntime: {
        runtimePath: join(fixture.appRootPath, 'dist', 'packaging-inputs', 'runtime'),
        electronRuntimePath: fixture.executablePath,
        nodeRuntimePath: fixture.executablePath,
      },
    })
  })

  it('rejects a capsule that does not own the selected app or executable', () => {
    const fixture = createCapsule()
    const otherApp = join(fixture.root, 'other-app')
    const otherExecutable = join(fixture.root, 'other-electron.exe')
    mkdirSync(otherApp, { recursive: true })
    writeFileSync(otherExecutable, 'other', 'utf8')

    expect(() => resolveElectronRuntimeContext({
      isPackaged: false,
      getAppPath: () => otherApp,
    } as Electron.App, {
      env: fixture.env,
      expectedExecutablePath: fixture.executablePath,
    })).toThrow('application root')

    expect(() => resolveElectronRuntimeContext({
      isPackaged: false,
      getAppPath: () => fixture.appRootPath,
    } as Electron.App, {
      env: fixture.env,
      expectedExecutablePath: otherExecutable,
    })).toThrow('current executable')
  })
})

function createCapsule(): {
  root: string
  appRootPath: string
  executablePath: string
  env: NodeJS.ProcessEnv
} {
  const root = mkdtempSync(join(tmpdir(), 'mortise-electron-capsule-'))
  roots.push(root)
  const appRootPath = join(root, 'app')
  for (const path of immutableRuntimeRequiredAppPaths()) write(appRootPath, path, 'fixture')
  const runtimePath = join(appRootPath, 'dist', 'packaging-inputs', 'runtime')
  const executablePath = join(runtimePath, ...(
    process.platform === 'win32'
      ? ['electron', 'electron.exe']
      : process.platform === 'darwin'
        ? ['electron', 'Electron.app', 'Contents', 'MacOS', 'Electron']
        : ['electron', 'electron']
  ))
  return {
    root,
    appRootPath,
    executablePath,
    env: {
      MORTISE_RUNTIME_APP_ROOT: appRootPath,
      MORTISE_RUNTIME_RESOURCES_DIR: join(appRootPath, 'dist', 'resources'),
      MORTISE_RUNTIME_RESOURCES_BASE: join(appRootPath, 'dist'),
      MORTISE_RUNTIME_BUNDLE_PATH: runtimePath,
      MORTISE_RUNTIME_ELECTRON_PATH: executablePath,
      MORTISE_RUNTIME_NODE_PATH: executablePath,
      MORTISE_RUNTIME_IMMUTABLE: '1',
    },
  }
}

function write(root: string, path: string, content: string): void {
  const target = join(root, ...path.split('/'))
  mkdirSync(join(target, '..'), { recursive: true })
  writeFileSync(target, content, 'utf8')
}
