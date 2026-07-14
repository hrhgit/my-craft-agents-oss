import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { requestCraftUiHost } from '../../craft-ui/client.ts'
import { DEFAULT_CRAFT_UI_RUN_ROOT, startCraftUiRun, stopCraftUiRun } from '../../craft-ui/controller.ts'
import type { CraftUiRunManifest, CraftUiSurface } from '../../craft-ui/protocol.ts'

interface SnapshotNode { ref: string; role: string; name: string; semanticId?: string; testId?: string }
interface Snapshot { revision: number; regions: Record<string, SnapshotNode[]> }

const iterations = boundedInteger(process.env.CRAFT_UI_STABILITY_ITERATIONS, 20, 1, 1_000)
const surfaces = parseSurfaces(process.env.CRAFT_UI_STABILITY_SURFACES ?? 'electron,webui')
const summary = {
  startedAt: new Date().toISOString(),
  iterations,
  surfaces,
  cycles: [] as Array<Record<string, unknown>>,
  status: 'running',
}
const summaryPath = join(DEFAULT_CRAFT_UI_RUN_ROOT, `stability-${Date.now()}.json`)
mkdirSync(DEFAULT_CRAFT_UI_RUN_ROOT, { recursive: true })

for (const surface of surfaces) {
  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    let manifest: CraftUiRunManifest | undefined
    const cycle: Record<string, unknown> = { surface, iteration, startedAt: new Date().toISOString(), status: 'running' }
    summary.cycles.push(cycle)
    persist()
    try {
      manifest = await startCraftUiRun({
        surface,
        profileMode: 'isolated',
        waitMs: surface === 'electron' ? 180_000 : 90_000,
        ...(surface === 'electron' && iteration > 1 ? { extraEnv: { CRAFT_UI_SKIP_BUILD: '1' } } : {}),
      })
      cycle.runId = manifest.runId
      if (surface === 'electron') {
        const scenario = await command(manifest, 'scenario.apply', { name: 'remote-ui-composer' }, 30_000)
        if (!scenario.ok) throw new Error(`${scenario.error.code}: ${scenario.error.message}`)
      }
      const snapResponse = await command<Snapshot>(manifest, 'ui.snapshot', {}, 30_000)
      if (!snapResponse.ok) throw new Error(`${snapResponse.error.code}: ${snapResponse.error.message}`)
      const unchanged = await command<{ revision: number; full: boolean; changes: { added: unknown[]; updated: unknown[]; removed: unknown[] } }>(
        manifest, 'ui.snapshot', { sinceRevision: snapResponse.result.revision }, 30_000,
      )
      if (!unchanged.ok || unchanged.result.full || unchanged.result.revision !== snapResponse.result.revision
        || Object.values(unchanged.result.changes).some(items => items.length > 0)) {
        throw new Error(unchanged.ok ? 'Unchanged incremental snapshot was not empty.' : unchanged.error.message)
      }
      const nodes = snapshotNodes(snapResponse.result)
      const node = surface === 'electron'
        ? nodes.find(item => item.role === 'radio' && item.name === 'Rapid prototype')
        : nodes.find(item => item.semanticId === 'navigation.nav_settings')
          ?? nodes.find(item => item.testId === 'onboarding-provider-api_key')
      if (!node) throw new Error('Stability scenario target was not found.')
      const action = await command(manifest, 'ui.action', {
        revision: snapResponse.result.revision,
        target: { ref: node.ref },
        action: 'click',
        mode: 'physical',
      }, 30_000)
      if (!action.ok || action.verificationLevel !== 'renderer-verified') throw new Error(action.ok ? 'Physical action did not reach renderer-verified.' : action.error.message)
      if (action.ok && typeof (action.result as { afterRevision?: unknown }).afterRevision === 'number'
        && (action.result as { afterRevision: number }).afterRevision <= snapResponse.result.revision) {
        throw new Error('Physical action did not advance the UI revision.')
      }
      const reset = await command(manifest, 'scenario.reset', {}, 30_000)
      if (!reset.ok) throw new Error(reset.error.message)
      const reload = surface === 'electron'
        ? await command(manifest, 'scenario.apply', { name: 'remote-ui-composer', variant: 'Direct input' }, 30_000)
        : await command<Snapshot>(manifest, 'ui.snapshot', {}, 30_000)
      if (!reload.ok) throw new Error(reload.error.message)
      if (surface === 'webui' && !snapshotNodes(reload.result as Snapshot).some(item =>
        item.semanticId === 'navigation.nav_settings' || item.testId === 'onboarding-setup-later')) {
        throw new Error('WebUI reload did not restore a registered stable application control.')
      }
      if (surface === 'webui') {
        const realShellScenario = await command(manifest, 'scenario.apply', { name: 'session.empty' }, 30_000)
        if (!realShellScenario.ok) throw new Error(realShellScenario.error.message)
        const realShellSnapshot = await command<Snapshot>(manifest, 'ui.snapshot', {}, 30_000)
        if (!realShellSnapshot.ok || !snapshotNodes(realShellSnapshot.result).some(item => item.testId === 'scenario.real-app-shell')) {
          throw new Error(realShellSnapshot.ok ? 'Controlled scenario did not render the production AppShell.' : realShellSnapshot.error.message)
        }
      }
      const evidence = await command(manifest, 'evidence.capture', { label: `stability-${surface}-${iteration}` }, 30_000)
      if (!evidence.ok) throw new Error(evidence.error.message)
      if (surface === 'webui') {
        const artifacts = (evidence.result as { artifacts?: Array<{ path?: string }> }).artifacts ?? []
        for (const suffix of ['snapshot.full.json', 'snapshot.incremental.json', 'page-errors.json', 'network-summary.json', 'state.json']) {
          if (!artifacts.some(item => item.path?.endsWith(suffix))) throw new Error(`Web evidence omitted ${suffix}.`)
        }
        const expectedFailure = await command(manifest, 'ui.action', {
          target: { ref: `r${snapResponse.result.revision}:missing-target` }, action: 'click', mode: 'physical',
        }, 30_000)
        if (expectedFailure.ok) throw new Error('Invalid Web target unexpectedly succeeded.')
        const automaticEvidence = expectedFailure.error.details?.automaticEvidence as { bundleDir?: string; artifacts?: unknown[] } | undefined
        if (!automaticEvidence?.bundleDir || !existsSync(automaticEvidence.bundleDir) || !automaticEvidence.artifacts?.length) {
          throw new Error('Web command failure did not produce an automatic evidence bundle.')
        }
        cycle.automaticFailureEvidence = automaticEvidence
      }
      cycle.verificationLevel = action.verificationLevel
      cycle.evidence = evidence.result
      cycle.status = 'passed'
    } catch (error) {
      cycle.status = 'failed'
      cycle.error = error instanceof Error ? error.stack ?? error.message : String(error)
      if (manifest) {
        const evidence = await command(manifest, 'evidence.capture', { label: `stability-failure-${surface}-${iteration}` }, 30_000).catch(() => undefined)
        if (evidence?.ok) cycle.failureEvidence = evidence.result
      }
      summary.status = 'failed'
      throw error
    } finally {
      if (manifest) {
        const stopped = await stopCraftUiRun(manifest.runDir)
        cycle.stopped = stopped.status === 'stopped'
        cycle.profileRemoved = !existsSync(manifest.profileDir)
        if (stopped.status !== 'stopped' || existsSync(manifest.profileDir)) {
          cycle.status = 'failed'
          cycle.cleanupError = stopped.cleanupError ?? 'Temporary profile remains after stop.'
          summary.status = 'failed'
        }
      }
      cycle.endedAt = new Date().toISOString()
      persist()
    }
  }
}

