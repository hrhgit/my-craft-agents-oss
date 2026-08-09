import { randomUUID } from 'node:crypto'
import { CONFIG_DIR, MORTISE_STATE_WRITER_VERSION, getMortiseStateDatabasePath } from '../config/index.ts'
import { MultiWriterStore, type JsonValue } from '../storage/index.ts'

export type MessageOutboxStatus = 'accepted' | 'pi_persisted' | 'failed'

export interface MessageOutboxRecord {
  clientMutationId: string
  sessionId: string
  workspaceId: string
  callerClientId?: string
  message: string
  attachments?: JsonValue
  storedAttachments?: JsonValue
  options?: JsonValue
  /** Minimal session configuration needed to recreate a provisional Session after a crash. */
  sessionOptions?: JsonValue
  provisional?: boolean
  status: MessageOutboxStatus
  attempt: number
  createdAt: number
  updatedAt: number
  error?: string
}

/** Storage boundary used by SessionManager and isolated durability tests. */
export interface MessageOutboxStore {
  put(record: MessageOutboxRecord): void
  update(
    clientMutationId: string,
    patch: Partial<Pick<MessageOutboxRecord, 'status' | 'attempt' | 'updatedAt' | 'error'>>,
  ): void
  listPending(): MessageOutboxRecord[]
  remove(clientMutationId: string): void
}

const NAMESPACE = 'sessions/message-outbox/v1'

let store: MultiWriterStore | null = null
function getStore(): MultiWriterStore {
  return store ??= MultiWriterStore.openSync({
    databasePath: getMortiseStateDatabasePath(CONFIG_DIR),
    writerId: `session-outbox-${process.pid}-${randomUUID()}`,
    writerVersion: MORTISE_STATE_WRITER_VERSION,
  })
}

export function putMessageOutbox(record: MessageOutboxRecord): void {
  const current = getStore().getRecord<JsonValue>(NAMESPACE, record.clientMutationId)
  const normalized = JSON.parse(JSON.stringify(record)) as MessageOutboxRecord
  getStore().mutateRecord({
    namespace: NAMESPACE,
    key: record.clientMutationId,
    value: normalized as unknown as JsonValue,
    expectedVersion: current?.version ?? null,
    operationId: `message-outbox-put-${record.clientMutationId}-${randomUUID()}`,
  })
}

export function updateMessageOutbox(
  clientMutationId: string,
  patch: Partial<Pick<MessageOutboxRecord, 'status' | 'attempt' | 'updatedAt' | 'error'>>,
): void {
  const current = getStore().getRecord<JsonValue>(NAMESPACE, clientMutationId)
  if (!current) return
  putMessageOutbox({ ...(current.value as unknown as MessageOutboxRecord), ...patch })
}

export function getMessageOutbox(clientMutationId: string): MessageOutboxRecord | null {
  const current = getStore().getRecord<JsonValue>(NAMESPACE, clientMutationId)
  return current ? current.value as unknown as MessageOutboxRecord : null
}

export function removeMessageOutbox(clientMutationId: string): void {
  getStore().deleteRecord(NAMESPACE, clientMutationId)
}

export function listPendingMessageOutbox(): MessageOutboxRecord[] {
  return getStore().readTransaction(tx => tx.all<{ value_json: string }>(
    'SELECT value_json FROM mortise_records WHERE namespace = ? ORDER BY updated_at',
    NAMESPACE,
  ).map(row => JSON.parse(row.value_json) as MessageOutboxRecord)
    .filter(record => record.status !== 'pi_persisted'))
}

/** Default durable store adapter. Keep the raw functions available for callers outside server-core. */
export const durableMessageOutbox: MessageOutboxStore = {
  put: putMessageOutbox,
  update: updateMessageOutbox,
  listPending: listPendingMessageOutbox,
  remove: removeMessageOutbox,
}
