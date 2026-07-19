import { describe, expect, it, mock } from 'bun:test'
import { PiAgent } from '../pi-agent.ts'
import type { BackendConfig } from '../backend/types.ts'

function createConfig(): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'workspace',
      name: 'Workspace',
      rootPath: process.cwd(),
    } as never,
    session: {
      mortiseId: 'mortise-parent',
      workspaceRootPath: process.cwd(),
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as never,
    isHeadless: true,
  }
}

describe('PiAgent child session listing', () => {
  it('queries with the runtime session ID established during RPC readiness', async () => {
    const agent = new PiAgent(createConfig())
    const listChildSessions = mock(async () => [])
    ;(agent as unknown as { ensureRpcClient: () => Promise<unknown> }).ensureRpcClient = async () => {
      agent.setSessionId('pi-parent')
      return { listChildSessions }
    }
    ;(agent as unknown as { requirePiRpcCommand: () => void }).requirePiRpcCommand = () => {}

    await expect(agent.listChildSessions('mortise-parent')).resolves.toEqual([])
    expect(listChildSessions).toHaveBeenCalledWith('pi-parent')
    agent.destroy()
  })
})
