import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { requestCraftUiHost } from '../../craft-ui/client.ts'
import { startCraftUiRun, stopCraftUiRun } from '../../craft-ui/controller.ts'

interface WindowInfo { webContentsId: number; workspaceId: string | null; role: 'main' | 'child-session'; sessionId?: string; parentWebContentsId?: number }
interface Snapshot {
  revision: number
  regions: Record<string, Array<{ ref: string; semanticId?: string; role: string; name: string }>>
}

const sourceRoot = mkdtempSync(join(tmpdir(), 'craft-ui-recovery-source-'))
const sourceCraft = join(sourceRoot, 'craft')
const sourcePi = join(sourceRoot, 'pi')
const sourceWorkspace = join(sourceRoot, 'workspace')
mkdirSync(sourceCraft, { recursive: true })
mkdirSync(sourcePi, { recursive: true })
mkdirSync(sourceWorkspace, { recursive: true })
writeFileSync(join(sourceCraft, 'config.json'), JSON.stringify({
  setupDeferred: true,
  activeWorkspaceId: 'recovery-workspace',
  activeSessionId: null,
  workspaces: [{ id: 'recovery-workspace', name: 'Recovery Workspace', rootPath: sourceWorkspace, createdAt: Date.now() }],
}, null, 2))
writeFileSync(join(sourcePi, 'settings.json'), JSON.stringify({
  defaultProvider: 'ui-validation-local',
  defaultModel: 'ui-validation-model',
}, null, 2))
writeFileSync(join(sourcePi, 'models.json'), JSON.stringify({
  providers: {
    'ui-validation-local': {
      baseUrl: 'http://127.0.0.1:1/v1',
      api: 'openai-completions',
      apiKey: 'ui-validation-fixture',
      models: [{ id: 'ui-validation-model', name: 'UI Validation Model', input: ['text'], contextWindow: 4096, maxTokens: 1024 }],
    },
  },
}, null, 2))

let manifest: Awaited<ReturnType<typeof startCraftUiRun>> | undefined
let crashEvidence: { bundleDir?: string; artifacts?: Array<{ path: string }> } | undefined

