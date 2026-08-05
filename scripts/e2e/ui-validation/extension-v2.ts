import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { requestMortiseUiHost } from '../../mortise-ui/client.ts'
import { startMortiseUiRun, stopMortiseUiRun } from '../../mortise-ui/controller.ts'

interface SnapshotNode {
  ref: string
  semanticId?: string
  role: string
  name: string
  actions: string[]
  bounds?: { x: number; y: number; width: number; height: number }
}

interface Snapshot { revision: number; regions?: Record<string, SnapshotNode[]>; nodes?: SnapshotNode[] }

const surface = process.env.MORTISE_UI_SURFACE === 'webui' ? 'webui' as const : 'electron' as const
const workspaceId = 'ui-extension-v2-workspace'
const sessionId = 'ui-extension-v2-session'
const extensionRoot = join(process.cwd(), 'apps', 'electron', 'resources', 'pi-extensions', 'extension-ui-v2-lab')
if (!existsSync(join(extensionRoot, 'package.json'))) throw new Error(`V2 lab extension is missing: ${extensionRoot}`)

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
      name: 'V2 Extension E2E',
      sessions: [{
        id: sessionId,
        name: 'V2 conversation session',
        messages: [
          { role: 'user', content: 'Review this conversation from the extension.' },
          { role: 'assistant', content: 'The host session is available for direct DOM integration.' },
        ],
      }],
    }],
  },
  extensionPaths: [extensionRoot],
  waitMs: 600_000,
})

try {
  await waitForNode(`navigation.session_${workspaceId}_${sessionId}`)
  await action(`navigation.session_${workspaceId}_${sessionId}`, 'click')
  await waitForNode(`composer.${sessionId}.input`)
  await waitForNode('extension-v2-lab.conversation-review')
  await waitForNode('extension-v2-lab.conversation-search')
  await waitForNode('extension-v2-lab.conversation-highlight')
  await waitForNode('extension-v2-lab.conversation-map-open')

  await action('extension-v2-lab.conversation-search', 'fill', 'host session')
  await action('extension-v2-lab.conversation-highlight', 'click')
  await action('extension-v2-lab.conversation-map-open', 'click')
  await waitForNode('extension-v2-lab.conversation-map-close')
  await action('extension-v2-lab.conversation-map-close', 'click')

  const toolbar = await waitForNode('extension-ui-v2-lab.toolbar')
  const before = toolbar.name
  await action('extension-ui-v2-lab.toolbar', 'click')
  const after = await waitForDifferentNodeName('extension-ui-v2-lab.toolbar', before)
  if (before === after.name) throw new Error(`Session channel did not update toolbar state: ${before}`)

  const status = await waitForNode('extension-ui-v2-lab.workspace-status')
  await action('extension-ui-v2-lab.workspace-status', 'click')
  const changedStatus = await waitForDifferentNodeName('extension-ui-v2-lab.workspace-status', status.name)
  if (!changedStatus.name.startsWith('Updated ')) throw new Error(`Workspace channel returned unexpected state: ${changedStatus.name}`)

  const replaceFailure = await snapshot()
  if (!nodes(replaceFailure).some(node => node.semanticId === `composer.${sessionId}.input` && node.actions.includes('fill'))) {
    throw new Error('Failed replace frontend removed the core composer input instead of falling back.')
  }

  const narrow = await command('ui.resize', { width: 640, height: 780 })
  if (!narrow || typeof narrow !== 'object') throw new Error('Electron renderer did not acknowledge the narrow validation resize.')
  const narrowSnapshot = await snapshot()
  const bounds = nodes(narrowSnapshot).filter(node => node.bounds && node.semanticId?.startsWith('composer.'))
  if (bounds.some(node => (node.bounds?.width ?? 0) <= 0 || (node.bounds?.height ?? 0) <= 0)) {
    throw new Error('Narrow conversation/composer layout exposed invalid bounds.')
  }

  const evidence = await command<{ bundleDir: string }>('evidence.capture', { label: 'extension-ui-v2-real-session' })
  if (surface === 'electron') {
    const evidenceManifest = JSON.parse(readFileSync(join(evidence.bundleDir, 'manifest.json'), 'utf8')) as { runId?: string; window?: { url?: string } }
    if (evidenceManifest.runId !== manifest.runId || !evidenceManifest.window?.url?.includes('/renderer/index.html')) {
      throw new Error(`V2 evidence identity is invalid: ${JSON.stringify(evidenceManifest)}`)
    }
  } else {
    const evidenceState = JSON.parse(readFileSync(join(evidence.bundleDir, 'state.json'), 'utf8')) as { runId?: string; surface?: string }
    if (evidenceState.surface !== surface || evidenceState.runId !== manifest.runId) {
      throw new Error(`V2 WebUI evidence identity is invalid: ${JSON.stringify(evidenceState)}`)
    }
  }
  process.stdout.write(`${JSON.stringify({ ok: true, runId: manifest.runId, surface, sessionId, evidence: evidence.bundleDir, surfaces: ['conversation.timeline.before', 'composer.toolbar', 'composer.status', 'composer.replace'], checks: ['host-dom-filter', 'portal', 'session-channel', 'workspace-channel', 'replace-fallback', 'narrow-layout'] })}\n`)
} catch (error) {
  try {
    const failure = await command<{ bundleDir: string }>('evidence.capture', { label: 'extension-ui-v2-failure' })
    process.stderr.write(`V2 extension UI validation failure evidence: ${failure.bundleDir}\n`)
  } catch (evidenceError) {
    process.stderr.write(`Unable to capture V2 failure evidence: ${String(evidenceError)}\n`)
  }
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
  let current: SnapshotNode | undefined
  while (Date.now() < deadline) {
    current = nodes(await snapshot()).find(node => node.semanticId === semanticId)
    if (current) return current
    await Bun.sleep(100)
  }
  throw new Error(`V2 semantic node did not appear: ${semanticId}`)
}

async function waitForDifferentNodeName(semanticId: string, previous: string): Promise<SnapshotNode> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const current = nodes(await snapshot()).find(node => node.semanticId === semanticId)
    if (current && current.name !== previous) return current
    await Bun.sleep(100)
  }
  throw new Error(`V2 semantic node did not update: ${semanticId}`)
}

async function action(semanticId: string, actionName: string, value?: string): Promise<void> {
  const current = await waitForNode(semanticId)
  if (!current.actions.includes(actionName)) throw new Error(`V2 node ${semanticId} does not support ${actionName}`)
  await command('ui.action', {
    revision: (await snapshot()).revision,
    target: { semanticId },
    action: actionName,
    mode: 'physical',
    ...(value === undefined ? {} : { value }),
  })
}
