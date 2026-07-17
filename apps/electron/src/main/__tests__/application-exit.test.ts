import { describe, expect, it, mock } from 'bun:test'
import {
  BeforeQuitGate,
  captureRecoverableWindowSnapshot,
  closeRendererWindowsGracefully,
  restoreRecoverableWindows,
  runCommittedExit,
  runUpdateQuitTransaction,
} from '../application-exit'
import type { SavedWindow } from '../window-state'

function managed(
  id: number,
  role: 'main' | 'child-session' | 'auxiliary',
  parentWebContentsId?: number,
) {
  return {
    role,
    ...(parentWebContentsId == null ? {} : { parentWebContentsId }),
    window: { isDestroyed: () => false, webContents: { id } },
  }
}

describe('application exit renderer flush', () => {
  it('closes child windows before their parents, then any orphan auxiliary', async () => {
    const remaining = new Map([
      [1, managed(1, 'main')],
      [2, managed(2, 'auxiliary', 1)],
      [3, managed(3, 'child-session', 1)],
      [4, managed(4, 'auxiliary')],
    ])
    const closed: number[] = []
    const manager = {
      getAllWindows: () => [...remaining.values()],
      closeWindowGracefully: mock(async (id: number) => {
        closed.push(id)
        remaining.delete(id)
        if (id === 1) remaining.delete(2)
      }),
    }

    await closeRendererWindowsGracefully(manager)

    expect(closed).toEqual([3, 1, 4])
  })

  it('propagates a renderer flush failure and stops closing later roots', async () => {
    const closeWindowGracefully = mock(async (id: number) => {
      if (id === 2) throw new Error('draft flush failed')
    })
    const manager = {
      getAllWindows: () => [managed(1, 'main'), managed(2, 'child-session', 1)],
      closeWindowGracefully,
    }

    await expect(closeRendererWindowsGracefully(manager)).rejects.toThrow('draft flush failed')
    expect(closeWindowGracefully).toHaveBeenCalledTimes(1)
  })

  it('closes a child graph in stable descendant-first order', async () => {
    const remaining = new Map([
      [1, managed(1, 'main')],
      [2, managed(2, 'child-session', 1)],
      [3, managed(3, 'child-session', 2)],
      [4, managed(4, 'child-session', 1)],
      [5, managed(5, 'auxiliary', 1)],
    ])
    const closed: number[] = []
    const manager = {
      getAllWindows: () => [...remaining.values()],
      closeWindowGracefully: mock(async (id: number) => {
        closed.push(id)
        remaining.delete(id)
      }),
    }

    await closeRendererWindowsGracefully(manager)

    expect(closed).toEqual([3, 2, 4, 1, 5])
  })

  it('does not close an ancestor when a grandchild cancels its flush', async () => {
    const closed: number[] = []
    const manager = {
      getAllWindows: () => [
        managed(1, 'main'),
        managed(2, 'child-session', 1),
        managed(3, 'child-session', 2),
      ],
      closeWindowGracefully: mock(async (id: number) => {
        closed.push(id)
        if (id === 3) throw new Error('grandchild flush cancelled')
      }),
    }

    await expect(closeRendererWindowsGracefully(manager)).rejects.toThrow('grandchild flush cancelled')
    expect(closed).toEqual([3])
  })

  it('degrades safely for orphan and cyclic child links while keeping auxiliaries last', async () => {
    const remaining = new Map([
      [6, managed(6, 'child-session', 7)],
      [7, managed(7, 'child-session', 6)],
      [8, managed(8, 'child-session', 999)],
      [9, managed(9, 'auxiliary', 999)],
    ])
    const closed: number[] = []
    const manager = {
      getAllWindows: () => [...remaining.values()],
      closeWindowGracefully: mock(async (id: number) => {
        closed.push(id)
        remaining.delete(id)
      }),
    }

    await closeRendererWindowsGracefully(manager)

    expect(closed).toEqual([7, 6, 8, 9])
    expect(new Set(closed).size).toBe(closed.length)
  })

  it('does not let a reentrant before-quit event bypass an in-flight flush', () => {
    const gate = new BeforeQuitGate()
    const firstPrevent = mock(() => {})
    const reentrantPrevent = mock(() => {})

    expect(gate.enter({ preventDefault: firstPrevent })).toBe('start')
    expect(gate.enter({ preventDefault: reentrantPrevent })).toBe('wait')
    expect(firstPrevent).toHaveBeenCalledTimes(1)
    expect(reentrantPrevent).toHaveBeenCalledTimes(1)
    expect(gate.isPreparing()).toBe(true)

    gate.cancel()
    expect(gate.enter({ preventDefault: mock(() => {}) })).toBe('start')
    gate.commit()
    const committedPrevent = mock(() => {})
    expect(gate.enter({ preventDefault: committedPrevent })).toBe('allow')
    expect(committedPrevent).not.toHaveBeenCalled()
  })

  it('restores the exact missing route and its child without persisting the child', () => {
    const firstBounds = { x: 10, y: 20, width: 900, height: 700 }
    const secondBounds = { x: 30, y: 40, width: 1000, height: 800 }
    const childBounds = { x: 50, y: 60, width: 800, height: 600 }
    const grandchildBounds = { x: 70, y: 80, width: 760, height: 560 }
    const firstUrl = 'file:///app/index.html?workspaceId=alpha&route=session-1'
    const secondUrl = 'file:///app/index.html?workspaceId=alpha&route=session-2'
    const live = (
      id: number,
      role: 'main' | 'child-session',
      url: string,
      bounds: SavedWindow['bounds'],
      extra: Record<string, unknown> = {},
    ) => ({
      role,
      workspaceId: 'alpha',
      ...extra,
      window: {
        isDestroyed: () => false,
        getBounds: () => bounds,
        webContents: { id, getURL: () => url },
      },
    })
    const first = live(1, 'main', firstUrl, firstBounds)
    const second = live(2, 'main', secondUrl, secondBounds)
    const child = live(3, 'child-session', 'file:///app/index.html?route=child-1', childBounds, {
      sessionId: 'child-1',
      customTitle: 'Research branch',
      parentWebContentsId: 1,
    })
    const grandchild = live(4, 'child-session', 'file:///app/index.html?route=grandchild-1', grandchildBounds, {
      sessionId: 'grandchild-1',
      customTitle: 'Nested branch',
      parentWebContentsId: 3,
    })
    let current = [first, second, child, grandchild]
    const createdMain: Array<{ options: any; bounds?: SavedWindow['bounds']; id: number }> = []
    const createdChild: Array<{ sessionId: string; options: any; bounds?: SavedWindow['bounds']; id: number }> = []
    const manager = {
      getAllWindows: () => current,
      getWindowStates: () => [
        { type: 'main' as const, workspaceId: 'alpha', bounds: firstBounds, focused: true, url: firstUrl },
        { type: 'main' as const, workspaceId: 'alpha', bounds: secondBounds, url: secondUrl },
      ],
      createWindow: mock((options: any) => {
        const entry = { options, id: 10 } as { options: any; bounds?: SavedWindow['bounds']; id: number }
        createdMain.push(entry)
        return {
          webContents: { id: entry.id },
          setBounds: (bounds: SavedWindow['bounds']) => { entry.bounds = bounds },
        }
      }),
      createChildSessionWindow: mock((sessionId: string, options: any) => {
        const entry = { sessionId, options, id: 11 + createdChild.length } as {
          sessionId: string
          options: any
          bounds?: SavedWindow['bounds']
          id: number
        }
        createdChild.push(entry)
        return {
          webContents: { id: entry.id },
          setBounds: (bounds: SavedWindow['bounds']) => { entry.bounds = bounds },
        }
      }),
    }

    const snapshot = captureRecoverableWindowSnapshot(manager)
    expect(snapshot).toHaveLength(4)
    expect(manager.getWindowStates()).toHaveLength(2)

    // The second route survives. Workspace-only matching would incorrectly
    // consume it as the first window and recreate route 2 instead of route 1.
    current = [second]
    expect(restoreRecoverableWindows(manager, snapshot)).toBe(3)
    expect(createdMain).toEqual([{
      options: {
        workspaceId: 'alpha',
        focused: true,
        restoreUrl: firstUrl,
      },
      bounds: firstBounds,
      id: 10,
    }])
    expect(createdChild).toEqual([{
      sessionId: 'child-1',
      options: {
        workspaceId: 'alpha',
        title: 'Research branch',
        width: 800,
        height: 600,
        parentWebContentsId: 10,
      },
      bounds: childBounds,
      id: 11,
    }, {
      sessionId: 'grandchild-1',
      options: {
        workspaceId: 'alpha',
        title: 'Nested branch',
        width: 760,
        height: 560,
        parentWebContentsId: 11,
      },
      bounds: grandchildBounds,
      id: 12,
    }])
  })

  it('finalizes exit after cleanup failures and continues later cleanup', async () => {
    const order: string[] = []
    const errors: string[] = []

    await runCommittedExit([
      { name: 'sessions', run: async () => { order.push('sessions'); throw new Error('cleanup failed') } },
      { name: 'server-lock', run: () => { order.push('server-lock') } },
    ], (name) => {
      errors.push(name)
    }, () => {
      order.push('exit')
    })

    expect(errors).toEqual(['sessions'])
    expect(order).toEqual(['sessions', 'server-lock', 'exit'])
  })

  it('rolls back closed windows when quitAndInstall throws', async () => {
    const order: string[] = []
    const installError = new Error('installer launch failed')

    await expect(runUpdateQuitTransaction({
      prepare: async () => {
        order.push('prepare')
        return async () => { order.push('rollback') }
      },
      install: () => {
        order.push('install')
        throw installError
      },
      markFailed: (error) => {
        expect(error).toBe(installError)
        order.push('ready')
      },
    })).rejects.toBe(installError)

    expect(order).toEqual(['prepare', 'install', 'ready', 'rollback'])
  })

  it('runs one rollback when updater failure is reported as an event', async () => {
    const rollback = mock(async () => {})
    const markFailed = mock(() => {})
    const firstError = new Error('installer event failure')
    let reportFailure: ((error: Error) => void) | undefined

    await expect(runUpdateQuitTransaction({
      prepare: () => rollback,
      onPrepared: recovery => {
        reportFailure = error => { void recovery.fail(error, markFailed) }
      },
      install: () => {
        reportFailure?.(firstError)
        reportFailure?.(new Error('duplicate event'))
      },
      markFailed,
    })).rejects.toBe(firstError)

    expect(markFailed).toHaveBeenCalledTimes(1)
    expect(rollback).toHaveBeenCalledTimes(1)
  })

  it('reports both installer and window recovery failures', async () => {
    const installError = new Error('installer launch failed')
    const rollbackError = new Error('window restore failed')

    try {
      await runUpdateQuitTransaction({
        prepare: () => () => { throw rollbackError },
        install: () => { throw installError },
        markFailed: () => {},
      })
      throw new Error('expected transaction to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError)
      expect((error as AggregateError).errors).toEqual([installError, rollbackError])
    }
  })
})
