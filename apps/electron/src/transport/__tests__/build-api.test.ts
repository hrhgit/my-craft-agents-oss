import { afterEach, describe, expect, it, mock } from 'bun:test'
import { RPC_CHANNELS } from '@mortise/shared/protocol'
import { buildClientApi, type ChannelMap } from '../build-api'
import { CHUNKED_TRANSFER_THRESHOLD } from '../chunked-payload'
import type { RpcClient } from '@mortise/server-core/transport'
import { CHANNEL_MAP } from '../channel-map'

function makeClient() {
  const calls: Array<{ channel: string; args: any[] }> = []
  const timedCalls: Array<{ channel: string; args: any[]; timeoutMs?: number }> = []
  const client = {
    invoke: mock(async (channel: string, ...args: any[]) => {
      calls.push({ channel, args })
      if (channel === RPC_CHANNELS.transfer.START) return { transferId: 'transfer-1' }
      if (channel === RPC_CHANNELS.transfer.COMMIT) return { ok: true }
      return null
    }),
    invokeWithOptions: mock(async (channel: string, args: any[], options?: { timeoutMs?: number }) => {
      timedCalls.push({ channel, args, timeoutMs: options?.timeoutMs })
      if (channel === RPC_CHANNELS.transfer.COMMIT) return { ok: true }
      return null
    }),
    on: mock(() => () => {}),
  } as unknown as RpcClient
  return { client, calls, timedCalls }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function waitUntil(predicate: () => boolean, message: string) {
  for (let i = 0; i < 50; i += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  throw new Error(message)
}

const channelMap: ChannelMap = {
  upload: { type: 'invoke', channel: 'sessions:import', largeArgIndex: 1 },
}

afterEach(() => {
  mock.restore()
})

describe('buildClientApi chunked invokes', () => {
  it('marks sendMessage attachments as the chunked argument', () => {
    expect(CHANNEL_MAP.sendMessage).toMatchObject({
      type: 'invoke',
      channel: RPC_CHANNELS.sessions.SEND_MESSAGE,
      largeArgIndex: 2,
      timeoutMs: 300_000,
      serializeByArgIndex: 0,
    })
  })

  it('allows extension reload to outlive per-runtime interruption cleanup', () => {
    expect(CHANNEL_MAP.reloadPiExtensions).toMatchObject({
      type: 'invoke',
      channel: RPC_CHANNELS.piExtensions.RELOAD,
      timeoutMs: 120_000,
    })
  })

  it('uses direct invoke for payloads below the threshold', async () => {
    const { client, calls } = makeClient()
    const api = buildClientApi(client, channelMap) as any

    await api.upload('workspace-1', { value: 'small' })

    expect(calls).toEqual([
      { channel: 'sessions:import', args: ['workspace-1', { value: 'small' }] },
    ])
  })

  it('chunks large payloads without requiring global Buffer', async () => {
    const originalBuffer = globalThis.Buffer
    try {
      // Simulate the browser bundle where Buffer is not available.
      ;(globalThis as any).Buffer = undefined
      const { client, calls } = makeClient()
      const api = buildClientApi(client, channelMap) as any
      const payload = { value: 'x'.repeat(CHUNKED_TRANSFER_THRESHOLD + 1) }

      await expect(api.upload('workspace-1', payload)).resolves.toEqual({ ok: true })

      expect(calls[0]?.channel).toBe(RPC_CHANNELS.transfer.START)
      expect(calls[0]?.args[0]).toMatchObject({
        channel: 'sessions:import',
        args: ['workspace-1', null],
        largeArgIndex: 1,
      })
      expect(calls.some((call) => call.channel === RPC_CHANNELS.transfer.CHUNK)).toBe(true)
      expect(calls.at(-1)?.channel).toBe(RPC_CHANNELS.transfer.COMMIT)
    } finally {
      ;(globalThis as any).Buffer = originalBuffer
    }
  })

  it('uses invokeWithOptions when an invoke entry specifies timeoutMs', async () => {
    const { client, calls, timedCalls } = makeClient()
    const api = buildClientApi(client, {
      sendSlow: { type: 'invoke', channel: 'sessions:sendMessage', timeoutMs: 1234 },
    }) as any

    await api.sendSlow('session-1', 'hello')

    expect(timedCalls).toEqual([
      { channel: 'sessions:sendMessage', args: ['session-1', 'hello'], timeoutMs: 1234 },
    ])
    expect(calls).toEqual([])
  })

  it('serializes sendMessage by session while a chunked commit is pending', async () => {
    const commitGate = deferred<{ ok: string }>()
    const calls: Array<{ channel: string; args: any[] }> = []
    const timedCalls: Array<{ channel: string; args: any[]; timeoutMs?: number }> = []
    const client = {
      invoke: mock(async (channel: string, ...args: any[]) => {
        calls.push({ channel, args })
        if (channel === RPC_CHANNELS.transfer.START) return { transferId: 'transfer-1' }
        return { ok: true }
      }),
      invokeWithOptions: mock(async (channel: string, args: any[], options?: { timeoutMs?: number }) => {
        timedCalls.push({ channel, args, timeoutMs: options?.timeoutMs })
        if (channel === RPC_CHANNELS.transfer.COMMIT) return commitGate.promise
        return { ok: `sent:${args[0]}` }
      }),
      on: mock(() => () => {}),
    } as unknown as RpcClient
    const api = buildClientApi(client, {
      sendMessage: {
        type: 'invoke',
        channel: RPC_CHANNELS.sessions.SEND_MESSAGE,
        largeArgIndex: 2,
        timeoutMs: 1234,
        serializeByArgIndex: 0,
      },
    }) as any
    const largePayload = { value: 'x'.repeat(CHUNKED_TRANSFER_THRESHOLD + 1) }

    const first = api.sendMessage('session-1', 'first', largePayload)
    await waitUntil(
      () => timedCalls.some(call => call.channel === RPC_CHANNELS.transfer.COMMIT),
      'chunked sendMessage did not reach commit',
    )

    const sameSessionSecond = api.sendMessage('session-1', 'second')
    const otherSession = api.sendMessage('session-2', 'third')

    await waitUntil(
      () => timedCalls.some(call => call.channel === RPC_CHANNELS.sessions.SEND_MESSAGE && call.args[0] === 'session-2'),
      'different session sendMessage was blocked',
    )

    expect(timedCalls.some(call =>
      call.channel === RPC_CHANNELS.sessions.SEND_MESSAGE &&
      call.args[0] === 'session-1' &&
      call.args[1] === 'second'
    )).toBe(false)
    await expect(otherSession).resolves.toEqual({ ok: 'sent:session-2' })

    commitGate.resolve({ ok: 'committed' })

    await expect(first).resolves.toEqual({ ok: 'committed' })
    await expect(sameSessionSecond).resolves.toEqual({ ok: 'sent:session-1' })
    expect(timedCalls.filter(call => call.channel === RPC_CHANNELS.sessions.SEND_MESSAGE).map(call => call.args[0])).toEqual([
      'session-2',
      'session-1',
    ])
  })
})
