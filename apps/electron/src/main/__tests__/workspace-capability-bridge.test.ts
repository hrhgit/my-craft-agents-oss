import { EventEmitter } from 'node:events'

import { describe, expect, it } from 'bun:test'

import { attachCapabilityBridge } from '../workspace-server-spawner'

class FakeChild extends EventEmitter {
  connected = true
  sent: unknown[] = []
  send(message: unknown): boolean { this.sent.push(message); return true }
}

async function flush(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

const request = {
  version: 1 as const,
  requestId: 'request-1',
  capability: 'browser.command',
  sessionId: 'session-1',
  runtimeId: 'runtime-1',
  extensionId: 'mortise-browser',
  operation: 'execute',
  input: { command: 'snapshot' },
}

describe('Electron workspace capability bridge', () => {
  it('forwards child requests, progress, and successful results', async () => {
    const child = new FakeChild()
    const seen: unknown[] = []
    attachCapabilityBridge(child as never, async (received, session, context) => {
      seen.push(received, session)
      context.reportProgress({ phase: 'running' })
      return { text: 'done' }
    })

    child.emit('message', {
      type: 'workspace_capability_request', version: 1, bridgeId: 'bridge-1',
      request, session: { workspaceId: 'workspace-1' },
    })
    await flush()

    expect(seen).toEqual([request, { workspaceId: 'workspace-1' }])
    expect(child.sent).toEqual([
      { type: 'workspace_capability_progress', version: 1, bridgeId: 'bridge-1', progress: { phase: 'running' } },
      { type: 'workspace_capability_result', version: 1, bridgeId: 'bridge-1', ok: true, output: { text: 'done' } },
    ])
  })

  it('aborts the parent execution when the child cancels', async () => {
    const child = new FakeChild()
    let signal: AbortSignal | undefined
    attachCapabilityBridge(child as never, async (_request, _session, context) => {
      signal = context.signal
      await new Promise((_, reject) => context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true }))
    })

    child.emit('message', {
      type: 'workspace_capability_request', version: 1, bridgeId: 'bridge-2',
      request, session: { workspaceId: 'workspace-1' },
    })
    child.emit('message', {
      type: 'workspace_capability_cancel', version: 1, bridgeId: 'bridge-2',
    })
    await flush()

    expect(signal?.aborted).toBe(true)
  })

  it('round-trips a validation probe through the child channel', async () => {
    const child = new FakeChild()
    const bridge = attachCapabilityBridge(child as never, async () => ({ text: 'unused' }), true)

    const resultPromise = bridge.probe(request)
    const sent = child.sent[0] as { bridgeId: string; type: string }
    expect(sent.type).toBe('workspace_capability_probe')
    child.emit('message', {
      type: 'workspace_capability_probe_result',
      version: 1,
      bridgeId: sent.bridgeId,
      ok: true,
      output: { text: 'probe complete' },
      progress: [{ phase: 'running' }],
    })

    await expect(resultPromise).resolves.toEqual({
      output: { text: 'probe complete' },
      progress: [{ phase: 'running' }],
    })
  })

  it('does not expose probes outside the validation host', async () => {
    const child = new FakeChild()
    const bridge = attachCapabilityBridge(child as never, async () => ({ text: 'unused' }), false)

    await expect(bridge.probe(request)).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' })
    expect(child.sent).toEqual([])
  })
})
