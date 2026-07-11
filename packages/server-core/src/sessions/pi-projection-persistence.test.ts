import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { PiProjectionEventV1 } from '@craft-agent/shared/protocol'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getSessionPath } from '@craft-agent/shared/sessions'
import { SessionManager, createManagedSession } from './SessionManager.ts'

function projectionEvent(seq: number): PiProjectionEventV1 {
  return {
    schemaVersion: 1,
    eventId: `event-${seq}`,
    seq,
    sessionId: 'session-1',
    runtimeId: 'runtime-1',
    turnId: 'turn-1',
    entityId: `block-${seq}`,
    entityType: 'content_block',
    entityVersion: 1,
    kind: 'assistant_text',
    payload: { text: `text-${seq}` },
  }
}

describe('Pi projection persistence', () => {
  let workspaceRoot: string

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'pi-projection-persistence-'))
  })

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('reloads pi-projection-v1.json after the Host restarts', async () => {
    const workspace = {
      id: 'workspace-1',
      name: 'Projection Workspace',
      rootPath: workspaceRoot,
      createdAt: Date.now(),
    } as never
    const session = createManagedSession({ craftId: 'session-1' }, workspace)
    const firstHost = new SessionManager()
    const firstHostInternals = firstHost as unknown as {
      sessions: Map<string, typeof session>
      piProjectionWrites: Map<string, Promise<void>>
    }
    firstHostInternals.sessions.set(session.id, session)

    expect(firstHost.applyPiProjectionEvent(projectionEvent(1)).status).toBe('applied')
    expect(firstHost.applyPiProjectionEvent(projectionEvent(2)).status).toBe('applied')
    await firstHostInternals.piProjectionWrites.get(session.id)

    const sidecarPath = join(getSessionPath(workspaceRoot, session.id), 'pi-projection-v1.json')
    const persisted = JSON.parse(readFileSync(sidecarPath, 'utf8'))
    expect(persisted.lastSeq).toBe(2)
    expect(persisted.entities.map((entity: { entityId: string }) => entity.entityId))
      .toEqual(['block-1', 'block-2'])

    const restartedHost = new SessionManager()
    const restartedSession = createManagedSession({ craftId: 'session-1' }, workspace)
    ;(restartedHost as unknown as { sessions: Map<string, typeof restartedSession> })
      .sessions.set(restartedSession.id, restartedSession)

    const restored = await restartedHost.getPiProjectionSnapshot(restartedSession.id)
    expect(restored).toEqual(persisted)
    expect(restartedHost.applyPiProjectionEvent(projectionEvent(3)).status).toBe('applied')
    expect((await restartedHost.getPiProjectionSnapshot(restartedSession.id))?.lastSeq).toBe(3)
  })

  it('coalesces streaming updates and persists the latest contiguous snapshot', async () => {
    const workspace = { id: 'workspace-1', name: 'Projection Workspace', rootPath: workspaceRoot, createdAt: Date.now() } as never
    const session = createManagedSession({ craftId: 'session-1' }, workspace)
    const host = new SessionManager()
    const internals = host as unknown as {
      sessions: Map<string, typeof session>
      piProjectionWrites: Map<string, Promise<void>>
    }
    internals.sessions.set(session.id, session)
    for (let seq = 1; seq <= 25; seq++) host.applyPiProjectionEvent(projectionEvent(seq))
    await internals.piProjectionWrites.get(session.id)
    const sidecarPath = join(getSessionPath(workspaceRoot, session.id), 'pi-projection-v1.json')
    const persisted = JSON.parse(readFileSync(sidecarPath, 'utf8'))
    expect(persisted.lastSeq).toBe(25)
    expect(persisted.entities).toHaveLength(25)
  })
})
