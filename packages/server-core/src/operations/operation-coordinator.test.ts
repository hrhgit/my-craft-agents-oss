import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MultiWriterStore } from '@mortise/shared/storage'
import { OperationCoordinator } from './operation-coordinator'

const roots: string[] = []

function open(root: string, writerId: string): OperationCoordinator {
  return new OperationCoordinator(MultiWriterStore.openSync({ databasePath: join(root, 'state.sqlite'), writerId, writerVersion: 1 }))
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('OperationCoordinator', () => {
  it('persists receipts and advances revisions monotonically', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-operation-'))
    roots.push(root)
    const first = open(root, 'operation-test-a')
    expect(first.accept('op-1', 'session.compact', { workspaceId: 'ws-1', sessionId: 's-1' }))
      .toMatchObject({ accepted: true, duplicate: false, revision: 1 })
    expect(first.update('op-1', 'running')).toMatchObject({ status: 'running', revision: 2 })
    first.close()

    const second = open(root, 'operation-test-b')
    expect(second.get('op-1')).toMatchObject({ status: 'running', revision: 2 })
    expect(second.update('op-1', 'succeeded', { resultRef: 'session:s-1' }))
      .toMatchObject({ status: 'succeeded', revision: 3 })
    second.close()
  })

  it('deduplicates the same identity and rejects operation id reuse', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-operation-'))
    roots.push(root)
    const coordinator = open(root, 'operation-test')
    coordinator.accept('op-1', 'session.sendMessage', { sessionId: 's-1' })
    expect(coordinator.accept('op-1', 'session.sendMessage', { sessionId: 's-1' })).toMatchObject({ duplicate: true })
    expect(() => coordinator.accept('op-1', 'session.compact', { sessionId: 's-1' })).toThrow('different identity')
    coordinator.close()
  })

  it('keeps terminal states immutable', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-operation-'))
    roots.push(root)
    const coordinator = open(root, 'operation-test')
    coordinator.accept('op-1', 'extension.reload')
    coordinator.update('op-1', 'failed', { error: { code: 'RELOAD_FAILED', message: 'failed' } })
    expect(coordinator.update('op-1', 'succeeded')).toMatchObject({ status: 'failed', revision: 2 })
    coordinator.close()
  })

  it('cancels only after the domain task acknowledges the explicit request', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-operation-'))
    roots.push(root)
    const coordinator = open(root, 'operation-test')
    let signal: AbortSignal | undefined
    coordinator.start('op-1', 'session.compact', {}, async currentSignal => {
      signal = currentSignal
      await new Promise<void>((_resolve, reject) => currentSignal.addEventListener('abort', () => reject(currentSignal.reason), { once: true }))
    }, { cancellable: true })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(await coordinator.cancel('op-1')).toMatchObject({ status: 'running', revision: 2 })
    expect(signal?.aborted).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(coordinator.get('op-1')).toMatchObject({ status: 'cancelled', revision: 3 })
    coordinator.close()
  })

  it('keeps a task successful when it ignores a cancellation request and finishes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-operation-'))
    roots.push(root)
    const coordinator = open(root, 'operation-test')
    coordinator.start('op-2', 'extension.reload', {}, async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    }, { cancellable: true })
    await Promise.resolve()
    await coordinator.cancel('op-2')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(coordinator.get('op-2')).toMatchObject({ status: 'succeeded' })
    coordinator.close()
  })

  it('rejects cancellation when the domain task has no cancellation contract', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-operation-'))
    roots.push(root)
    const coordinator = open(root, 'operation-test')
    coordinator.start('op-3', 'session.refreshTitle', {}, async () => {
      await new Promise(resolve => setTimeout(resolve, 10))
    })
    await Promise.resolve()
    await expect(coordinator.cancel('op-3')).rejects.toThrow('not cancellable')
    await new Promise(resolve => setTimeout(resolve, 20))
    coordinator.close()
  })
})
