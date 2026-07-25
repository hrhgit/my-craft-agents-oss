import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { immutableRuntimeRequiredAppPaths } from '@mortise/session-tools-core/runtime'
import { createHeadlessPlatform } from './platform-headless'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('createHeadlessPlatform immutable runtime', () => {
  it('uses the canonical absolute capsule layout', () => {
    const fixture = createCapsule()
    expect(createHeadlessPlatform({
      env: fixture.env,
      executablePath: fixture.executablePath,
    })).toMatchObject({
      appRootPath: fixture.appRootPath,
      resourcesPath: join(fixture.appRootPath, 'dist', 'resources'),
      resourcesBasePath: join(fixture.appRootPath, 'dist'),
      immutableRuntime: {
        runtimePath: join(fixture.appRootPath, 'dist', 'packaging-inputs', 'runtime'),
        nodeRuntimePath: fixture.executablePath,
      },
    })
  })

  it('rejects missing and relative capsule roots', () => {
    const fixture = createCapsule()
    delete fixture.env.MORTISE_RUNTIME_RESOURCES_BASE
    expect(() => createHeadlessPlatform({
      env: fixture.env,
      executablePath: fixture.executablePath,
    })).toThrow('MORTISE_RUNTIME_RESOURCES_BASE')

    fixture.env.MORTISE_RUNTIME_RESOURCES_BASE = 'relative-dist'
    expect(() => createHeadlessPlatform({
      env: fixture.env,
      executablePath: fixture.executablePath,
    })).toThrow('must be absolute')
  })

  it('uses the injected environment consistently for packaged and debug state', () => {
    const platform = createHeadlessPlatform({
      env: { MORTISE_IS_PACKAGED: 'true', MORTISE_DEBUG: 'false' },
    })
    expect(platform.isPackaged).toBe(true)
    expect(platform.isDebugMode).toBe(false)
  })
})

function createCapsule(): {
  appRootPath: string
  executablePath: string
  env: NodeJS.ProcessEnv
} {
  const root = mkdtempSync(join(tmpdir(), 'mortise-headless-capsule-'))
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
