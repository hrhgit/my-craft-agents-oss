import { describe, it, expect, afterEach, mock, beforeEach } from 'bun:test'
import {
  serializeEnvelope,
  deserializeEnvelope,
} from '@mortise/server-core/transport'
import type { SpawnedServer } from './server-spawner.ts'

// ---------------------------------------------------------------------------
// Mock WS server for run command tests
// ---------------------------------------------------------------------------

interface MockServerOptions {
  /** What pi:getGlobalProviders returns */
  providers?: unknown[]
}

interface MockServer {
  url: string
  token: string
  close: () => void
  /** Channels invoked by the client, in order */
  invokedChannels: string[]
  /** Arguments passed to sessions:create */
  createSessionArgs?: unknown[]
  /** All invocation args, keyed by channel */
  invokeArgs: Record<string, unknown[][]>
}

function pushSessionEvents(
  ws: any,
  sessionId: string,
  events: Array<Record<string, unknown>>,
): void {
  setTimeout(() => {
    for (const ev of events) {
      ws.send(serializeEnvelope({
        id: crypto.randomUUID(),
        type: 'event',
        channel: 'session:event',
        args: [{ sessionId, ...ev }],
      }))
    }
  }, 10)
}

function createMockServer(opts?: MockServerOptions): MockServer {
  const token = 'test-token'
  const invokedChannels: string[] = []
  const invokeArgs: Record<string, unknown[][]> = {}
  let createSessionArgs: unknown[] | undefined
  const providers = opts?.providers ?? []

  const server = Bun.serve({
    port: 0,
    fetch(req, svr) {
      if (svr.upgrade(req)) return undefined
      return new Response('Not found', { status: 404 })
    },
    websocket: {
      message(ws, message) {
        const raw = typeof message === 'string' ? message : new TextDecoder().decode(message)
        const envelope = deserializeEnvelope(raw)

        if (envelope.type === 'handshake') {
          ws.send(serializeEnvelope({
            id: crypto.randomUUID(),
            type: 'handshake_ack',
            clientId: 'run-test-client',
            protocolVersion: '1.0',
          }))
          return
        }

        if (envelope.type === 'request') {
          const ch = envelope.channel!
          invokedChannels.push(ch)
          if (!invokeArgs[ch]) invokeArgs[ch] = []
          invokeArgs[ch].push(envelope.args ?? [])

          let result: unknown
          switch (ch) {
            case 'workspaces:get':
              result = [{ id: 'ws-1', name: 'Test Workspace' }]
              break
            case 'workspaces:create':
              result = { id: 'ws-1', name: 'ci-workspace' }
              break
            case 'window:switchWorkspace':
              result = { ok: true }
              break
            case 'pi:getGlobalProviders':
              result = providers
              break
            case 'pi:saveGlobalProvider':
              result = { success: true }
              break
            case 'pi:setGlobalDefault':
              result = { success: true }
              break
            case 'sessions:create':
              createSessionArgs = envelope.args
              result = { id: 'run-session-1', name: 'run-test' }
              break
            case 'sessions:sendMessage': {
              ws.send(serializeEnvelope({
                id: envelope.id,
                type: 'response',
                channel: ch,
                result: { started: true },
              }))
              pushSessionEvents(ws, 'run-session-1', [
                { type: 'text_delta', delta: 'Hello ' },
                { type: 'text_delta', delta: 'World' },
                { type: 'complete' },
              ])
              return // already sent response
            }
            case 'sessions:delete':
              result = { deleted: true }
              break
            case 'sessions:cancel':
              result = { cancelled: true }
              break
            default:
              result = null
          }

          ws.send(serializeEnvelope({
            id: envelope.id,
            type: 'response',
            channel: ch,
            result,
          }))
        }
      },
    },
  })

  return {
    url: `ws://localhost:${server.port}`,
    token,
    close: () => server.stop(),
    invokedChannels,
    invokeArgs,
    get createSessionArgs() { return createSessionArgs },
  }
}

// ---------------------------------------------------------------------------
// Mock spawnServer so cmdRun doesn't actually launch a child process
// ---------------------------------------------------------------------------

