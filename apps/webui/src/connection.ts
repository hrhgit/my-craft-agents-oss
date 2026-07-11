import type { TransportConnectionState, WsRpcClient } from '@craft-agent/server-core/transport/client'

type ConnectionClient = Pick<WsRpcClient, 'getConnectionState' | 'onConnectionStateChanged'>

export function waitForInitialConnection(client: ConnectionClient): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    let unsubscribe: (() => void) | undefined

    const finish = (state: TransportConnectionState) => {
      if (settled) return
      if (state.status !== 'connected' && state.status !== 'failed') return

      settled = true
      unsubscribe?.()
      if (state.status === 'connected') {
        resolve()
      } else {
        reject(new Error(state.lastError?.message ?? 'Failed to connect to server'))
      }
    }

    finish(client.getConnectionState())
    if (settled) return

    unsubscribe = client.onConnectionStateChanged(finish)
    if (settled) unsubscribe()
  })
}
