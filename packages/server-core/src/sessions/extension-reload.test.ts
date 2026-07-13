import { describe, expect, it, jest } from 'bun:test'
import { SessionManager, createManagedSession } from './SessionManager.ts'

function addSession(manager: SessionManager, id: string, isProcessing: boolean, options?: {
  reloadResult?: { reloaded: boolean; deferred: boolean }
  reloadError?: Error
  order?: string[]
}) {
  const managed = createManagedSession(
    { craftId: id, name: `Session ${id}` },
    { id: 'workspace-1', name: 'Workspace', rootPath: process.cwd(), createdAt: 0 } as never,
    { messagesLoaded: true },
  )
  const abort = jest.fn(async () => { options?.order?.push(`abort:${id}`) })
  const reloadExtensions = jest.fn(async () => {
    options?.order?.push(`reload:${id}`)
    if (options?.reloadError) throw options.reloadError
    return options?.reloadResult ?? { reloaded: true, deferred: false }
  })
  managed.agent = { abort, reloadExtensions, isProcessing: () => isProcessing } as never
  managed.isProcessing = isProcessing
  ;(manager as unknown as { sessions: Map<string, typeof managed> }).sessions.set(id, managed)
  return { abort, reloadExtensions }
}

describe('SessionManager extension reload', () => {
  it('reloads immediately when every session is idle', async () => {
    const manager = new SessionManager()
    const session = addSession(manager, 'idle', false)

    await expect(manager.requestExtensionReload(false)).resolves.toEqual({
      status: 'reloaded',
      interruptedSessionCount: 0,
      reloadedSessionCount: 1,
      deferredSessionCount: 0,
    })
    expect(session.abort).not.toHaveBeenCalled()
    expect(session.reloadExtensions).toHaveBeenCalledTimes(1)
  })

  it('requires confirmation without interrupting or reloading running sessions', async () => {
    const manager = new SessionManager()
    const session = addSession(manager, 'running', true)

    await expect(manager.requestExtensionReload(false)).resolves.toEqual({
      status: 'confirmation_required',
      activeSessions: [{ sessionId: 'running', workspaceName: 'Workspace', title: 'Session running' }],
    })
    expect(session.abort).not.toHaveBeenCalled()
    expect(session.reloadExtensions).not.toHaveBeenCalled()
  })

  it('interrupts every running session before reloading after confirmation', async () => {
    const manager = new SessionManager()
    const order: string[] = []
    const first = addSession(manager, 'first', true, { order })
    const second = addSession(manager, 'second', true, { order })

    await expect(manager.requestExtensionReload(true)).resolves.toMatchObject({
      status: 'reloaded',
      interruptedSessionCount: 2,
      reloadedSessionCount: 2,
      deferredSessionCount: 0,
    })
    expect(first.abort).toHaveBeenCalledTimes(1)
    expect(second.abort).toHaveBeenCalledTimes(1)
    expect(order.slice(0, 2).sort()).toEqual(['abort:first', 'abort:second'])
    expect(order.slice(2).sort()).toEqual(['reload:first', 'reload:second'])
  })

  it('surfaces runtime reload failures', async () => {
    const manager = new SessionManager()
    addSession(manager, 'broken', false, { reloadError: new Error('bad extension') })

    await expect(manager.requestExtensionReload(false)).rejects.toThrow('broken: bad extension')
  })
})
