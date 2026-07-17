import { describe, expect, it } from 'bun:test'
import { RPC_CHANNELS } from '../../../shared/types'
import type { AppLayout } from '../../../shared/app-layout'
import { registerLayoutHandlers } from '../layout'
import type { HandlerDeps } from '../handler-deps'

function register(overrides: {
  createAuxiliaryWindow?: () => unknown
} = {}) {
  const handlers = new Map<string, (...args: any[]) => any>()
  const calls: Array<[string, ...unknown[]]> = []
  const layout = { workspaceId: 'ws-a' } as AppLayout
  const bounds = { x: 100, y: 80, width: 900, height: 700 }
  const coordinator = {
    getSnapshot: () => layout,
    saveSnapshot: () => layout,
    saveWindowSnapshot: (layoutWindowId: string) => {
      calls.push(['saveWindow', layoutWindowId])
      return layout
    },
    detachTab: (workspaceId: string, tabId: string, windowId: string, resolved: unknown) => {
      calls.push(['detachTab', workspaceId, tabId, windowId, resolved])
      return layout
    },
    detachGroup: () => layout,
    redockWindow: (windowId: string, workspaceId: string) => {
      calls.push(['redock', windowId, workspaceId])
      return layout
    },
  }
  const windowManager = {
    getWorkspaceForWindow: (webContentsId: number) => [42, 43, 44].includes(webContentsId) ? 'ws-a' : null,
    getLayoutWriteContext: (webContentsId: number) => webContentsId === 42
      ? { workspaceId: 'ws-a', layoutWindowId: 'primary', role: 'primary', ownerWebContentsId: 42 }
      : webContentsId === 44
        ? { workspaceId: 'ws-a', layoutWindowId: 'aux-one', role: 'auxiliary', ownerWebContentsId: 42 }
        : null,
    resolveAuxiliaryWindowBounds: (webContentsId: number, requested: unknown) => {
      calls.push(['resolveBounds', webContentsId, requested])
      return bounds
    },
    createAuxiliaryWindow: overrides.createAuxiliaryWindow ?? ((windowId: string, workspaceId: string, parentId: number, resolved: unknown) => {
      calls.push(['createWindow', windowId, workspaceId, parentId, resolved])
    }),
  }
  registerLayoutHandlers({
    handle(channel: string, handler: (...args: any[]) => any) { handlers.set(channel, handler) },
  } as any, {
    layoutCoordinator: coordinator,
    windowManager,
  } as unknown as HandlerDeps)
  return { handlers, calls, bounds }
}

describe('layout handlers', () => {
  it('detaches one tab and creates its auxiliary window with resolved bounds', () => {
    const { handlers, calls, bounds } = register()
    handlers.get(RPC_CHANNELS.layout.DETACH_TAB)!(
      { clientId: 'client', workspaceId: 'ws-a', webContentsId: 42 },
      'tab-a',
      { x: 5, y: 6, width: 700, height: 500 },
    )

    expect(calls[0]?.[0]).toBe('resolveBounds')
    expect(calls[1]?.slice(0, 3)).toEqual(['detachTab', 'ws-a', 'tab-a'])
    expect(calls[1]?.[4]).toEqual(bounds)
    expect(calls[2]?.slice(0, 2)).toEqual(['createWindow', calls[1]?.[3]])
    expect(calls[2]?.slice(2)).toEqual(['ws-a', 42, bounds])
  })

  it('redocks the tab when auxiliary window creation fails', () => {
    const { handlers, calls } = register({
      createAuxiliaryWindow: () => { throw new Error('window failed') },
    })

    expect(() => handlers.get(RPC_CHANNELS.layout.DETACH_TAB)!(
      { clientId: 'client', workspaceId: 'ws-a', webContentsId: 42 },
      'tab-a',
    )).toThrow('window failed')
    expect(calls.at(-1)?.slice(0, 2)).toEqual(['redock', calls[1]?.[3]])
  })

  it('merges saves into the trusted primary or auxiliary layout window', () => {
    const { handlers, calls } = register()
    handlers.get(RPC_CHANNELS.layout.SAVE)!({ webContentsId: 42, workspaceId: 'ws-a' }, { workspaceId: 'ws-a' }, 3)
    handlers.get(RPC_CHANNELS.layout.SAVE)!({ webContentsId: 44, workspaceId: 'ws-a' }, { workspaceId: 'ws-a' }, 4)
    expect(calls.filter(call => call[0] === 'saveWindow')).toEqual([
      ['saveWindow', 'primary'],
      ['saveWindow', 'aux-one'],
    ])
  })

  it('rejects layout writes and detaches from secondary session windows', () => {
    const { handlers } = register()
    expect(() => handlers.get(RPC_CHANNELS.layout.SAVE)!(
      { webContentsId: 43, workspaceId: 'ws-a' },
      { workspaceId: 'ws-a' },
    )).toThrow('not a layout writer')
    expect(() => handlers.get(RPC_CHANNELS.layout.DETACH_TAB)!(
      { webContentsId: 43, workspaceId: 'ws-a' },
      'tab-a',
    )).toThrow('Only the primary layout window')
  })
})
