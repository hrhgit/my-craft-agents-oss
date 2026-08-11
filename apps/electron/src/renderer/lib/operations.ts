import type { ElectronAPI, OperationReceipt, OperationUpdatedEvent } from '../../shared/types'

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled'])

export type OperationCommunicationState =
  | 'waiting'
  | 'response-uncertain'
  | 'reconnecting'
  | 'recovered'
  | 'settled'

export interface WaitForOperationOptions {
  onCommunicationState?(state: OperationCommunicationState): void
}

export async function waitForOperation(
  api: ElectronAPI,
  operationId: string,
  options: WaitForOperationOptions = {},
): Promise<OperationReceipt> {
  return await new Promise<OperationReceipt>((resolve, reject) => {
    let settled = false
    let latestRevision = 0
    let sawReceipt = false
    const cleanups: Array<() => void> = []
    const finish = (result: OperationReceipt | null, error?: unknown) => {
      if (settled) return
      if (error) {
        settled = true
        for (const cleanup of cleanups) cleanup()
        reject(error)
        return
      }
      if (!result || result.operationId !== operationId || result.revision < latestRevision) return
      sawReceipt = true
      latestRevision = result.revision
      if (!TERMINAL.has(result.status)) return
      settled = true
      options.onCommunicationState?.('settled')
      for (const cleanup of cleanups) cleanup()
      resolve(result)
    }
    const query = async () => {
      try {
        const receipt = await api.getOperation({ operationId })
        if (!receipt && !sawReceipt) throw new Error(`Operation ${operationId} was not found`)
        finish(receipt)
      } catch (error) {
        // A transport failure only makes the response uncertain. Reconnect
        // will query the durable receipt again.
        const state = await api.getTransportConnectionState?.().catch(() => null)
        if (state?.status === 'connected') {
          finish(null, error)
          return
        }
        options.onCommunicationState?.('response-uncertain')
        if (state?.status === 'reconnecting' || state?.status === 'connecting') {
          options.onCommunicationState?.('reconnecting')
        }
      }
    }
    options.onCommunicationState?.('waiting')
    cleanups.push(api.onOperationUpdated((event: OperationUpdatedEvent) => finish(event.receipt)))
    if (typeof api.onReconnected === 'function') {
      cleanups.push(api.onReconnected(() => {
        options.onCommunicationState?.('recovered')
        void query()
      }))
    }
    void api.subscribeOperation({ operationId }).then(receipt => finish(receipt)).catch(() => undefined)
    void query()
  })
}
