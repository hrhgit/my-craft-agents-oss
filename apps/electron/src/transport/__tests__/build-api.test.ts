import { afterEach, describe, expect, it, mock } from 'bun:test'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { buildClientApi, type ChannelMap } from '../build-api'
import { CHUNKED_TRANSFER_THRESHOLD } from '../chunked-payload'
import type { RpcClient } from '@craft-agent/server-core/transport'

function makeClient() {
  const calls: Array<{ channel: string; args: any[] }> = []
  const client = {
    invoke: mock(async (channel: string, ...args: any[]) => {
      calls.push({ channel, args })
      if (channel === RPC_CHANNELS.transfer.START) return { transferId: 'transfer-1' }
      if (channel === RPC_CHANNELS.transfer.COMMIT) return { ok: true }
      return null
    }),
    on: mock(() => () => {}),
  } as unknown as RpcClient
  return { client, calls }
}

const channelMap: ChannelMap = {
  upload: { type: 'invoke', channel: 'sessions:import', largeArgIndex: 1 },
}

afterEach(() => {
  mock.restore()
})

describe('buildClientApi chunked invokes', () => {
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
})
