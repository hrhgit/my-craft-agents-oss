import { describe, expect, it } from 'bun:test'
import { RPC_CHANNELS } from '@mortise/shared/protocol'
import {
  CLIENT_OPEN_EXTERNAL,
  CLIENT_OPEN_PATH,
  CLIENT_SHOW_IN_FOLDER,
} from '@mortise/server-core/transport'
import type { RpcServer, HandlerFn, RequestContext } from '@mortise/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { registerSystemCoreHandlers } from './system'

function createTestHarness(overrides?: {
  workspaceId?: string | null
  capabilities?: string[]
  platform?: Partial<HandlerDeps['platform']>
  invokeError?: Error & { code?: string }
}) {
  const handlers = new Map<string, HandlerFn>()
  const invokeClientCalls: Array<{ clientId: string; channel: string; args: any[] }> = []
  const pushCalls: Array<{ channel: string; target: any; args: any[] }> = []
  const capabilities = new Set(overrides?.capabilities ?? [CLIENT_OPEN_EXTERNAL])

  const server: RpcServer = {
    handle(channel, handler) {
      handlers.set(channel, handler)
    },
    push(channel, target, ...args) {
      pushCalls.push({ channel, target, args })
    },
    async invokeClient(clientId, channel, ...args) {
      invokeClientCalls.push({ clientId, channel, args })
      if (overrides?.invokeError) throw overrides.invokeError
      return undefined
    },
    hasClientCapability(_clientId, capability) { return capabilities.has(capability) },
    findClientsWithCapability() { return [] },
  }

  const deps: HandlerDeps = {
    sessionManager: {} as HandlerDeps['sessionManager'],
    platform: {
      appRootPath: '/',
      resourcesPath: '/',
      isPackaged: false,
      appVersion: '0.0.0-test',
      isDebugMode: true,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      imageProcessor: {
        getMetadata: async () => null,
        process: async () => Buffer.from(''),
      },
      ...overrides?.platform,
    },
  }

  registerSystemCoreHandlers(server, deps)

  const ctx: RequestContext = {
    clientId: 'client-1',
    workspaceId: overrides?.workspaceId ?? 'ws-1',
    webContentsId: 101,
  }

  const handler = (channel: string): HandlerFn => {
    const registered = handlers.get(channel)
    if (!registered) throw new Error(`${channel} handler not registered`)
    return registered
  }

  return {
    openUrl: handler(RPC_CHANNELS.shell.OPEN_URL),
    handler,
    ctx,
    invokeClientCalls,
    pushCalls,
  }
}

