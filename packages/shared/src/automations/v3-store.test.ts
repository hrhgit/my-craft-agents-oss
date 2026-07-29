import { afterEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CapabilityReadOnlyError, MultiWriterStore } from '../storage/index.ts'
import { automationIdentity, AutomationV3Store } from './v3-store.ts'
import type { AutomationDefinitionV3, AutomationRunV1, AutomationsDocumentV3 } from './v3-types.ts'

const roots: string[] = []
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

function open() {
  const root = mkdtempSync(join(tmpdir(), 'mortise-automations-v3-'))
  roots.push(root)
  return new AutomationV3Store({ workspaceId: 'workspace-one', workspaceRootPath: root })
}

function legacyCapabilities() {
  return {
    'automations.definitions': { minWriteVersion: 1, maxWriteVersion: 1 },
    'automations.ingress': { minWriteVersion: 1, maxWriteVersion: 1 },
    'automations.runs': { minWriteVersion: 1, maxWriteVersion: 1 },
    'automations.history': { minWriteVersion: 1, maxWriteVersion: 1 },
  }
}

function spawnStoreWorker(input: {
  root: string
  databasePath: string
  runId: string
  ownerId: string
  gatePath: string
  action: 'claim' | 'renew' | 'recover' | 'due'
  now?: string
}) {
  const helperPath = join(input.root, `worker-${input.ownerId}.ts`)
  const storeModule = pathToFileURL(join(import.meta.dir, 'v3-store.ts')).href
  writeFileSync(helperPath, `
import { existsSync, writeFileSync } from 'node:fs'
import { AutomationV3Store } from ${JSON.stringify(storeModule)}
import { AutomationV3Runtime } from ${JSON.stringify(pathToFileURL(join(import.meta.dir, 'v3-runtime.ts')).href)}
const [databasePath, root, runId, ownerId, gatePath, action, nowValue] = process.argv.slice(2)
const store = new AutomationV3Store({
  workspaceId: 'workspace-one',
  workspaceRootPath: root,
  databasePath,
  writerId: ownerId,
})
const preparedDue = action === 'due'
  ? store.listDueOccurrences(
      new Date('2027-01-01T00:00:00.000Z'),
      1,
      new Date('2025-12-31T23:59:59.000Z'),
    )[0]
  : undefined
if (action === 'due' && !preparedDue) throw new Error('Expected one due occurrence before the concurrency gate')
writeFileSync(gatePath + '.' + ownerId + '.ready', '')
while (!existsSync(gatePath)) await Bun.sleep(2)
let result
if (action === 'claim') result = store.claimRunExecution(runId, { ownerId, leaseMs: 60_000, now: new Date(nowValue) })
else if (action === 'renew') result = store.renewRunExecution(runId, ownerId, 60_000, new Date(nowValue))
else if (action === 'recover') result = store.recoverExpiredExecutions(new Date(nowValue))
else {
  const due = preparedDue
  if (!due) throw new Error('Expected one prepared due occurrence')
  const runtime = new AutomationV3Runtime({
    workspaceId: 'workspace-one',
    store,
    callbacks: { prompt: async () => ({ status: 'succeeded' }), webhook: async () => ({ status: 'succeeded' }) },
  })
  result = runtime.acceptTimeTrigger(due.definition, due.trigger, due.occurrence, due.definitionRevision)
}
store.close()
process.stdout.write(JSON.stringify(result))
`)
  return Bun.spawn([
    process.execPath,
    helperPath,
    input.databasePath,
    input.root,
    input.runId,
    input.ownerId,
    input.gatePath,
    input.action,
    input.now ?? '2026-07-26T00:00:00.000Z',
  ], { stdout: 'pipe', stderr: 'pipe' })
}

async function releaseWorkers(gatePath: string, ownerIds: string[]): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (ownerIds.every(ownerId => existsSync(`${gatePath}.${ownerId}.ready`))) break
    await Bun.sleep(2)
  }
  expect(ownerIds.every(ownerId => existsSync(`${gatePath}.${ownerId}.ready`))).toBe(true)
  writeFileSync(gatePath, '')
}

async function workerResult(child: ReturnType<typeof Bun.spawn>): Promise<unknown> {
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(stderr).toBe('')
  expect(exitCode).toBe(0)
  return JSON.parse(stdout)
}

