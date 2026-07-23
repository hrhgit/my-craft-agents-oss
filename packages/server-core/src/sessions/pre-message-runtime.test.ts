import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLAN_MODE_STATE_CUSTOM_TYPE } from '@mortise/core/types'
import { setSharedPiSessionsDirForTests } from '@mortise/shared/sessions'
import { SessionManager, createManagedSession } from './SessionManager.ts'

describe('SessionManager pre-message runtime preparation', () => {
  let manager: SessionManager
  let workspaceRoot: string

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'pre-message-runtime-'))
    setSharedPiSessionsDirForTests(join(workspaceRoot, 'pi-sessions'))
    manager = new SessionManager()
  })

  afterEach(async () => {
    await manager.cleanup()
    setSharedPiSessionsDirForTests(undefined)
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('creates an agent before invoking an extension command', async () => {
    const managed = createManagedSession(
      { mortiseId: 'pre-message-session', name: 'Pre-message session' },
      {
        id: 'pre-message-workspace',
        name: 'Pre-message workspace',
        rootPath: workspaceRoot,
        createdAt: Date.now(),
      } as never,
      { messagesLoaded: true },
    )
    const extensionAgent = {
      dispose: jest.fn(() => undefined),
      sendExtensionCommandInvoke: jest.fn(async () => ({
        invoked: true,
        customMessages: [{
          customType: PLAN_MODE_STATE_CUSTOM_TYPE,
          content: '',
          display: false,
          details: {
            schemaVersion: 1,
            state: { schemaVersion: 1, phase: 'discussing', updatedAt: 1 },
          },
          timestamp: 1,
        }],
      })),
    }
    const getOrCreateAgent = jest.fn(async () => {
      managed.agent = extensionAgent as never
      return extensionAgent
    })

    ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(managed.id, managed)
    ;(
      manager as unknown as {
        getOrCreateAgent: (session: unknown) => Promise<typeof extensionAgent>
      }
    ).getOrCreateAgent = getOrCreateAgent

    const result = await manager.invokeExtensionCommand(managed.id, 'plan-mode', 'discussion')

    expect(getOrCreateAgent).toHaveBeenCalledTimes(1)
    expect(getOrCreateAgent).toHaveBeenCalledWith(managed)
    expect(extensionAgent.sendExtensionCommandInvoke).toHaveBeenCalledWith('plan-mode', 'discussion')
    expect(result.invoked).toBe(true)
    expect(managed.planModeState?.phase).toBe('discussing')
    await manager.flushSession(managed.id)
  })
})