summary.status = 'passed'
persist()
process.stdout.write(`${JSON.stringify({ ok: true, summaryPath, cycles: summary.cycles.length })}\n`)

async function command<T = unknown>(manifest: CraftUiRunManifest, name: string, params: Record<string, unknown>, timeoutMs: number) {
  return await requestCraftUiHost<T>({ ...manifest, command: name, params, timeoutMs })
}

function persist(): void {
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
}

function snapshotNodes(snapshot: Snapshot): SnapshotNode[] {
  if ('regions' in snapshot && snapshot.regions) return Object.values(snapshot.regions).flat()
  return Array.isArray((snapshot as unknown as { nodes?: SnapshotNode[] }).nodes)
    ? (snapshot as unknown as { nodes: SnapshotNode[] }).nodes
    : []
}

function parseSurfaces(value: string): CraftUiSurface[] {
  const parsed = [...new Set(value.split(',').map(item => item.trim()).filter(Boolean))]
  if (parsed.length === 0 || parsed.some(item => item !== 'electron' && item !== 'webui')) throw new Error('CRAFT_UI_STABILITY_SURFACES must contain electron and/or webui.')
  return parsed as CraftUiSurface[]
}

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = value === undefined ? fallback : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error(`Expected an integer between ${min} and ${max}.`)
  return parsed
}
