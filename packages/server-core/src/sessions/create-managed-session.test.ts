import { describe, expect, it } from 'bun:test'
import {
  createManagedSession,
  InvalidSessionThinkingLevelError,
  resolveSessionThinkingLevel,
  resolveToolDisplayMeta,
  SessionManager,
} from './SessionManager.ts'

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
    }, workspace as never)

    expect(managed.thinkingLevel).toBe('medium')
  })

  it('rejects invalid thinking levels instead of leaking them into runtime state', () => {
    expect(() => createManagedSession({
      mortiseId: 'session_invalid',
      thinkingLevel: 'ultra' as never,
    }, workspace as never)).toThrow(InvalidSessionThinkingLevelError)
  })

  it('rejects retired explicit creation input instead of silently using the default', () => {
    expect(() => resolveSessionThinkingLevel('think', 'medium')).toThrow(InvalidSessionThinkingLevelError)
    expect(() => resolveSessionThinkingLevel('ultra', 'medium')).toThrow(InvalidSessionThinkingLevelError)
    expect(resolveSessionThinkingLevel(undefined, 'medium')).toBe('medium')
    expect(resolveSessionThinkingLevel('minimal', 'medium')).toBe('minimal')
  })

  it('accepts the current max thinking level', () => {
    expect(resolveSessionThinkingLevel('max', 'medium')).toBe('max')
  })

  it('rejects retired thinking input through the Session creation boundary', async () => {
    const manager = new SessionManager({ resolveWorkspaceByNameOrId: () => workspace as never })
    const createWithUntrustedInput = manager.createSession.bind(manager) as unknown as (
      workspaceId: string,
      options: { hidden: true; thinkingLevel: string },
    ) => Promise<unknown>

    await expect(createWithUntrustedInput(workspace.id, {
      hidden: true,
      thinkingLevel: 'think',
    })).rejects.toMatchObject({
      name: 'InvalidSessionThinkingLevelError',
      code: 'SESSION_THINKING_LEVEL_INVALID',
      thinkingLevel: 'think',
    })
  })

  it('does not render retired namespaced session tools as current internal tools', async () => {
    await expect(resolveToolDisplayMeta('mcp__session__config_validate', {}, workspace.rootPath)).resolves.toBeUndefined()
    await expect(resolveToolDisplayMeta('config_validate', {}, workspace.rootPath)).resolves.toMatchObject({
      displayName: 'Validate Config',
      category: 'native',
    })
  })
})
