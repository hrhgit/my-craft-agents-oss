import { describe, expect, it } from 'bun:test'
import {
  assertWorkspaceSessionBatch,
  flushWorkspaceLayoutBeforeTransition,
  isWorkspaceLayoutTransitioning,
  LatestTaskQueue,
  registerWorkspaceLayoutFlusher,
  resolveWorkspaceTransitionCommit,
  waitForRendererCommit,
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

describe('waitForRendererCommit', () => {
  it('continues on the next animation frame and cancels the fallback', async () => {
    let frameCallback: FrameRequestCallback | null = null
    let fallbackCallback: (() => void) | null = null
    const cancelled: unknown[] = []
    const fallbackHandle = { id: 'fallback' } as unknown as ReturnType<typeof setTimeout>
    const wait = waitForRendererCommit({
      requestFrame(callback) {
        frameCallback = callback
        return 1
      },
      scheduleFallback(callback) {
        fallbackCallback = callback
        return fallbackHandle
      },
      cancelFallback(handle) {
        cancelled.push(handle)
      },
    })

    expect(frameCallback).not.toBeNull()
    frameCallback!(0)
    await wait
    expect(cancelled).toEqual([fallbackHandle])
    fallbackCallback!()
    expect(cancelled).toEqual([fallbackHandle])
  })

  it('continues through the fallback when a background window receives no frame', async () => {
    let fallbackCallback: (() => void) | null = null
    const wait = waitForRendererCommit({
      requestFrame: () => 1,
      scheduleFallback(callback) {
        fallbackCallback = callback
        return { id: 'fallback' } as unknown as ReturnType<typeof setTimeout>
      },
      cancelFallback() {},
    })

    expect(fallbackCallback).not.toBeNull()
    fallbackCallback!()
    await wait
  })
})

describe('workspace layout transition boundary', () => {
  it('awaits a delayed source-workspace flush without invoking another workspace owner', async () => {
    const calls: string[] = []
    let completed = false
    const unregisterSource = registerWorkspaceLayoutFlusher('workspace-a', async () => {
      calls.push('source:start')
      await new Promise(resolve => setTimeout(resolve, 140))
      calls.push('source:end')
    })
    const unregisterTarget = registerWorkspaceLayoutFlusher('workspace-b', () => {
      calls.push('target')
    })

    try {
      const flush = flushWorkspaceLayoutBeforeTransition('workspace-a').then(() => {
        completed = true
      })
      await new Promise(resolve => setTimeout(resolve, 125))

      expect(completed).toBe(false)
      expect(calls).toEqual(['source:start'])

      await flush
      expect(calls).toEqual(['source:start', 'source:end'])
    } finally {
      unregisterSource()
      unregisterTarget()
    }
  })

  it('suppresses only source and target dock ownership during the explicit transition', () => {
    const transition = {
      sourceWorkspaceId: 'workspace-a',
      targetWorkspaceId: 'workspace-b',
    }

    expect(isWorkspaceLayoutTransitioning(transition, 'workspace-a')).toBe(true)
    expect(isWorkspaceLayoutTransitioning(transition, 'workspace-b')).toBe(true)
    expect(isWorkspaceLayoutTransitioning(transition, 'workspace-c')).toBe(false)
    expect(isWorkspaceLayoutTransitioning(null, 'workspace-a')).toBe(false)
  })

  it('restores the captured baseline when A -> B coalesces back to A', () => {
    expect(resolveWorkspaceTransitionCommit('workspace-a', 'workspace-a', 'workspace-a')).toEqual({
      rendererWorkspaceChanged: false,
      restoreBaseline: true,
    })
    expect(resolveWorkspaceTransitionCommit('workspace-a', 'workspace-a', 'workspace-b')).toEqual({
      rendererWorkspaceChanged: true,
      restoreBaseline: false,
    })
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
