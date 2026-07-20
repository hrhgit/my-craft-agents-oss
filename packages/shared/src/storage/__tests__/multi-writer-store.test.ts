import { afterEach, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  CapabilityReadOnlyError,
  MigrationChecksumError,
  MultiWriterStore,
  OperationIdentityConflictError,
  openCraftSqliteDatabase,
} from '../index.ts'

const temporaryDirectories: string[] = []
const repositoryRoot = resolve(import.meta.dir, '../../../../..')
const workerPath = join(import.meta.dir, 'fixtures', 'multi-writer-worker.ts')

function createDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'mortise-multi-writer-'))
  temporaryDirectories.push(directory)
  return join(directory, 'mortise-state.sqlite')
}

function electronExecutablePath(): string {
  if (process.platform === 'win32') {
    return join(repositoryRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
  }
  if (process.platform === 'darwin') {
    return join(repositoryRoot, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
  }
  return join(repositoryRoot, 'node_modules', 'electron', 'dist', 'electron')
}

interface ProcessResult {
  stdout: string
  stderr: string
}

function collectProcess(child: ChildProcess): Promise<ProcessResult> {
  let stdout = ''
  let stderr = ''
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', chunk => { stdout += chunk })
  child.stderr?.on('data', chunk => { stderr += chunk })
  return new Promise((resolvePromise, reject) => {
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolvePromise({ stdout, stderr })
      else reject(new Error(`Worker exited with ${code}: ${stderr}`))
    })
  })
}