let mockWsServer: MockServer | null = null

mock.module('./server-spawner.ts', () => ({
  spawnServer: async (): Promise<SpawnedServer> => {
    if (!mockWsServer) throw new Error('mockWsServer not initialized')
    return {
      url: mockWsServer.url,
      token: mockWsServer.token,
      stop: async () => {},
    }
  },
}))

// Import main AFTER mocking
const { parseArgs } = await import('./index.ts')

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('run command', () => {
  beforeEach(() => {
    mockWsServer = createMockServer()
  })

  afterEach(() => {
    mockWsServer?.close()
    mockWsServer = null
  })

  it('parseArgs: run with --source accumulates sources', () => {
    const args = parseArgs([
      'bun', 'index.ts',
      '--source', 'mortise-kb',
      '--source', 'github',
      'run', 'do', 'stuff',
    ])
    expect(args.command).toBe('run')
    expect(args.sources).toEqual(['mortise-kb', 'github'])
    expect(args.rest).toEqual(['do', 'stuff'])
  })

  it('parseArgs: --output-format stream-json', () => {
    const args = parseArgs([
      'bun', 'index.ts',
      '--output-format', 'stream-json',
      'run', 'test',
    ])
    expect(args.outputFormat).toBe('stream-json')
  })

  it('parseArgs: --no-cleanup flag', () => {
    const args = parseArgs([
      'bun', 'index.ts',
      '--no-cleanup',
      'run', 'test',
    ])
    expect(args.noCleanup).toBe(true)
  })

  it('creates session with correct workspace and options', async () => {
    // We can't easily call cmdRun directly since it calls process.exit.
    // Instead, test the mock server interaction via CliRpcClient to verify
    // the channels and args that cmdRun would invoke.
    const { CliRpcClient } = await import('./client.ts')

    const client = new CliRpcClient(mockWsServer!.url, {
      token: mockWsServer!.token,
      requestTimeout: 5_000,
    })
    await client.connect()

    // Simulate what cmdRun does: resolve workspace, create session
    const workspaces = await client.invoke('workspaces:get') as any[]
    expect(workspaces).toHaveLength(1)

    await client.invoke('window:switchWorkspace', workspaces[0].id)

    const session = await client.invoke('sessions:create', 'ws-1', {
      permissionMode: 'allow-all',
      enabledSourceSlugs: ['mortise-kb'],
    }) as { id: string }
    expect(session.id).toBe('run-session-1')

    // Verify the create args
    expect(mockWsServer!.createSessionArgs).toEqual([
      'ws-1',
      { permissionMode: 'allow-all', enabledSourceSlugs: ['mortise-kb'] },
    ])

    // Verify channel order
    expect(mockWsServer!.invokedChannels).toEqual([
      'workspaces:get',
      'window:switchWorkspace',
      'sessions:create',
    ])

    client.destroy()
  })

  it('streams text events from session', async () => {
    const { CliRpcClient } = await import('./client.ts')

    const client = new CliRpcClient(mockWsServer!.url, {
      token: mockWsServer!.token,
      requestTimeout: 5_000,
    })
    await client.connect()

    // Subscribe and collect text deltas
    const deltas: string[] = []
    let completed = false

    const unsub = client.on('session:event', (event: unknown) => {
      const ev = event as { type: string; sessionId: string; delta?: string }
      if (ev.sessionId !== 'run-session-1') return
      if (ev.type === 'text_delta') deltas.push(ev.delta!)
      if (ev.type === 'complete') completed = true
    })

    await client.invoke('sessions:sendMessage', 'run-session-1', 'test')

    // Wait for events
    const deadline = Date.now() + 5_000
    while (!completed && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50))
    }

    unsub()
    expect(completed).toBe(true)
    expect(deltas).toEqual(['Hello ', 'World'])

    client.destroy()
  })

  it('session delete is called in lifecycle', async () => {
    const { CliRpcClient } = await import('./client.ts')

    const client = new CliRpcClient(mockWsServer!.url, {
      token: mockWsServer!.token,
      requestTimeout: 5_000,
    })
    await client.connect()

    await client.invoke('sessions:create', 'ws-1', { permissionMode: 'allow-all' })
    await client.invoke('sessions:delete', 'run-session-1')

    expect(mockWsServer!.invokedChannels).toContain('sessions:create')
    expect(mockWsServer!.invokedChannels).toContain('sessions:delete')

    client.destroy()
  })

  it('spawnServer mock returns expected url and token', async () => {
    const { spawnServer } = await import('./server-spawner.ts')
    const server = await spawnServer()

    expect(server.url).toBe(mockWsServer!.url)
    expect(server.token).toBe(mockWsServer!.token)
    expect(typeof server.stop).toBe('function')
  })

  it('parseArgs: --workspace-dir sets workspaceDir', () => {
    const args = parseArgs([
      'bun', 'index.ts',
      '--workspace-dir', '/tmp/my-workspace',
      'run', 'hello',
    ])
    expect(args.workspaceDir).toBe('/tmp/my-workspace')
    expect(args.command).toBe('run')
  })

  it('parseArgs: workspaceDir defaults to undefined', () => {
    const args = parseArgs(['bun', 'index.ts', 'run', 'hello'])
    expect(args.workspaceDir).toBeUndefined()
  })

  it('workspace:create returns ID used directly (no workspaces:get needed)', async () => {
    const { CliRpcClient } = await import('./client.ts')

    const client = new CliRpcClient(mockWsServer!.url, {
      token: mockWsServer!.token,
      requestTimeout: 5_000,
    })
    await client.connect()

    // Simulate the workspace bootstrap path from cmdRun:
    // workspaces:create returns { id }, which is used directly
    const ws = (await client.invoke('workspaces:create', '/tmp/ws', 'ci-workspace')) as { id: string }
    expect(ws.id).toBe('ws-1')

    // Then switchWorkspace is called with the returned ID
    await client.invoke('window:switchWorkspace', ws.id)

    // Session is created with the bootstrapped workspace ID
    await client.invoke('sessions:create', ws.id, {
      permissionMode: 'allow-all',
      enabledSourceSlugs: ['mortise-public'],
    })

    expect(mockWsServer!.invokedChannels).toEqual([
      'workspaces:create',
      'window:switchWorkspace',
      'sessions:create',
    ])
    expect(mockWsServer!.invokeArgs['workspaces:create']![0]).toEqual(['/tmp/ws', 'ci-workspace'])

    client.destroy()
  })

  it('provider bootstrap calls save and setDefault when no providers exist', async () => {
    mockWsServer?.close()
    mockWsServer = createMockServer({ providers: [] })

    const { CliRpcClient } = await import('./client.ts')
    const client = new CliRpcClient(mockWsServer!.url, {
      token: mockWsServer!.token,
      requestTimeout: 5_000,
    })
    await client.connect()

    const providers = (await client.invoke('pi:getGlobalProviders')) as any[]
    expect(providers).toEqual([])

    await client.invoke('pi:saveGlobalProvider', {
      key: 'anthropic',
      provider: { models: [{ id: 'claude-sonnet-4-6' }] },
      apiKey: 'sk-test-key',
    })
    await client.invoke('pi:setGlobalDefault', { provider: 'anthropic', model: 'claude-sonnet-4-6' })

    expect(mockWsServer!.invokedChannels).toEqual([
      'pi:getGlobalProviders',
      'pi:saveGlobalProvider',
      'pi:setGlobalDefault',
    ])

    client.destroy()
  })

  it('provider bootstrap is skipped when providers already exist', async () => {
    mockWsServer?.close()
    mockWsServer = createMockServer({
      providers: [{ key: 'existing', name: 'Existing' }],
    })

    const { CliRpcClient } = await import('./client.ts')
    const client = new CliRpcClient(mockWsServer!.url, {
      token: mockWsServer!.token,
      requestTimeout: 5_000,
    })
    await client.connect()

    const providers = (await client.invoke('pi:getGlobalProviders')) as any[]
    expect(providers).toHaveLength(1)

    // No further LLM calls should be needed
    expect(mockWsServer!.invokedChannels).toEqual(['pi:getGlobalProviders'])

    client.destroy()
  })
})
