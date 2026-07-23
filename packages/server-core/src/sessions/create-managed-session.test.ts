import { describe, expect, it } from 'bun:test'
import { createManagedSession, InvalidSessionThinkingLevelError } from './SessionManager.ts'

describe('createManagedSession', () => {
  const workspace = {
    id: 'ws_test',
    name: 'Test Workspace',
    rootPath: '/tmp/test-workspace',
    createdAt: Date.now(),
  }

  it('rejects retired thinkingLevel values instead of migrating them on restore', () => {
    expect(() => createManagedSession({
      mortiseId: 'session_retired',
      thinkingLevel: 'think' as never,
    }, workspace as never)).toThrow(InvalidSessionThinkingLevelError)
  })

  it('preserves a canonical thinking level on restore', () => {
    const managed = createManagedSession({
      mortiseId: 'session_current',
      thinkingLevel: 'medium',
    }, workspace as any)

    expect(managed.thinkingLevel).toBe('medium')
  })

  it('rejects invalid thinking levels instead of leaking them into runtime state', () => {
    expect(() => createManagedSession({
      mortiseId: 'session_invalid',
      thinkingLevel: 'ultra' as never,
    }, workspace as never)).toThrow(InvalidSessionThinkingLevelError)
  })
})
