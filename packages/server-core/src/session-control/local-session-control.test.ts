import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalSessionControlClient } from './local-session-control'

describe('local Session turn control', () => {
  const roots: string[] = []
  const clients: LocalSessionControlClient[] = []

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close()
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  function createClient(backendId: string, recoveryGraceMs = 40): LocalSessionControlClient {
    const root = roots[0] ?? (() => {
      const value = mkdtempSync(join(tmpdir(), 'session-control-'))
      roots.push(value)
      return value
    })()
    const client = new LocalSessionControlClient({ backendId, configDir: root, recoveryGraceMs })
    clients.push(client)
    return client
  }

  it('atomically grants one backend and rejects a competing backend', async () => {
    const first = createClient('electron')
    const second = createClient('webui')
    const handle = await first.acquire('session-one')

    await expect(second.acquire('session-one')).rejects.toMatchObject({
      code: 'SESSION_CONTROL_NOT_ACQUIRED',
      reason: 'conflict',
      accepted: false,
    })

    await handle.release()
    const replacement = await second.acquire('session-one')
    expect(replacement.backendId).toBe('webui')
    await replacement.release()
  })

  it('invalidates a turn-scoped handle when it is released', async () => {
    const client = createClient('electron')
    const handle = await client.acquire('session-handle')
    await handle.setState('running')
    await handle.release()

    expect(handle.valid).toBe(false)
    expect(() => handle.assertValid()).toThrow('no longer valid')
  })

  it('keeps existing OS ownership across coordinator restart and rejects requests during recovery', async () => {
    const owner = createClient('electron', 2_500)
    const peer = createClient('webui', 2_500)
    const handle = await owner.acquire('session-owned')
    await peer.snapshot()

    await owner.simulateCoordinatorCrashForTest()
    const recovering = await peer.snapshot()
    expect(recovering.recovering).toBe(true)
    await expect(peer.acquire('another-session')).rejects.toMatchObject({
      reason: 'coordinator-recovering',
      accepted: false,
    })
    await expect(peer.acquire('session-owned')).rejects.toMatchObject({ reason: 'conflict' })

    await new Promise(resolve => setTimeout(resolve, 2_600))
    const next = await peer.acquire('another-session')
    expect(next.valid).toBe(true)
    await next.release()
    await handle.release()
  })
})
