import { describe, expect, it } from 'bun:test'
import { rollbackFailedBranchCreation } from '@mortise/server-core/domain'

describe('rollbackFailedBranchCreation', () => {
  it('cleans runtime and storage after preflight failure', async () => {
    let destroyed = false
    let runtimeDeleted: string | null = null
    let storageDeleted: string | null = null
    const managed = {
      agent: {
        destroy: () => { destroyed = true },
      },
    }

    await rollbackFailedBranchCreation({
      managed,
      workspaceRootPath: '/workspace',
      sessionId: 'child',
      deleteFromRuntimeSessions: id => { runtimeDeleted = id },
      deleteStoredSession: (_root, id) => { storageDeleted = id },
    })

    expect(destroyed).toBe(true)
    expect(managed.agent).toBeNull()
    expect(runtimeDeleted).toBe('child')
    expect(storageDeleted).toBe('child')
  })

  it('continues cleanup when agent or storage cleanup fails', async () => {
    let runtimeDeleted = false
    await expect(rollbackFailedBranchCreation({
      managed: { agent: { destroy: () => { throw new Error('dispose failed') } } },
      workspaceRootPath: '/workspace',
      sessionId: 'child',
      deleteFromRuntimeSessions: () => { runtimeDeleted = true },
      deleteStoredSession: async () => { throw new Error('delete failed') },
    })).resolves.toBeUndefined()
    expect(runtimeDeleted).toBe(true)
  })
})
