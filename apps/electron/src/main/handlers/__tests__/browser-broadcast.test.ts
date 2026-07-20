/**
 * Tests for browser handler broadcast, ownership, and LIST.
 *
 * Instance commands and LIST enforce configured local/remote workspace
 * ownership in the main process. Broadcasts remain broad because renderer
 * subscriptions are shared, but renderer registries discard foreign state.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test'
import type { RpcServer } from '@mortise/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { RPC_CHANNELS, type BrowserInstanceInfo } from '@mortise/shared/protocol'

const remoteWorkspaceAliases = new Map<string, string>()

mock.module('electron', () => ({
  ipcMain: { handle: () => {}, on: () => {} },
}))
mock.module('@mortise/shared/config', () => ({
  getWorkspaceByNameOrId: (workspaceId: string) => {
    const remoteWorkspaceId = remoteWorkspaceAliases.get(workspaceId)
    return remoteWorkspaceId ? { id: workspaceId, remoteServer: { remoteWorkspaceId } } : null
  },
}))

type HandlerFn = (...args: unknown[]) => unknown
type Push = { channel: string; target: unknown; args: unknown[] }

interface Recorder {
  server: RpcServer
  handlers: Map<string, HandlerFn>
  pushes: Push[]
}

function makeServer(): Recorder {
  const handlers = new Map<string, HandlerFn>()
  const pushes: Push[] = []
  const server: RpcServer = {
    handle(channel, handler) {
      handlers.set(channel, handler as HandlerFn)
    },
    push(channel, target, ...args) {
      pushes.push({ channel, target, args })
    },
    async invokeClient() {},
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  }
  return { server, handlers, pushes }
}

function makeInstance(id: string, overrides?: Partial<BrowserInstanceInfo>): BrowserInstanceInfo {
  return {
    id,
    url: 'https://example.com',
    title: 'Example',
    favicon: null,
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    boundSessionId: null,
    ownerType: 'manual',
    ownerSessionId: null,
    isVisible: true,
    agentControlActive: false,
    themeColor: null,
    workspaceId: null,
    ...overrides,
  }
}

function makeDeps(opts: {
  instances: BrowserInstanceInfo[]
  captureStateCb?: (cb: (info: BrowserInstanceInfo) => void) => void
  captureRemovedCb?: (cb: (id: string) => void) => void
  captureInteractedCb?: (cb: (id: string) => void) => void
}): HandlerDeps {
  return {
    sessionManager: {} as HandlerDeps['sessionManager'],
    platform: {
      appRootPath: '',
      resourcesPath: '',
      isPackaged: false,
      appVersion: '0.0.0-test',
      isDebugMode: false,
      logger: console,
      imageProcessor: {
        getMetadata: async () => null,
        process: async () => Buffer.from(''),
      },
    },
    windowManager: {} as HandlerDeps['windowManager'],
    browserPaneManager: {
      listInstances: () => opts.instances,
      listInstancesForWorkspace: (workspaceId: string | null) =>
        opts.instances.filter(instance => instance.workspaceId === workspaceId),
      listInstancesForWorkspaceAliases: (workspaceIds: readonly (string | null)[]) => {
        const allowed = new Set(workspaceIds)
        return opts.instances.filter(instance => allowed.has(instance.workspaceId ?? null))
      },
      assertInstanceOwnedByWorkspace: (id: string, workspaceId: string | null) => {
        const instance = opts.instances.find(candidate => candidate.id === id)
        if (!instance) throw new Error(`Browser instance not found: ${id}`)
        if (instance.workspaceId !== workspaceId) {
          throw new Error(`Browser instance does not belong to the active workspace: ${id}`)
        }
      },
      assertInstanceOwnedByWorkspaceAliases: (id: string, workspaceIds: readonly (string | null)[]) => {
        const instance = opts.instances.find(candidate => candidate.id === id)
        if (!instance) throw new Error(`Browser instance not found: ${id}`)
        if (!new Set(workspaceIds).has(instance.workspaceId ?? null)) {
          throw new Error(`Browser instance does not belong to the active workspace: ${id}`)
        }
      },
      getBoundForSession: (sessionId: string) =>
        opts.instances.find(instance => instance.ownerType === 'session' && instance.ownerSessionId === sessionId)?.id ?? null,
      onStateChange: (cb: (info: BrowserInstanceInfo) => void) => opts.captureStateCb?.(cb),
      onRemoved: (cb: (id: string) => void) => opts.captureRemovedCb?.(cb),
      onInteracted: (cb: (id: string) => void) => opts.captureInteractedCb?.(cb),
    } as unknown as NonNullable<HandlerDeps['browserPaneManager']>,
  }
}

beforeEach(() => {
  remoteWorkspaceAliases.clear()
})

describe('browser handler — workspace filtering', () => {
  let recorder: Recorder

  beforeEach(() => {
    recorder = makeServer()
  })

  describe('STATE_CHANGED broadcast target', () => {
    it('always broadcasts to all renderers (workspace-aware-filtering happens in the renderer)', async () => {
      let captured: ((info: BrowserInstanceInfo) => void) | null = null
      const { registerBrowserHandlers } = await import('../browser')
      registerBrowserHandlers(
        recorder.server,
        makeDeps({
          instances: [],
          captureStateCb: (cb) => { captured = cb },
        }),
      )

      expect(captured).not.toBeNull()
      // Workspace-stamped instance broadcasts to all (renderer will filter).
      captured!(makeInstance('b-ws', { workspaceId: 'ws-1' }))
      expect(recorder.pushes).toHaveLength(1)
      expect(recorder.pushes[0].target).toEqual({ to: 'all' })

      // Unbound instance also broadcasts to all.
      captured!(makeInstance('b-unbound', { workspaceId: null }))
      expect(recorder.pushes).toHaveLength(2)
      expect(recorder.pushes[1].target).toEqual({ to: 'all' })
    })
  })

  describe('REMOVED / INTERACTED stay broadcast-to-all', () => {
    it('REMOVED uses { to: "all" } even when the entry was workspace-scoped', async () => {
      let captured: ((id: string) => void) | null = null
      const { registerBrowserHandlers } = await import('../browser')
      registerBrowserHandlers(
        recorder.server,
        makeDeps({
          instances: [],
          captureRemovedCb: (cb) => { captured = cb },
        }),
      )

      captured!('b-removed')

      expect(recorder.pushes).toHaveLength(1)
      expect(recorder.pushes[0].target).toEqual({ to: 'all' })
      // Payload is id-only — workspaces that never saw the entry simply no-op.
      expect(recorder.pushes[0].args).toEqual(['b-removed'])
    })

    it('INTERACTED uses { to: "all" }', async () => {
      let captured: ((id: string) => void) | null = null
      const { registerBrowserHandlers } = await import('../browser')
      registerBrowserHandlers(
        recorder.server,
        makeDeps({
          instances: [],
          captureInteractedCb: (cb) => { captured = cb },
        }),
      )

      captured!('b-interacted')

      expect(recorder.pushes).toHaveLength(1)
      expect(recorder.pushes[0].target).toEqual({ to: 'all' })
    })
  })

  describe('LIST handler', () => {
    function callListHandler(workspaceId: string | null): BrowserInstanceInfo[] {
      const listChannel = Array.from(recorder.handlers.keys())
        .find((ch) => ch.endsWith(':list') && ch.includes('browser'))
      if (!listChannel) throw new Error('LIST handler not registered')
      const handler = recorder.handlers.get(listChannel)!
      return handler({ clientId: 'c1', workspaceId, webContentsId: null }) as BrowserInstanceInfo[]
    }

    it('returns only instances owned by ctx.workspaceId', async () => {
      const instances = [
        makeInstance('local-tab', { workspaceId: 'local-ws' }),
        makeInstance('remote-tab', { workspaceId: 'remote-ws' }),
        makeInstance('unbound', { workspaceId: null }),
      ]
      const { registerBrowserHandlers } = await import('../browser')
      registerBrowserHandlers(recorder.server, makeDeps({ instances }))

      expect(callListHandler('local-ws').map((i) => i.id)).toEqual(['local-tab'])
      expect(callListHandler('remote-ws').map((i) => i.id)).toEqual(['remote-tab'])
      expect(callListHandler(null)).toEqual([])
    })

    it('includes only the configured remote mirror for a local workspace', async () => {
      remoteWorkspaceAliases.set('local-ws', 'remote-ws')
      const instances = [
        makeInstance('local-tab', { workspaceId: 'local-ws' }),
        makeInstance('remote-tab', { workspaceId: 'remote-ws' }),
        makeInstance('foreign-tab', { workspaceId: 'foreign-ws' }),
        makeInstance('unbound', { workspaceId: null }),
      ]
      const { registerBrowserHandlers } = await import('../browser')
      registerBrowserHandlers(recorder.server, makeDeps({ instances }))

      expect(callListHandler('local-ws').map((i) => i.id)).toEqual(['local-tab', 'remote-tab'])
    })
  })
})

describe('browser handler — workspace command ownership', () => {
  it('requires renderer-created browsers to carry a workspace identity', async () => {
    const recorder = makeServer()
    const calls: unknown[][] = []
    const deps = makeDeps({ instances: [] })
    Object.assign(deps.browserPaneManager!, {
      createInstance: (...args: unknown[]) => {
        calls.push(args)
        return 'created-browser'
      },
    })
    const { registerBrowserHandlers } = await import('../browser')
    registerBrowserHandlers(recorder.server, deps)
    const create = recorder.handlers.get(RPC_CHANNELS.browserPane.CREATE)!

    expect(() => create(
      { clientId: 'client', workspaceId: null, webContentsId: 42 },
      { show: false },
    )).toThrow('Browser creation requires a workspaceId')
    expect(create(
      { clientId: 'client', workspaceId: 'workspace-a', webContentsId: 42 },
      { show: false, workspaceId: 'workspace-a' },
    )).toBe('created-browser')
    expect(calls).toEqual([[undefined, { show: false, workspaceId: 'workspace-a' }]])
  })

  it('allows commands for the configured remote mirror but not an unrelated workspace', async () => {
    remoteWorkspaceAliases.set('workspace-local', 'workspace-remote')
    const recorder = makeServer()
    const calls: unknown[][] = []
    const deps = makeDeps({
      instances: [
        makeInstance('remote-browser', { workspaceId: 'workspace-remote' }),
        makeInstance('foreign-browser', { workspaceId: 'workspace-foreign' }),
      ],
    })
    Object.assign(deps.browserPaneManager!, {
      detachFromHost: (...args: unknown[]) => calls.push(args),
    })
    const { registerBrowserHandlers } = await import('../browser')
    registerBrowserHandlers(recorder.server, deps)
    const detach = recorder.handlers.get(RPC_CHANNELS.browserPane.DETACH)!
    const ctx = { clientId: 'client', workspaceId: 'workspace-local', webContentsId: 42 }

    expect(() => detach(ctx, 'remote-browser')).not.toThrow()
    expect(calls).toEqual([['remote-browser', 42]])
    expect(() => detach(ctx, 'foreign-browser'))
      .toThrow('Browser instance does not belong to the active workspace')
  })

  it('rejects every id-based command for an instance from another workspace', async () => {
    const recorder = makeServer()
    const deps = makeDeps({
      instances: [makeInstance('foreign-browser', { workspaceId: 'workspace-b' })],
    })
    const { registerBrowserHandlers } = await import('../browser')
    registerBrowserHandlers(recorder.server, deps)
    const ctx = { clientId: 'client', workspaceId: 'workspace-a', webContentsId: 42 }
    const embedBounds = { x: 10, y: 20, width: 300, height: 500 }
    const cases: Array<[string, unknown[]]> = [
      [RPC_CHANNELS.browserPane.EMBED, ['foreign-browser', embedBounds]],
      [RPC_CHANNELS.browserPane.UPDATE_EMBED_BOUNDS, ['foreign-browser', embedBounds]],
      [RPC_CHANNELS.browserPane.DETACH, ['foreign-browser']],
      [RPC_CHANNELS.browserPane.DESTROY, ['foreign-browser']],
      [RPC_CHANNELS.browserPane.NAVIGATE, ['foreign-browser', 'https://example.com']],
      [RPC_CHANNELS.browserPane.GO_BACK, ['foreign-browser']],
      [RPC_CHANNELS.browserPane.GO_FORWARD, ['foreign-browser']],
      [RPC_CHANNELS.browserPane.RELOAD, ['foreign-browser']],
      [RPC_CHANNELS.browserPane.STOP, ['foreign-browser']],
      [RPC_CHANNELS.browserPane.FOCUS, ['foreign-browser']],
      [RPC_CHANNELS.browserPane.SNAPSHOT, ['foreign-browser']],
      [RPC_CHANNELS.browserPane.CLICK, ['foreign-browser', '@e1']],
      [RPC_CHANNELS.browserPane.FILL, ['foreign-browser', '@e1', 'value']],
      [RPC_CHANNELS.browserPane.SELECT, ['foreign-browser', '@e1', 'value']],
      [RPC_CHANNELS.browserPane.SCREENSHOT, ['foreign-browser']],
      [RPC_CHANNELS.browserPane.EVALUATE, ['foreign-browser', 'document.title']],
      [RPC_CHANNELS.browserPane.SCROLL, ['foreign-browser', 'down', 100]],
    ]

    for (const [channel, args] of cases) {
      const handler = recorder.handlers.get(channel)
      expect(handler).toBeDefined()
      await expect(Promise.resolve().then(() => handler!(ctx, ...args)))
        .rejects.toThrow('Browser instance does not belong to the active workspace')
    }
  })

  it('rejects reuse of an explicit browser id owned by another workspace', async () => {
    const recorder = makeServer()
    const deps = makeDeps({
      instances: [makeInstance('foreign-browser', { workspaceId: 'workspace-b' })],
    })
    const { registerBrowserHandlers } = await import('../browser')
    registerBrowserHandlers(recorder.server, deps)
    const create = recorder.handlers.get(RPC_CHANNELS.browserPane.CREATE)!

    expect(() => create(
      { clientId: 'client', workspaceId: 'workspace-a', webContentsId: 42 },
      { id: 'foreign-browser' },
    )).toThrow('Browser instance does not belong to the active workspace')
  })

  it('rejects rebinding a session-owned browser from another workspace', async () => {
    const recorder = makeServer()
    const deps = makeDeps({
      instances: [makeInstance('foreign-browser', {
        workspaceId: 'workspace-b',
        ownerType: 'session',
        ownerSessionId: 'session-1',
      })],
    })
    const { registerBrowserHandlers } = await import('../browser')
    registerBrowserHandlers(recorder.server, deps)
    const create = recorder.handlers.get(RPC_CHANNELS.browserPane.CREATE)!

    expect(() => create(
      { clientId: 'client', workspaceId: 'workspace-a', webContentsId: 42 },
      { bindToSessionId: 'session-1' },
    )).toThrow('Browser instance does not belong to the active workspace')
  })
})

describe('browser handler — workbench embedding', () => {
  it('binds embed operations to the requesting renderer webContents', async () => {
    const recorder = makeServer()
    const calls: unknown[][] = []
    const deps = makeDeps({
      instances: [makeInstance('browser-1', { workspaceId: 'workspace' })],
    })
    Object.assign(deps.browserPaneManager!, {
      embedInHost: (...args: unknown[]) => calls.push(['embed', ...args]),
      updateEmbeddedBounds: (...args: unknown[]) => calls.push(['resize', ...args]),
      detachFromHost: (...args: unknown[]) => calls.push(['detach', ...args]),
    })
    const { registerBrowserHandlers } = await import('../browser')
    registerBrowserHandlers(recorder.server, deps)
    const ctx = { clientId: 'client', workspaceId: 'workspace', webContentsId: 42 }
    const bounds = { x: 10, y: 20, width: 300, height: 500 }

    recorder.handlers.get(RPC_CHANNELS.browserPane.EMBED)!(ctx, 'browser-1', bounds)
    recorder.handlers.get(RPC_CHANNELS.browserPane.UPDATE_EMBED_BOUNDS)!(ctx, 'browser-1', bounds)
    recorder.handlers.get(RPC_CHANNELS.browserPane.DETACH)!(ctx, 'browser-1')

    expect(calls).toEqual([
      ['embed', 'browser-1', 42, bounds],
      ['resize', 'browser-1', 42, bounds],
      ['detach', 'browser-1', 42],
    ])
  })
})
