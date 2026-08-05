import { existsSync, readFileSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { requestMortiseUiHost } from '../../mortise-ui/client.ts'
import { startMortiseUiRun, stopMortiseUiRun } from '../../mortise-ui/controller.ts'

interface SnapshotNode {
  ref: string
  semanticId?: string
  role: string
  name: string
}

interface Snapshot {
  revision: number
  regions: Record<string, SnapshotNode[]>
}

interface ExtensionDefinitionSnapshot {
  kind: 'extension'
  definitions: Array<{
    extensionId: string
    sessionId: string
    runtimeId: string
    definition: {
      id: string
      contributionId: string
      snapshot?: { state?: Record<string, unknown> }
    }
  }>
}

interface NativeSnapshot {
  revision: number
  windows: Array<{ nodes: Array<{ ref: string; role: string; actions: string[] }> }>
}

const fixtureRoot = await mkdtemp(join(tmpdir(), 'mortise-ui-extension-source-'))
const extensionPackageRoot = join(fixtureRoot, 'extension-package')
const workspaceId = 'ui-extension-workspace'
const sessionId = 'ui-extension-published-session'
const extensionSourcePath = resolve(process.env.MORTISE_UI_EXTENSION_EXAMPLE
  ?? join(process.cwd(), 'pi', 'packages', 'coding-agent', 'examples', 'extensions', 'mortise-gui.ts'))

if (!existsSync(extensionSourcePath)) throw new Error(`Pi Mortise GUI example is missing: ${extensionSourcePath}`)

await mkdir(extensionPackageRoot, { recursive: true })
await copyFile(extensionSourcePath, join(extensionPackageRoot, 'index.ts'))
await writeFile(join(extensionPackageRoot, 'package.json'), `${JSON.stringify({
  name: 'mortise-gui-example-e2e',
  private: true,
  type: 'module',
  pi: {
    extensions: [{
      id: 'mortise-gui-example',
      path: './index.ts',
      activation: 'startup',
      manifest: {
        schemaVersion: 1,
        name: 'Mortise GUI Example',
        version: '1.0.0',
        author: { name: 'Mortise Contributors' },
        capabilities: ['ui.contributions'],
        permissions: [],
      },
    }],
  },
}, null, 2)}\n`, 'utf8')
const manifest = await startMortiseUiRun({
  surface: 'electron',
  profileMode: 'fixture',
  windowMode: 'foreground',
  fixtureSpec: {
    version: 1,
    active: { workspaceId, sessionId },
    workspaces: [{
      id: workspaceId,
      name: 'UI Extension E2E',
      sessions: [{
        id: sessionId,
        name: 'Published extension validation session',
        messages: [
          { role: 'user', content: 'Load the extension validation surface.' },
          { role: 'assistant', content: 'The extension validation surface is ready.' },
        ],
      }],
    }],
  },
  extensionPaths: [extensionPackageRoot],
  extraEnv: { MORTISE_UI_DIRECT_SCENARIO_HOST: '0' },
  waitMs: 600_000,
})

if (manifest.mountedExtensions?.[0]?.entries[0]?.id !== 'mortise-gui-example') {
  throw new Error(`Extension package was not mounted into the run: ${JSON.stringify(manifest.mountedExtensions)}`)
}

try {
  const initial = await command<Snapshot>('ui.snapshot')
  const publishedSessionSemanticId = `navigation.session_${workspaceId}_${sessionId}`
  const publishedSession = nodes(initial).find(node => node.semanticId === publishedSessionSemanticId)
  if (!publishedSession) throw new Error(`Published fixture session ${sessionId} was not available in workspace navigation.`)
  await command('ui.action', {
    target: { semanticId: publishedSessionSemanticId },
    action: 'click',
    mode: 'physical',
    waitUntil: { kind: 'state', scope: 'session', entityId: sessionId, phase: 'ready', timeoutMs: 60_000 },
    timeoutMs: 60_000,
  }, 'renderer-verified')

  const sessionSnapshot = await command<Snapshot>('ui.snapshot')
  const input = nodes(sessionSnapshot).find(node => node.semanticId === `composer.${sessionId}.input`)
  if (!input) throw new Error(`Published fixture session ${sessionId} did not expose its semantic composer input.`)

  await command('ui.wait', {
    predicate: { kind: 'state', scope: 'extension', phase: 'ready' },
    timeoutMs: 60_000,
    stableForMs: 100,
  })

  const extensionList = await command<ExtensionDefinitionSnapshot>('ui.snapshot', {
    target: { kind: 'extension', sessionId, extensionId: 'mortise-gui-example' },
  })
  const registered = extensionList.definitions.find(item => item.definition.id === 'mortise-gui-example.contract')
  if (!registered) throw new Error('Real Pi extension did not publish its validation definition.')
  const extensionTarget = {
    kind: 'extension',
    sessionId,
    extensionId: registered.extensionId,
    runtimeId: registered.runtimeId,
    definitionId: registered.definition.id,
  }

  const scenarioSeed = 1701
  await command('scenario.apply', { target: extensionTarget, name: 'count', seed: scenarioSeed, input: { count: 7 } }, 'scenario-verified')
  const scenarioSnapshot = await command<ExtensionDefinitionSnapshot>('ui.snapshot', { target: extensionTarget })
  assertCount(scenarioSnapshot, 7)

  await command('ui.action', { target: extensionTarget, action: 'update', input: {} }, 'scenario-verified')
  const updated = await command<ExtensionDefinitionSnapshot>('ui.snapshot', { target: extensionTarget })
  assertCount(updated, 8)

  const hostSnapshot = await command<Snapshot>('ui.snapshot')
  const physicalUpdate = nodes(hostSnapshot).find(node => node.role === 'button' && node.name === 'Update')
  if (!physicalUpdate?.semanticId) throw new Error('Host-rendered extension contribution did not expose its stable Update semantic.')
  await command('ui.action', {
    target: { semanticId: physicalUpdate.semanticId },
    action: 'click',
    mode: 'physical',
    timeoutMs: 30_000,
  }, 'renderer-verified')
  const physicalResult = await command<ExtensionDefinitionSnapshot>('ui.snapshot', { target: extensionTarget })
  assertCount(physicalResult, 9)

  await command('ui.wait', {
    predicate: { kind: 'state', scope: 'extension', phase: 'ready', detail: { definitionId: 'mortise-gui-example.sandbox-contract' } },
    timeoutMs: 60_000,
    stableForMs: 100,
  })
  const sandboxExtensionId = 'mortise-gui-example:sandbox:validation-counter'
  const sandboxList = await command<ExtensionDefinitionSnapshot>('ui.snapshot', {
    target: { kind: 'extension', sessionId, extensionId: sandboxExtensionId },
  })
  const sandboxRegistered = sandboxList.definitions.find(item => item.definition.id === 'mortise-gui-example.sandbox-contract')
  if (!sandboxRegistered) throw new Error('Sandbox app did not publish its validation definition through the private bridge.')
  const sandboxTarget = {
    kind: 'extension',
    sessionId,
    extensionId: sandboxRegistered.extensionId,
    runtimeId: sandboxRegistered.runtimeId,
    definitionId: sandboxRegistered.definition.id,
  }
  const sandboxSeed = 2701
  await command('scenario.apply', { target: sandboxTarget, name: 'count', seed: sandboxSeed, input: { count: 11 } }, 'scenario-verified')
  assertCount(await command<ExtensionDefinitionSnapshot>('ui.snapshot', { target: sandboxTarget }), 11)
  await command('ui.action', { target: sandboxTarget, action: 'increment', input: {} }, 'scenario-verified')
  assertCount(await command<ExtensionDefinitionSnapshot>('ui.snapshot', { target: sandboxTarget }), 12)

  const sandboxHostSnapshot = await command<Snapshot>('ui.snapshot')
  const sandboxButton = nodes(sandboxHostSnapshot).find(node => node.role === 'button' && node.name === 'Increment sandbox count')
  if (!sandboxButton) throw new Error('Sandbox iframe did not expose its physical button through the unified snapshot.')
  await command('ui.action', {
    target: { role: 'button', name: 'Increment sandbox count', exact: true },
    action: 'click',
    mode: 'physical',
    waitUntil: { kind: 'text', value: 'Sandbox count: 13', exact: true, timeoutMs: 30_000 },
    timeoutMs: 30_000,
  }, 'renderer-verified')
  assertCount(await command<ExtensionDefinitionSnapshot>('ui.snapshot', { target: sandboxTarget }), 13)

  let nativeVerificationLevel: string | undefined
  if (process.platform === 'win32') {
    const native = await command<NativeSnapshot>('ui.native', { operation: 'snapshot' })
    const nativeWindow = native.windows.flatMap(window => window.nodes)
      .find(node => node.role === 'Window' && node.actions.includes('focus'))
    if (!nativeWindow) throw new Error('Native driver did not expose a focusable Mortise window.')
    const focused = await command('ui.action', {
      mode: 'native', revision: native.revision,
      target: { kind: 'native', ref: nativeWindow.ref }, action: 'focus',
    }, 'native-verified')
    nativeVerificationLevel = focused.verificationLevel
  }

  const evidence = await command<{ bundleDir: string }>('evidence.capture', { label: 'pi-sandbox-extension-three-level' })
  const evidenceManifest = JSON.parse(readFileSync(join(evidence.bundleDir, 'manifest.json'), 'utf8')) as {
    scenario?: { id?: unknown; source?: unknown; seed?: unknown; target?: { extensionId?: unknown; definitionId?: unknown } }
    seed?: unknown
  }
  if (evidenceManifest.seed !== sandboxSeed
    || evidenceManifest.scenario?.id !== 'count'
    || evidenceManifest.scenario?.source !== 'extension'
    || evidenceManifest.scenario?.target?.extensionId !== sandboxTarget.extensionId
    || evidenceManifest.scenario?.target?.definitionId !== sandboxTarget.definitionId) {
    throw new Error(`Extension evidence omitted active scenario identity: ${JSON.stringify(evidenceManifest.scenario)}`)
  }
  await command('scenario.reset', { target: sandboxTarget, name: 'count', input: {} }, 'scenario-verified')
  await command('scenario.reset', { target: extensionTarget, name: 'count', input: {} }, 'scenario-verified')
  process.stdout.write(`${JSON.stringify({
    ok: true,
    runId: manifest.runId,
    sessionId,
    extensionId: registered.extensionId,
    sandboxExtensionId: sandboxRegistered.extensionId,
    levels: ['scenario-verified', 'renderer-verified', ...(nativeVerificationLevel ? [nativeVerificationLevel] : [])],
    evidence: evidence.bundleDir,
  })}\n`)
} catch (error) {
  try {
    const failure = await command<{ bundleDir: string }>('evidence.capture', { label: 'extension-e2e-client-failure' })
    process.stderr.write(`Extension UI validation failure evidence: ${failure.bundleDir}\n`)
  } catch (evidenceError) {
    process.stderr.write(`Unable to capture extension UI validation failure evidence: ${String(evidenceError)}\n`)
  }
  throw error
} finally {
  await stopMortiseUiRun(manifest.runDir)
  await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

async function command<T = Record<string, unknown>>(
  name: string,
  params: Record<string, unknown> = {},
  expectedLevel?: string,
): Promise<T & { verificationLevel?: string }> {
  const response = await requestMortiseUiHost<T>({ ...manifest, command: name, params, timeoutMs: 120_000 })
  if (response.ok === false) throw new Error(`${name} failed: ${response.error.code}: ${response.error.message}`)
  if (expectedLevel && response.verificationLevel !== expectedLevel) {
    throw new Error(`${name} returned ${response.verificationLevel}; expected ${expectedLevel}.`)
  }
  return Object.assign(response.result as T, { verificationLevel: response.verificationLevel })
}

function nodes(snapshot: Snapshot): SnapshotNode[] { return Object.values(snapshot.regions).flat() }

function assertCount(snapshot: ExtensionDefinitionSnapshot, expected: number): void {
  const count = snapshot.definitions[0]?.definition.snapshot?.state?.count
  if (count !== expected) throw new Error(`Extension validation count is ${String(count)}; expected ${expected}.`)
}
