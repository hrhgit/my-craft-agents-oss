import { describe, expect, it, mock } from 'bun:test'
import { createWorkspaceElectronApi } from '../WorkspaceElectronApiContext'

const route = { serverId: 'remote.example', workspaceId: 'workspace-a' }

describe('workspace Electron API context', () => {
  it('scopes remote-eligible methods and keeps local window methods on the host API', async () => {
    const invokeWorkspaceApi = mock(async () => undefined)
    const getSessions = mock(async () => [])
    const closeWindow = mock(async () => undefined)
    const api = createWorkspaceElectronApi({
      getSessions,
      closeWindow,
      invokeWorkspaceApi,
      onWorkspaceApiEvent: mock(() => () => {}),
    } as any, route)

    await api.getSessions()
    await api.closeWindow()

    expect(invokeWorkspaceApi).toHaveBeenCalledWith(route, 'getSessions')
    expect(getSessions).not.toHaveBeenCalled()
    expect(closeWindow).toHaveBeenCalledTimes(1)
  })

  it('scopes remote event subscriptions', () => {
    const onWorkspaceApiEvent = mock(() => () => {})
    const callback = mock(() => {})
    const api = createWorkspaceElectronApi({
      invokeWorkspaceApi: mock(async () => undefined),
      onWorkspaceApiEvent,
    } as any, route)

    api.onSessionEvent(callback)
    expect(onWorkspaceApiEvent).toHaveBeenCalledWith(route, 'onSessionEvent', callback)
  })

  it('uses the platform API unchanged when the scoped preload bridge is unavailable', () => {
    const getSessions = mock(async () => [])
    const base = { getSessions } as any
    const api = createWorkspaceElectronApi(base, route)

    expect(api).toBe(base)
  })
})
