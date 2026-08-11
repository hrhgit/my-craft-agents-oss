import { describe, expect, it } from 'bun:test'

import type { CapabilityProvider, CapabilityProviderContext } from '@mortise/server-core/capabilities'
import {
  REQUESTING_CLIENT_CAPABILITY_NAMES,
  type WorkspaceCapabilityBridgeToHostV1,
} from '@mortise/shared/protocol'

import {
  WorkspaceCapabilityBridgeClient,
  type WorkspaceCapabilityBridgeTransport,
} from './workspace-capability-bridge'

class FakeTransport implements WorkspaceCapabilityBridgeTransport {
  connected = true
  sent: WorkspaceCapabilityBridgeToHostV1[] = []
  private onMessage: (message: unknown) => void = () => undefined
  private onDisconnect: () => void = () => undefined

  isConnected(): boolean { return this.connected }
  send(message: WorkspaceCapabilityBridgeToHostV1): void { this.sent.push(message) }
  subscribe(onMessage: (message: unknown) => void, onDisconnect: () => void): () => void {
    this.onMessage = onMessage
    this.onDisconnect = onDisconnect
    return () => undefined
  }
  receive(message: unknown): void { this.onMessage(message) }
  disconnect(): void { this.connected = false; this.onDisconnect() }
}

function context(signal = new AbortController().signal): CapabilityProviderContext & { progress: unknown[] } {
  const progress: unknown[] = []
  return {
    request: {
      version: 1,
      requestId: 'request-1',
      capability: 'browser.command',
      sessionId: 'session-1',
      runtimeId: 'runtime-1',
      extensionId: 'mortise-browser',
      operation: 'execute',
      input: { command: 'snapshot' },
    },
    signal,
    progress,
    reportProgress(value) { progress.push(value) },
  }
}

async function flush(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('workspace capability bridge client', () => {
  it('registers only requesting-client providers and forwards context, progress, and output', async () => {
    const transport = new FakeTransport()
    const providers: CapabilityProvider[] = []
    const client = new WorkspaceCapabilityBridgeClient(transport)
    client.registerProviders({
      registerCapabilityProvider(provider) { providers.push(provider); return () => undefined },
      async getSession() { return { workspaceId: 'workspace-1' } },
      getSessionPath() { return 'C:\\sessions\\session-1' },
    })

    expect(providers.map(provider => provider.capability)).toEqual([...REQUESTING_CLIENT_CAPABILITY_NAMES])
    const provider = providers.find(candidate => candidate.capability === 'browser.command')!
    const providerContext = context()
    const resultPromise = provider.invoke('execute', { command: 'snapshot' }, providerContext)
    await flush()

    const sent = transport.sent[0]
    expect(sent.type).toBe('workspace_capability_request')
    if (sent.type !== 'workspace_capability_request') throw new Error('Expected capability request')
    expect(sent.session).toEqual({ workspaceId: 'workspace-1', sessionPath: 'C:\\sessions\\session-1' })
    transport.receive({
      type: 'workspace_capability_progress', version: 1, bridgeId: sent.bridgeId,
      progress: { phase: 'running' },
    })
    transport.receive({
      type: 'workspace_capability_result', version: 1, bridgeId: sent.bridgeId,
      ok: true, output: { text: 'done' },
    })

    await expect(resultPromise).resolves.toEqual({ text: 'done' })
    expect(providerContext.progress).toEqual([{ phase: 'running' }])
  })

  it('cancels an active host request and degrades explicitly after disconnect', async () => {
    const transport = new FakeTransport()
    const providers: CapabilityProvider[] = []
    new WorkspaceCapabilityBridgeClient(transport).registerProviders({
      registerCapabilityProvider(provider) { providers.push(provider); return () => undefined },
      async getSession() { return { workspaceId: 'workspace-1' } },
      getSessionPath() { return undefined },
    })
    const provider = providers[0]
    const controller = new AbortController()
    const pending = provider.invoke('execute', {}, context(controller.signal))
    await flush()
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'CAPABILITY_CANCELLED' })
    expect(transport.sent.at(-1)?.type).toBe('workspace_capability_cancel')

    transport.disconnect()
    await expect(provider.invoke('execute', {}, context())).rejects.toMatchObject({
      code: 'NO_INTERACTIVE_CLIENT',
    })
  })

  it('runs a validation probe through a registered proxy provider', async () => {
    const transport = new FakeTransport()
    const client = new WorkspaceCapabilityBridgeClient(transport, true)
    client.registerProviders({
      registerCapabilityProvider() { return () => undefined },
      async getSession() { return { workspaceId: 'workspace-1' } },
      getSessionPath() { return 'C:\\sessions\\session-1' },
    })

    transport.receive({
      type: 'workspace_capability_probe',
      version: 1,
      bridgeId: 'probe-1',
      request: context().request,
    })
    await flush()
    const forwarded = transport.sent.at(-1)
    expect(forwarded?.type).toBe('workspace_capability_request')
    if (forwarded?.type !== 'workspace_capability_request') throw new Error('Expected forwarded request')
    transport.receive({
      type: 'workspace_capability_result',
      version: 1,
      bridgeId: forwarded.bridgeId,
      ok: true,
      output: { text: 'probe complete' },
    })
    await flush()

    expect(transport.sent.at(-1)).toEqual({
      type: 'workspace_capability_probe_result',
      version: 1,
      bridgeId: 'probe-1',
      ok: true,
      output: { text: 'probe complete' },
      progress: [],
    })
  })
})
