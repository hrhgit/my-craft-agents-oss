import { requestCraftUiHost } from '../../craft-ui/client.ts'
import { startCraftUiRun, stopCraftUiRun } from '../../craft-ui/controller.ts'
import type { CraftUiRunManifest } from '../../craft-ui/protocol.ts'

interface SnapshotNode {
  ref: string
  role: string
  name: string
  semanticId?: string
  actions: string[]
}

interface Snapshot {
  revision: number
  regions: Record<string, SnapshotNode[]>
}

interface ScenarioStatus {
  activeScenario?: string
  clock?: { mode?: string; pending?: Record<string, number> }
  faults?: Array<{ point: string; remaining: number }>
  serviceEvents?: Array<{ operation: string; outcome: string }>
}

let manifest: CraftUiRunManifest | undefined
try {
  manifest = await startCraftUiRun({
    surface: 'electron',
    profileMode: 'fixture',
    waitMs: 180_000,
    ...(process.env.CRAFT_UI_SKIP_BUILD === '1' ? { extraEnv: { CRAFT_UI_SKIP_BUILD: '1' } } : {}),
  })

  const capabilities = await ok<{
    protocolVersion: number
    items: Array<{ kind: string; id: string; inputSchema: unknown }>
    runtimeDiscovery?: { extensionDefinitions?: unknown }
  }>(manifest, 'ui.capabilities', { operation: 'list' })
  if (capabilities.protocolVersion !== 1
    || !capabilities.items.some(item => item.kind === 'scenario' && item.id === 'transport.reconnect' && item.inputSchema)
    || !capabilities.items.some(item => item.kind === 'action' && item.id === 'ime' && item.inputSchema)
    || !capabilities.items.some(item => item.kind === 'action' && item.id === 'native.close' && item.inputSchema)
    || !capabilities.runtimeDiscovery?.extensionDefinitions) {
    throw new Error('The real Test Host did not expose the bounded route/scenario/action/extension discovery contract.')
  }

  const applied = await ok<{ seed: number; state: ScenarioStatus }>(manifest, 'scenario.apply', {
    name: 'transport.reconnect',
    seed: 4242,
    clock: { mode: 'frozen', now: '2026-01-01T00:00:00Z' },
  })
  if (applied.seed !== 4242 || applied.state.clock?.mode !== 'frozen') {
    throw new Error('Frozen scenario did not preserve its deterministic seed and clock mode.')
  }

  await ok(manifest, 'fault.set', {
    point: 'transport.connect',
    scope: { surface: 'app-shell' },
    effect: { kind: 'delay', ms: 50 },
    times: 1,
  })

  const snapshot = await ok<Snapshot>(manifest, 'ui.snapshot')
  const retry = Object.values(snapshot.regions).flat()
    .find(node => node.semanticId === 'transport.retry' && node.role === 'button' && node.actions.includes('click'))
  if (!retry) throw new Error('Transport scenario did not expose its real Retry control.')
  await ok(manifest, 'ui.action', {
    revision: snapshot.revision,
    target: { ref: retry.ref },
    action: 'click',
    mode: 'physical',
  })

  const delayed = await ok<{ status: ScenarioStatus }>(manifest, 'fault.status')
  if (delayed.status.clock?.pending?.timer !== 1 || delayed.status.faults?.length !== 0) {
    throw new Error(`Fault was not consumed exactly once into the frozen timer domain: ${JSON.stringify(delayed.status)}`)
  }
  await ok(manifest, 'clock.advance', { ms: 50 })
  const retryPending = await ok<{ status: ScenarioStatus }>(manifest, 'fault.status')
  if (retryPending.status.clock?.pending?.retry !== 1) {
    throw new Error(`Retry work was not scheduled after the injected delay: ${JSON.stringify(retryPending.status.clock)}`)
  }
  await ok(manifest, 'clock.advance', { ms: 100 })
  const completed = await ok<{ status: ScenarioStatus }>(manifest, 'fault.status')
  if (!completed.status.serviceEvents?.some(event => event.operation === 'transport.connect' && event.outcome === 'completed')) {
    throw new Error('Advancing the public clock did not complete the real transport retry flow.')
  }

  const firstReset = await ok(manifest, 'scenario.reset')
  const afterFirstReset = await ok<Snapshot>(manifest, 'ui.snapshot')
  const secondReset = await ok(manifest, 'scenario.reset')
  const afterSecondReset = await ok<Snapshot>(manifest, 'ui.snapshot')
  if (!sameStableSemantics(afterFirstReset, afterSecondReset)) {
    throw new Error('scenario.reset is not idempotent at the public semantic snapshot boundary.')
  }

  const evidence = await ok<{ bundleDir: string }>(manifest, 'evidence.capture', { label: 'runtime-contract' })
  process.stdout.write(`${JSON.stringify({
    ok: true,
    runId: manifest.runId,
    resetRevisions: [afterFirstReset.revision, afterSecondReset.revision],
    evidence: evidence.bundleDir,
    firstReset,
    secondReset,
  })}\n`)
} catch (error) {
  if (manifest) {
    await ok(manifest, 'evidence.capture', { label: 'runtime-contract-failure' }).catch(() => undefined)
  }
  throw error
} finally {
  if (manifest) await stopCraftUiRun(manifest.runDir)
}

async function ok<T = Record<string, unknown>>(
  run: CraftUiRunManifest,
  command: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const response = await requestCraftUiHost<T>({ ...run, command, params, timeoutMs: 60_000 })
  if (!response.ok) throw new Error(`${command}: ${response.error.code}: ${response.error.message}`)
  return response.result
}

function sameStableSemantics(left: Snapshot, right: Snapshot): boolean {
  return JSON.stringify(stableSemantics(left)) === JSON.stringify(stableSemantics(right))
}

function stableSemantics(snapshot: Snapshot): string[] {
  return Object.values(snapshot.regions).flat()
    .map(node => `${node.role}:${node.name}:${[...node.actions].sort().join(',')}`)
    .sort()
}
