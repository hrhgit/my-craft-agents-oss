import { describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RPC_CHANNELS } from '@mortise/shared/protocol'
import type { HandlerDeps } from '../handler-deps'
import type { ISessionManager } from '../session-manager-interface'
import type { HandlerFn, RpcServer } from '../../transport'
import { registerSettingsHandlers } from './settings'

class TestRpcServer implements RpcServer {
  readonly handlers = new Map<string, HandlerFn>()
  handle(channel: string, handler: HandlerFn): void { this.handlers.set(channel, handler) }
  push(): void {}
  async invokeClient(): Promise<unknown> { return undefined }
  hasClientCapability(): boolean { return false }
  findClientsWithCapability(): string[] { return [] }
}

describe('Extension settings load boundary', () => {
  it('exposes runtime reload with the explicit interruption boundary', async () => {
    const server = new TestRpcServer()
    let interruptRunning: boolean | undefined
    registerSettingsHandlers(server, {
      sessionManager: {
        requestExtensionReload: async (value: boolean) => {
          interruptRunning = value
          return {
            status: 'reloaded' as const,
            interruptedSessionCount: value ? 1 : 0,
            reloadedSessionCount: 1,
            deferredSessionCount: 0,
          }
        },
      } as ISessionManager,
      platform: {} as HandlerDeps['platform'],
    })

    const handler = server.handlers.get(RPC_CHANNELS.piExtensions.RELOAD)
    expect(handler).toBeDefined()
    await handler!({} as never, { interruptRunning: true })
    expect(interruptRunning).toBe(true)
  })

  it('persists extension enabled state using the positional IPC arguments', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'mortise-extension-state-'))
    const previousAgentDir = process.env.MORTISE_AGENT_DIR
    process.env.MORTISE_AGENT_DIR = agentDir
    try {
      const server = new TestRpcServer()
      registerSettingsHandlers(server, {
        sessionManager: {} as ISessionManager,
        platform: {} as HandlerDeps['platform'],
      })

      const handler = server.handlers.get(RPC_CHANNELS.piExtensions.SET_EXTENSION_ENABLED)
      expect(handler).toBeDefined()
      await handler!({} as never, 'sample-extension', false)

      const settings = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8')) as {
        extensionConfig?: Record<string, { enabled?: boolean }>
      }
      expect(settings.extensionConfig?.['sample-extension']?.enabled).toBe(false)
      expect(settings.extensionConfig?.undefined).toBeUndefined()
    } finally {
      if (previousAgentDir === undefined) delete process.env.MORTISE_AGENT_DIR
      else process.env.MORTISE_AGENT_DIR = previousAgentDir
      await rm(agentDir, { recursive: true, force: true })
    }
  })
})
