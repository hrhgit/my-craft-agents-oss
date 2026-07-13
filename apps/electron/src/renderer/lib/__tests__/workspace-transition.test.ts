import { describe, expect, it } from 'bun:test'
import {
  assertWorkspaceSessionBatch,
  LatestTaskQueue,
  WorkspaceSessionMismatchError,
} from '../workspace-transition'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

describe('LatestTaskQueue', () => {
  it('serializes transitions and coalesces queued work to the latest request', async () => {
    const queue = new LatestTaskQueue()
    const firstGate = deferred()
    const calls: string[] = []

    const first = queue.enqueue(async () => {
      calls.push('first:start')
      await firstGate.promise
      calls.push('first:end')
    })
    const superseded = queue.enqueue(async () => { calls.push('superseded') })
    const latest = queue.enqueue(async () => { calls.push('latest') })

    expect(queue.isRunning).toBe(true)
    expect(queue.hasPending).toBe(true)
    expect(calls).toEqual(['first:start'])

    firstGate.resolve()
    await Promise.all([first, superseded, latest])

    expect(calls).toEqual(['first:start', 'first:end', 'latest'])
    expect(queue.isRunning).toBe(false)
  })

  it('continues with the latest queued transition after an active failure', async () => {
    const queue = new LatestTaskQueue()
    const firstGate = deferred()
    const calls: string[] = []

    const failed = queue.enqueue(async () => {
      await firstGate.promise
      throw new Error('switch failed')
    })
    const recovered = queue.enqueue(async () => { calls.push('recovered') })

    firstGate.resolve()
    await expect(failed).rejects.toThrow('switch failed')
    await recovered
    expect(calls).toEqual(['recovered'])
  })
})

describe('assertWorkspaceSessionBatch', () => {
  it('accepts local and remote workspace identities for the target', () => {
    expect(() => assertWorkspaceSessionBatch(
      [{ workspaceId: 'remote-ws' }],
      ['local-ws', 'remote-ws'],
    )).not.toThrow()
  })

  it('rejects a stale response from another workspace', () => {
    expect(() => assertWorkspaceSessionBatch(
      [{ workspaceId: 'old-ws' }],
      ['new-ws'],
    )).toThrow(WorkspaceSessionMismatchError)
  })
})
