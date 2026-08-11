import { describe, expect, it } from 'bun:test'

import { createElectronCapabilityExecutor } from '../electron-capability-providers'

function request(capability: string, operation: string, input: unknown) {
  return {
    version: 1 as const,
    requestId: `request-${capability}`,
    capability,
    sessionId: 'session-child',
    runtimeId: 'runtime-child',
    extensionId: 'extension-1',
    operation,
    input,
  }
}

describe('Electron interactive capability providers', () => {
  it('uses the workspace-server session context for browser creation', async () => {
    const calls: unknown[] = []
    const browserPaneManager = {
      async getOrCreateForSessionAsync(sessionId: string, options: unknown) {
        calls.push(['create', sessionId, options])
        return 'browser-1'
      },
      async navigate(instanceId: string, url: string) {
        calls.push(['navigate', instanceId, url])
        return { url, title: 'Example' }
      },
      focus(instanceId: string) { calls.push(['focus', instanceId]) },
    }
    const executor = createElectronCapabilityExecutor({
      browserPaneManager: browserPaneManager as never,
      dialog: { async showOpenDialog() { return { canceled: true, filePaths: [] } } } as never,
      showNotification() {},
    })

    const output = await executor(
      request('browser.open', 'navigate', { url: 'https://example.com', focus: true }),
      { workspaceId: 'workspace-child', sessionPath: 'C:\\sessions\\session-child' },
      { signal: new AbortController().signal, reportProgress() {} },
    )

    expect(output).toEqual({ instanceId: 'browser-1', url: 'https://example.com/', title: 'Example' })
    expect(calls).toEqual([
      ['create', 'session-child', { workspaceId: 'workspace-child' }],
      ['navigate', 'browser-1', 'https://example.com/'],
      ['focus', 'browser-1'],
    ])
  })

  it('routes system notifications with the bridged workspace identity', async () => {
    const notifications: unknown[] = []
    const executor = createElectronCapabilityExecutor({
      browserPaneManager: {} as never,
      dialog: { async showOpenDialog() { return { canceled: true, filePaths: [] } } } as never,
      showNotification(...args) { notifications.push(args) },
    })

    await executor(
      request('system.notification', 'show', { title: 'Done', body: 'Finished' }),
      { workspaceId: 'workspace-child' },
      { signal: new AbortController().signal, reportProgress() {} },
    )

    expect(notifications).toEqual([['Done', 'Finished', 'workspace-child', 'session-child']])
  })
})
