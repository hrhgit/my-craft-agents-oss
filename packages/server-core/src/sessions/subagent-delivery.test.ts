import { describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager, createManagedSession } from './SessionManager.ts'

type TestManagedSession = ReturnType<typeof createManagedSession>

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for subagent completion delivery')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

describe('SessionManager subagent completion delivery', () => {
  it('persists completion delivery and sends each operation once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-subagent-delivery-'))
    const ledgerPath = join(root, 'subagent-deliveries.json')
    const manager = new SessionManager()
    const managed = createManagedSession(
      { mortiseId: 'parent', name: 'Parent' },
      { id: 'workspace', name: 'Workspace', rootPath: root, createdAt: Date.now() } as never,
      { messagesLoaded: true },
    )
    let acknowledge: (() => void) | undefined
    const sendMessage = mock((...args: unknown[]) => {
      acknowledge = args[7] as (() => void) | undefined
      return new Promise<void>(() => {})
    })
    const internals = manager as unknown as {
      sessions: Map<string, TestManagedSession>
      getSubagentDeliveryLedgerPath: () => string
      recordBackgroundChildOperation: (
        managed: TestManagedSession,
        operation: { operationId: string; childSessionId: string; sessionPath: string },
      ) => Promise<void>
      settleBackgroundChildOperation: (
        managed: TestManagedSession,
        operation: {
          operationId: string
          childSessionId: string
          sessionPath: string
          status: 'completed'
          output: string
          modified: string
        },
      ) => Promise<void>
      sendMessage: typeof sendMessage
    }
    internals.sessions.set(managed.id, managed)
    internals.getSubagentDeliveryLedgerPath = () => ledgerPath
    internals.sendMessage = sendMessage
    const operation = {
      operationId: 'operation-1',
      childSessionId: 'child-1',
      sessionPath: join(root, 'child-1.jsonl'),
    }

    try {
      await internals.recordBackgroundChildOperation(managed, operation)
      const firstDelivery = internals.settleBackgroundChildOperation(managed, {
        ...operation,
        status: 'completed',
        output: 'Final child output',
        modified: '2026-07-27T00:00:00.000Z',
      })
      const concurrentRecovery = internals.settleBackgroundChildOperation(managed, {
        ...operation,
        status: 'completed',
        output: 'Final child output',
        modified: '2026-07-27T00:00:00.000Z',
      })
      await waitUntil(() => acknowledge !== undefined)

      expect(sendMessage).toHaveBeenCalledTimes(1)
      acknowledge?.()
      await Promise.all([firstDelivery, concurrentRecovery])
      await internals.settleBackgroundChildOperation(managed, {
        ...operation,
        status: 'completed',
        output: 'Final child output',
        modified: '2026-07-27T00:00:00.000Z',
      })

      expect(sendMessage).toHaveBeenCalledTimes(1)
      expect(sendMessage.mock.calls[0]?.[1]).toContain('Final child output')
      expect(JSON.parse(readFileSync(ledgerPath, 'utf8')).operations['operation-1']).toMatchObject({
        state: 'delivered',
        messageId: 'subagent-completion-operation-1',
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
