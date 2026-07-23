import { describe, expect, it } from 'bun:test'
import { SessionManager } from './SessionManager'

describe('Session working-directory contract', () => {
  it('rejects workingDirectory on the current create contract', async () => {
    const manager = new SessionManager()
    const createWithRemovedField = manager.createSession.bind(manager) as unknown as (
      workspaceId: string,
      options: { workingDirectory: string },
    ) => Promise<unknown>

    await expect(createWithRemovedField('missing-workspace', {
      workingDirectory: 'C:\\legacy-session-cwd',
    })).rejects.toMatchObject({
      name: 'RemovedSessionFieldError',
      code: 'SESSION_FIELD_REMOVED',
      field: 'workingDirectory',
    })
  })
})
