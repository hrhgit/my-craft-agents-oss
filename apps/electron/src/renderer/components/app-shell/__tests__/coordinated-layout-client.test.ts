import { describe, expect, it, mock } from 'bun:test'
import { createDefaultAppLayout, type AppLayout } from '../../../../shared/app-layout'
import {
  createCoordinatedLayoutSaveQueue,
  recoverCoordinatedLayoutRetryFailure,
  runAuthoritativeLayoutMutation,
  saveCoordinatedWindowLayout,
  shouldApplyCoordinatorRevision,
} from '../coordinated-layout-client'

function layout(revision: number): AppLayout {
  return { ...createDefaultAppLayout({ serverId: 'local', workspaceId: 'workspace' }), revision }
}

describe('coordinated layout client', () => {
  it('serializes writes and flushes both in-flight and queued work', async () => {
    const queue = createCoordinatedLayoutSaveQueue()
    const order: string[] = []
    let finishFirst: (() => void) | undefined
    const first = queue.enqueue(async () => {
      order.push('first:start')
      await new Promise<void>(resolve => { finishFirst = resolve })
      order.push('first:end')
      return 1
    })
    const second = queue.enqueue(async () => {
      order.push('second:start')
      order.push('second:end')
      return 2
    })
    let flushed = false
    const flush = queue.flush().then(() => { flushed = true })

    await Bun.sleep(0)
    expect(order).toEqual(['first:start'])
    expect(flushed).toBe(false)

    finishFirst?.()
    await Promise.all([first, second, flush])
    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end'])
    expect(flushed).toBe(true)
  })

  it('keeps later writes runnable after an earlier write rejects', async () => {
    const queue = createCoordinatedLayoutSaveQueue()
    const failed = queue.enqueue(async () => { throw new Error('offline') })
    const recovered = queue.enqueue(async () => 2)

    await expect(failed).rejects.toThrow('offline')
    await expect(recovered).resolves.toBe(2)
    await expect(queue.flush()).resolves.toBeUndefined()
  })

  it('keeps flushing when another write is queued while an in-flight write settles', async () => {
    const queue = createCoordinatedLayoutSaveQueue()
    let finishFirst: (() => void) | undefined
    let finishSecond: (() => void) | undefined
    void queue.enqueue(() => new Promise<void>(resolve => { finishFirst = resolve }))

    let flushed = false
    const flush = queue.flush().then(() => { flushed = true })
    await Bun.sleep(0)
    void queue.enqueue(() => new Promise<void>(resolve => { finishSecond = resolve }))
    finishFirst?.()
    await Bun.sleep(0)

    expect(flushed).toBe(false)
    finishSecond?.()
    await flush
    expect(flushed).toBe(true)
  })

  it('keeps coordinator revisions monotonic when responses arrive late', () => {
    expect(shouldApplyCoordinatorRevision(null, 4)).toBe(true)
    expect(shouldApplyCoordinatorRevision(4, 4)).toBe(true)
    expect(shouldApplyCoordinatorRevision(5, 4)).toBe(false)
    expect(shouldApplyCoordinatorRevision(5, 6)).toBe(true)
  })

  it('does not let an old-scope retry failure mutate the new scope', () => {
    const clearPendingSave = mock(() => undefined)
    const applyLatest = mock(() => undefined)

    expect(recoverCoordinatedLayoutRetryFailure({
      currentScope: 'workspace:new',
      saveScope: 'workspace:old',
      latest: layout(8),
      clearPendingSave,
      applyLatest,
    })).toBe(false)
    expect(clearPendingSave).not.toHaveBeenCalled()
    expect(applyLatest).not.toHaveBeenCalled()

    expect(recoverCoordinatedLayoutRetryFailure({
      currentScope: 'workspace:new',
      saveScope: 'workspace:new',
      latest: layout(9),
      clearPendingSave,
      applyLatest,
    })).toBe(true)
    expect(clearPendingSave).toHaveBeenCalledTimes(1)
    expect(applyLatest).toHaveBeenCalledTimes(1)
  })

  it('applies the authoritative snapshot returned by a layout mutation', async () => {
    const authoritative = layout(3)
    const apply = mock(() => undefined)

    expect(await runAuthoritativeLayoutMutation(async () => authoritative, apply)).toBe(authoritative)
    expect(apply).toHaveBeenCalledWith(authoritative)
  })

  it('rebases one window view onto the latest coordinator revision', async () => {
    const firstError = new Error('revision conflict')
    const latest = layout(8)
    const saved = layout(9)
    const save = mock(async (_snapshot: AppLayout, expectedRevision: number) => {
      if (expectedRevision === 7) throw firstError
      return saved
    })

    expect(await saveCoordinatedWindowLayout({
      snapshot: layout(7),
      expectedRevision: 7,
      save,
      loadLatest: async () => latest,
      onRetryFailure: () => undefined,
    })).toBe(saved)
    expect(save).toHaveBeenNthCalledWith(2, expect.objectContaining({ revision: 8 }), 8)
  })

  it('returns the latest coordinator snapshot to the renderer when the retry also fails', async () => {
    const firstError = new Error('first conflict')
    const retryError = new Error('retry conflict')
    const latest = layout(12)
    let attempt = 0
    const save = mock(async () => {
      attempt += 1
      throw attempt === 1 ? firstError : retryError
    })
    const recover = mock(() => undefined)

    await expect(saveCoordinatedWindowLayout({
      snapshot: layout(10),
      expectedRevision: 10,
      save,
      loadLatest: async () => latest,
      onRetryFailure: recover,
    })).rejects.toBe(retryError)
    expect(recover).toHaveBeenCalledWith(latest, retryError, firstError)
  })
})
