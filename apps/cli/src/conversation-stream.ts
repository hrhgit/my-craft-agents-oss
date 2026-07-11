import type { PiProjectionEventV1 } from '@craft-agent/shared/protocol'
import type { CliRpcClient } from './client.ts'

export interface ConversationStreamEvent {
  source: 'pi-projection'
  kind: string
  sessionId: string
  payload: Record<string, unknown>
  raw: unknown
}

/** Pi projection is the only transcript stream for new Craft sessions. */
export function subscribeToConversationStream(
  client: Pick<CliRpcClient, 'on'>,
  sessionId: string,
  listener: (event: ConversationStreamEvent) => void,
): () => void {
  const unsubscribeProjection = client.on('session:piProjectionEvent', (value: unknown) => {
    const event = value as Partial<PiProjectionEventV1>
    if (event.schemaVersion !== 1 || event.sessionId !== sessionId || typeof event.kind !== 'string') return
    listener({
      source: 'pi-projection',
      kind: event.kind,
      sessionId,
      payload: asRecord(event.payload),
      raw: value,
    })
  })

  return () => {
    unsubscribeProjection()
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}
