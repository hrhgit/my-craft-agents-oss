import { afterEach, describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HandlerFn, RpcServer } from '../../transport/types.ts'
import { AutomationIngressTokenRegistry } from '../../services/automation-ingress-token-registry.ts'
import {
  AUTOMATION_INGRESS_TOKEN_RPC_CHANNEL,
  AUTOMATION_WORKSPACE_RPC_CHANNEL,
  registerAutomationWorkspaceRpcHandlers,
} from '../automation-workspace.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function setup() {
  const handlers = new Map<string, HandlerFn>()
  const server = {
    handle: (channel: string, handler: HandlerFn) => { handlers.set(channel, handler) },
  } as unknown as RpcServer
  const root = mkdtempSync(join(tmpdir(), 'mortise-automation-rpc-'))
  roots.push(root)
  const execute = mock(async (..._args: unknown[]) => ({ schemaVersion: 1 as const, status: 'ok' as const, revision: 1, data: [] }))
  registerAutomationWorkspaceRpcHandlers(server, {
    dispatcher: { execute },
    tokens: new AutomationIngressTokenRegistry(root),
  })
  return { handlers, execute }
}

const context = { clientId: 'client-1', workspaceId: 'workspace-1', webContentsId: null }

describe('automation workspace RPC ingress', () => {
  it('uses the authenticated workspace and Mortise source identity', async () => {
    const { handlers, execute } = setup()
    const result = await handlers.get(AUTOMATION_WORKSPACE_RPC_CHANNEL)!(context, { schemaVersion: 1, operation: 'list' })
    expect(result).toMatchObject({ schemaVersion: 1, status: 'ok', data: [] })
    expect(execute).toHaveBeenCalledWith(
      'workspace-1',
      { schemaVersion: 1, operation: 'list' },
      { eventSourceKind: 'mortise' },
    )
  })

  it('requires a workspace binding and rejects non-canonical DTO fields', async () => {
    const { handlers, execute } = setup()
    await expect(handlers.get(AUTOMATION_WORKSPACE_RPC_CHANNEL)!({ ...context, workspaceId: null }, { schemaVersion: 1, operation: 'list' })).rejects.toThrow('authenticated workspace')
    await expect(handlers.get(AUTOMATION_WORKSPACE_RPC_CHANNEL)!(context, { schemaVersion: 1, operation: 'list', workspaceId: 'spoofed' })).rejects.toThrow()
    expect(execute).not.toHaveBeenCalled()
  })

  it('rotates tokens without returning the credential', async () => {
    const { handlers } = setup()
    const show = await handlers.get(AUTOMATION_INGRESS_TOKEN_RPC_CHANNEL)!(context, { operation: 'show-path' }) as Record<string, unknown>
    const rotate = await handlers.get(AUTOMATION_INGRESS_TOKEN_RPC_CHANNEL)!(context, { operation: 'rotate' }) as Record<string, unknown>
    expect(show.path).toBe(rotate.path)
    expect(show.token).toBeUndefined()
    expect(rotate.token).toBeUndefined()
  })
})
