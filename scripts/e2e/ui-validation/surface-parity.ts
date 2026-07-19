import { requestMortiseUiHost } from '../../mortise-ui/client.ts'
import { startMortiseUiRun, stopMortiseUiRun } from '../../mortise-ui/controller.ts'
import type { MortiseUiRunManifest, MortiseUiSurface } from '../../mortise-ui/protocol.ts'

interface SnapshotNode {
  role: string
  name: string
  semanticId?: string
  testId?: string
  actions: string[]
  states?: Record<string, unknown>
}

interface Snapshot {
  regions?: Record<string, SnapshotNode[]>
  nodes?: SnapshotNode[]
}

const REQUIRED_SEMANTICS = [
  'app.new-session',
  'navigation.main',
  'navigation.nav_allSessions',
  'navigation.nav_skills',
  'navigation.nav_automations',
  'navigation.nav_settings',
] as const

const results = new Map<MortiseUiSurface, Record<string, unknown>>()
for (const surface of ['webui', 'electron'] as const) {
  let manifest: MortiseUiRunManifest | undefined
  try {
    manifest = await startMortiseUiRun({
      surface,
      profileMode: 'fixture',
      waitMs: surface === 'electron' ? 180_000 : 90_000,
      ...(process.env.MORTISE_UI_SKIP_BUILD === '1' ? { extraEnv: { MORTISE_UI_SKIP_BUILD: '1' } } : {}),
    })
    await ok(manifest, 'scenario.apply', { name: 'session.empty', seed: 1701 })
    const snapshot = await ok<Snapshot>(manifest, 'ui.snapshot')
    const nodes = snapshot.regions ? Object.values(snapshot.regions).flat() : snapshot.nodes ?? []
    const contract = Object.fromEntries(REQUIRED_SEMANTICS.map(id => {
      const matches = nodes.filter(node => node.semanticId === id)
      if (matches.length !== 1) throw new Error(`${surface} exposed ${matches.length} nodes for ${id}.`)
      const node = matches[0]!
      return [id, { role: node.role, actions: [...node.actions].sort(), disabled: node.states?.disabled === true }]
    }))
    const evidence = await ok<{ bundleDir: string }>(manifest, 'evidence.capture', { label: `surface-parity-${surface}` })
    results.set(surface, { contract, evidence: evidence.bundleDir, runId: manifest.runId })
  } catch (error) {
    if (manifest) await ok(manifest, 'evidence.capture', { label: `surface-parity-${surface}-failure` }).catch(() => undefined)
    throw error
  } finally {
    if (manifest) await stopMortiseUiRun(manifest.runDir)
  }
}

const web = results.get('webui')!
const electron = results.get('electron')!
if (JSON.stringify(web.contract) !== JSON.stringify(electron.contract)) {
  throw new Error(`WebUI/Electron semantic contracts diverged: ${JSON.stringify({ web: web.contract, electron: electron.contract })}`)
}
process.stdout.write(`${JSON.stringify({ ok: true, scenario: 'session.empty', surfaces: Object.fromEntries(results) })}\n`)

async function ok<T = Record<string, unknown>>(
  run: MortiseUiRunManifest,
  command: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const response = await requestMortiseUiHost<T>({ ...run, command, params, timeoutMs: 60_000 })
  if (!response.ok) throw new Error(`${command}: ${response.error.code}: ${response.error.message}`)
  return response.result
}
