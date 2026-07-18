import { MultiWriterStore, openCraftSqliteDatabase } from '../../index.ts'

const [mode, databasePath, writerId, rawCount] = process.argv.slice(2)
if (!mode || !databasePath || !writerId) {
  throw new Error('Usage: multi-writer-worker.ts <mode> <databasePath> <writerId> [count]')
}

const count = Number(rawCount ?? 1)

if (mode === 'append') {
  const store = await MultiWriterStore.open({ databasePath, writerId, writerVersion: 1 })
  try {
    for (let index = 0; index < count; index += 1) {
      const id = `${writerId}-${index}`
      const result = store.appendEvent({
        streamId: 'concurrent-stream',
        eventId: `event-${id}`,
        eventType: 'probe',
        schemaVersion: 1,
        payload: { writerId, index },
        operationId: `operation-${id}`,
      })
      if (result.status !== 'applied') throw new Error(`Append conflict for ${id}`)
    }
  } finally {
    store.close()
  }
  process.stdout.write(JSON.stringify({ runtime: process.versions.bun ? 'bun' : 'node', count }))
} else if (mode === 'record') {
  const store = await MultiWriterStore.open({ databasePath, writerId, writerVersion: 1 })
  try {
    const result = store.mutateRecord({
      namespace: 'concurrent-records',
      key: 'shared-key',
      expectedVersion: null,
      value: { writerId },
      operationId: `record-${writerId}`,
    })
    process.stdout.write(JSON.stringify(result))
  } finally {
    store.close()
  }
} else if (mode === 'hold-transaction') {
  const store = await MultiWriterStore.open({ databasePath, writerId, writerVersion: 1 })
  store.close()

  const database = await openCraftSqliteDatabase(databasePath)
  database.exec('BEGIN IMMEDIATE')
  database.prepare(`
    INSERT INTO craft_records
      (namespace, record_key, version, value_json, updated_at, writer_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('crash-probe', 'uncommitted', 1, '{"partial":true}', Date.now(), writerId)
  process.stdout.write('READY\n')
  setInterval(() => {}, 60_000)
} else {
  throw new Error(`Unknown worker mode: ${mode}`)
}
