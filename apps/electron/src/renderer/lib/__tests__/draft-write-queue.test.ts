import { describe, expect, it } from 'bun:test'
import { DraftWriteQueue } from '../draft-write-queue'

describe('DraftWriteQueue', () => {
  it('orders a durable clear after an earlier draft write', async () => {
    const firstWrite = Promise.withResolvers<void>()
    const firstWriteStarted = Promise.withResolvers<void>()
    const writes: Array<{ id: string; text: string }> = []
    const queue = new DraftWriteQueue(async (id, draft) => {
      writes.push({ id, text: draft.text })
      if (draft.text === 'sent message') {
        firstWriteStarted.resolve()
        await firstWrite.promise
      }
    })

    const pendingWrite = queue.write('workspace_draft', { text: 'sent message' })
    const pendingClear = queue.write('workspace_draft', { text: '' })

    await firstWriteStarted.promise
    expect(writes).toEqual([{ id: 'workspace_draft', text: 'sent message' }])

    firstWrite.resolve()
    await Promise.all([pendingWrite, pendingClear])
    expect(writes).toEqual([
      { id: 'workspace_draft', text: 'sent message' },
      { id: 'workspace_draft', text: '' },
    ])
  })

  it('continues with later writes after a failed persistence operation', async () => {
    const writes: string[] = []
    const queue = new DraftWriteQueue(async (_id, draft) => {
      writes.push(draft.text)
      if (draft.text === 'broken') throw new Error('write failed')
    })

    await expect(queue.write('workspace_draft', { text: 'broken' })).rejects.toThrow('write failed')
    await queue.write('workspace_draft', { text: '' })

    expect(writes).toEqual(['broken', ''])
    await expect(queue.flush()).resolves.toBeUndefined()
  })
})
