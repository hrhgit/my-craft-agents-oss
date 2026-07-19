import { afterEach, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { createWorkspaceIdentity, WorkspaceCoordinationStore } from '../index.ts'

const workerPath = fileURLToPath(new URL('./fixtures/coordination-worker.ts', import.meta.url))
const repositoryRoot = resolve(import.meta.dir, '../../../../..')
const temporaryDirectories: string[] = []
const spawnedChildren: ChildProcess[] = []

interface Harness {
  configDir: string
  workspaceRoot: string
}

function createHarness(): Harness {
  const root = mkdtempSync(join(tmpdir(), 'mortise-coordination-'))
  const configDir = join(root, 'config')
  const workspaceRoot = join(root, 'workspace')
  mkdirSync(configDir, { recursive: true })
  mkdirSync(workspaceRoot, { recursive: true })
  temporaryDirectories.push(root)
  return { configDir, workspaceRoot }
}

function openStore(harness: Harness, writerId: string): WorkspaceCoordinationStore {
  return WorkspaceCoordinationStore.open({
    configDir: harness.configDir,
    workspaceRoot: harness.workspaceRoot,
    workspaceId: 'ws-test',
    writerId,
  })
}

function begin(store: WorkspaceCoordinationStore, activityId: string, now = Date.now(), leaseDurationMs = 30_000): void {
  store.beginActivity({
    operationId: `begin:${activityId}`,
    activityId,
    actor: { kind: 'agent', id: activityId, sessionId: activityId },
    intent: `Work for ${activityId}`,
    leaseDurationMs,
    now,
  })
}

function spawnWorker(
  harness: Harness,
  activityId: string,
  resourcePath: string,
  barrierPath: string,
): ChildProcess {
  const child = spawn(process.execPath, [
    workerPath,
    harness.configDir,
    harness.workspaceRoot,
    `writer:${activityId}`,
    activityId,
    `claim:${activityId}`,
    resourcePath,
    barrierPath,
  ], {
    cwd: repositoryRoot,
    env: { ...process.env, MORTISE_CONFIG_DIR: harness.configDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  spawnedChildren.push(child)
  return child
}

function waitForReady(child: ChildProcess): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    let stdout = ''
    let stderr = ''
    const onData = (chunk: Buffer | string) => {
      stdout += String(chunk)
      if (stdout.includes('READY\n')) {
        child.stdout?.off('data', onData)
        resolvePromise()
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', chunk => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('exit', code => {
      if (!stdout.includes('READY\n')) reject(new Error(`Worker exited before ready (${code}): ${stderr}`))
    })
  })
}

function collectResult(child: ChildProcess): Promise<{ status: string }> {
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', chunk => { stdout += String(chunk) })
  child.stderr?.on('data', chunk => { stderr += String(chunk) })
  return new Promise((resolvePromise, reject) => {
    child.once('error', reject)
    child.once('exit', code => {
      if (code !== 0) {
        reject(new Error(`Worker exited with ${code}: ${stderr}`))
        return
      }
      const jsonLine = stdout.trim().split(/\r?\n/).findLast(line => line.startsWith('{'))
      if (!jsonLine) {
        reject(new Error(`Worker returned no result: ${stdout}`))
        return
      }
      resolvePromise(JSON.parse(jsonLine) as { status: string })
    })
  })
}

afterEach(async () => {
  for (const child of spawnedChildren.splice(0)) {
    if (child.exitCode !== null) continue
    child.kill()
    await Promise.race([
      new Promise<void>(resolvePromise => child.once('exit', () => resolvePromise())),
      delay(1_000).then(() => undefined),
    ])
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('WorkspaceCoordinationStore', () => {
  it('uses canonical workspace identity and an external provenance ledger', () => {
    const harness = createHarness()
    const previousConfigDir = process.env.MORTISE_CONFIG_DIR
    process.env.MORTISE_CONFIG_DIR = harness.configDir
    const store = WorkspaceCoordinationStore.open({
      workspaceRoot: harness.workspaceRoot,
      workspaceId: 'ws-test',
      writerId: 'writer-a',
    })
    try {
      const expected = createWorkspaceIdentity(harness.workspaceRoot, 'ws-test')
      expect(store.workspace).toEqual(expected)
      expect(store.databasePath).toBe(join(
        harness.configDir,
        'provenance',
        'v1',
        expected.workspaceKey,
        'ledger.sqlite',
      ))
      expect(existsSync(store.databasePath)).toBe(true)
      expect(store.databasePath.startsWith(harness.workspaceRoot)).toBe(false)
    } finally {
      store.close()
      if (previousConfigDir === undefined) delete process.env.MORTISE_CONFIG_DIR
      else process.env.MORTISE_CONFIG_DIR = previousConfigDir
    }
  })

  it('blocks only blocking-to-blocking conflicts and retains advisory overlaps', () => {
    const harness = createHarness()
    const first = openStore(harness, 'writer-a')
    const second = openStore(harness, 'writer-b')
    try {
      begin(first, 'activity-a', 1_000)
      begin(second, 'activity-b', 1_000)
      begin(second, 'activity-c', 1_000)
      expect(first.acquireClaim({
        operationId: 'claim-op-a',
        claimId: 'claim-a',
        activityId: 'activity-a',
        resource: { kind: 'file', path: 'src/shared.ts' },
        enforcement: 'blocking',
        leaseDurationMs: 10_000,
        now: 1_000,
      }).status).toBe('acquired')

      const advisory = second.acquireClaim({
        operationId: 'claim-op-b',
        claimId: 'claim-b',
        activityId: 'activity-b',
        resource: { kind: 'file', path: 'src/shared.ts' },
        enforcement: 'advisory',
        leaseDurationMs: 10_000,
        now: 1_000,
      })
      expect(advisory.status).toBe('acquired')
      if (advisory.status === 'acquired') expect(advisory.conflicts.map(item => item.claimId)).toEqual(['claim-a'])

      const blocked = second.acquireClaim({
        operationId: 'claim-op-c',
        claimId: 'claim-c',
        activityId: 'activity-c',
        resource: { kind: 'file', path: 'src/shared.ts' },
        enforcement: 'blocking',
        leaseDurationMs: 10_000,
        now: 1_000,
      })
      expect(blocked.status).toBe('conflict')
      if (blocked.status === 'conflict') {
        expect(blocked.conflicts.map(item => item.claimId).sort()).toEqual(['claim-a', 'claim-b'])
      }

      expect(first.releaseClaim({ operationId: 'release-a', claimId: 'claim-a', activityId: 'activity-a', now: 1_100 })).toBe(true)
      const blockingAgainstAdvisory = second.acquireClaim({
        operationId: 'claim-op-c-retry',
        claimId: 'claim-c',
        activityId: 'activity-c',
        resource: { kind: 'file', path: 'src/shared.ts' },
        enforcement: 'blocking',
        leaseDurationMs: 10_000,
        now: 1_100,
      })
      expect(blockingAgainstAdvisory.status).toBe('acquired')
      if (blockingAgainstAdvisory.status === 'acquired') {
        expect(blockingAgainstAdvisory.conflicts.map(item => item.claimId)).toEqual(['claim-b'])
      }
      expect(second.acquireClaim({
        operationId: 'claim-op-c-retry',
        claimId: 'claim-c',
        activityId: 'activity-c',
        resource: { kind: 'file', path: 'src/shared.ts' },
        enforcement: 'blocking',
        leaseDurationMs: 10_000,
        now: 1_100,
      })).toMatchObject({ status: 'acquired', replayed: true })
    } finally {
      first.close()
      second.close()
    }
  })

  it('overlaps broad workspace file resources with exact file claims', () => {
    const harness = createHarness()
    const store = openStore(harness, 'writer-a')
    try {
      begin(store, 'snapshot-activity', 1_000)
      begin(store, 'file-activity', 1_000)
      expect(store.acquireClaim({
        operationId: 'snapshot-claim-op',
        claimId: 'snapshot-claim',
        activityId: 'snapshot-activity',
        resource: { kind: 'logical', name: 'workspace/source-snapshot' },
        access: 'read',
        enforcement: 'blocking',
        leaseDurationMs: 10_000,
        now: 1_000,
      }).status).toBe('acquired')
      const fileWrite = store.acquireClaim({
        operationId: 'file-claim-op',
        claimId: 'file-claim',
        activityId: 'file-activity',
        resource: { kind: 'file', path: 'src/app.ts' },
        access: 'write',
        enforcement: 'blocking',
        leaseDurationMs: 10_000,
        now: 1_000,
      })
      expect(fileWrite.status).toBe('conflict')
      if (fileWrite.status === 'conflict') {
        expect(fileWrite.conflicts.map(item => item.claimId)).toEqual(['snapshot-claim'])
      }
    } finally {
      store.close()
    }
  })

  it('reclaims expired activity and claim leases', () => {
    const harness = createHarness()
    const first = openStore(harness, 'writer-a')
    const second = openStore(harness, 'writer-b')
    try {
      begin(first, 'expired-activity', 1_000, 100)
      expect(first.acquireClaim({
        operationId: 'expired-claim-op',
        claimId: 'expired-claim',
        activityId: 'expired-activity',
        resource: { kind: 'logical', name: 'electron/dist' },
        leaseDurationMs: 100,
        now: 1_000,
      }).status).toBe('acquired')

      begin(second, 'next-activity', 1_200, 1_000)
      const reclaimed = second.acquireClaim({
        operationId: 'next-claim-op',
        claimId: 'next-claim',
        activityId: 'next-activity',
        resource: { kind: 'logical', name: 'electron/dist' },
        leaseDurationMs: 1_000,
        now: 1_200,
      })
      expect(reclaimed.status).toBe('acquired')
      expect(second.snapshot({ now: 1_200 }).activities.map(item => item.activityId)).toEqual(['next-activity'])
      expect(second.snapshot({ now: 1_200 }).claims.map(item => item.claimId)).toEqual(['next-claim'])
    } finally {
      first.close()
      second.close()
    }
  })

  it('heartbeats an activity and its claims, then releases them together', () => {
    const harness = createHarness()
    const store = openStore(harness, 'writer-a')
    try {
      begin(store, 'activity-a', 1_000, 100)
      store.acquireClaim({
        operationId: 'claim-op-a',
        claimId: 'claim-a',
        activityId: 'activity-a',
        resource: { kind: 'logical', name: 'installer/windows' },
        leaseDurationMs: 100,
        now: 1_000,
      })
      const heartbeat = store.heartbeatActivity({
        operationId: 'heartbeat-a',
        activityId: 'activity-a',
        leaseDurationMs: 500,
        now: 1_050,
      })
      expect(heartbeat.leaseExpiresAt).toBe(1_550)
      expect(store.snapshot({ now: 1_200 }).claims[0]?.leaseExpiresAt).toBe(1_550)

      expect(store.releaseActivity({
        operationId: 'release-activity-a',
        activityId: 'activity-a',
        now: 1_250,
      })).toBe(true)
      const released = store.snapshot({ now: 1_250 })
      expect(released.activities).toEqual([])
      expect(released.claims).toEqual([])
      expect(() => store.heartbeatActivity({
        operationId: 'heartbeat-after-release',
        activityId: 'activity-a',
        leaseDurationMs: 500,
        now: 1_300,
      })).toThrow('Activity is not active')
      expect(() => store.acquireClaim({
        operationId: 'claim-after-release',
        claimId: 'claim-after-release',
        activityId: 'activity-a',
        resource: { kind: 'logical', name: 'installer/windows' },
        leaseDurationMs: 500,
        now: 1_300,
      })).toThrow('Activity is not active')
    } finally {
      store.close()
    }
  })

  it('stores before and after blobs by SHA-256 and exposes recent changes', () => {
    const harness = createHarness()
    const store = openStore(harness, 'writer-a')
    try {
      begin(store, 'activity-a')
      const change = store.recordChange({
        operationId: 'change-op-1',
        changeId: 'change-1',
        activityId: 'activity-a',
        actor: { kind: 'agent', id: 'agent-a', sessionId: 'activity-a', turnId: 'turn-1', toolUseId: 'tool-1' },
        resource: { kind: 'file', path: 'src/example.ts' },
        beforeContent: 'export const value = 1\n',
        afterContent: 'export const value = 2\n',
        summary: 'Update the value',
      })
      expect(change.before?.oid).not.toBe(change.after?.oid)
      expect(change.before && store.hasBlob(change.before.oid)).toBe(true)
      expect(change.after && Buffer.from(store.readBlob(change.after.oid)).toString('utf8')).toBe('export const value = 2\n')
      expect(store.listRecentChanges(1)).toEqual([change])
      expect(store.snapshot().recentChanges).toEqual([change])
      expect(store.listRecentChanges(0)).toEqual([])
    } finally {
      store.close()
    }
  })

  it('uses cross-process CAS for conflicting claims and permits disjoint resources', async () => {
    const harness = createHarness()
    const initializer = openStore(harness, 'initializer')
    initializer.close()

    const sameBarrier = join(harness.configDir, 'same.go')
    const sameA = spawnWorker(harness, 'same-a', 'src/shared.ts', sameBarrier)
    const sameB = spawnWorker(harness, 'same-b', 'src/shared.ts', sameBarrier)
    await Promise.all([waitForReady(sameA), waitForReady(sameB)])
    const sameResults = [collectResult(sameA), collectResult(sameB)]
    writeFileSync(sameBarrier, 'go')
    expect((await Promise.all(sameResults)).map(result => result.status).sort()).toEqual(['acquired', 'conflict'])

    const differentBarrier = join(harness.configDir, 'different.go')
    const differentA = spawnWorker(harness, 'different-a', 'src/a.ts', differentBarrier)
    const differentB = spawnWorker(harness, 'different-b', 'src/b.ts', differentBarrier)
    await Promise.all([waitForReady(differentA), waitForReady(differentB)])
    const differentResults = [collectResult(differentA), collectResult(differentB)]
    writeFileSync(differentBarrier, 'go')
    expect((await Promise.all(differentResults)).map(result => result.status)).toEqual(['acquired', 'acquired'])
  }, 30_000)
})
