import { describe, expect, it, mock } from 'bun:test'
import {
  AUTOMATION_INGRESS_TOKEN_RPC_CHANNEL,
  AUTOMATION_WORKSPACE_RPC_CHANNEL,
} from '@mortise/server-core/handlers/automation-workspace'
import { invokeAutomationIngressToken, invokeAutomationWorkspace } from './automation-client.ts'

describe('typed automation CLI client', () => {
  it('uses the canonical RPC ingress and validates its result', async () => {
    const invoke = mock(async () => ({ schemaVersion: 1, status: 'ok', revision: 1, data: [] }))
    const result = await invokeAutomationWorkspace({ invoke } as any, { schemaVersion: 1, operation: 'list' })
    expect(result).toMatchObject({ status: 'ok', data: [] })
    expect(invoke).toHaveBeenCalledWith(AUTOMATION_WORKSPACE_RPC_CHANNEL, { schemaVersion: 1, operation: 'list' })
  })

  it('rejects malformed commands before sending them', async () => {
    const invoke = mock(async () => null)
    await expect(invokeAutomationWorkspace({ invoke } as any, { operation: 'list' })).rejects.toThrow()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('never expects token material from lifecycle commands', async () => {
    const invoke = mock(async () => ({ schemaVersion: 1, workspaceId: 'workspace-1', path: 'token.json' }))
    const result = await invokeAutomationIngressToken({ invoke } as any, 'show-path')
    expect(result).toEqual({ schemaVersion: 1, workspaceId: 'workspace-1', path: 'token.json' })
    expect(invoke).toHaveBeenCalledWith(AUTOMATION_INGRESS_TOKEN_RPC_CHANNEL, { operation: 'show-path' })
  })
})
