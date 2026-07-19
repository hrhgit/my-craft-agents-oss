import { describe, expect, it, mock } from 'bun:test'
import type { TransportConnectionState } from '@mortise/server-core/transport/client'
import { waitForInitialConnection } from './connection'

function state(status: TransportConnectionState['status'], message?: string): TransportConnectionState {
  return {
    mode: 'remote',
    status,
    url: 'ws://localhost:5175/ws',
    attempt: 0,
    updatedAt: Date.now(),
    ...(message ? { lastError: { kind: 'auth' as const, message } } : {}),
  }
}

describe('waitForInitialConnection', () => {
  it('waits through connecting and resolves once connected', async () => {
    let listener: (value: TransportConnectionState) => void = () => {}
    let resolved = false
    const unsubscribe = mock(() => {})
    const client = {
      getConnectionState: () => state('connecting'),
      onConnectionStateChanged: (callback: typeof listener) => {
        listener = callback
        callback(state('connecting'))
        return unsubscribe
      },
    }

    const pending = waitForInitialConnection(client).then(() => { resolved = true })
    await Promise.resolve()
    expect(resolved).toBe(false)

    listener(state('connected'))
    await pending
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('rejects with the connection error', async () => {
    let listener: (value: TransportConnectionState) => void = () => {}
    const client = {
      getConnectionState: () => state('connecting'),
      onConnectionStateChanged: (callback: typeof listener) => {
        listener = callback
        return () => {}
      },
    }

    const pending = waitForInitialConnection(client)
    listener(state('failed', 'Token required'))
    expect(pending).rejects.toThrow('Token required')
  })

  it('handles an already connected client without subscribing', async () => {
    const subscribe = mock(() => () => {})
    const client = {
      getConnectionState: () => state('connected'),
      onConnectionStateChanged: subscribe,
    }

    await waitForInitialConnection(client)
    expect(subscribe).not.toHaveBeenCalled()
  })
})
