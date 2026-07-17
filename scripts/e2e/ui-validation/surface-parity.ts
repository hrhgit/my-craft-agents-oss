import { requestCraftUiHost } from '../../craft-ui/client.ts'
import { startCraftUiRun, stopCraftUiRun } from '../../craft-ui/controller.ts'
import type { CraftUiRunManifest, CraftUiSurface } from '../../craft-ui/protocol.ts'

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

const results = new Map<CraftUiSurface, Record<string, unknown>>()
for (const surface of ['webui', 'electron'] as const) {
  let manifest: CraftUiRunManifest | undefined
  try {
    manifest = await startCraftUiRun({
      surface,
      profileMode: 'fixture',
      waitMs: surface === 'electron' ? 180_000 : 90_000,
      ...(process.env.CRAFT_UI_SKIP_BUILD === '1' ? { extraEnv: { CRAFT_UI_SKIP_BUILD: '1' } } : {}),
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
    if (manifest) await stopCraftUiRun(manifest.runDir)
  }
}

const web = results.get('webui')!
const electron = results.get('electron')!
if (JSON.stringify(web.contract) !== JSON.stringify(electron.contract)) {
  throw new Error(`WebUI/Electron semantic contracts diverged: ${JSON.stringify({ web: web.contract, electron: electron.contract })}`)
}
process.stdout.write(`${JSON.stringify({ ok: true, scenario: 'session.empty', surfaces: Object.fromEntries(results) })}\n`)

async function ok<T = Record<string, unknown>>(
  run: CraftUiRunManifest,
  command: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const response = await requestCraftUiHost<T>({ ...run, command, params, timeoutMs: 60_000 })
  if (!response.ok) throw new Error(`${command}: ${response.error.code}: ${response.error.message}`)
  return response.result
}