describe('registerSystemCoreHandlers OPEN_URL', () => {
  it('routes mortise action links internally via deeplink:navigate', async () => {
    const { openUrl, ctx, invokeClientCalls, pushCalls } = createTestHarness()

    await openUrl(ctx, 'mortise://action/new-session?input=sg&send=true')

    expect(invokeClientCalls).toHaveLength(0)
    expect(pushCalls).toHaveLength(1)
    expect(pushCalls[0]).toEqual({
      channel: RPC_CHANNELS.deeplink.NAVIGATE,
      target: { to: 'client', clientId: 'client-1' },
      args: [{ action: 'new-session', actionParams: { input: 'sg', send: 'true' } }],
    })
  })

  it('routes workspace deep links to workspace target when URL workspace differs', async () => {
    const { openUrl, ctx, invokeClientCalls, pushCalls } = createTestHarness({ workspaceId: 'ws-1' })

    await openUrl(ctx, 'mortise://workspace/ws-2/action/new-session?input=hello')

    expect(invokeClientCalls).toHaveLength(0)
    expect(pushCalls).toHaveLength(1)
    expect(pushCalls[0]).toEqual({
      channel: RPC_CHANNELS.deeplink.NAVIGATE,
      target: { to: 'workspace', workspaceId: 'ws-2' },
      args: [{ action: 'new-session', actionParams: { input: 'hello' } }],
    })
  })

  it('falls back to client openExternal for mortise window-mode links', async () => {
    const { openUrl, ctx, invokeClientCalls, pushCalls } = createTestHarness()

    await openUrl(ctx, 'mortise://action/new-session?window=focused')

    expect(pushCalls).toHaveLength(0)
    expect(invokeClientCalls).toHaveLength(1)
    expect(invokeClientCalls[0]).toEqual({
      clientId: 'client-1',
      channel: CLIENT_OPEN_EXTERNAL,
      args: ['mortise://action/new-session?window=focused'],
    })
  })

  it('keeps forwarding normal http URLs via client openExternal', async () => {
    const { openUrl, ctx, invokeClientCalls } = createTestHarness()

    await openUrl(ctx, 'https://example.com')

    expect(invokeClientCalls).toHaveLength(1)
    expect(invokeClientCalls[0]).toEqual({
      clientId: 'client-1',
      channel: CLIENT_OPEN_EXTERNAL,
      args: ['https://example.com'],
    })
  })

  it('rejects unsupported protocols with a per-scheme reason', async () => {
    const { openUrl, ctx } = createTestHarness()

    // OPEN_URL uses a blocklist (url-safety.ts) and rejects known-dangerous
    // schemes by name. file: is one of them — and the most important on
    // Windows where it's an RCE vector. The thrown error includes the
    // scheme in parens and a human-readable reason so the renderer can
    // show a useful toast instead of a generic "Invalid URL".
    await expect(openUrl(ctx, 'file:///tmp/test.txt')).rejects.toThrow(
      /^Failed to open URL: URL blocked \(file:\)\. file: URLs are blocked /,
    )
  })

  it('rejects javascript: URLs with the JavaScript-specific reason', async () => {
    const { openUrl, ctx } = createTestHarness()

    await expect(openUrl(ctx, 'javascript:alert(1)')).rejects.toThrow(
      /^Failed to open URL: URL blocked \(javascript:\)\. JavaScript URLs /,
    )
  })

  it('rejects malformed URLs through the shared classifier instead of raw URL parsing', async () => {
    const { openUrl, ctx } = createTestHarness()

    await expect(openUrl(ctx, 'not a url')).rejects.toThrow(
      /^Failed to open URL: URL blocked\. URL is malformed and cannot be parsed\./,
    )
  })

  it('returns a stable typed error when no client or platform can open a URL', async () => {
    const { openUrl, ctx } = createTestHarness({ capabilities: [] })

    let caught: unknown
    try {
      await openUrl(ctx, 'https://example.com')
    } catch (error) {
      caught = error
    }

    expect((caught as { code?: string }).code).toBe('CAPABILITY_UNAVAILABLE')
    expect((caught as Error).message).toBe(
      'Open URL is unavailable because neither the requesting client nor this platform implements it',
    )
  })

  it('preserves a typed unavailable error when client capability disappears during dispatch', async () => {
    const unavailable = Object.assign(new Error('Client lacks capability: client:openExternal'), {
      code: 'CAPABILITY_UNAVAILABLE',
    })
    const { openUrl, ctx } = createTestHarness({ invokeError: unavailable })

    let caught: unknown
    try {
      await openUrl(ctx, 'https://example.com')
    } catch (error) {
      caught = error
    }

    expect(caught).toBe(unavailable)
    expect((caught as { code?: string }).code).toBe('CAPABILITY_UNAVAILABLE')
  })
})

describe('registerSystemCoreHandlers native file actions', () => {
  it.each([
    [RPC_CHANNELS.shell.OPEN_FILE, 'Open file'],
    [RPC_CHANNELS.shell.SHOW_IN_FOLDER, 'Show in folder'],
  ])('returns CAPABILITY_UNAVAILABLE for %s without a capable client or platform', async (channel, action) => {
    const { handler, ctx } = createTestHarness({ capabilities: [] })

    let caught: unknown
    try {
      await handler(channel)(ctx, process.env.USERPROFILE ?? process.cwd())
    } catch (error) {
      caught = error
    }

    expect((caught as { code?: string }).code).toBe('CAPABILITY_UNAVAILABLE')
    expect((caught as Error).message).toBe(
      `${action} is unavailable because neither the requesting client nor this platform implements it`,
    )
  })

  it.each([
    [RPC_CHANNELS.shell.OPEN_FILE, CLIENT_OPEN_PATH],
    [RPC_CHANNELS.shell.SHOW_IN_FOLDER, CLIENT_SHOW_IN_FOLDER],
  ])('routes %s through an advertised client capability', async (channel, capability) => {
    const { handler, ctx, invokeClientCalls } = createTestHarness({ capabilities: [capability] })
    const path = process.env.USERPROFILE ?? process.cwd()

    await handler(channel)(ctx, path)

    expect(invokeClientCalls).toHaveLength(1)
    expect(invokeClientCalls[0]?.channel).toBe(capability)
  })
})
