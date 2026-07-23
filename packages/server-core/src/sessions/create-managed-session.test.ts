import { describe, expect, it } from 'bun:test'
import { createManagedSession } from './SessionManager.ts'

describe('createManagedSession', () => {
  const workspace = {
    id: 'ws_test',
    name: 'Test Workspace',
    rootPath: '/tmp/test-workspace',
    createdAt: Date.now(),
  }

  it('drops removed thinkingLevel values instead of migrating them on restore', () => {
    const managed = createManagedSession({
      mortiseId: 'session_legacy',
      thinkingLevel: 'think' as any,
    }, workspace as any)

    expect(managed.thinkingLevel).toBeUndefined()
  })

  it('preserves a canonical thinking level on restore', () => {
    const managed = createManagedSession({
      mortiseId: 'session_current',
      thinkingLevel: 'medium',
    }, workspace as any)

    expect(managed.thinkingLevel).toBe('medium')
  })

  it('drops invalid thinking levels instead of leaking them into runtime state', () => {
    const managed = createManagedSession({
      mortiseId: 'session_invalid',
      thinkingLevel: 'ultra' as any,
    }, workspace as any)

    expect(managed.thinkingLevel).toBeUndefined()
  })
})
