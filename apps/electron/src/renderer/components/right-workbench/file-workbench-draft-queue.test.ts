import { describe, expect, it } from 'bun:test'
import {
  WorkspaceFileDraftQueue,
  type WorkspaceFileDraftMutation,
} from './file-workbench-draft-queue'

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

describe('WorkspaceFileDraftQueue', () => {
  it('waits for the in-flight write and persists the latest queued snapshot', async () => {
    const firstWrite = deferred()
    const writes: string[] = []
    const queue = new WorkspaceFileDraftQueue({
      set: async (_path, content) => {
        writes.push(content)
        if (writes.length === 1) await firstWrite.promise
      },
      delete: async () => {},
    })
    void queue.enqueue(setMutation('first')).catch(() => {})
    void queue.enqueue(setMutation('second')).catch(() => {})
    const flushed = queue.flush(setMutation('latest'))

    expect(writes).toEqual(['first'])
    firstWrite.resolve()
    await flushed
    expect(writes).toEqual(['first', 'latest'])
  })

  it('retains a failed mutation so a later flush can retry it', async () => {
    let attempts = 0
    const queue = new WorkspaceFileDraftQueue({
      set: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('disk unavailable')
      },
      delete: async () => {},
    })

    await expect(queue.enqueue(setMutation('draft'))).rejects.toThrow('disk unavailable')
    await queue.flush()
    expect(attempts).toBe(2)
  })

  it('surfaces delete failures instead of reporting a successful flush', async () => {
    const queue = new WorkspaceFileDraftQueue({
      set: async () => {},
      delete: async () => { throw new Error('delete failed') },
    })
    await expect(queue.flush({ type: 'delete', relativePath: 'notes.txt' }))
      .rejects.toThrow('delete failed')
  })

  it('keeps failed draft cleanup pending and reports completion only after a retry succeeds', async () => {
    let attempts = 0
    const pendingStates: boolean[] = []
    const queue = new WorkspaceFileDraftQueue({
      set: async () => {},
      delete: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('file locked')
      },
    }, {
      onPendingChange: pending => pendingStates.push(pending),
    })

    await expect(queue.enqueue({ type: 'delete', relativePath: 'notes.txt' }))
      .rejects.toThrow('file locked')
    expect(pendingStates.at(-1)).toBe(true)

    await queue.flush()
    expect(attempts).toBe(2)
    expect(pendingStates.at(-1)).toBe(false)
  })
})

function setMutation(content: string): WorkspaceFileDraftMutation {
  return {
    type: 'set',
    relativePath: 'notes.txt',
    content,
    baseContent: 'original',
  }
}
