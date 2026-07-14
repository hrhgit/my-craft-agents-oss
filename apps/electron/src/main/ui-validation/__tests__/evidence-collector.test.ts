import { afterEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ElectronEvidenceCollector } from '../evidence-collector'
import type { UiDriverSnapshot } from '../electron-surface-driver'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

describe('ElectronEvidenceCollector', () => {
  it('writes redacted, hashed full evidence and incremental snapshots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'craft-evidence-'))
    dirs.push(root)
    const runtimeLogPath = join(root, 'runtime.log')
    await writeFile(runtimeLogPath, 'Bearer runtime-secret https://host.test/api?token=raw\n')
    let revision = 1
    const snapshot = (): UiDriverSnapshot => ({
      revision,
      window: { webContentsId: 4, workspaceId: 'w1', role: 'main', title: 'Craft', url: 'https://host.test/?key=raw', bounds: { x: 0, y: 0, width: 800, height: 600 } },
      regions: { navigation: [], sidebar: [], dialog: [], notification: [], main: [{ ref: `r${revision}:node`, role: 'button', name: revision === 1 ? 'Send' : 'Sent', state: {}, actions: ['click'] }] },
      truncated: false,
    })
    const collector = new ElectronEvidenceCollector({
      artifactsDir: join(root, 'artifacts'), runId: 'run-1', runtimeLogPath,
      secrets: ['runtime-secret'], snapshot: async () => snapshot(),
      screenshot: async (_selector, path) => { await writeFile(path, Buffer.from('png')) },
      state: () => ({ revision: 3, latestSeq: 2, states: [{ scope: 'app', phase: 'ready', revision: 3, updatedAt: 1 }] }),
      events: ({ afterSeq = 0 } = {}) => ({ latestSeq: 2, events: [{ v: 1 as const, kind: 'event' as const, seq: 2, type: 'state.app.changed', timestamp: 1, revision: 3, payload: { token: 'raw' } }].filter(event => event.seq > afterSeq) }),
      driver: { name: 'test-driver' },
    })
    collector.start()
    collector.record('console', { message: 'Bearer console-secret', url: 'https://host.test/a?code=raw' })
    collector.record('network', { timestamp: 1, webContentsId: 4, status: 200, url: 'https://host.test/api?token=raw' })
    collector.record('network', { timestamp: 2, webContentsId: 4, status: 200, url: 'file:///app/playground.html?scenario=secret' })
    const first = await collector.capture({ label: 'first', selector: { webContentsId: 4 }, verificationLevel: 'renderer-verified', clocks: { application: 'real', os: 'real', network: 'real' } })
    expect(first.artifacts.some(item => item.path.endsWith('snapshot.incremental.json'))).toBe(true)
    revision = 2
    const second = await collector.capture({ label: 'second', selector: { webContentsId: 4 }, verificationLevel: 'renderer-verified', clocks: { application: 'real', os: 'real', network: 'real' } })
    expect(first.artifacts.every(item => /^[a-f0-9]{64}$/.test(item.sha256))).toBe(true)
    for (const item of first.artifacts) {
      const bytes = await readFile(item.path)
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(item.sha256)
    }
    expect(second.artifacts.some(item => item.path.endsWith('snapshot.incremental.json'))).toBe(true)
    const runtime = await readFile(first.artifacts.find(item => item.kind === 'runtime-log')!.path, 'utf8')
    const network = await readFile(first.artifacts.find(item => item.kind === 'network')!.path, 'utf8')
    expect(runtime).not.toContain('runtime-secret')
    expect(runtime).toContain('token=[REDACTED]')
    expect(network).not.toContain('token=raw')
    expect(network).not.toContain('scenario=secret')
    const manifest = JSON.parse(await readFile(first.artifacts.find(item => item.kind === 'state-manifest')!.path, 'utf8'))
    expect(manifest).toMatchObject({ runId: 'run-1', verificationLevel: 'renderer-verified', networkCapture: { requestBodiesCaptured: false } })
    collector.dispose()
  })

  it('still produces diagnostic evidence when renderer capture is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'craft-evidence-failed-'))
    dirs.push(root)
    const collector = new ElectronEvidenceCollector({
      artifactsDir: root, runId: 'run-failed', runtimeLogPath: join(root, 'missing.log'),
      snapshot: async () => { throw new Error('renderer gone') },
      screenshot: async () => { throw new Error('window gone') },
      state: () => ({ revision: 9, latestSeq: 4, states: [{ scope: 'app', phase: 'error', revision: 9, updatedAt: 1 }] }),
      events: () => ({ latestSeq: 4, events: [] }), driver: { name: 'test-driver' },
    })
    const result = await collector.capture({ label: 'failure', selector: { webContentsId: 4 }, verificationLevel: 'scenario-verified', clocks: { application: 'real', os: 'real', network: 'real' } })
    expect(result.revision).toBe(9)
    expect(result.seqRange).toEqual({ from: 4, to: 4 })
    const kinds = result.artifacts.map(item => item.kind)
    expect(['semantic-snapshot-error', 'screenshot-error', 'state', 'events', 'runtime-log', 'state-manifest'].every(kind => kinds.includes(kind))).toBe(true)
  })
})
