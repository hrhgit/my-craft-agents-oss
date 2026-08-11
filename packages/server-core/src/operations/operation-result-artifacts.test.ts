import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { OperationResultArtifactStore } from './operation-result-artifacts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function createStore(maxAgeMs = 1_000): Promise<{ root: string; store: OperationResultArtifactStore }> {
  const root = await mkdtemp(join(tmpdir(), 'mortise-operation-results-'))
  roots.push(root)
  return { root, store: new OperationResultArtifactStore(root, maxAgeMs) }
}

describe('OperationResultArtifactStore', () => {
  it('atomically writes and reads a result', async () => {
    const { root, store } = await createStore()
    await store.write('operation-1', 'session-export', { sessionId: 'session-1' })
    await expect(store.read('operation-1', 'session-export')).resolves.toEqual({ sessionId: 'session-1' })
    expect((await readFile(store.path('operation-1', 'session-export'), 'utf8')).includes('session-1')).toBe(true)
    expect((await import('node:fs/promises')).readdir(root).then(names => names.some(name => name.includes('.tmp-')))).resolves.toBe(false)
  })

  it('stores first-turn domain results separately from the operation receipt', async () => {
    const { store } = await createStore()
    const result = { session: { id: 'session-1' }, messageId: 'message-1', publication: 'published' }
    await store.write('first-turn-1', 'first-turn', result)
    await expect(store.read('first-turn-1', 'first-turn')).resolves.toEqual(result)
  })

  it('distinguishes missing and corrupt artifacts', async () => {
    const { store } = await createStore()
    await expect(store.read('missing', 'session-export')).rejects.toMatchObject({ code: 'OPERATION_RESULT_MISSING' })
    await writeFile(store.path('corrupt', 'remote-transfer'), '{broken', 'utf8')
    await expect(store.read('corrupt', 'remote-transfer')).rejects.toMatchObject({ code: 'OPERATION_RESULT_CORRUPT' })
  })

  it('removes only expired operation result artifacts', async () => {
    const { root, store } = await createStore(100)
    await store.write('old', 'session-export', { old: true })
    await store.write('fresh', 'remote-transfer', { fresh: true })
    await writeFile(join(root, 'unrelated.json'), '{}', 'utf8')
    const oldDate = new Date(Date.now() - 1_000)
    await utimes(store.path('old', 'session-export'), oldDate, oldDate)

    await expect(store.cleanupExpired()).resolves.toBe(1)
    await expect(store.read('old', 'session-export')).rejects.toMatchObject({ code: 'OPERATION_RESULT_MISSING' })
    await expect(store.read('fresh', 'remote-transfer')).resolves.toEqual({ fresh: true })
    await expect(readFile(join(root, 'unrelated.json'), 'utf8')).resolves.toBe('{}')
  })
})
