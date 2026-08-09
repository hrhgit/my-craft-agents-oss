import { describe, expect, it, mock } from 'bun:test'
import { SessionManager, createManagedSession } from './SessionManager'

function createManager(extensionIds: string[] = []): SessionManager {
  return new SessionManager({
    extensionRuntime: {
      clear: () => undefined,
      getWorkspaceSnapshot: (workspaceId: string) => workspaceId === 'workspace-1' ? ({
        workspaceId,
        workspaceRoot: process.cwd(),
        loadedAt: 1,
        extensions: extensionIds.map(id => ({ id, path: `${id}.ts`, resolvedPath: `${process.cwd()}/${id}.ts` })),
        failures: [],
      }) : null,
      openWorkspace: async () => ({
        workspaceId: 'workspace-1',
        workspaceRoot: process.cwd(),
        loadedAt: Date.now(),
        extensions: [],
        failures: [],
      }),
    } as never,
  })
}

function addSession(manager: SessionManager, id: string, isProcessing: boolean) {
  const managed = createManagedSession(
    { mortiseId: id, name: `Session ${id}` },
    {
      schemaVersion: 2,
      id: 'workspace-1',
      revision: 1,
      name: 'Workspace',
      nameSource: 'custom',
      slug: 'workspace',
      primaryLocationId: 'location-1',
      locations: [{
        id: 'location-1',
        name: 'Workspace',
        rootName: 'workspace',
        endpoint: { kind: 'local', rootPath: process.cwd() },
      }],
      createdAt: 0,
    },
    { messagesLoaded: true },
  )
  const reloadExtensions = mock(async () => ({ reloaded: true, deferred: false }))
  managed.agent = { reloadExtensions, isProcessing: () => isProcessing } as never
  managed.isProcessing = isProcessing
  ;(manager as unknown as { sessions: Map<string, typeof managed> }).sessions.set(id, managed)
  return { reloadExtensions }
}

describe('SessionManager extension reload', () => {
  it('reports the extension IDs from the applied Workspace runtime snapshot', () => {
    const manager = createManager(['mortise-permissions', 'sample-extension'])

    expect(manager.getExtensionRuntimeState('workspace-1')).toEqual({
      loaded: true,
      extensionIds: ['mortise-permissions', 'sample-extension'],
    })
    expect(manager.getExtensionRuntimeState('missing')).toEqual({ loaded: false, extensionIds: [] })
  })

  it('reloads every open idle Pi runtime', async () => {
    const manager = createManager()
    const session = addSession(manager, 'idle', false)

    await expect(manager.requestExtensionReload(false)).resolves.toMatchObject({
      status: 'reloaded',
      interruptedSessionCount: 0,
      reloadedSessionCount: 1,
      deferredSessionCount: 0,
    })
    expect(session.reloadExtensions).toHaveBeenCalledTimes(1)
  })

  it('requires confirmation before touching a running Session', async () => {
    const manager = createManager()
    const session = addSession(manager, 'running', true)

    await expect(manager.requestExtensionReload(false)).resolves.toEqual({
      status: 'confirmation_required',
      activeSessions: [{ sessionId: 'running', workspaceName: 'Workspace', title: 'Session running' }],
    })
    expect(session.reloadExtensions).not.toHaveBeenCalled()
  })
})
