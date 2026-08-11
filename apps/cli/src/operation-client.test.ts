import { describe, expect, it } from 'bun:test'
import {
  RPC_CHANNELS,
  type OperationReceipt,
  type OperationUpdatedEvent,
} from '@mortise/shared/protocol'

import type { CliRpcClient } from './client'
import { submitFirstTurn, submitSessionMessage, waitForOperation } from './index'

function receipt(revision: number, status: OperationReceipt['status']): OperationReceipt {
  return {
    operationId: 'operation-1',
    operationType: 'session.sendMessage',
    status,
    revision,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(revision).toISOString(),
    scope: { workspaceId: 'workspace-1', sessionId: 'session-1' },
  }
}

interface FakeCliClient {
  isConnected: boolean
  clientId: string | null
  connect(): Promise<string>
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on(channel: string, listener: (value: OperationUpdatedEvent) => void): () => void
}

describe('CLI long-operation recovery', () => {
  it('resubscribes and queries the durable receipt after reconnect', async () => {
    const channels: string[] = []
    let generation = 1
    let getCount = 0
    const client: FakeCliClient = {
      isConnected: true,
      clientId: 'client-1',
      async connect() {
        generation += 1
        this.isConnected = true
        this.clientId = `client-${generation}`
        return this.clientId
      },
      async invoke(channel) {
        channels.push(channel)
        if (channel === RPC_CHANNELS.operations.SUBSCRIBE) return receipt(2, 'running')
        if (channel === RPC_CHANNELS.operations.GET) {
          getCount += 1
          if (getCount === 1) {
            this.isConnected = false
            this.clientId = null
            throw new Error('disconnected')
          }
          return receipt(3, 'succeeded')
        }
        throw new Error(`Unexpected channel: ${channel}`)
      },
      on() { return () => {} },
    }

    await expect(waitForOperation(client as unknown as CliRpcClient, 'operation-1')).resolves.toMatchObject({
      revision: 3,
      status: 'succeeded',
    })
    expect(channels.filter(channel => channel === RPC_CHANNELS.operations.SUBSCRIBE)).toHaveLength(2)
    expect(getCount).toBe(2)
  })

  it('retries a lost submit response with the same operation id', async () => {
    const operationIds: string[] = []
    let submits = 0
    const client: FakeCliClient = {
      isConnected: true,
      clientId: 'client-1',
      async connect() {
        this.isConnected = true
        this.clientId = 'client-2'
        return this.clientId
      },
      async invoke(channel, ...args) {
        if (channel !== RPC_CHANNELS.sessions.SEND_MESSAGE) throw new Error(`Unexpected channel: ${channel}`)
        submits += 1
        const options = args[4] as { operationId: string }
        operationIds.push(options.operationId)
        if (submits === 1) {
          this.isConnected = false
          this.clientId = null
          throw new Error('response lost')
        }
        return {
          accepted: true,
          operationId: options.operationId,
          status: 'running',
          revision: 2,
          duplicate: true,
        }
      },
      on() { return () => {} },
    }

    await expect(submitSessionMessage(
      client as unknown as CliRpcClient,
      'session-1',
      'hello',
      'operation-1',
    )).resolves.toMatchObject({ operationId: 'operation-1', duplicate: true })
    expect(operationIds).toEqual(['operation-1', 'operation-1'])
  })

  it('reconciles a lost first-turn response by operation id before retrying', async () => {
    let submissions = 0
    const client: FakeCliClient = {
      isConnected: true,
      clientId: 'client-1',
      async connect() {
        this.isConnected = true
        this.clientId = 'client-2'
        return this.clientId
      },
      async invoke(channel) {
        if (channel === RPC_CHANNELS.sessions.CREATE_AND_SEND_FIRST_TURN) {
          submissions += 1
          this.isConnected = false
          this.clientId = null
          throw new Error('response lost')
        }
        if (channel === RPC_CHANNELS.operations.GET) return receipt(1, 'accepted')
        throw new Error(`Unexpected channel: ${channel}`)
      },
      on() { return () => {} },
    }

    await expect(submitFirstTurn(client as unknown as CliRpcClient, {
      operationId: 'first-turn-1',
      workspaceId: 'workspace-1',
      message: 'hello',
    })).resolves.toMatchObject({ operationId: 'first-turn-1', duplicate: true })
    expect(submissions).toBe(1)
  })
})