function spawnBunWorker(args: string[]): ChildProcess {
  return spawn(process.execPath, [workerPath, ...args], {
    cwd: repositoryRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function spawnElectronWorker(args: string[]): ChildProcess {
  return spawn(electronExecutablePath(), [workerPath, ...args], {
    cwd: repositoryRoot,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

async function waitForOutput(child: ChildProcess, expected: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    let stdout = ''
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${expected}`)), 10_000)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', chunk => {
      stdout += chunk
      if (stdout.includes(expected)) {
        clearTimeout(timer)
        resolvePromise()
      }
    })
    child.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('MultiWriterStore', () => {
  it('uses WAL and applies idempotent CAS mutations', async () => {
    const databasePath = createDatabasePath()
    const store = await MultiWriterStore.open({ databasePath, writerId: 'writer-a', writerVersion: 1 })
    try {
      expect(store.runtime).toBe('bun')
      const create = store.mutateRecord({
        namespace: 'config',
        key: '/theme',
        value: 'dark',
        expectedVersion: null,
        operationId: 'set-theme-1',
      })
      expect(create).toEqual({ status: 'applied', version: 1, value: 'dark', replayed: false })

      const replay = store.mutateRecord({
        namespace: 'config',
        key: '/theme',
        value: 'dark',
        expectedVersion: null,
        operationId: 'set-theme-1',
      })
      expect(replay).toEqual({ status: 'applied', version: 1, value: 'dark', replayed: true })

      const conflict = store.mutateRecord({
        namespace: 'config',
        key: '/theme',
        value: 'light',
        expectedVersion: null,
        operationId: 'set-theme-stale',
      })
      expect(conflict).toEqual({
        status: 'conflict',
        currentVersion: 1,
        currentValue: 'dark',
        replayed: false,
      })
      expect(store.getRecord('config', '/theme')?.value).toBe('dark')

      expect(() => store.mutateRecord({
        namespace: 'config',
        key: '/theme',
        value: 'different',
        expectedVersion: 1,
        operationId: 'set-theme-1',
      })).toThrow(OperationIdentityConflictError)
    } finally {
      store.close()
    }

    const database = await openCraftSqliteDatabase(databasePath)
    try {
      const journalMode = database.prepare('PRAGMA journal_mode').get<{ journal_mode: string }>()
      expect(journalMode?.journal_mode.toLowerCase()).toBe('wal')
    } finally {
      database.close()
    }
  })

  it('allocates ordered event sequences and deduplicates retries', async () => {
    const store = await MultiWriterStore.open({
      databasePath: createDatabasePath(),
      writerId: 'event-writer',
      writerVersion: 1,
    })
    try {
      const first = store.appendEvent({
        streamId: 'session-1',
        eventId: 'event-1',
        eventType: 'message',
        schemaVersion: 1,
        payload: { text: 'hello' },
        operationId: 'event-operation-1',
        expectedSequence: 0,
      })
      expect(first).toEqual({ status: 'applied', sequence: 1, replayed: false })

      const replay = store.appendEvent({
        streamId: 'session-1',
        eventId: 'event-1',
        eventType: 'message',
        schemaVersion: 1,
        payload: { text: 'hello' },
        operationId: 'event-operation-1',
        expectedSequence: 0,
      })
      expect(replay).toEqual({ status: 'applied', sequence: 1, replayed: true })

      const stale = store.appendEvent({
        streamId: 'session-1',
        eventId: 'event-2',
        eventType: 'message',
        schemaVersion: 1,
        payload: { text: 'stale' },
        operationId: 'event-operation-stale',
        expectedSequence: 0,
      })
      expect(stale).toEqual({
        status: 'conflict',
        reason: 'sequence_mismatch',
        currentSequence: 1,
        replayed: false,
      })
      expect(store.listEvents('session-1')).toHaveLength(1)
    } finally {
      store.close()
    }
  })

  it('fences only an incompatible capability while preserving reads and other writes', async () => {
    const databasePath = createDatabasePath()
    const store = await MultiWriterStore.open({ databasePath, writerId: 'old-writer', writerVersion: 1 })
    try {
      store.mutateRecord({
        namespace: 'config',
        key: '/language',
        value: 'zh-CN',
        expectedVersion: null,
        operationId: 'language-1',
      })

      const database = await openCraftSqliteDatabase(databasePath)
      try {
        database.prepare(`UPDATE mortise_capabilities SET version = 2 WHERE name = 'records'`).run()
      } finally {
        database.close()
      }

      expect(store.getRecord('config', '/language')?.value).toBe('zh-CN')
      expect(() => store.mutateRecord({
        namespace: 'config',
        key: '/language',
        value: 'en-US',
        expectedVersion: 1,
        operationId: 'language-2',
      })).toThrow(CapabilityReadOnlyError)

      expect(store.appendEvent({
        streamId: 'compatible-events',
        eventId: 'compatible-event-1',
        eventType: 'probe',
        schemaVersion: 1,
        payload: { ok: true },
        operationId: 'compatible-event-operation-1',
      }).status).toBe('applied')
    } finally {
      store.close()
    }
  })

  it('registers and fences domain-specific capabilities independently', async () => {
    const databasePath = createDatabasePath()
    const current = await MultiWriterStore.open({
      databasePath,
      writerId: 'automation-v3-writer',
      writerVersion: 1,
      capabilities: { 'automations.definitions': { minWriteVersion: 3, maxWriteVersion: 3 } },
    })
    try {
      expect(current.getCapabilityVersion('automations.definitions')).toBe(3)
      expect(current.mutateRecord({
        capability: 'automations.definitions',
        namespace: 'automations',
        key: 'definitions',
        value: { schemaVersion: 3 },
        expectedVersion: null,
        operationId: 'automation-definition-v3',
      }).status).toBe('applied')
    } finally {
      current.close()
    }

    const older = await MultiWriterStore.open({
      databasePath,
      writerId: 'automation-v2-writer',
      writerVersion: 1,
      capabilities: { 'automations.definitions': { minWriteVersion: 2, maxWriteVersion: 2 } },
    })
    try {
      expect(older.getRecord('automations', 'definitions')?.value).toEqual({ schemaVersion: 3 })
      expect(older.isCapabilityWritable('automations.definitions')).toBe(false)
      expect(() => older.mutateRecord({
        capability: 'automations.definitions',
        namespace: 'automations',
        key: 'definitions',
        value: { schemaVersion: 2 },
        expectedVersion: 1,
        operationId: 'automation-definition-v2',
      })).toThrow(CapabilityReadOnlyError)
      expect(older.appendEvent({
        streamId: 'compatible-events',
        eventId: 'compatible-domain-event',
        eventType: 'probe',
        schemaVersion: 1,
        payload: { ok: true },
        operationId: 'compatible-domain-event-operation',
      }).status).toBe('applied')
    } finally {
      older.close()
    }
  })

  it('rejects a modified known migration but ignores unknown newer migrations', async () => {
    const databasePath = createDatabasePath()
    const initial = await MultiWriterStore.open({ databasePath, writerId: 'writer-a', writerVersion: 1 })
    initial.close()

    const database = await openCraftSqliteDatabase(databasePath)
    database.prepare(`
      INSERT INTO mortise_schema_migrations (id, checksum, applied_at) VALUES (?, ?, ?)
    `).run('9999_future_additive', 'future-checksum', Date.now())
    database.close()

    const compatible = await MultiWriterStore.open({ databasePath, writerId: 'writer-b', writerVersion: 1 })
    compatible.close()

    const tamper = await openCraftSqliteDatabase(databasePath)
    tamper.prepare(`
      UPDATE mortise_schema_migrations SET checksum = 'invalid'
      WHERE id = '0001_multi_writer_core'
    `).run()
    tamper.close()

    await expect(MultiWriterStore.open({
      databasePath,
      writerId: 'writer-c',
      writerVersion: 1,
    })).rejects.toBeInstanceOf(MigrationChecksumError)
  })

  it('supports concurrent Bun and Electron writers without lost events', async () => {
    const databasePath = createDatabasePath()
    const initial = await MultiWriterStore.open({ databasePath, writerId: 'initializer', writerVersion: 1 })
    initial.close()

    const [bunResult, electronResult] = await Promise.all([
      collectProcess(spawnBunWorker(['append', databasePath, 'bun-writer', '60'])),
      collectProcess(spawnElectronWorker(['append', databasePath, 'electron-writer', '60'])),
    ])
    expect(JSON.parse(bunResult.stdout)).toEqual({ runtime: 'bun', count: 60 })
    expect(JSON.parse(electronResult.stdout)).toEqual({ runtime: 'node', count: 60 })

    const reader = await MultiWriterStore.open({ databasePath, writerId: 'reader', writerVersion: 1 })
    try {
      const events = reader.listEvents<{ writerId: string; index: number }>('concurrent-stream')
      expect(events).toHaveLength(120)
      expect(events.map(event => event.sequence)).toEqual(Array.from({ length: 120 }, (_, index) => index + 1))
      expect(new Set(events.map(event => event.eventId)).size).toBe(120)
    } finally {
      reader.close()
    }
  }, 30_000)

  it('turns simultaneous create attempts into one applied CAS and one conflict', async () => {
    const databasePath = createDatabasePath()
    const initial = await MultiWriterStore.open({ databasePath, writerId: 'initializer', writerVersion: 1 })
    initial.close()

    const results = await Promise.all([
      collectProcess(spawnBunWorker(['record', databasePath, 'bun-cas'])),
      collectProcess(spawnElectronWorker(['record', databasePath, 'electron-cas'])),
    ])
    const statuses = results.map(result => JSON.parse(result.stdout).status).sort()
    expect(statuses).toEqual(['applied', 'conflict'])
  }, 30_000)

  it('recovers an uncommitted transaction after a writer is terminated', async () => {
    const databasePath = createDatabasePath()
    const initial = await MultiWriterStore.open({ databasePath, writerId: 'initializer', writerVersion: 1 })
    initial.close()

    const child = spawnBunWorker(['hold-transaction', databasePath, 'terminated-writer'])
    await waitForOutput(child, 'READY')
    child.kill()
    await new Promise<void>(resolvePromise => child.once('exit', () => resolvePromise()))

    const recovered = await MultiWriterStore.open({ databasePath, writerId: 'recovery-writer', writerVersion: 1 })
    try {
      expect(recovered.getRecord('crash-probe', 'uncommitted')).toBeNull()
      expect(recovered.mutateRecord({
        namespace: 'crash-probe',
        key: 'uncommitted',
        value: { recovered: true },
        expectedVersion: null,
        operationId: 'recovery-operation',
      }).status).toBe('applied')
    } finally {
      recovered.close()
    }
  }, 30_000)
})
