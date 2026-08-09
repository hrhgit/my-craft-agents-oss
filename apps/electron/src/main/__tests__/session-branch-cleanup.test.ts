import { describe, expect, it } from 'bun:test'
import { rollbackFailedBranchCreation } from '@mortise/server-core/domain'

describe('rollbackFailedBranchCreation', () => {
  it('cleans runtime and storage after preflight failure', async () => {
    let destroyed = false
    const runtimeDeleted: string[] = []
    const storageDeleted: string[] = []
    const managed = {
      agent: {
        destroy: () => { destroyed = true },
      },
    }

    await rollbackFailedBranchCreation({
      managed,
      workspaceId: 'workspace-1',
      sessionId: 'child',
      deleteFromRuntimeSessions: id => { runtimeDeleted.push(id) },
      deleteStoredSession: (_root, id) => { storageDeleted.push(id) },
    })

    expect(destroyed).toBe(true)
    expect(managed.agent).toBeNull()
    expect(runtimeDeleted).toEqual(['child'])
    expect(storageDeleted).toEqual(['child'])
  })

  it('continues cleanup when agent or storage cleanup fails', async () => {
    let runtimeDeleted = false
    await expect(rollbackFailedBranchCreation({
      managed: { agent: { destroy: () => { throw new Error('dispose failed') } } },
      workspaceId: 'workspace-1',
      sessionId: 'child',
      deleteFromRuntimeSessions: () => { runtimeDeleted = true },
      deleteStoredSession: async () => { throw new Error('delete failed') },
    })).resolves.toBeUndefined()
    expect(runtimeDeleted).toBe(true)
  })
})
