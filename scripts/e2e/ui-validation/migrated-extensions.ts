import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { requestMortiseUiHost } from '../../mortise-ui/client.ts'
import { startMortiseUiRun, stopMortiseUiRun } from '../../mortise-ui/controller.ts'

interface SnapshotNode { semanticId?: string; role: string; name: string; actions: string[] }
interface Snapshot { nodes?: SnapshotNode[]; regions?: Record<string, SnapshotNode[]> }

const surface = process.env.MORTISE_UI_SURFACE === 'electron' ? 'electron' as const : 'webui' as const
const workspaceId = 'migrated-extension-workspace'
const sessionId = 'migrated-extension-session'
const packageRoot = join(process.env.MORTISE_EXTENSION_PACKAGE_ROOT ?? 'E:/_workSpace/_Agents/pi-extensions')
if (!existsSync(join(packageRoot, 'package.json'))) throw new Error(`Independent extension package is missing: ${packageRoot}`)

const manifest = await startMortiseUiRun({
  surface,
  profileMode: 'fixture',
  windowMode: surface === 'electron' ? 'foreground' : 'background',
  extraEnv: surface === 'electron' ? { MORTISE_UI_DIRECT_SCENARIO_HOST: '0' } : undefined,
  fixtureSpec: {
    version: 1,
    active: { workspaceId, sessionId },
    workspaces: [{
      id: workspaceId,
      name: 'Migrated Extensions',
      sessions: [{ id: sessionId, name: 'Migrated extension session', messages: [
        { role: 'user', content: 'The migrated extensions are mounted.' },
        { role: 'assistant', content: 'The production conversation shell remains available.' },
      ] }],
    }],
  },
  extensionPaths: [packageRoot],
  waitMs: 600_000,
})

try {
  await waitForNode(manifest, `navigation.session_${workspaceId}_${sessionId}`)
  await action(manifest, `navigation.session_${workspaceId}_${sessionId}`, 'click')
  await waitForNode(manifest, `composer.${sessionId}.input`)
  const toolbar = await waitForNode(manifest, 'permissions.mode.trigger')
  if (!toolbar.actions.includes('click')) throw new Error('Permissions extension toolbar is not physically actionable.')
  const snapshot = await command<Snapshot>(manifest, 'ui.snapshot')
  const flat = nodes(snapshot)
  if (!flat.some(node => node.semanticId === `composer.${sessionId}.input`)) throw new Error('Core composer disappeared after extension mounting.')
  const evidence = await command<{ bundleDir: string }>(manifest, 'evidence.capture', { label: `migrated-extensions-${surface}` })
  const statePath = join(evidence.bundleDir, surface === 'webui' ? 'state.json' : 'manifest.json')
  const evidenceState = JSON.parse(readFileSync(statePath, 'utf8')) as { runId?: string; surface?: string; window?: { url?: string } }
  if (evidenceState.runId !== manifest.runId) throw new Error(`Evidence does not belong to this run: ${statePath}`)
  if (surface === 'webui' && evidenceState.surface !== surface) throw new Error('WebUI evidence surface mismatch.')
  if (surface === 'electron' && !evidenceState.window?.url?.includes('/renderer/index.html')) throw new Error('Electron evidence is not from the production renderer.')
  process.stdout.write(`${JSON.stringify({ ok: true, surface, runId: manifest.runId, evidence: evidence.bundleDir, checks: ['independent-package', 'permissions-toolbar', 'core-composer-fallback', 'production-shell-evidence'] })}\n`)
} catch (error) {
  try {
    const evidence = await command<{ bundleDir: string }>(manifest, 'evidence.capture', { label: `migrated-extensions-failure-${surface}` })
    const diagnostics = ['console.json', 'page-errors.json', 'snapshot.full.json']
      .map(name => join(evidence.bundleDir, name))
      .filter(path => existsSync(path))
      .map(path => ({ path, content: readFileSync(path, 'utf8').slice(0, 20_000) }))
    process.stderr.write(`${JSON.stringify({ failureEvidence: evidence.bundleDir, diagnostics })}\n`)
  } catch (captureError) {
    process.stderr.write(`Failed to capture migration failure evidence: ${captureError instanceof Error ? captureError.message : String(captureError)}\n`)
  }
  throw error
} finally {
  await stopMortiseUiRun(manifest.runDir)
}

async function command<T>(run: typeof manifest, name: string, params: Record<string, unknown> = {}): Promise<T> {
  const response = await requestMortiseUiHost<T>({ ...run, command: name, params, timeoutMs: 120_000 })
  if (!response.ok) throw new Error(`${name} failed: ${response.error.code}: ${response.error.message}`)
  return response.result
}

function nodes(snapshot: Snapshot): SnapshotNode[] { return snapshot.nodes ?? Object.values(snapshot.regions ?? {}).flat() }

async function waitForNode(run: typeof manifest, semanticId: string): Promise<SnapshotNode> {
  const deadline = Date.now() + 60_000
  let lastSnapshot: Snapshot | undefined
  while (Date.now() < deadline) {
    const snapshot = await command<Snapshot>(run, 'ui.snapshot')
    lastSnapshot = snapshot
    const node = nodes(snapshot).find(item => item.semanticId === semanticId)
    if (node) return node
    await Bun.sleep(100)
  }
  const available = nodes(lastSnapshot ?? {}).map(item => item.semanticId ?? `${item.role}:${item.name}`).slice(0, 80)
  throw new Error(`Semantic node did not appear: ${semanticId}; available=${JSON.stringify(available)}`)
}

async function action(run: typeof manifest, semanticId: string, actionName: string): Promise<void> {
  const node = await waitForNode(run, semanticId)
  if (!node.actions.includes(actionName)) throw new Error(`Node ${semanticId} does not support ${actionName}`)
  const snapshot = await command<Snapshot & { revision?: number }>(run, 'ui.snapshot')
  await command(run, 'ui.action', { revision: snapshot.revision, target: { semanticId }, action: actionName, mode: 'physical' })
}