function definition(id: string, updatedAt = '2026-07-20T00:00:00.000Z'): AutomationDefinitionV3 {
  return {
    id,
    name: id,
    enabled: true,
    triggers: [{ id: `trigger-${id}`, type: 'event', source: 'external', eventType: 'tests.failed' }],
    actions: [{ id: `action-${id}`, type: 'prompt', prompt: `secret-${id}`, target: { kind: 'new-session' } }],
    createdAt: updatedAt,
    updatedAt,
  }
}

function run(definitionValue: AutomationDefinitionV3, suffix: string): AutomationRunV1 {
  const createdAt = `2026-07-20T00:00:0${suffix}.000Z`
  const occurrenceKey = `event-${suffix}`
  const occurrenceId = automationIdentity(
    'occ',
    'workspace-one',
    definitionValue.id,
    2,
    definitionValue.triggers[0]!.id,
    occurrenceKey,
  )
  const runId = automationIdentity('run', occurrenceId, 0)
  return {
    schemaVersion: 1,
    runId,
    occurrenceId,
    occurrenceKey,
    automationId: definitionValue.id,
    definitionRevision: 2,
    definitionSnapshot: definitionValue,
    triggerId: definitionValue.triggers[0]!.id,
    state: 'queued',
    createdAt,
    actions: [{
      actionRunId: automationIdentity('action', runId, definitionValue.actions[0]!.id),
      actionId: definitionValue.actions[0]!.id,
      state: 'queued',
      attempts: 0,
    }],
  }
}

function timeDefinition(id: string): AutomationDefinitionV3 {
  return {
    ...definition(id),
    triggers: [{
      id: `trigger-${id}`,
      type: 'time',
      schedule: { kind: 'once', at: '2026-01-01T00:00:00.000Z' },
    }],
  }
}

