import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { requestMortiseUiHost } from '../../mortise-ui/client.ts'
import { startMortiseUiRun, stopMortiseUiRun } from '../../mortise-ui/controller.ts'

interface SnapshotNode { ref: string; semanticId?: string; role: string; name: string; actions: string[]; bounds?: { x: number; y: number; width: number; height: number } }
interface Snapshot { revision: number; regions?: Record<string, SnapshotNode[]>; nodes?: SnapshotNode[] }

const surface = process.env.MORTISE_UI_SURFACE === 'webui' ? 'webui' as const : 'electron' as const
const workspaceId = 'ui-extension-composition-workspace'
const sessionId = 'ui-extension-composition-session'
const extensionBase = join(process.cwd(), 'apps', 'electron', 'resources', 'pi-extensions')
const extensionRoots = ['mortise-ui-kit', 'mortise-ui-kit-compact', 'conversation-board', 'conversation-board-replace', 'conversation-board-tweak']
  .map(id => join(extensionBase, id))
for (const root of extensionRoots) if (!existsSync(join(root, 'package.json'))) throw new Error(`Composition extension is missing: ${root}`)

const manifest = await startMortiseUiRun({
  surface,
  profileMode: 'fixture',
  windowMode: surface === 'electron' ? 'foreground' : 'background',
  extraEnv: surface === 'electron' ? { MORTISE_UI_DIRECT_SCENARIO_HOST: '0' } : undefined,
  fixtureSpec: {
    version: 1,
    active: { workspaceId, sessionId },
    workspaces: [{ id: workspaceId, name: 'Extension Composition E2E', sessions: [{ id: sessionId, name: 'Composition session', messages: [{ role: 'user', content: 'Composition fixture.' }, { role: 'assistant', content: 'The component chain is mounted.' }] }] }],
  },
  extensionPaths: extensionRoots,
  waitMs: 600_000,
})

try {
  await waitForNode(`navigation.session_${workspaceId}_${sessionId}`)
  await action(`navigation.session_${workspaceId}_${sessionId}`, 'click')
  await waitForNode('composer.' + sessionId + '.input')
  await waitForNode('conversation-board.board')
  const pin = await waitForNode('conversation-board.pin')
  await action(pin.semanticId!, 'click')
  const tweak = await waitForNode('conversation-board-tweak.toolbar')
  if (!tweak.name.includes('Board++')) throw new Error(`Third-level override did not replace the toolbar: ${tweak.name}`)
  await action(tweak.semanticId!, 'click')
  const snapshotResult = await snapshot()
  const all = nodes(snapshotResult)
  if (all.some(node => node.semanticId === 'conversation-board-replace.toolbar')) throw new Error('Intermediate replacement remained mounted after third-level override.')
  const narrow = await command('ui.resize', { width: 640, height: 780 })
  if (!narrow || typeof narrow !== 'object') throw new Error('Composition resize was not acknowledged.')
  const bounds = nodes(await snapshot()).filter(node => node.bounds && (node.semanticId?.startsWith('conversation-board') || node.semanticId?.startsWith('composer.')))
  if (bounds.some(node => (node.bounds?.width ?? 0) <= 0 || (node.bounds?.height ?? 0) <= 0)) throw new Error('Composition exposed invalid narrow-layout bounds.')
  const evidence = await command<{ bundleDir: string }>('evidence.capture', { label: 'extension-composition-v2-real-session' })
  if (surface === 'electron') {
    const evidenceManifest = JSON.parse(readFileSync(join(evidence.bundleDir, 'manifest.json'), 'utf8')) as { runId?: string; window?: { url?: string } }
    if (evidenceManifest.runId !== manifest.runId || !evidenceManifest.window?.url?.includes('/renderer/index.html')) throw new Error(`Invalid Electron composition evidence: ${JSON.stringify(evidenceManifest)}`)
  } else {
    const state = JSON.parse(readFileSync(join(evidence.bundleDir, 'state.json'), 'utf8')) as { runId?: string; surface?: string }
    if (state.runId !== manifest.runId || state.surface !== surface) throw new Error(`Invalid WebUI composition evidence: ${JSON.stringify(state)}`)
  }
  process.stdout.write(JSON.stringify({ ok: true, runId: manifest.runId, surface, sessionId, evidence: evidence.bundleDir, checks: ['kit-module', 'decorated-button', 'board-session-ui', 'replace-chain', 'third-level-tweak', 'narrow-layout'] }) + '\n')
} catch (error) {
  try { const failure = await command<{ bundleDir: string }>('evidence.capture', { label: 'extension-composition-v2-failure' }); process.stderr.write(`Composition failure evidence: ${failure.bundleDir}\n`) } catch (evidenceError) { process.stderr.write(`Unable to capture composition failure evidence: ${String(evidenceError)}\n`) }
  throw error
} finally {
  await stopMortiseUiRun(manifest.runDir)
}

async function command<T = Record<string, unknown>>(name: string, params: Record<string, unknown> = {}): Promise<T> {
  const response = await requestMortiseUiHost<T>({ ...manifest, command: name, params, timeoutMs: 120_000 })
  if (!response.ok) throw new Error(`${name} failed: ${response.error.code}: ${response.error.message}`)
  return response.result
}
async function snapshot(): Promise<Snapshot> { return command<Snapshot>('ui.snapshot') }
function nodes(value: Snapshot): SnapshotNode[] { return value.nodes ?? Object.values(value.regions ?? {}).flat() }
async function waitForNode(semanticId: string): Promise<SnapshotNode> {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) { const current = nodes(await snapshot()).find(node => node.semanticId === semanticId); if (current) return current; await Bun.sleep(100) }
  throw new Error(`Composition semantic node did not appear: ${semanticId}`)
}
async function action(semanticId: string, actionName: string): Promise<void> {
  const current = await waitForNode(semanticId)
  if (!current.actions.includes(actionName)) throw new Error(`Composition node ${semanticId} does not support ${actionName}`)
  await command('ui.action', { revision: (await snapshot()).revision, target: { semanticId }, action: actionName, mode: 'physical' })
}
