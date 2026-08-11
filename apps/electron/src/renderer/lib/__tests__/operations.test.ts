import { describe, expect, it } from 'bun:test'
import type { ElectronAPI, OperationReceipt, OperationUpdatedEvent } from '../../../shared/types'
import { waitForOperation } from '../operations'

function receipt(revision: number, status: OperationReceipt['status']): OperationReceipt {
  return {
    operationId: 'op-1',
    operationType: 'session.compact',
    status,
    revision,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(revision).toISOString(),
    scope: { sessionId: 'session-1' },
  }
}

describe('waitForOperation', () => {
  it('ignores stale operation events', async () => {
    let eventListener: ((event: OperationUpdatedEvent) => void) | undefined
    const api = {
      getOperation: async () => receipt(2, 'running'),
      subscribeOperation: async () => receipt(2, 'running'),
      onOperationUpdated: (listener: (event: OperationUpdatedEvent) => void) => { eventListener = listener; return () => {} },
      onReconnected: () => () => {},
      getTransportConnectionState: async () => ({ status: 'connected' }),
    } as unknown as ElectronAPI
    const waiting = waitForOperation(api, 'op-1')
    await new Promise(resolve => setTimeout(resolve, 0))
    eventListener?.({ receipt: receipt(1, 'failed') })
    eventListener?.({ receipt: receipt(3, 'succeeded') })
    await expect(waiting).resolves.toMatchObject({ revision: 3, status: 'succeeded' })
  })

  it('queries the durable receipt after reconnect', async () => {
    let reconnected: (() => void) | undefined
    let connected = false
    const api = {
      getOperation: async () => {
        if (!connected) throw new Error('disconnected')
        return receipt(4, 'succeeded')
      },
      subscribeOperation: async () => { throw new Error('disconnected') },
      onOperationUpdated: () => () => {},
      onReconnected: (listener: () => void) => { reconnected = listener; return () => {} },
      getTransportConnectionState: async () => ({ status: connected ? 'connected' : 'reconnecting' }),
    } as unknown as ElectronAPI
    const communicationStates: string[] = []
    const waiting = waitForOperation(api, 'op-1', {
      onCommunicationState: state => communicationStates.push(state),
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    connected = true
    reconnected?.()
    await expect(waiting).resolves.toMatchObject({ revision: 4, status: 'succeeded' })
    expect(communicationStates).toEqual([
      'waiting',
      'response-uncertain',
      'reconnecting',
      'recovered',
      'settled',
    ])
  })
})
