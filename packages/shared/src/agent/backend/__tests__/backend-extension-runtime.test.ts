import { afterEach, describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
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
    expect(reload).toHaveBeenCalledTimes(1)
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
    expect(reload).toHaveBeenCalledTimes(1)
    registry.closeWorkspace('workspace')
    await registry.openWorkspace('workspace', 'E:/workspace')
    expect(reload).toHaveBeenCalledTimes(2)
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