try {
  manifest = await startCraftUiRun({
    surface: 'electron',
    profileMode: 'clone',
    sourceCraftConfigDir: sourceCraft,
    sourcePiAgentDir: sourcePi,
    waitMs: 180_000,
  })
  const initialWindows = await command<WindowInfo[]>('ui.windows')
  if (initialWindows.length !== 1 || initialWindows[0]?.role !== 'main') {
    throw new Error(`Expected one initial main renderer window, received ${JSON.stringify(initialWindows)}.`)
  }
  const first = initialWindows[0]!
  const beforeDetach = await command<Snapshot>('ui.snapshot', { webContentsId: first.webContentsId })
  const setupLater = Object.values(beforeDetach.regions).flat().find(node => node.semanticId === 'onboarding.setup-later')
  if (setupLater) {
    await command('ui.action', {
      webContentsId: first.webContentsId,
      revision: beforeDetach.revision,
      target: { ref: setupLater.ref },
      action: 'click',
      mode: 'physical',
      waitUntil: { predicate: { kind: 'node', target: { semanticId: 'navigation.nav_settings' } }, timeoutMs: 60_000 },
    })
  }

  const chat = await command<{ opened: { route?: { surface?: string } }; settled?: boolean }>('app.open', {
    webContentsId: first.webContentsId,
    route: { surface: 'chat', workspaceId: 'recovery-workspace' },
    timeoutMs: 60_000,
    stableForMs: 100,
  })
  if (!chat.settled || chat.opened.route?.surface !== 'chat') {
    throw new Error(`Primary AppShell chat route did not settle: ${JSON.stringify(chat)}`)
  }

  const sessionList = await command<Snapshot>('ui.snapshot', { webContentsId: first.webContentsId })
  const newSession = nodes(sessionList).find(node => node.semanticId === 'app.new-session')
  if (!newSession) {
    await command('evidence.capture', { webContentsId: first.webContentsId, label: 'primary-app-shell-missing-new-session' })
    throw new Error('Primary AppShell did not expose app.new-session.')
  }
  await command('ui.action', {
    webContentsId: first.webContentsId,
    revision: sessionList.revision,
    target: { ref: newSession.ref },
    action: 'click',
    mode: 'physical',
    waitUntil: { kind: 'state', scope: 'sessions', phase: 'ready', detail: { count: 1 }, timeoutMs: 60_000 },
    timeoutMs: 60_000,
  })
  const primarySession = await command<Snapshot>('ui.snapshot', { webContentsId: first.webContentsId })
  const composer = nodes(primarySession).find(node => node.semanticId?.startsWith('composer.') && node.semanticId.endsWith('.input'))
  if (!composer?.semanticId) throw new Error('Created session did not expose a semantic composer input.')
  const sessionId = composer.semanticId.slice('composer.'.length, -'.input'.length)
  await command('ui.action', {
    webContentsId: first.webContentsId,
    revision: primarySession.revision,
    target: { ref: composer.ref },
    action: 'fill',
    mode: 'semantic',
    value: 'Persist this recovery validation session.',
  })
  const filledSession = await command<Snapshot>('ui.snapshot', { webContentsId: first.webContentsId })
  const send = nodes(filledSession).find(node => node.semanticId === `composer.${sessionId}.send`)
  if (!send) throw new Error('Created session did not expose its semantic send action.')
  await command('ui.action', {
    webContentsId: first.webContentsId,
    revision: filledSession.revision,
    target: { ref: send.ref },
    action: 'click',
    mode: 'physical',
    waitUntil: { kind: 'state', scope: 'sessions', phase: 'ready', detail: { count: 1 }, timeoutMs: 60_000 },
    timeoutMs: 60_000,
  })

  const opened = await command<{ webContentsId: number; workspaceId: string; role: string; sessionId: string }>(
    'diagnostics.window.open',
    { webContentsId: first.webContentsId, sessionId },
  )
  if (opened.role !== 'child-session' || opened.sessionId !== sessionId || opened.workspaceId !== first.workspaceId) {
    throw new Error(`Diagnostic command did not create the expected child AppShell: ${JSON.stringify(opened)}`)
  }
  await command('ui.wait', {
    webContentsId: opened.webContentsId,
    predicate: { kind: 'state', scope: 'app', phase: 'ready', detail: {} },
    timeoutMs: 60_000,
  })
  await command('ui.wait', {
    webContentsId: opened.webContentsId,
    predicate: { kind: 'semantic-ready' },
    timeoutMs: 60_000,
  })
  await command('ui.wait', {
    webContentsId: opened.webContentsId,
    predicate: { kind: 'state', scope: 'route', phase: 'ready', detail: { surface: 'chat', sessionId } },
    timeoutMs: 60_000,
    stableForMs: 100,
  })
  const windows = await command<WindowInfo[]>('ui.windows')
  const childWindow = windows.find(window => window.webContentsId === opened.webContentsId)
  if (windows.length !== 2 || childWindow?.role !== 'child-session' || childWindow.sessionId !== sessionId
    || childWindow.parentWebContentsId !== first.webContentsId) {
    throw new Error(`Second managed window did not expose stable child-session identity: ${JSON.stringify(windows)}`)
  }
  const ambiguous = await raw('ui.snapshot')
  if (ambiguous.ok || ambiguous.error.code !== 'AMBIGUOUS_TARGET') {
    throw new Error(`Unselected multi-window snapshot did not fail with AMBIGUOUS_TARGET: ${JSON.stringify(ambiguous)}`)
  }
  const childSnapshot = await command<Snapshot>('ui.snapshot', { webContentsId: opened.webContentsId })
  if (!nodes(childSnapshot).some(node => node.semanticId === composer.semanticId)) {
    throw new Error('Child AppShell did not expose the selected session composer through business semantics.')
  }
  await command('ui.window', { webContentsId: opened.webContentsId, action: 'close' })
  await command('ui.wait', {
    webContentsId: first.webContentsId,
    predicate: { kind: 'state', scope: 'app', phase: 'ready', detail: {} },
    timeoutMs: 30_000,
    stableForMs: 100,
  })
  const afterCloseWindows = await command<WindowInfo[]>('ui.windows')
  if (afterCloseWindows.length !== 1 || afterCloseWindows[0]?.webContentsId !== first.webContentsId) {
    throw new Error(`Closing the child AppShell did not restore unambiguous primary-window selection: ${JSON.stringify(afterCloseWindows)}`)
  }
  await command<Snapshot>('ui.snapshot')

  const picker = await command<{ opened: { route?: { surface?: string } }; settled?: boolean }>('app.open', {
    webContentsId: first.webContentsId,
    route: { surface: 'workspace-picker' },
    timeoutMs: 60_000,
    stableForMs: 100,
  })
  if (!picker.settled || picker.opened.route?.surface !== 'workspace-picker') {
    throw new Error(`Workspace picker route did not settle: ${JSON.stringify(picker)}`)
  }
  const pickerSnapshot = await command<Snapshot>('ui.snapshot', { webContentsId: first.webContentsId })
  if (!nodes(pickerSnapshot).some(node => node.role === 'heading' || node.role === 'button')) {
    throw new Error('Workspace picker route settled without exposing real interactive UI.')
  }

  await command('diagnostics.renderer.detach', { webContentsId: first.webContentsId })
  const afterDetach = await command<Snapshot>('ui.snapshot', { webContentsId: first.webContentsId })
  if (Object.values(afterDetach.regions).flat().length === 0) throw new Error('CDP driver did not recover after debugger detach.')

  await command('diagnostics.renderer.crash', { webContentsId: first.webContentsId })
  await command('ui.wait', {
    webContentsId: first.webContentsId,
    predicate: { kind: 'state', scope: 'app', phase: 'error', detail: {} },
    timeoutMs: 30_000,
  })
  crashEvidence = await command('evidence.capture', { webContentsId: first.webContentsId, label: 'renderer-crash-recovery' })
  if (!crashEvidence.bundleDir || !existsSync(crashEvidence.bundleDir)) throw new Error('Renderer crash did not produce a diagnostic evidence bundle.')
  const paths = crashEvidence.artifacts?.map(item => item.path) ?? []
  if (!paths.some(path => path.endsWith('page-errors.json')) || !paths.some(path => path.endsWith('main-process.json'))) {
    throw new Error('Renderer crash evidence omitted page errors or main-process diagnostics.')
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    runId: manifest.runId,
    detachRecoveredFromRevision: beforeDetach.revision,
    windowsVerified: windows.length,
    crashEvidence: crashEvidence.bundleDir,
  })}\n`)
} catch (error) {
  if (manifest) {
    try {
      const failure = await command<{ bundleDir: string }>('evidence.capture', { label: 'recovery-e2e-client-failure' })
      process.stderr.write(`Recovery UI validation failure evidence: ${failure.bundleDir}\n`)
    } catch (evidenceError) {
      process.stderr.write(`Unable to capture recovery UI validation failure evidence: ${String(evidenceError)}\n`)
    }
  }
  throw error
} finally {
  if (manifest) await stopCraftUiRun(manifest.runDir)
  rmSync(sourceRoot, { recursive: true, force: true })
}

async function raw<T = Record<string, unknown>>(command: string, params: Record<string, unknown> = {}) {
  if (!manifest) throw new Error('UI validation run has not started.')
  return await requestCraftUiHost<T>({ ...manifest, command, params, timeoutMs: 120_000 })
}

async function command<T = Record<string, unknown>>(name: string, params: Record<string, unknown> = {}): Promise<T> {
  const response = await raw<T>(name, params)
  if (response.ok === false) throw new Error(`${name} failed: ${response.error.code}: ${response.error.message}`)
  return response.result
}

function nodes(snapshot: Snapshot) { return Object.values(snapshot.regions).flat() }