describe('AutomationV3Store', () => {
  it('enforces revision CAS and operation replay', () => {
    const store = open()
    const initial = store.initialize()
    const next: AutomationsDocumentV3 = { ...initial, definitions: [] }
    const applied = store.mutateDocument({ operationId: 'operation-create-0001', expectedRevision: 1, document: next })
    expect(applied.status).toBe('ok')
    expect(applied.revision).toBe(2)
    const replay = store.mutateDocument({ operationId: 'operation-create-0001', expectedRevision: 1, document: next })
    expect(replay.status).toBe('duplicate')
    const stale = store.mutateDocument({ operationId: 'operation-create-0002', expectedRevision: 1, document: next })
    expect(stale.status).toBe('conflict')
    expect(stale.revision).toBe(2)
    store.close()
  })

  it('does not read or rewrite former automations.json formats', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-automations-v3-'))
    roots.push(root)
    const legacyPath = join(root, 'automations.json')
    const legacy = JSON.stringify({ automations: { SchedulerTick: [{ actions: [{ type: 'prompt', prompt: 'old' }] }] } })
    writeFileSync(legacyPath, legacy)
    const store = new AutomationV3Store({ workspaceId: 'workspace-one', workspaceRootPath: root })

    expect(store.initialize()).toEqual({ schemaVersion: 3, revision: 1, definitions: [] })
    expect(readFileSync(legacyPath, 'utf8')).toBe(legacy)
    store.close()
  })

  it('deduplicates CloudEvents by source/id and detects changed payloads', () => {
    const store = open()
    const event = { specversion: '1.0', id: 'event-one', source: 'urn:test:ci', type: 'tests.failed', time: '2026-07-20T00:00:00Z', data: { code: 1 } }
    const accepted = store.acceptCloudEvent(event, { sourceKind: 'external' })
    expect(accepted.status).toBe('accepted')
    expect(accepted.data?.acceptedAt).not.toBe(event.time)
    expect(Date.parse(accepted.data!.acceptedAt)).toBeGreaterThan(Date.parse(event.time))
    expect(store.acceptCloudEvent(event, { sourceKind: 'external' }).status).toBe('duplicate')
    expect(store.acceptCloudEvent({ ...event, data: { code: 2 } }, { sourceKind: 'external' }).status).toBe('conflict')
    store.close()
  })

  it('overwrites untrusted workspace identity and rejects foreign Sessions', () => {
    const store = open()
    const result = store.acceptCloudEvent({
      specversion: '1.0', id: 'event-two', source: 'urn:test', type: 'test', time: '2026-07-20T00:00:00Z',
      mortiseworkspaceid: 'other', mortisesessionid: 'session-other', data: {},
    }, { sourceKind: 'external', validateSession: () => false })
    expect(result.status).toBe('invalid')
    expect(result.error?.code).toBe('invalid_event_session')
    store.close()
  })

  it('provides bounded definition and run pages with stale-cursor rejection', () => {
    const store = open()
    const initial = store.initialize()
    const first = definition('automation-page-0001')
    const second = definition('automation-page-0002')
    expect(store.mutateDocument({
      operationId: 'operation-page-definitions',
      expectedRevision: initial.revision,
      document: { ...initial, definitions: [first, second] },
    }).status).toBe('ok')

    const firstPage = store.listDefinitionsPage({ limit: 1 })
    expect(firstPage.items.map(item => item.id)).toEqual([first.id])
    expect(firstPage.nextCursor).toBeDefined()
    expect(store.listDefinitionsPage({ limit: 1, cursor: firstPage.nextCursor }).items[0]?.id).toBe(second.id)

    expect(store.claimRun(run(first, '1'), 'operation-run-page-1').duplicate).toBe(false)
    expect(store.claimRun(run(first, '2'), 'operation-run-page-2').duplicate).toBe(false)
    const runPage = store.listRunsPage({ automationId: first.id, limit: 1 })
    expect(runPage.items).toHaveLength(1)
    expect(runPage.nextCursor).toBeDefined()
    expect(store.listRunsPage({ automationId: first.id, limit: 1, cursor: runPage.nextCursor }).items).toHaveLength(1)
    expect(() => store.listRunsPage({ automationId: second.id, limit: 1, cursor: runPage.nextCursor }))
      .toThrow('cursor query does not match')
    expect(() => store.listRunsPage({ automationId: first.id, limit: 2, cursor: runPage.nextCursor }))
      .toThrow('cursor query does not match')

    const changed = store.mutateDocument({
      operationId: 'operation-page-definitions-update',
      expectedRevision: 2,
      document: { schemaVersion: 3, revision: 2, definitions: [first] },
    })
    expect(changed.status).toBe('ok')
    expect(() => store.listDefinitionsPage({ limit: 1, cursor: firstPage.nextCursor })).toThrow('cursor is stale')
    store.close()
  })

  it('writes redacted history in the same transaction as the canonical run projection', () => {
    const store = open()
    const initial = store.initialize()
    const value = definition('automation-history-0001')
    expect(store.mutateDocument({
      operationId: 'operation-history-definition',
      expectedRevision: initial.revision,
      document: { ...initial, definitions: [value] },
    }).status).toBe('ok')
    const claimed = run(value, '3')
    store.claimRun(claimed, 'operation-history-run')

    expect(store.listRunsPage({ automationId: value.id }).items[0]?.runId).toBe(claimed.runId)
    const history = store.readHistoryChanges({ runId: claimed.runId, limit: 10 })
    expect(history.items).toHaveLength(1)
    expect(history.items[0]?.kind).toBe('run.created')
    const serialized = JSON.stringify(history.items[0]?.payload)
    expect(serialized).not.toContain('definitionSnapshot')
    expect(serialized).not.toContain(`secret-${value.id}`)
    expect(store.getChangeToken()).toEqual({ revision: 2, historyCursor: 3 })

    const secondRun = run(value, '4')
    store.claimRun(secondRun, 'operation-history-run-2')
    const firstHistoryPage = store.readHistoryChanges({ automationId: value.id, afterSequence: 1, limit: 1 })
    expect(firstHistoryPage.nextCursor).toBeDefined()
    expect(store.readHistoryChanges({
      automationId: value.id,
      afterSequence: 1,
      limit: 1,
      cursor: firstHistoryPage.nextCursor,
    }).items[0]?.payload).toMatchObject({ runId: secondRun.runId })
    expect(() => store.readHistoryChanges({
      automationId: value.id,
      afterSequence: 2,
      limit: 1,
      cursor: firstHistoryPage.nextCursor,
    })).toThrow('cursor query does not match')
    expect(() => store.readHistoryChanges({
      automationId: value.id,
      afterSequence: 1,
      limit: 2,
      cursor: firstHistoryPage.nextCursor,
    })).toThrow('cursor query does not match')
    store.close()
  })

  it('schema-validates and projects canonical legacy V3 records before upgrading capabilities', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-automations-v3-valid-migration-'))
    roots.push(root)
    const databasePath = join(root, 'automations-v3.sqlite')
    const seed = MultiWriterStore.openSync({
      databasePath,
      writerId: 'legacy-writer',
      writerVersion: 1,
      capabilities: legacyCapabilities(),
    })
    const value = definition('automation-valid-migration')
    const document = { schemaVersion: 3 as const, revision: 1, definitions: [value] }
    seed.mutateRecord({
      capability: 'automations.definitions',
      namespace: 'automations-document:workspace-one',
      key: 'definitions',
      value: JSON.parse(JSON.stringify(document)),
      expectedVersion: null,
      operationId: 'legacy-document-create',
    })
    const eventId = automationIdentity('evt', 'urn:test:migration', 'migration-event')
    const event = {
      eventId,
      sourceKind: 'external' as const,
      workspaceId: 'workspace-one',
      cloudEvent: {
        specversion: '1.0' as const,
        id: 'migration-event',
        source: 'urn:test:migration',
        type: 'tests.migrated',
        time: '2026-07-20T00:00:00.000Z',
        data: { status: 'legacy-v3' },
      },
      acceptedAt: '2026-07-20T00:00:01.000Z',
    }
    seed.mutateRecord({
      capability: 'automations.ingress',
      namespace: 'automations-events:workspace-one',
      key: eventId,
      value: JSON.parse(JSON.stringify(event)),
      expectedVersion: null,
      operationId: 'legacy-event-create',
    })
    seed.appendEvent({
      capability: 'automations.history',
      streamId: 'automations-history:workspace-one',
      eventId: automationIdentity('ledger', 'workspace-one', 'event.accepted', eventId),
      eventType: 'event.accepted',
      schemaVersion: 1,
      payload: JSON.parse(JSON.stringify(event)),
      operationId: 'legacy-event-create:ledger:event.accepted',
    })
    const legacyRun = { ...run(value, '1'), eventId }
    seed.mutateRecord({
      capability: 'automations.runs',
      namespace: 'automations-runs:workspace-one',
      key: legacyRun.runId,
      value: JSON.parse(JSON.stringify(legacyRun)),
      expectedVersion: null,
      operationId: 'legacy-run-create',
    })
    seed.appendEvent({
      capability: 'automations.history',
      streamId: 'automations-history:workspace-one',
      eventId: automationIdentity('ledger', 'workspace-one', 'run.created', legacyRun.runId),
      eventType: 'run.created',
      schemaVersion: 1,
      payload: JSON.parse(JSON.stringify(legacyRun)),
      operationId: 'legacy-run-create:ledger:run.created',
    })
    seed.close()

    const migrated = new AutomationV3Store({ workspaceId: 'workspace-one', workspaceRootPath: root, databasePath })
    expect(migrated.listDefinitionsPage().items.map(item => item.id)).toEqual([value.id])
    expect(migrated.listRunsPage({ eventId }).items.map(item => item.runId)).toEqual([legacyRun.runId])
    expect(migrated.readHistoryChanges({ runId: legacyRun.runId }).items).toHaveLength(1)
    expect(migrated.isWritable()).toBe(true)
    migrated.close()
  })

  it('rolls back migration when history workspace and ledger identities are inconsistent', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-automations-v3-history-migration-'))
    roots.push(root)
    const databasePath = join(root, 'automations-v3.sqlite')
    const seed = MultiWriterStore.openSync({
      databasePath,
      writerId: 'legacy-writer',
      writerVersion: 1,
      capabilities: legacyCapabilities(),
    })
    const eventId = automationIdentity('evt', 'urn:test:migration', 'foreign-event')
    const event = {
      eventId,
      sourceKind: 'external' as const,
      workspaceId: 'workspace-one',
      cloudEvent: {
        specversion: '1.0' as const,
        id: 'foreign-event',
        source: 'urn:test:migration',
        type: 'tests.migrated',
        time: '2026-07-20T00:00:00.000Z',
        data: {},
      },
      acceptedAt: '2026-07-20T00:00:01.000Z',
    }
    seed.mutateRecord({
      capability: 'automations.ingress',
      namespace: 'automations-events:workspace-one',
      key: eventId,
      value: JSON.parse(JSON.stringify(event)),
      expectedVersion: null,
      operationId: 'legacy-event-create',
    })
    seed.appendEvent({
      capability: 'automations.history',
      streamId: 'automations-history:workspace-one',
      eventId: automationIdentity('ledger', 'workspace-one', 'event.accepted', eventId),
      eventType: 'event.accepted',
      schemaVersion: 1,
      payload: JSON.parse(JSON.stringify({ ...event, workspaceId: 'workspace-foreign' })),
      operationId: 'legacy-event-create:ledger:event.accepted',
    })
    seed.close()

    expect(() => new AutomationV3Store({ workspaceId: 'workspace-one', workspaceRootPath: root, databasePath }))
      .toThrow('workspace does not match')
    const database = new Database(databasePath, { readonly: true })
    expect(database.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'automation_%'").all()).toEqual([])
    expect(database.query<{ version: number }, [string]>('SELECT version FROM mortise_capabilities WHERE name = ?')
      .get('automations.history')?.version).toBe(1)
    database.close()
  })

  it('rolls back a corrupt automation index backfill and capability upgrade', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-automations-v3-migration-'))
    roots.push(root)
    const databasePath = join(root, 'automations-v3.sqlite')
    const seed = MultiWriterStore.openSync({
      databasePath,
      writerId: 'legacy-writer',
      writerVersion: 1,
      capabilities: legacyCapabilities(),
    })
    seed.mutateRecord({
      capability: 'automations.runs',
      namespace: 'automations-runs:workspace-one',
      key: 'corrupt-run',
      value: JSON.parse(JSON.stringify({ ...run(definition('automation-corrupt-run'), '9'), state: 'not-a-state' })),
      expectedVersion: null,
      operationId: 'legacy-corrupt-run',
    })
    seed.close()

    expect(() => new AutomationV3Store({ workspaceId: 'workspace-one', workspaceRootPath: root, databasePath }))
      .toThrow()

    const database = new Database(databasePath, { readonly: true })
    expect(database.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'automation_%'").all()).toEqual([])
    expect(database.query<{ version: number }, [string]>('SELECT version FROM mortise_capabilities WHERE name = ?')
      .get('automations.runs')?.version).toBe(1)
    expect(database.query<{ count: number }, []>("SELECT count(*) AS count FROM mortise_schema_migrations WHERE id = '1001_automation_v3_index_projection'")
      .get()?.count).toBe(0)
    database.close()
  })

  it('binds one canonical workspace identity to each automation database', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-automations-v3-workspace-identity-'))
    roots.push(root)
    const databasePath = join(root, 'automations-v3.sqlite')
    const first = new AutomationV3Store({ workspaceId: 'workspace-one', workspaceRootPath: root, databasePath })
    first.initialize()
    first.close()
    expect(() => new AutomationV3Store({
      workspaceId: 'workspace-two',
      workspaceRootPath: root,
      databasePath,
    })).toThrow('database workspace identity does not match')
  })

  it('rejects foreign automation namespaces before projection or capability upgrade', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-automations-v3-foreign-workspace-'))
    roots.push(root)
    const databasePath = join(root, 'automations-v3.sqlite')
    const seed = MultiWriterStore.openSync({
      databasePath,
      writerId: 'foreign-workspace-writer',
      writerVersion: 1,
      capabilities: legacyCapabilities(),
    })
    seed.mutateRecord({
      capability: 'automations.definitions',
      namespace: 'automations-document:workspace-foreign',
      key: 'definitions',
      value: { schemaVersion: 3, revision: 1, definitions: [] },
      expectedVersion: null,
      operationId: 'foreign-workspace-document',
    })
    seed.close()

    expect(() => new AutomationV3Store({ workspaceId: 'workspace-one', workspaceRootPath: root, databasePath }))
      .toThrow('foreign workspace authority')
    const database = new Database(databasePath, { readonly: true })
    expect(database.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'automation_%'").all()).toEqual([])
    expect(database.query<{ version: number }, [string]>('SELECT version FROM mortise_capabilities WHERE name = ?')
      .get('automations.definitions')?.version).toBe(1)
    expect(database.query<{ count: number }, []>(`
      SELECT count(*) AS count FROM mortise_schema_migrations
      WHERE id = '1001_automation_v3_index_projection'
    `).get()?.count).toBe(0)
    database.close()
  })

  it('rejects invalid runs before any canonical or operation record is committed', () => {
    const store = open()
    const value = definition('automation-preflight-run')
    store.initialize()
    const valid = run(value, '6')
    const invalid = { ...valid, unexpected: true } as unknown as AutomationRunV1
    expect(() => store.claimRun(invalid, 'operation-invalid-run')).toThrow()
    expect(store.getRun(valid.runId)).toBeNull()
    const database = new Database(store.databasePath, { readonly: true })
    expect(database.query<{ count: number }, [string]>(`
      SELECT count(*) AS count FROM mortise_operations WHERE operation_id = ?
    `).get('operation-invalid-run')?.count).toBe(0)
    database.close()

    store.claimRun(valid, 'operation-valid-run')
    expect(() => store.updateRun(invalid, 'operation-invalid-update')).toThrow()
    expect(store.getRun(valid.runId)).toEqual(valid)
    store.close()
  })

  it('fences only the incompatible capability instead of globally blocking writes', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-automations-v3-capability-scope-'))
    roots.push(root)
    const databasePath = join(root, 'automations-v3.sqlite')
    const current = new AutomationV3Store({ workspaceId: 'workspace-one', workspaceRootPath: root, databasePath })
    current.initialize()
    current.close()
    const future = MultiWriterStore.openSync({
      databasePath,
      writerId: 'future-ingress-writer',
      writerVersion: 2,
      capabilities: {
        'automations.definitions': { minWriteVersion: 4, maxWriteVersion: 4 },
        'automations.ingress': { minWriteVersion: 3, maxWriteVersion: 3 },
        'automations.runs': { minWriteVersion: 2, maxWriteVersion: 2 },
        'automations.history': { minWriteVersion: 2, maxWriteVersion: 2 },
      },
    })
    future.close()
    const database = new Database(databasePath)
    database.run("UPDATE mortise_capabilities SET version = 3 WHERE name = 'automations.ingress'")
    database.close()
    const scoped = new AutomationV3Store({ workspaceId: 'workspace-one', workspaceRootPath: root, databasePath })
    const document = scoped.getDocument()!
    expect(scoped.mutateDocument({
      operationId: 'operation-definition-with-future-ingress',
      expectedRevision: document.revision,
      document,
    }).status).toBe('ok')
    expect(() => scoped.acceptCloudEvent({
      specversion: '1.0', id: 'future-ingress-event', source: 'urn:test:future', type: 'test.future',
      time: '2026-07-26T00:00:00.000Z', data: {},
    }, { sourceKind: 'external' })).toThrow(CapabilityReadOnlyError)
    scoped.close()
  })

  it('rejects changes to run fields that define durable index identity', () => {
    const store = open()
    const value = definition('automation-immutable-run')
    store.initialize()
    const claimed = {
      ...run(value, '9'),
      eventId: 'event-immutable-run',
    }
    store.claimRun(claimed, 'operation-immutable-run')
    for (const [mutation, message] of [
      [{ ...claimed, occurrenceKey: 'event-immutable-changed' }, 'workspace occurrence'],
      [{ ...claimed, eventId: 'event-immutable-changed' }, 'immutable identities cannot change'],
      [{ ...claimed, scheduledAt: '2026-07-21T00:00:00.000Z' }, 'immutable identities cannot change'],
      [{ ...claimed, createdAt: '2026-07-21T00:00:00.000Z' }, 'immutable identities cannot change'],
    ]) {
      expect(() => store.updateRun(mutation as AutomationRunV1, 'operation-change-index-identity'))
        .toThrow(message as string)
    }
    expect(store.listRunsPage({ eventId: 'event-immutable-run' }).items).toHaveLength(1)
    expect(store.listRunsPage({ eventId: 'event-immutable-changed' }).items).toHaveLength(0)
    store.close()
  })

  it('fails explicitly instead of looping on a stale expired-lease projection', () => {
    const store = open()
    const value = definition('automation-stale-lease')
    store.initialize()
    const stale = run(value, '8')
    store.claimRun(stale, 'operation-stale-lease-run')
    store.claimRunExecution(stale.runId, {
      ownerId: 'stale-owner',
      leaseMs: 1,
      now: new Date('2026-07-25T00:00:00.000Z'),
    })
    const database = new Database(store.databasePath)
    database.run('UPDATE automation_run_index SET record_version = 999 WHERE run_id = ?', [stale.runId])
    expect(() => store.recoverExpiredExecutions(new Date('2026-07-26T00:00:00.000Z')))
      .toThrow('projection version is inconsistent')
    database.close()
    store.close()
  })

  it('rolls back canonical records and operation identities when index or history projection fails', () => {
    const store = open()
    const initial = store.initialize()
    const value = definition('automation-fault-0001')
    expect(store.mutateDocument({
      operationId: 'operation-fault-definition',
      expectedRevision: initial.revision,
      document: { ...initial, definitions: [value] },
    }).status).toBe('ok')
    const database = new Database(store.databasePath)

    database.exec("CREATE TRIGGER fail_run_index BEFORE INSERT ON automation_run_index BEGIN SELECT RAISE(ABORT, 'run index fault'); END")
    const failedRunProjection = run(value, '4')
    expect(() => store.claimRun(failedRunProjection, 'operation-run-index-fault')).toThrow('run index fault')
    expect(store.getRun(failedRunProjection.runId)).toBeNull()
    expect(database.query<{ count: number }, []>("SELECT count(*) AS count FROM mortise_operations WHERE operation_id = 'operation-run-index-fault'").get()?.count).toBe(0)
    database.exec('DROP TRIGGER fail_run_index')

    database.exec("CREATE TRIGGER fail_history_index BEFORE INSERT ON automation_history_index BEGIN SELECT RAISE(ABORT, 'history index fault'); END")
    const failedHistoryProjection = run(value, '5')
    expect(() => store.claimRun(failedHistoryProjection, 'operation-history-index-fault')).toThrow('history index fault')
    expect(store.getRun(failedHistoryProjection.runId)).toBeNull()
    expect(database.query<{ count: number }, [string]>("SELECT count(*) AS count FROM automation_run_index WHERE run_id = ?").get(failedHistoryProjection.runId)?.count).toBe(0)
    expect(database.query<{ count: number }, []>("SELECT count(*) AS count FROM mortise_events WHERE operation_id = 'operation-history-index-fault:ledger:run.created'").get()?.count).toBe(0)
    expect(database.query<{ count: number }, []>("SELECT count(*) AS count FROM mortise_operations WHERE operation_id = 'operation-history-index-fault'").get()?.count).toBe(0)
    database.exec('DROP TRIGGER fail_history_index')
    database.close()
    store.close()
  })

  it('fences an already-open old automation writer after the index capability upgrade', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-automations-v3-fence-'))
    roots.push(root)
    const databasePath = join(root, 'automations-v3.sqlite')
    const oldWriter = MultiWriterStore.openSync({
      databasePath,
      writerId: 'old-writer',
      writerVersion: 1,
      capabilities: legacyCapabilities(),
    })
    const oldReadableRun = run(definition('automation-old-writer'), '8')
    oldWriter.mutateRecord({
      capability: 'automations.runs',
      namespace: 'automations-runs:workspace-one',
      key: oldReadableRun.runId,
      value: JSON.parse(JSON.stringify(oldReadableRun)),
      expectedVersion: null,
      operationId: 'old-readable-run-create',
    })
    let currentWriter: AutomationV3Store | undefined
    try {
      currentWriter = new AutomationV3Store({ workspaceId: 'workspace-one', workspaceRootPath: root, databasePath })
      expect(oldWriter.getRecord('automations-runs:workspace-one', oldReadableRun.runId)).not.toBeNull()
      expect(() => oldWriter.mutateRecord({
        capability: 'automations.runs',
        namespace: 'automations-runs:workspace-one',
        key: 'old-writer-after-upgrade',
        value: { state: 'queued' },
        expectedVersion: null,
        operationId: 'old-writer-after-upgrade',
      })).toThrow(CapabilityReadOnlyError)
    } finally {
      currentWriter?.close()
      oldWriter.close()
    }
  })

  it('allows exactly one process to claim a queued run', async () => {
    const store = open()
    const value = definition('automation-concurrent-claim')
    store.initialize()
    const queued = run(value, '6')
    store.claimRun(queued, 'operation-concurrent-run')
    const root = store.workspaceRootPath
    const databasePath = store.databasePath
    store.close()
    const gatePath = join(root, 'claim.gate')
    const first = spawnStoreWorker({ root, databasePath, runId: queued.runId, ownerId: 'claim-a', gatePath, action: 'claim' })
    const second = spawnStoreWorker({ root, databasePath, runId: queued.runId, ownerId: 'claim-b', gatePath, action: 'claim' })
    await releaseWorkers(gatePath, ['claim-a', 'claim-b'])
    const results = await Promise.all([workerResult(first), workerResult(second)]) as Array<{ claimed: boolean }>
    expect(results.filter(result => result.claimed)).toHaveLength(1)
    const verifier = new AutomationV3Store({ workspaceId: 'workspace-one', workspaceRootPath: root, databasePath })
    expect(verifier.getRun(queued.runId)?.state).toBe('running')
    verifier.close()
  })

  it('allows two hosts to claim one due occurrence only once', async () => {
    const store = open()
    const value = timeDefinition('automation-concurrent-due')
    const initial = store.initialize()
    expect(store.mutateDocument({
      operationId: 'operation-concurrent-due-definition',
      expectedRevision: initial.revision,
      document: { ...initial, definitions: [value] },
    }).status).toBe('ok')
    const root = store.workspaceRootPath
    const databasePath = store.databasePath
    store.close()
    const gatePath = join(root, 'due.gate')
    const first = spawnStoreWorker({ root, databasePath, runId: 'unused-due-run', ownerId: 'due-a', gatePath, action: 'due' })
    const second = spawnStoreWorker({ root, databasePath, runId: 'unused-due-run', ownerId: 'due-b', gatePath, action: 'due' })
    await releaseWorkers(gatePath, ['due-a', 'due-b'])
    const results = await Promise.all([workerResult(first), workerResult(second)]) as Array<{ runId: string }>
    expect(new Set(results.map(result => result.runId)).size).toBe(1)
    const verifier = new AutomationV3Store({ workspaceId: 'workspace-one', workspaceRootPath: root, databasePath })
    expect(verifier.listRunsPage({ automationId: value.id }).items).toHaveLength(1)
    expect(verifier.readHistoryChanges({ runId: results[0]!.runId }).items.filter(item => item.kind === 'run.created')).toHaveLength(1)
    expect(verifier.listDueOccurrences(new Date('2027-01-01T00:00:00.000Z'))).toHaveLength(0)
    verifier.close()
  })

  it('does not expire a lease after another host renews it first', () => {
    const renewHost = open()
    const value = definition('automation-renew-first')
    renewHost.initialize()
    const leased = run(value, '7')
    renewHost.claimRun(leased, 'operation-renew-first-run')
    renewHost.claimRunExecution(leased.runId, {
      ownerId: 'lease-owner',
      leaseMs: 1,
      now: new Date('2026-07-25T00:00:00.000Z'),
    })
    const recoveryHost = new AutomationV3Store({
      workspaceId: 'workspace-one',
      workspaceRootPath: renewHost.workspaceRootPath,
      databasePath: renewHost.databasePath,
      writerId: 'recovery-host',
    })
    const boundary = new Date('2026-07-26T00:00:00.000Z')
    const renewed = renewHost.renewRunExecution(leased.runId, 'lease-owner', 60_000, boundary)
    expect(renewed?.executor?.leaseExpiresAt).toBe('2026-07-26T00:01:00.000Z')
    expect(recoveryHost.recoverExpiredExecutions(boundary)).toEqual([])
    expect(recoveryHost.getRun(leased.runId)).toMatchObject({ state: 'running' })
    recoveryHost.close()
    renewHost.close()
  })

  it('rejects renewal after another host commits expiry recovery first', () => {
    const recoveryHost = open()
    const value = definition('automation-recovery-first')
    recoveryHost.initialize()
    const leased = run(value, '8')
    recoveryHost.claimRun(leased, 'operation-recovery-first-run')
    recoveryHost.claimRunExecution(leased.runId, {
      ownerId: 'lease-owner',
      leaseMs: 1,
      now: new Date('2026-07-25T00:00:00.000Z'),
    })
    const renewHost = new AutomationV3Store({
      workspaceId: 'workspace-one',
      workspaceRootPath: recoveryHost.workspaceRootPath,
      databasePath: recoveryHost.databasePath,
      writerId: 'renew-host',
    })
    const boundary = new Date('2026-07-26T00:00:00.000Z')
    expect(recoveryHost.recoverExpiredExecutions(boundary)).toHaveLength(1)
    expect(renewHost.renewRunExecution(leased.runId, 'lease-owner', 60_000, boundary)).toBeNull()
    expect(renewHost.getRun(leased.runId)).toMatchObject({
      state: 'failed',
      reason: 'execution-lease-expired',
    })
    renewHost.close()
    recoveryHost.close()
  })
})
