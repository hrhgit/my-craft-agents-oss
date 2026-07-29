import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { BackendSnapshotStore } from '../backend-snapshot-store.ts'

interface ProbeSnapshot {
  version: 1
  value: string
}

const roots: string[] = []
const isProbeSnapshot = (value: unknown): value is ProbeSnapshot =>
  typeof value === 'object'
  && value !== null
  && (value as { version?: unknown }).version === 1
  && typeof (value as { value?: unknown }).value === 'string'

function createStore(): BackendSnapshotStore {
  const root = mkdtempSync(join(tmpdir(), 'mortise-backend-snapshot-'))
  roots.push(root)
  return new BackendSnapshotStore(root)
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('BackendSnapshotStore', () => {
  it('isolates layout baselines by Workspace and backend type', async () => {
    const store = createStore()
    await store.write(
      { kind: 'layout', workspaceId: 'workspace-a', backendType: 'electron' },
      { version: 1, value: 'electron' },
      isProbeSnapshot,
    )
    await store.write(
      { kind: 'layout', workspaceId: 'workspace-a', backendType: 'webui' },
      { version: 1, value: 'webui' },
      isProbeSnapshot,
    )

    expect(store.read(
      { kind: 'layout', workspaceId: 'workspace-a', backendType: 'electron' },
      isProbeSnapshot,
    )?.value).toBe('electron')
    expect(store.read(
      { kind: 'layout', workspaceId: 'workspace-a', backendType: 'webui' },
      isProbeSnapshot,
    )?.value).toBe('webui')
    expect(store.read(
      { kind: 'layout', workspaceId: 'workspace-b', backendType: 'electron' },
      isProbeSnapshot,
    )).toBeNull()
  })

  it('isolates optional Extension state by Extension identity', async () => {
    const store = createStore()
    const key = {
      kind: 'extension-state' as const,
      workspaceId: 'workspace-a',
      backendType: 'electron' as const,
      extensionId: '@example/extension',
    }
    await store.write(key, { version: 1, value: 'state' }, isProbeSnapshot)

    expect(store.read(key, isProbeSnapshot)?.value).toBe('state')
    expect(store.read({ ...key, extensionId: '@example/other' }, isProbeSnapshot)).toBeNull()
  })

  it('ignores corrupt or schema-invalid snapshots and rejects incomplete writes', async () => {
    const store = createStore()
    const key = { kind: 'layout' as const, workspaceId: 'workspace-a', backendType: 'electron' as const }
    const path = store.resolvePath(key)
    await store.write(key, { version: 1, value: 'complete' }, isProbeSnapshot)
    writeFileSync(path, '{broken')
    expect(store.read(key, isProbeSnapshot)).toBeNull()
    writeFileSync(path, JSON.stringify({ version: 2, value: 'wrong' }))
    expect(store.read(key, isProbeSnapshot)).toBeNull()
    await expect(store.write(key, { version: 2, value: 'wrong' }, isProbeSnapshot)).rejects.toThrow(
      'Invalid complete layout snapshot',
    )
  })

  it('serializes concurrent complete writes without leaving temporary files', async () => {
    const store = createStore()
    const key = { kind: 'layout' as const, workspaceId: 'workspace-a', backendType: 'electron' as const }
    await Promise.all(Array.from({ length: 20 }, (_, index) =>
      store.write(key, { version: 1 as const, value: String(index) }, isProbeSnapshot)))

    expect(Number(store.read(key, isProbeSnapshot)?.value)).toBeGreaterThanOrEqual(0)
    const directory = dirname(store.resolvePath(key))
    expect(existsSync(directory)).toBe(true)
    expect(readdirSync(directory).filter(name => name.includes('.tmp-'))).toEqual([])
  })
})
