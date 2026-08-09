import { afterEach, describe, expect, it, mock } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BackendExtensionRuntimeRegistry } from '../backend-extension-runtime.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'mortise-backend-extensions-'))
  roots.push(value)
  return value
}

describe('BackendExtensionRuntimeRegistry', () => {
  it('loads a Workspace once and isolates one Extension failure', async () => {
    const reload = mock(async () => undefined)
    const registry = new BackendExtensionRuntimeRegistry({
      backendType: 'electron',
      snapshotRoot: root(),
      createLoader: () => ({
        reload,
        getExtensions: () => ({
          extensions: [{ id: 'healthy', path: 'healthy.ts', resolvedPath: 'E:/workspace/.mortise/extensions/healthy.ts' }],
          errors: [{ path: 'broken.ts', error: 'load failed' }],
        }),
      }),
    })

    const first = await registry.openWorkspace('workspace', 'E:/workspace')
    const second = await registry.openWorkspace('workspace', 'E:/workspace')
    expect(reload).toHaveBeenCalledTimes(2)
    expect(first.extensions.map(extension => extension.id)).toEqual(['healthy'])
    expect(first.failures).toEqual([{ path: 'broken.ts', error: 'load failed' }])
    expect(second).toEqual(first)
  })

  it('does not retry a failed load until the Workspace is explicitly closed and opened', async () => {
    const reload = mock(async () => { throw new Error('broken loader') })
    const registry = new BackendExtensionRuntimeRegistry({
      backendType: 'electron', snapshotRoot: root(),
      createLoader: () => ({ reload, getExtensions: () => ({ extensions: [], errors: [] }) }),
    })

    expect((await registry.openWorkspace('workspace', 'E:/workspace')).failures[0]?.error).toBe('broken loader')
    await registry.openWorkspace('workspace', 'E:/workspace')
    expect(reload).toHaveBeenCalledTimes(2)
    registry.closeWorkspace('workspace')
    await registry.openWorkspace('workspace', 'E:/workspace')
    expect(reload).toHaveBeenCalledTimes(3)
  })

  it('loads the global blueprint once before multiple Workspaces', async () => {
    const loads: Array<{ scope: 'global' | 'workspace'; additionalExtensionPaths: string[] }> = []
    const registry = new BackendExtensionRuntimeRegistry({
      backendType: 'electron',
      snapshotRoot: root(),
      createLoader: ({ scope, additionalExtensionPaths }) => ({
        reload: async () => { loads.push({ scope, additionalExtensionPaths }) },
        getExtensions: () => ({ extensions: [], errors: [] }),
      }),
    })

    await Promise.all([
      registry.openWorkspace('workspace-a', 'E:/workspace-a'),
      registry.openWorkspace('workspace-b', 'E:/workspace-b'),
    ])

    expect(loads.filter(load => load.scope === 'global')).toEqual([{
      scope: 'global',
      additionalExtensionPaths: [],
    }])
    expect(loads.filter(load => load.scope === 'workspace')).toEqual([
      { scope: 'workspace', additionalExtensionPaths: [] },
      { scope: 'workspace', additionalExtensionPaths: [] },
    ])
  })

  it('includes bundled Extensions in the applied global runtime snapshot', async () => {
    const fixtureRoot = root()
    const agentDir = join(fixtureRoot, 'agent')
    const bundledDir = join(fixtureRoot, 'bundled')
    mkdirSync(agentDir, { recursive: true })
    mkdirSync(bundledDir, { recursive: true })
    writeFileSync(join(bundledDir, 'package.json'), JSON.stringify({
      name: 'bundled-runtime-fixture',
      private: true,
      type: 'module',
      pi: {
        extensions: [{
          id: 'bundled-runtime-fixture',
          path: './index.js',
          activation: 'startup',
        }],
      },
    }))
    writeFileSync(join(bundledDir, 'index.js'), 'export default function bundledRuntimeFixture() {}\n')

    const previousBundledPath = process.env.MORTISE_BUNDLED_PI_EXTENSIONS_PATH
    delete process.env.MORTISE_BUNDLED_PI_EXTENSIONS_PATH
    try {
      const registry = new BackendExtensionRuntimeRegistry({
        backendType: 'electron',
        agentDir,
        snapshotRoot: join(fixtureRoot, 'snapshots'),
      })
      expect((await registry.openGlobal()).extensions).toEqual([])
      process.env.MORTISE_BUNDLED_PI_EXTENSIONS_PATH = bundledDir

      const snapshot = await registry.openGlobal()
      expect(snapshot.failures).toEqual([])
      expect(snapshot.extensions.map(extension => extension.id)).toEqual(['bundled-runtime-fixture'])
    } finally {
      if (previousBundledPath === undefined) delete process.env.MORTISE_BUNDLED_PI_EXTENSIONS_PATH
      else process.env.MORTISE_BUNDLED_PI_EXTENSIONS_PATH = previousBundledPath
    }
  })

  it('reloads the global blueprint when a configured bundled directory appears', async () => {
    const fixtureRoot = root()
    const agentDir = join(fixtureRoot, 'agent')
    const bundledDir = join(fixtureRoot, 'late-bundled')
    mkdirSync(agentDir, { recursive: true })

    const previousBundledPath = process.env.MORTISE_BUNDLED_PI_EXTENSIONS_PATH
    process.env.MORTISE_BUNDLED_PI_EXTENSIONS_PATH = bundledDir
    try {
      const registry = new BackendExtensionRuntimeRegistry({
        backendType: 'electron',
        agentDir,
        snapshotRoot: join(fixtureRoot, 'snapshots'),
      })
      expect((await registry.openGlobal()).extensions).toEqual([])

      mkdirSync(bundledDir, { recursive: true })
      writeFileSync(join(bundledDir, 'package.json'), JSON.stringify({
        name: 'late-bundled-runtime-fixture',
        private: true,
        type: 'module',
        pi: {
          extensions: [{
            id: 'late-bundled-runtime-fixture',
            path: './index.js',
            activation: 'startup',
          }],
        },
      }))
      writeFileSync(join(bundledDir, 'index.js'), 'export default function lateBundledRuntimeFixture() {}\n')

      const snapshot = await registry.openGlobal()
      expect(snapshot.failures).toEqual([])
      expect(snapshot.extensions.map(extension => extension.id)).toEqual(['late-bundled-runtime-fixture'])
    } finally {
      if (previousBundledPath === undefined) delete process.env.MORTISE_BUNDLED_PI_EXTENSIONS_PATH
      else process.env.MORTISE_BUNDLED_PI_EXTENSIONS_PATH = previousBundledPath
    }
  })

  it('does not let a cleared Workspace load overwrite the replacement snapshot', async () => {
    const workspaceLoads: Array<{ release: () => void; id: string }> = []
    const registry = new BackendExtensionRuntimeRegistry({
      backendType: 'electron',
      snapshotRoot: root(),
      createLoader: ({ scope }) => {
        if (scope === 'global') {
          return {
            reload: async () => undefined,
            getExtensions: () => ({ extensions: [], errors: [] }),
          }
        }
        const id = workspaceLoads.length === 0 ? 'stale' : 'current'
        let release!: () => void
        const blocked = new Promise<void>(resolve => { release = resolve })
        workspaceLoads.push({ release, id })
        return {
          reload: async () => blocked,
          getExtensions: () => ({
            extensions: [{ id, path: `${id}.js`, resolvedPath: `E:/workspace/${id}.js` }],
            errors: [],
          }),
        }
      },
    })

    const stale = registry.openWorkspace('workspace', 'E:/workspace')
    await Bun.sleep(0)
    registry.clear()
    const current = registry.openWorkspace('workspace', 'E:/workspace')
    await Bun.sleep(0)

    workspaceLoads[0]!.release()
    await stale
    expect(registry.getWorkspaceSnapshot('workspace')).toBeNull()

    const joinedCurrent = registry.openWorkspace('workspace', 'E:/workspace')
    expect(workspaceLoads).toHaveLength(2)
    workspaceLoads[1]!.release()
    await Promise.all([current, joinedCurrent])
    expect(registry.getWorkspaceSnapshot('workspace')?.extensions.map(extension => extension.id)).toEqual(['current'])
  })

  it('persists optional state by Workspace, backend type, and Extension identity', async () => {
    const snapshotRoot = root()
    const isState = (value: unknown): value is { version: 1; count: number } =>
      typeof value === 'object' && value !== null
      && (value as { version?: unknown }).version === 1
      && typeof (value as { count?: unknown }).count === 'number'
    const electron = new BackendExtensionRuntimeRegistry({ backendType: 'electron', snapshotRoot })
    const webui = new BackendExtensionRuntimeRegistry({ backendType: 'webui', snapshotRoot })
    await electron.writeExtensionState('workspace', 'counter', { version: 1, count: 2 }, isState)
    await webui.writeExtensionState('workspace', 'counter', { version: 1, count: 9 }, isState)

    expect(electron.readExtensionState('workspace', 'counter', isState)?.count).toBe(2)
    expect(webui.readExtensionState('workspace', 'counter', isState)?.count).toBe(9)
    expect(electron.readExtensionState('workspace', 'other', isState)).toBeNull()
  })
})
