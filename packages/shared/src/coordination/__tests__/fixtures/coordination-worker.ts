import { existsSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { WorkspaceCoordinationStore } from '../../store.ts'

const [configDir, workspaceRoot, writerId, activityId, claimId, resourcePath, barrierPath] = process.argv.slice(2)
if (!configDir || !workspaceRoot || !writerId || !activityId || !claimId || !resourcePath || !barrierPath) {
  throw new Error('Missing coordination worker argument')
}

const store = WorkspaceCoordinationStore.open({ configDir, workspaceRoot, writerId })
try {
  store.beginActivity({
    operationId: `begin:${activityId}`,
    activityId,
    actor: { kind: 'agent', id: activityId, sessionId: activityId },
    leaseDurationMs: 30_000,
  })
  process.stdout.write('READY\n')
  while (!existsSync(barrierPath)) await delay(5)
  const result = store.acquireClaim({
    operationId: `claim:${claimId}`,
    claimId,
    activityId,
    resource: { kind: 'file', path: resourcePath },
    enforcement: 'blocking',
    leaseDurationMs: 30_000,
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
} finally {
  store.close()
}

