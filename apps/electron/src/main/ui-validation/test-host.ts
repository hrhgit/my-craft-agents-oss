import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { BrowserWindow, dialog, Menu } from 'electron'
import type { ManagedWindowRole, WindowManager } from '../window-manager'
import type { BrowserPaneManager } from '../browser-pane-manager'
import { queryUiValidationCapabilities, UiValidationError, type UiValidationCapabilitiesQuery } from '@craft-agent/shared/ui-validation'
import { extensionUIValidationEntityId } from '@craft-agent/shared/protocol'
import {
  ElectronUiDriverError,
  ElectronUiSurfaceDriver,
  type UiDriverSnapshot,
  type UiDriverWindowSelector,
  type UiVerificationLevel,
} from './electron-surface-driver'
import { getUiValidationStateBridge } from './state-bridge'
import { expectedRendererRoute, parseStateCondition, semanticReadyAppGate, stateObservation, UI_TEST_HOST_DEFAULT_WAIT_MS, UI_TEST_HOST_MAX_WAIT_MS } from './test-host-state'
import { ElectronExtensionValidationAdapter, ExtensionValidationAdapterError } from './extension-validation-adapter'
import { WindowsNativeUiDriver } from './windows-native-driver'
import { ElectronNativeWindowController } from './native-window-readiness'
import { ElectronEvidenceCollector } from './evidence-collector'
import { ElectronNativeDialogAdapter, type NativeDialogKind } from './native-dialog-adapter'
import { ElectronNativeMenuAdapter } from './native-menu-adapter'
import { captureMainProcessDiagnostics } from './main-process-diagnostics'
import { APP_SHELL_SCENARIO_IDS, AppShellScenarioAdapterError, ElectronAppShellScenarioAdapter, appShellScenarioApplyRequest } from './app-shell-scenario-adapter'
import { loadRendererTarget, rendererPageUrl } from './renderer-navigation'
import { uiTestHostHttpErrorEnvelope } from './http-error-envelope'
import { findRendererSnapshotTargets, resolveRendererSnapshotTarget } from './snapshot-target'
import { parseElectronActionParams, parseElectronWaitParams } from './test-host-request'
import { ElectronBackgroundWindowController, parseElectronUiWindowMode } from './background-window-mode'
import { parseBrowserViewKeyAction } from './browser-view-key-action'
import { ElectronBrowserViewSurfaceAdapter } from './browser-view-surface-adapter'

const MAX_REQUEST_BYTES = 1_000_000
const MAX_WAIT_MS = UI_TEST_HOST_MAX_WAIT_MS

export interface UiTestHostOptions {
  isPackaged: boolean
  windowManager: WindowManager
  browserPaneManager?: BrowserPaneManager
  runtimeLogPath: string
  openRoute?: (params: Record<string, unknown>, target: { webContentsId: number; workspaceId: string | null }) => Promise<unknown>
  shutdown?: () => void
}

interface CommandRequest {
  v: 1
  kind: 'request'
  id: string
  requestId: string
  runId: string
  method: string
  params?: Record<string, unknown>
}

interface UiTestHost {
  close(): Promise<void>
  url: string
}

interface ExtensionTarget {
  kind: 'extension'
  sessionId: string
  extensionId: string
  runtimeId?: string
  definitionId?: string
}

export async function startUiTestHost(options: UiTestHostOptions): Promise<UiTestHost | null> {
  if (process.env.CRAFT_UI_TEST_HOST !== '1') return null
  if (options.isPackaged || process.env.NODE_ENV === 'production') {
    throw new Error('CRAFT_UI_TEST_HOST is forbidden in packaged or production runtime.')
  }

  const runId = requireEnv('CRAFT_UI_RUN_ID')
  const token = requireEnv('CRAFT_UI_TOKEN')
  const manifestPath = resolve(requireEnv('CRAFT_UI_ENDPOINT_MANIFEST'))
  const artifactsDir = resolve(requireEnv('CRAFT_UI_ARTIFACTS_DIR'))
  const surface = process.env.CRAFT_UI_SURFACE
  const windowMode = parseElectronUiWindowMode(process.env.CRAFT_UI_WINDOW_MODE)
  if (surface !== 'electron') throw new Error(`Electron Test Host cannot serve surface ${surface ?? '(missing)'}.`)
  if (!/^[a-f0-9]{64}$/i.test(token)) throw new Error('CRAFT_UI_TOKEN must be 64 hexadecimal characters.')
  if (process.env.CRAFT_UI_PROTOCOL_VERSION !== '1') throw new Error('Unsupported CRAFT_UI_PROTOCOL_VERSION.')

  await mkdir(artifactsDir, { recursive: true })
  const driver = new ElectronUiSurfaceDriver(options.windowManager)
  const browserSurfaces = options.browserPaneManager
    ? new ElectronBrowserViewSurfaceAdapter(options.browserPaneManager)
    : undefined
  const compositeSnapshot = async (selector: UiDriverWindowSelector): Promise<UiDriverSnapshot> => {
    const snapshot = await driver.snapshot(selector)
    if (!browserSurfaces) return snapshot
    const embeddedSurfaces = await browserSurfaces.snapshot(snapshot.window.webContentsId)
    return embeddedSurfaces.length > 0 ? { ...snapshot, embeddedSurfaces } : snapshot
  }
  const compositeScreenshot = async (selector: UiDriverWindowSelector, path: string) => {
    const renderer = await driver.screenshot(selector, path)
    const artifacts = [{ kind: 'renderer-screenshot', path: renderer.path, mimeType: 'image/png' }]
    const surfaces: Array<Record<string, unknown>> = []
    if (options.browserPaneManager && browserSurfaces) {
      const snapshots = await browserSurfaces.snapshot(renderer.webContentsId)
      for (const surface of snapshots.filter(item => item.visible)) {
        try {
          const captured = await options.browserPaneManager.screenshot(surface.instanceId, { mode: 'raw' })
          const extension = captured.imageFormat === 'jpeg' ? 'jpg' : 'png'
          const surfacePath = join(dirname(path), `${basename(path, '.png')}-${sanitizeArtifactPart(surface.instanceId)}.${extension}`)
          await writeFile(surfacePath, captured.imageBuffer)
          artifacts.push({ kind: 'browser-view-screenshot', path: surfacePath, mimeType: captured.imageFormat === 'jpeg' ? 'image/jpeg' : 'image/png' })
          surfaces.push({
            surfaceId: surface.surfaceId,
            instanceId: surface.instanceId,
            bounds: surface.bounds,
            requestedBounds: surface.requestedBounds,
            artifactPath: surfacePath,
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const requiresForeground = windowMode === 'background' && /display surface is unavailable|focus(?:ing)? the browser window/i.test(message)
          surfaces.push({
            surfaceId: surface.surfaceId,
            instanceId: surface.instanceId,
            bounds: surface.bounds,
            requestedBounds: surface.requestedBounds,
            error: message,
            ...(requiresForeground ? {
              requiresForeground: true,
              retry: { windowMode: 'foreground', reason: 'BrowserView pixel capture requires a visible native display surface.' },
            } : {}),
          })
        }
      }
    }
    return { renderer, artifacts, surfaces }
  }
  const nativeDriver = new WindowsNativeUiDriver(process.pid)
  const nativeMenus = new ElectronNativeMenuAdapter(Menu, () => BrowserWindow.getFocusedWindow())
  const stateBridge = getUiValidationStateBridge()!
  if (!stateBridge) throw new Error('UI validation state bridge must be installed before the Test Host starts.')
  const nativeWindows = new ElectronNativeWindowController(nativeDriver, (webContentsId, phase, detail) => {
    stateBridge.setNativeDriverState(webContentsId, phase, detail)
  }, windowMode)
  const backgroundWindows = windowMode === 'background'
    ? new ElectronBackgroundWindowController(options.windowManager)
    : undefined
  if (windowMode === 'foreground') {
    for (const { window } of options.windowManager.getAllWindows()) {
      if (!window.isDestroyed()) nativeWindows.reveal(window, { focus: false })
    }
  }
  let nativeDialogWindowId: number | undefined
  const nativeDialogs = new ElectronNativeDialogAdapter(dialog, record => {
    if (nativeDialogWindowId === undefined) return
    stateBridge.setNativeDriverState(nativeDialogWindowId, record.phase === 'opening' ? 'busy' : record.phase === 'error' ? 'error' : 'ready', {
      dialog: { id: record.dialogId, kind: record.kind, phase: record.phase, canceled: record.canceled, selectionCount: record.selectionCount },
    })
  })
  let seq = 0
  let revision = 0
  let lastSnapshot: UiDriverSnapshot | undefined
  const snapshotHistory = new Map<number, UiDriverSnapshot>()
  let activeScenario: {
    id: string
    source?: 'app-shell' | 'playground' | 'extension'
    variant?: string
    seed: number
    clock: string
    clockDomains?: string[]
    target?: ExtensionTarget
    input?: Record<string, unknown>
    state?: unknown
  } | undefined
  let closing = false
  let runVerificationLevel: UiVerificationLevel = 'scenario-verified'
  const activeWaits = new Set<AbortController>()
  const evidenceCollector = new ElectronEvidenceCollector({
    artifactsDir,
    runId,
    runtimeLogPath: options.runtimeLogPath,
    secrets: [token],
    snapshot: compositeSnapshot,
    screenshot: compositeScreenshot,
    state: webContentsId => stateBridge.snapshot(webContentsId),
    events: eventOptions => stateBridge.events(eventOptions),
    driver: { name: 'electron-webcontents-debugger', cdpVersion: '1.3', native: process.platform === 'win32' ? 'windows-uia' : 'unsupported', rawProtocolExposed: false },
    mainProcessDiagnostics: captureMainProcessDiagnostics,
  })
  evidenceCollector.start(options.windowManager.getAllWindows().map(({ window }) => window.webContents))

  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/command') {
      sendJson(response, 404, uiTestHostHttpErrorEnvelope({
        requestId: randomUUID(), runId, seq: ++seq, revision,
        verificationLevel: 'scenario-verified', code: 'TARGET_NOT_FOUND', message: 'Unknown endpoint.',
      }))
      return
    }
    if (!authorized(request.headers.authorization, token)) {
      sendJson(response, 401, uiTestHostHttpErrorEnvelope({
        requestId: randomUUID(), runId, seq: ++seq, revision,
        verificationLevel: 'scenario-verified', code: 'UNSUPPORTED', message: 'Authentication required.',
      }))
      return
    }

    let body: CommandRequest
    const abortController = new AbortController()
    activeWaits.add(abortController)
    response.once('close', () => {
      if (!response.writableEnded) abortController.abort('client disconnected')
    })
    try {
      body = await readCommand(request)
      validateCommand(body, runId)
    } catch (error) {
      const requestId = typeof (error as { id?: unknown })?.id === 'string'
        ? String((error as { id: string }).id)
        : 'invalid'
      sendJson(response, 400, failureEnvelope(requestId, runId, ++seq, revision, 'scenario-verified', error))
      return
    }

    try {
      const commandSeq = ++seq
      const command = normalizeMethod(body.method)
      const result = await dispatch(command, body.params ?? {}, abortController.signal)
      backgroundWindows?.refresh()
      const level = resultVerificationLevel(command, result)
      if (level === 'native-verified' || (level === 'renderer-verified' && runVerificationLevel === 'scenario-verified')) {
        runVerificationLevel = level
      }
      revision = Math.max(revision, snapshotRevision(result), lastSnapshot?.revision ?? 0)
      sendJson(response, 200, {
        v: 1,
        kind: 'response',
        id: body.id,
        requestId: body.requestId,
        runId,
        seq: commandSeq,
        revision,
        verificationLevel: level,
        ok: true,
        result,
      })
    } catch (error) {
      const command = normalizeMethod(body.method)
      let evidenceBundle: string | undefined
      if (command !== 'evidence' && command !== 'shutdown' && command !== 'stop') {
        try {
          const evidence = await captureEvidence({ label: `failure-${command}` }, parseSelector(body.params ?? {})) as { bundleDir?: string }
          evidenceBundle = evidence.bundleDir
        } catch {
          // The original typed failure remains authoritative when evidence is unavailable.
        }
      }
      sendJson(response, 200, {
        ...failureEnvelope(body.requestId, runId, ++seq, revision, verificationLevel(command), error, evidenceBundle ? { evidenceBundle } : undefined),
      })
    } finally {
      backgroundWindows?.refresh()
      activeWaits.delete(abortController)
    }
  })

  function rememberSnapshot(snapshot: UiDriverSnapshot): UiDriverSnapshot {
    lastSnapshot = snapshot
    snapshotHistory.set(snapshot.revision, snapshot)
    while (snapshotHistory.size > 20) snapshotHistory.delete(snapshotHistory.keys().next().value!)
    return snapshot
  }

  async function dispatch(command: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    evidenceCollector.start(options.windowManager.getAllWindows().map(({ window }) => window.webContents))
    const selector = parseSelector(params)
    const extensionTarget = parseExtensionTarget(params)
    if (command === 'capabilities') {
      return queryUiValidationCapabilities('electron', {
        operation: params.operation,
        kind: params.kind,
        id: params.id,
      } as UiValidationCapabilitiesQuery)
    }
    if (command === 'status') {
      const state = stateBridge.snapshot(selectedWindowId(options.windowManager, selector, false))
      const app = state.states.find(item => item.scope === 'app' && item.phase !== 'disposed')
      const driverStatus = driver.ready()
      const nativeWindowId = selectedWindowId(options.windowManager, selector, false)
      const nativeWindow = nativeWindowId === undefined ? undefined : options.windowManager.getWindowByWebContentsId(nativeWindowId)
      const nativeWindowStatuses = options.windowManager.getAllWindows().map(entry => nativeWindows.status(entry.window))
      const appShellScenario = activeScenario && APP_SHELL_SCENARIO_IDS.has(activeScenario.id as never)
        ? await callAppShellScenarioAdapter(() => appShellScenarioAdapter(selector).snapshot())
        : undefined
      return {
        ...driverStatus,
        ready: driverStatus.ready && app?.phase === 'ready',
        windowMode,
        windows: driver.windows(),
        nativeDriver: {
          ...nativeWindows.status(nativeWindow ?? undefined),
          platform: process.platform,
          adapter: 'windows-uia',
          applicationMenu: nativeMenus.ready(),
          windows: nativeWindowStatuses,
        },
        phase: app?.phase ?? 'loading',
        revision: state.revision,
        state,
        ...(appShellScenario ? { appShellScenario } : {}),
      }
    }
    if (command === 'windows') return driver.windows()
    if (command === 'screenshot') {
      const label = boundedArtifactLabel(params.label, 'screenshot')
      const outputPath = join(artifactsDir, 'driver', `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}-${label}.png`)
      const captured = await compositeScreenshot(selector, outputPath)
      return {
        artifact: captured.artifacts[0],
        artifacts: captured.artifacts,
        width: captured.renderer.width,
        height: captured.renderer.height,
        embeddedSurfaces: captured.surfaces,
      }
    }
    if (command === 'logs') {
      const maxBytes = boundedLogBytes(params.maxBytes)
      let runtime = ''
      try {
        runtime = await driver.logs(options.runtimeLogPath, maxBytes)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'ENOENT') throw error
      }
      return { maxBytes, logs: { runtime: redactDiagnosticText(runtime, maxBytes) } }
    }
    if (command === 'snapshot') {
      if (params.scope === 'native') {
        return await nativeWindows.snapshot(resolveManagedWindow(options.windowManager, selector), {
          timeoutMs: numberOr(params.timeoutMs, UI_TEST_HOST_DEFAULT_WAIT_MS),
          signal,
        })
      }
      if (extensionTarget) {
        const definitions = await extensionAdapter(selector).snapshot({
          sessionId: extensionTarget.sessionId,
          extensionId: extensionTarget.extensionId,
        }) as Array<Record<string, unknown>>
        const selected = extensionTarget.definitionId
          ? definitions.filter(item => (item.definition as { id?: unknown } | undefined)?.id === extensionTarget.definitionId
            && (extensionTarget.runtimeId === undefined || item.runtimeId === extensionTarget.runtimeId))
          : definitions
        if (extensionTarget.definitionId && selected.length === 0) throw new ElectronUiDriverError('TARGET_NOT_FOUND', 'Extension validation definition was not found.')
        return { kind: 'extension', definitions: selected, revision: stateBridge.snapshot().revision, verificationLevel: 'scenario-verified' }
      }
      const snapshot = rememberSnapshot(await compositeSnapshot(selector))
      if (typeof params.sinceRevision === 'number') {
        const previous = snapshotHistory.get(params.sinceRevision)
        if (previous) return incrementalSnapshot(previous, snapshot)
        return { ...snapshot, sinceRevision: params.sinceRevision, full: true, resetRequired: true }
      }
      return snapshot
    }
    if (command === 'action') {
      const parsedAction = parseElectronActionParams(params)
      const actionWindow = resolveManagedWindow(options.windowManager, selector)
      const actionSelector = { ...selector, webContentsId: actionWindow.webContents.id }
      if ('kind' in parsedAction.target && parsedAction.target.kind === 'browser') {
        if (!browserSurfaces) throw new ElectronUiDriverError('UNSUPPORTED', 'BrowserView validation adapter is unavailable.')
        const beforeEventSeq = stateBridge.events().latestSeq
        const browserReceipt = await browserSurfaces.action(actionWindow.webContents.id, {
          instanceId: parsedAction.target.instanceId,
          revision: requiredNumber(parsedAction.revision, 'revision'),
          ref: parsedAction.target.ref,
          action: requiredBrowserViewAction(parsedAction.action),
          ...(parsedAction.value === undefined ? {} : { value: parsedAction.value }),
        })
        return await settleActionReceipt(browserReceipt, params, actionSelector, beforeEventSeq, signal)
      }
      if (params.mode === 'native' || (isRecord(params.target) && params.target.kind === 'native')) {
        const target = isRecord(params.target) ? params.target : params
        const beforeEventSeq = stateBridge.events().latestSeq
        const nativeReceipt = await nativeWindows.action(actionWindow, {
          revision: requiredNumber(params.revision, 'revision'),
          ref: requiredString(target.ref, 'target.ref'),
          action: requiredNativeAction(params.action),
          ...(typeof params.value === 'string' ? { value: params.value } : {}),
        }, {
          timeoutMs: numberOr(params.timeoutMs, UI_TEST_HOST_DEFAULT_WAIT_MS),
          signal,
        })
        return await settleActionReceipt({ ...nativeReceipt }, params, actionSelector, beforeEventSeq, signal)
      }
      if (extensionTarget) {
        if (!extensionTarget.definitionId) throw new ElectronUiDriverError('TARGET_NOT_FOUND', 'Extension action target requires definitionId.')
        const definitionId = extensionTarget.definitionId
        const actionId = requiredScenarioId(params.action)
        const beforeRevision = stateBridge.snapshot().revision
        const beforeEventSeq = stateBridge.events().latestSeq
        const beforeDefinitionRevision = await currentExtensionDefinitionRevision(extensionTarget, actionSelector)
        const result = await callExtensionAdapter(() => extensionAdapter(actionSelector).execute({
          ...extensionTarget,
          definitionId,
          kind: 'action',
          id: actionId,
          ...(isRecord(params.input) ? { input: params.input } : {}),
        }))
        const readiness = await waitForExtensionCommandSettle(extensionTarget, actionSelector, beforeEventSeq, beforeDefinitionRevision, params, signal)
        return await settleActionReceipt({
          actionId: randomUUID(),
          result,
          readiness,
          beforeRevision,
          afterRevision: stateBridge.snapshot().revision,
          targetResolved: { ...extensionTarget },
          settledBy: ['extension-command-ack', 'extension-readiness'],
          warnings: [],
          mode: 'semantic',
          verificationLevel: 'scenario-verified',
        }, params, actionSelector, beforeEventSeq, signal)
      }
      const target = typeof params.target === 'object' && params.target !== null
        ? params.target as Record<string, unknown>
        : params
      let actionRevision = typeof params.revision === 'number' ? requiredNumber(params.revision, 'revision') : undefined
      let actionRef = typeof target.ref === 'string' ? requiredString(target.ref, 'target.ref') : undefined
      if (
        typeof target.ref !== 'string'
        && (
          typeof target.semanticId === 'string'
          || typeof target.testId === 'string'
          || typeof target.role === 'string'
        )
      ) {
        const current = rememberSnapshot(await compositeSnapshot(actionSelector))
        const matched = resolveRendererSnapshotTarget(Object.values(current.regions).flat(), target)
        actionRevision = current.revision
        actionRef = matched.ref
      }
      const beforeEventSeq = stateBridge.events().latestSeq
      const action = await driver.action(actionSelector, {
        revision: actionRevision ?? requiredNumber(params.revision, 'revision'),
        ref: actionRef ?? requiredString(target.ref, 'target.ref'),
        action: requiredAction(params.action),
        ...(params.mode === 'semantic' || params.mode === 'physical' ? { mode: params.mode } : {}),
        ...(typeof params.value === 'string' ? { value: params.value } : {}),
        ...(typeof params.key === 'string' ? { key: params.key } : {}),
        ...(Array.isArray(params.modifiers) ? { modifiers: params.modifiers as never } : {}),
        ...(isPoint(params.to) ? { to: params.to } : {}),
      })
      lastSnapshot = rememberSnapshot(await compositeSnapshot(actionSelector))
      return await settleActionReceipt({ ...action, afterRevision: lastSnapshot.revision }, params, actionSelector, beforeEventSeq, signal)
    }
    if (command === 'browser-key') {
      const manager = options.browserPaneManager
      if (!manager) throw new ElectronUiDriverError('UNSUPPORTED', 'BrowserView validation adapter is unavailable.')
      const window = resolveManagedWindow(options.windowManager, selector)
      const workspaceId = options.windowManager.getWorkspaceForWindow(window.webContents.id)
      if (!workspaceId) throw new ElectronUiDriverError('TARGET_NOT_FOUND', 'Selected window has no workspace.')
      const shortcut = parseBrowserViewKeyAction(params)
      try {
        manager.assertInstanceOwnedByWorkspace(shortcut.instanceId, workspaceId)
        await manager.sendKeyToEmbeddedHost(shortcut.instanceId, window.webContents.id, shortcut)
      } catch (error) {
        throw new ElectronUiDriverError('TARGET_NOT_FOUND', error instanceof Error ? error.message : String(error))
      }
      return {
        instanceId: shortcut.instanceId,
        hostWebContentsId: window.webContents.id,
        key: shortcut.key,
        modifiers: shortcut.modifiers,
        settledBy: ['browser-view-input-dispatched'],
        verificationLevel: 'renderer-verified',
      }
    }
    if (command === 'resize') {
      driver.resize(selector, requiredNumber(params.width, 'width'), requiredNumber(params.height, 'height'))
      return { resized: true }
    }
    if (command === 'native') {
      if (params.operation === 'menu.snapshot') return nativeMenus.snapshot()
      if (params.operation === 'menu.action') {
        if (windowMode === 'background') {
          throw new ElectronUiDriverError('UNSUPPORTED', 'Native menu actions require a foreground window and are unavailable in background mode.', { windowMode })
        }
        const target = isRecord(params.target) ? params.target : params
        return await nativeMenus.action({
          revision: requiredNumber(params.revision, 'revision'),
          ref: requiredString(target.ref, 'target.ref'),
          action: params.action === 'click' ? 'click' : (() => { throw new ElectronUiDriverError('UNSUPPORTED', 'Electron menu supports only click.') })(),
        })
      }
      if (params.operation === 'dialog.open') {
        if (windowMode === 'background') {
          throw new ElectronUiDriverError('UNSUPPORTED', 'Native dialogs require a foreground window and are unavailable in background mode.', { windowMode })
        }
        const window = resolveManagedWindow(options.windowManager, selector)
        return await nativeWindows.withReadyWindow(window, {
          timeoutMs: numberOr(params.timeoutMs, UI_TEST_HOST_DEFAULT_WAIT_MS),
          signal,
        }, async () => {
          nativeDialogWindowId = window.webContents.id
          const opened = nativeDialogs.open(window, {
            kind: requiredNativeDialogKind(params.kind),
            ...(typeof params.title === 'string' ? { title: params.title } : {}),
          })
          const title = typeof params.title === 'string' ? params.title : undefined
          const appeared = await nativeDriver.waitForNode(node =>
            node.role === 'Window' && (!title || node.name === title),
          { timeoutMs: numberOr(params.timeoutMs, UI_TEST_HOST_DEFAULT_WAIT_MS), signal })
          return { ...opened, nativeRevision: appeared.snapshot.revision, nativeTarget: appeared.node }
        })
      }
      if (params.operation === 'dialog.status') {
        return nativeDialogs.status(typeof params.dialogId === 'string' ? params.dialogId : undefined)
      }
      if (params.operation === 'dialog.wait') {
        return await nativeDialogs.wait(requiredString(params.dialogId, 'dialogId'), {
          timeoutMs: numberOr(params.timeoutMs, UI_TEST_HOST_DEFAULT_WAIT_MS),
          signal,
        })
      }
      if (params.operation === 'snapshot' || params.action === undefined) {
        const window = resolveManagedWindow(options.windowManager, selector)
        return await nativeWindows.snapshot(window, {
          timeoutMs: numberOr(params.timeoutMs, UI_TEST_HOST_DEFAULT_WAIT_MS),
          signal,
        })
      }
      const target = isRecord(params.target) ? params.target : params
      return await nativeWindows.action(resolveManagedWindow(options.windowManager, selector), {
        revision: requiredNumber(params.revision, 'revision'),
        ref: requiredString(target.ref, 'target.ref'),
        action: requiredNativeAction(params.action),
        ...(typeof params.value === 'string' ? { value: params.value } : {}),
      }, {
        timeoutMs: numberOr(params.timeoutMs, UI_TEST_HOST_DEFAULT_WAIT_MS),
        signal,
      })
    }
    if (command === 'window') {
      const action = params.action
      if (action !== 'focus' && action !== 'minimize' && action !== 'maximize' && action !== 'restore' && action !== 'close') {
        throw new ElectronUiDriverError('UNSUPPORTED', 'Unsupported native action.')
      }
      if (windowMode === 'background' && (action === 'focus' || action === 'maximize' || action === 'restore')) {
        throw new ElectronUiDriverError('UNSUPPORTED', `${action} is unavailable in background mode.`, { windowMode, action })
      }
      return { verificationLevel: await driver.electronWindowAction(selector, action) }
    }
    if (command === 'open') {
      if (!options.openRoute) throw new ElectronUiDriverError('UNSUPPORTED', 'Route adapter is unavailable.')
      const targetWindow = resolveManagedWindow(options.windowManager, selector)
      const afterSeq = stateBridge.events().latestSeq
      const opened = await options.openRoute(params, {
        webContentsId: targetWindow.webContents.id,
        workspaceId: options.windowManager.getWorkspaceForWindow(targetWindow.webContents.id),
      }) as { ready?: unknown; dependencies?: unknown }
      const openTimeoutMs = Math.min(numberOr(params.timeoutMs, UI_TEST_HOST_DEFAULT_WAIT_MS), MAX_WAIT_MS)
      const waitOptions = {
        timeoutMs: openTimeoutMs,
        stableForMs: Math.min(numberOr(params.stableForMs, 0), openTimeoutMs),
        afterSeq,
        signal,
      }
      if (isRecord(opened.ready)) {
        const declaredWaits = [
          ...(Array.isArray(opened.dependencies) ? opened.dependencies.filter(isRecord) : []),
          opened.ready,
        ]
        const deadline = Date.now() + openTimeoutMs
        for (const declared of declaredWaits) {
          const remainingMs = Math.max(0, deadline - Date.now())
          await stateBridge.wait({
            scope: declared.scope as 'route',
            phase: declared.phase as 'ready',
            ...(typeof declared.windowId === 'string' ? { windowId: declared.windowId } : { windowId: String(targetWindow.webContents.id) }),
            ...(typeof declared.entityId === 'string' ? { entityId: declared.entityId } : {}),
            ...(isRecord(declared.detail) ? { detail: declared.detail } : {}),
          }, {
            ...waitOptions,
            timeoutMs: remainingMs,
            stableForMs: Math.min(waitOptions.stableForMs, remainingMs),
          })
        }
      } else {
        const expectedRoute = expectedRendererRoute(params)
        if (!expectedRoute) throw new ElectronUiDriverError('UNSUPPORTED', 'Open route cannot be mapped to a renderer route readiness condition.')
        if (expectedRoute.startsWith('action/')) {
        const routeEvent = await stateBridge.registry.events.waitFor(event => {
          const payload = event.payload as { windowId?: unknown } | undefined
          return event.type === 'state.route.changed' && payload?.windowId === String(targetWindow.webContents.id)
        }, { afterSeq, timeoutMs: openTimeoutMs, signal })
        await stateBridge.wait({ scope: 'route', phase: 'ready', windowId: String(targetWindow.webContents.id) }, { ...waitOptions, afterSeq: routeEvent.seq })
        } else {
          await stateBridge.wait({
            scope: 'route',
            phase: 'ready',
            windowId: String(targetWindow.webContents.id),
            detail: { route: expectedRoute },
          }, waitOptions)
        }
      }
      lastSnapshot = rememberSnapshot(await compositeSnapshot(selector))
      return {
        opened,
        revision: Math.max(lastSnapshot.revision, stateBridge.snapshot().revision),
        settled: true,
        settledBy: ['route-dependencies', 'route'],
      }
    }
    if (command === 'wait') {
      if (extensionTarget) return waitForExtension(extensionTarget, selector, params, signal)
      parseElectronWaitParams(params)
      return waitUntil(params, selector, signal)
    }
    if (command === 'assert') {
      if (extensionTarget) {
        if (!extensionTarget.definitionId) throw new ElectronUiDriverError('TARGET_NOT_FOUND', 'Extension assertion requires definitionId.')
        const readiness = await callExtensionAdapter(() => extensionAdapter(selector).readiness({ ...extensionTarget, definitionId: extensionTarget.definitionId! })) as { phase?: unknown }
        const expected = typeof params.phase === 'string' ? params.phase : 'ready'
        if (readiness.phase !== expected) throw new ElectronUiDriverError('TARGET_NOT_FOUND', `Extension readiness is ${String(readiness.phase)}, expected ${expected}.`, { readiness })
        return { matched: true, observed: readiness, verificationLevel: 'scenario-verified' }
      }
      parseElectronWaitParams(params)
      const observed = await evaluateCondition(params, selector)
      if (!observed.matched) throw new ElectronUiDriverError('TARGET_NOT_FOUND', 'UI assertion did not match.', { observed })
      return observed
    }
    if (command === 'evidence') return captureEvidence(params, selector)
    if (command === 'diagnostics.renderer.detach') {
      const window = resolveManagedWindow(options.windowManager, selector)
      if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach()
      return { detached: true, webContentsId: window.webContents.id }
    }
    if (command === 'diagnostics.renderer.crash') {
      const window = resolveManagedWindow(options.windowManager, selector)
      const webContentsId = window.webContents.id
      window.webContents.forcefullyCrashRenderer()
      return { crashRequested: true, webContentsId }
    }
    if (command === 'diagnostics.window.open') {
      const source = resolveManagedWindow(options.windowManager, selector)
      const workspaceId = options.windowManager.getWorkspaceForWindow(source.webContents.id)
      if (!workspaceId) throw new ElectronUiDriverError('TARGET_NOT_FOUND', 'Selected window has no workspace identity.')
      const sessionId = typeof params.sessionId === 'string' && params.sessionId
        ? requiredString(params.sessionId, 'sessionId')
        : 'ui-validation-secondary'
      const created = options.windowManager.createChildSessionWindow(sessionId, {
        workspaceId,
        parentWebContentsId: source.webContents.id,
        title: 'UI Validation Secondary',
      })
      return { webContentsId: created.webContents.id, workspaceId, role: 'child-session', sessionId }
    }
    if (command === 'clock.advance') {
      ensureActiveAppShellScenario()
      const now = await callAppShellScenarioAdapter(() => appShellScenarioAdapter(selector).advance(requiredNumber(params.ms, 'ms')))
      const scenarioState = await callAppShellScenarioAdapter(() => appShellScenarioAdapter(selector).snapshot()) as { revision?: unknown; clock?: { mode?: unknown } }
      if (activeScenario) activeScenario = { ...activeScenario, state: scenarioState }
      return { now, state: scenarioState, revision: typeof scenarioState.revision === 'number' ? scenarioState.revision : revision, verificationLevel: 'scenario-verified' }
    }
    if (command === 'fault.set') {
      const adapter = await ensureAppShellScenarioHost(selector, params)
      const source = isRecord(params.fault) ? params.fault : params
      const request: Record<string, unknown> = {
        point: requiredString(source.point, 'point'),
        effect: isRecord(source.effect) ? source.effect : (() => { throw new ElectronUiDriverError('UNSUPPORTED', 'effect must be an object.') })(),
        ...(typeof source.times === 'number' ? { times: source.times } : {}),
        ...(isRecord(source.scope) ? { scope: source.scope } : {}),
      }
      const fault = await callAppShellScenarioAdapter(() => adapter.setFault(request))
      return { fault, status: await callAppShellScenarioAdapter(() => adapter.snapshot()), verificationLevel: 'scenario-verified' }
    }
    if (command === 'fault.clear') {
      const adapter = await ensureAppShellScenarioHost(selector, params)
      await callAppShellScenarioAdapter(() => adapter.clearFault(params.faultId === undefined ? undefined : requiredString(params.faultId, 'faultId')))
      return { cleared: true, status: await callAppShellScenarioAdapter(() => adapter.snapshot()), verificationLevel: 'scenario-verified' }
    }
    if (command === 'fault.status') {
      const adapter = await ensureAppShellScenarioHost(selector, params)
      return { status: await callAppShellScenarioAdapter(() => adapter.snapshot()), verificationLevel: 'scenario-verified' }
    }
    if (command === 'scenario.reset' && extensionTarget) {
      if (!extensionTarget.definitionId) throw new ElectronUiDriverError('TARGET_NOT_FOUND', 'Extension scenario target requires definitionId.')
      const scenarioId = requiredScenarioId(params.id ?? params.name ?? params.scenario)
      const beforeEventSeq = stateBridge.events().latestSeq
      const beforeDefinitionRevision = await currentExtensionDefinitionRevision(extensionTarget, selector)
      const result = await callExtensionAdapter(() => extensionAdapter(selector).execute({
        ...extensionTarget,
        definitionId: extensionTarget.definitionId!,
        kind: 'scenario',
        id: scenarioId,
        phase: 'teardown',
        ...(isRecord(params.input) ? { input: params.input } : {}),
      }))
      await waitForExtensionCommandSettle(extensionTarget, selector, beforeEventSeq, beforeDefinitionRevision, params, signal)
      if (activeScenario?.source === 'extension'
        && activeScenario.id === scenarioId
        && sameExtensionTarget(activeScenario.target, extensionTarget)) {
        activeScenario = undefined
      }
      return { result, scenarioId, phase: 'teardown', revision: stateBridge.snapshot().revision, verificationLevel: 'scenario-verified' }
    }
    if (command === 'scenario' || command === 'scenario.apply') {
      if (extensionTarget) {
        if (!extensionTarget.definitionId) throw new ElectronUiDriverError('TARGET_NOT_FOUND', 'Extension scenario target requires definitionId.')
        const definitionId = extensionTarget.definitionId
        const scenarioId = requiredScenarioId(params.id ?? params.name ?? params.scenario)
        const phase = params.action === 'reset' || params.phase === 'teardown' ? 'teardown' : 'setup'
        const beforeEventSeq = stateBridge.events().latestSeq
        const beforeDefinitionRevision = await currentExtensionDefinitionRevision(extensionTarget, selector)
        const result = await callExtensionAdapter(() => extensionAdapter(selector).execute({
          ...extensionTarget,
          definitionId,
          kind: 'scenario',
          id: scenarioId,
          phase,
          ...(isRecord(params.input) ? { input: params.input } : {}),
        }))
        await waitForExtensionCommandSettle(extensionTarget, selector, beforeEventSeq, beforeDefinitionRevision, params, signal)
        if (phase === 'setup') {
          activeScenario = {
            id: scenarioId,
            source: 'extension',
            seed: Number.isSafeInteger(params.seed) ? params.seed as number : 0,
            clock: 'real',
            target: { ...extensionTarget, definitionId },
            ...(isRecord(params.input) ? { input: params.input } : {}),
          }
        } else if (activeScenario?.source === 'extension'
          && activeScenario.id === scenarioId
          && sameExtensionTarget(activeScenario.target, extensionTarget)) {
          activeScenario = undefined
        }
        return { result, scenarioId, phase, revision: stateBridge.snapshot().revision, verificationLevel: 'scenario-verified' }
      }
      if (params.action === 'reset') {
        const window = resolveManagedWindow(options.windowManager, selector)
        await loadRendererTarget(window, rendererPageUrl(window.webContents.getURL(), 'index.html').toString(), {
          timeoutMs: numberOr(params.timeoutMs, UI_TEST_HOST_DEFAULT_WAIT_MS), signal,
        })
        lastSnapshot = rememberSnapshot(await driver.snapshot({ webContentsId: window.webContents.id }))
        return { reset: true, revision: lastSnapshot.revision, verificationLevel: 'scenario-verified' }
      }
      const scenarioId = requiredScenarioId(params.id ?? params.name ?? params.scenario)
      if (APP_SHELL_SCENARIO_IDS.has(scenarioId as never)) {
        const adapter = await ensureAppShellScenarioHost(selector, params)
        const window = resolveManagedWindow(options.windowManager, selector)
        if (isRecord(params.viewport)) {
          driver.resize({ webContentsId: window.webContents.id }, requiredNumber(params.viewport.width, 'viewport.width'), requiredNumber(params.viewport.height, 'viewport.height'))
        }
        const applyRequest = appShellScenarioApplyRequest(params, scenarioId)
        const result = await callAppShellScenarioAdapter(() => adapter.apply(applyRequest)) as { seed?: unknown; revision?: unknown }
        const scenarioState = await callAppShellScenarioAdapter(() => adapter.snapshot()) as { clock?: { mode?: unknown; virtualizedDomains?: unknown }; revision?: unknown }
        const clockMode = scenarioState.clock?.mode === 'frozen' ? 'frozen' : 'real'
        const clockDomains = Array.isArray(scenarioState.clock?.virtualizedDomains) ? scenarioState.clock.virtualizedDomains.filter((value): value is string => typeof value === 'string') : []
        activeScenario = { id: scenarioId, source: 'app-shell', seed: typeof result.seed === 'number' ? result.seed : 0, clock: clockMode, clockDomains, state: scenarioState }
        lastSnapshot = rememberSnapshot(await driver.snapshot({ webContentsId: window.webContents.id }))
        return {
          ...result,
          state: scenarioState,
          revision: Math.max(lastSnapshot.revision, typeof result.revision === 'number' ? result.revision : 0),
          verificationLevel: 'scenario-verified',
          clocks: { application: clockMode, applicationDomains: clockDomains, os: 'not-virtualized', network: 'not-virtualized' },
        }
      }
      const clock = typeof params.clock === 'object' && params.clock !== null ? params.clock as Record<string, unknown> : undefined
      if (clock?.mode === 'frozen') throw new ElectronUiDriverError('UNSUPPORTED', 'Frozen application timers require a registered scenario clock adapter.')
      if (params.fixture !== undefined) throw new ElectronUiDriverError('UNSUPPORTED', 'Arbitrary scenario fixtures are forbidden; use a registered component variant.')
      const window = resolveManagedWindow(options.windowManager, selector)
      if (typeof params.viewport === 'object' && params.viewport !== null) {
        const viewport = params.viewport as Record<string, unknown>
        driver.resize({ webContentsId: window.webContents.id }, requiredNumber(viewport.width, 'viewport.width'), requiredNumber(viewport.height, 'viewport.height'))
      }
      const scenarioUrl = rendererPageUrl(await waitForRendererUrl(window, numberOr(params.timeoutMs, UI_TEST_HOST_DEFAULT_WAIT_MS)), 'playground.html')
      scenarioUrl.searchParams.set('scenario', scenarioId)
      if (typeof params.variant === 'string' && params.variant.length <= 200) scenarioUrl.searchParams.set('variant', params.variant)
      const targetScenarioUrl = scenarioUrl.toString()
      await loadRendererTarget(window, targetScenarioUrl, {
        timeoutMs: numberOr(params.timeoutMs, UI_TEST_HOST_DEFAULT_WAIT_MS), signal,
      })
      const expectedPrefix = `Scenario: ${scenarioId}`
      try {
        lastSnapshot = rememberSnapshot(await driver.waitForSnapshot(
          { webContentsId: window.webContents.id },
          (snapshot) => Object.values(snapshot.regions).flat().some((node) => node.role === 'region' && node.name.startsWith(expectedPrefix)),
          numberOr(params.timeoutMs, UI_TEST_HOST_DEFAULT_WAIT_MS),
        ))
      } catch (error) {
        throw new ElectronUiDriverError('TIMEOUT', `Scenario ${scenarioId} did not become ready.`, { cause: error instanceof Error ? error.message : String(error) })
      }
      activeScenario = {
        id: scenarioId,
        source: 'playground',
        ...(typeof params.variant === 'string' ? { variant: params.variant } : {}),
        seed: Number.isSafeInteger(params.seed) ? params.seed as number : 0,
        clock: clock?.mode === 'frozen' ? 'frozen' : 'real',
      }
      return {
        scenarioId,
        seed: Number.isSafeInteger(params.seed) ? params.seed : 0,
        revision: lastSnapshot.revision,
        verificationLevel: 'scenario-verified',
        reset: false,
        clocks: { application: 'real', os: 'not-virtualized', network: 'not-virtualized' },
      }
    }
    if (command === 'scenario.reset') {
      if (activeScenario && APP_SHELL_SCENARIO_IDS.has(activeScenario.id as never)) {
        const adapter = appShellScenarioAdapter(selector)
        await callAppShellScenarioAdapter(() => adapter.reset())
        const window = resolveManagedWindow(options.windowManager, selector)
        await loadRendererTarget(window, rendererPageUrl(window.webContents.getURL(), 'index.html').toString(), {
          timeoutMs: numberOr(params.timeoutMs, UI_TEST_HOST_DEFAULT_WAIT_MS), signal,
        })
        lastSnapshot = rememberSnapshot(await driver.snapshot({ webContentsId: window.webContents.id }))
        activeScenario = undefined
        return { reset: true, revision: lastSnapshot.revision, verificationLevel: 'scenario-verified' }
      }
      const window = resolveManagedWindow(options.windowManager, selector)
      await loadRendererTarget(window, rendererPageUrl(window.webContents.getURL(), 'index.html').toString(), {
        timeoutMs: numberOr(params.timeoutMs, UI_TEST_HOST_DEFAULT_WAIT_MS), signal,
      })
      lastSnapshot = rememberSnapshot(await driver.snapshot({ webContentsId: window.webContents.id }))
      activeScenario = undefined
      return { reset: true, revision: lastSnapshot.revision, verificationLevel: 'scenario-verified' }
    }
    if (command === 'shutdown' || command === 'stop') {
      closing = true
      setImmediate(() => {
        void close().finally(() => options.shutdown?.())
      })
      return { stopping: true }
    }
    throw new ElectronUiDriverError('UNSUPPORTED', `Unsupported command ${command}.`)
  }

  function extensionAdapter(selector: UiDriverWindowSelector): ElectronExtensionValidationAdapter {
    return new ElectronExtensionValidationAdapter(resolveManagedWindow(options.windowManager, selector).webContents)
  }

  async function settleActionReceipt(
    receipt: Record<string, unknown>,
    params: Record<string, unknown>,
    selector: UiDriverWindowSelector,
    beforeEventSeq: number,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    let explicit: unknown
    const waitRequest = isRecord(params.waitUntil) ? params.waitUntil : isRecord(params.settle) ? params.settle : undefined
    if (waitRequest) explicit = await waitUntil(waitRequest, selector, signal)
    const eventRead = stateBridge.events({ afterSeq: beforeEventSeq })
    const stateChanges = eventRead.events.filter(event => event.type.startsWith('state.'))
    const settledBy = Array.isArray(receipt.settledBy) ? [...receipt.settledBy] : []
    if (waitRequest) settledBy.push('explicit-condition')
    if (stateChanges.some(event => event.type === 'state.route.changed')) settledBy.push('route')
    return {
      ...receipt,
      eventSeqs: eventRead.events.map(event => event.seq),
      stateChanges,
      settledBy: [...new Set(settledBy)],
      ...(explicit === undefined ? {} : { explicit }),
    }
  }

  function appShellScenarioAdapter(selector: UiDriverWindowSelector): ElectronAppShellScenarioAdapter {
    return new ElectronAppShellScenarioAdapter(resolveManagedWindow(options.windowManager, selector).webContents)
  }

  async function ensureAppShellScenarioHost(selector: UiDriverWindowSelector, params: Record<string, unknown>): Promise<ElectronAppShellScenarioAdapter> {
    const window = resolveManagedWindow(options.windowManager, selector)
    let adapter = new ElectronAppShellScenarioAdapter(window.webContents)
    try {
      await adapter.list()
      return adapter
    } catch (error) {
      if (!(error instanceof AppShellScenarioAdapterError) || error.code !== 'NOT_READY') throw error
    }
    const scenarioUrl = rendererPageUrl(await waitForRendererUrl(window, numberOr(params.timeoutMs, UI_TEST_HOST_DEFAULT_WAIT_MS)), 'playground.html')
    scenarioUrl.searchParams.set('scenario', 'app-shell-scenario-host')
    const targetScenarioUrl = scenarioUrl.toString()
    await loadRendererTarget(window, targetScenarioUrl, {
      timeoutMs: numberOr(params.timeoutMs, UI_TEST_HOST_DEFAULT_WAIT_MS),
    })
    await driver.waitForSnapshot(
      { webContentsId: window.webContents.id },
      snapshot => Object.values(snapshot.regions).flat().some(node => node.role === 'region' && node.name.startsWith('Scenario: app-shell-scenario-host')),
      numberOr(params.timeoutMs, UI_TEST_HOST_DEFAULT_WAIT_MS),
    )
    adapter = new ElectronAppShellScenarioAdapter(window.webContents)
    const registered = await callAppShellScenarioAdapter(() => adapter.list()) as Array<{ id?: unknown }>
    if (!Array.isArray(registered) || ![...APP_SHELL_SCENARIO_IDS].every(id => registered.some(item => item?.id === id))) {
      throw new ElectronUiDriverError('NOT_READY', 'AppShell scenario registry did not become ready after playground load.')
    }
    return adapter
  }

  function ensureActiveAppShellScenario(): void {
    if (!activeScenario || !APP_SHELL_SCENARIO_IDS.has(activeScenario.id as never)) throw new ElectronUiDriverError('NOT_READY', 'No AppShell scenario is active.')
  }

  async function waitForExtension(target: ExtensionTarget, selector: UiDriverWindowSelector, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (!target.definitionId) throw new ElectronUiDriverError('TARGET_NOT_FOUND', 'Extension wait target requires definitionId.')
    const adapter = extensionAdapter(selector)
    const current = await callExtensionAdapter(() => adapter.readiness({ ...target, definitionId: target.definitionId! })) as { phase?: unknown }
    const phase = typeof params.phase === 'string' ? params.phase : 'ready'
    if (!['loading', 'busy', 'ready', 'error'].includes(phase)) throw new ElectronUiDriverError('UNSUPPORTED', 'Unsupported extension readiness phase.')
    if (current.phase === phase) return { matched: true, observed: current, elapsedMs: 0, verificationLevel: 'scenario-verified' }
    if (!target.runtimeId) throw new ElectronUiDriverError('AMBIGUOUS_TARGET', 'Extension wait requires runtimeId for event identity.')
    const window = resolveManagedWindow(options.windowManager, selector)
    const timeoutMs = Math.min(numberOr(params.timeoutMs, UI_TEST_HOST_DEFAULT_WAIT_MS), MAX_WAIT_MS)
    const startedAt = Date.now()
    const state = await stateBridge.wait({
      scope: 'extension',
      phase: phase as 'loading' | 'busy' | 'ready' | 'error',
      windowId: String(window.webContents.id),
      entityId: extensionUIValidationEntityId(target.sessionId, target.extensionId, target.runtimeId, target.definitionId),
    }, {
      timeoutMs,
      stableForMs: Math.min(numberOr(params.stableForMs, 0), timeoutMs),
      afterSeq: typeof params.afterSeq === 'number' ? numberOr(params.afterSeq, 0) : stateBridge.events().latestSeq,
      signal,
    })
    const readiness = await callExtensionAdapter(() => adapter.readiness({ ...target, definitionId: target.definitionId! }))
    return { matched: true, observed: readiness, state, elapsedMs: Date.now() - startedAt, verificationLevel: 'scenario-verified' }
  }

  async function waitForExtensionCommandSettle(
    target: ExtensionTarget,
    selector: UiDriverWindowSelector,
    afterSeq: number,
    afterDefinitionRevision: number,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!target.definitionId || !target.runtimeId) {
      throw new ElectronUiDriverError('AMBIGUOUS_TARGET', 'Extension command settle requires runtimeId and definitionId.')
    }
    const window = resolveManagedWindow(options.windowManager, selector)
    const timeoutMs = Math.min(numberOr(params.timeoutMs, UI_TEST_HOST_DEFAULT_WAIT_MS), MAX_WAIT_MS)
    const entityId = extensionUIValidationEntityId(target.sessionId, target.extensionId, target.runtimeId, target.definitionId)
    const matches = (event: { type: string; payload?: unknown }) => {
      const payload = event.payload as { entityId?: unknown; phase?: unknown; detail?: { definitionRevision?: unknown; commandOwnerExtensionId?: unknown } } | undefined
      return event.type === 'state.extension.changed'
        && payload?.phase === 'ready'
        && typeof payload.detail?.definitionRevision === 'number'
        && ((payload.entityId === entityId && payload.detail.definitionRevision > afterDefinitionRevision)
          || payload.detail.commandOwnerExtensionId === target.extensionId)
    }
    const replay = stateBridge.events({ afterSeq })
    if (!replay.events.some(matches)) {
      await stateBridge.registry.events.waitFor(matches, { afterSeq, timeoutMs, signal })
    }
    return await callExtensionAdapter(() => extensionAdapter(selector).readiness({ ...target, definitionId: target.definitionId! }))
  }

  async function currentExtensionDefinitionRevision(target: ExtensionTarget, selector: UiDriverWindowSelector): Promise<number> {
    if (!target.definitionId) throw new ElectronUiDriverError('TARGET_NOT_FOUND', 'Extension target requires definitionId.')
    const definitions = await callExtensionAdapter(() => extensionAdapter(selector).snapshot({
      sessionId: target.sessionId,
      extensionId: target.extensionId,
    })) as Array<{ runtimeId?: unknown; revision?: unknown; definition?: { id?: unknown } }>
    const current = definitions.find(item => item.definition?.id === target.definitionId
      && (target.runtimeId === undefined || item.runtimeId === target.runtimeId))
    if (!current || typeof current.revision !== 'number') throw new ElectronUiDriverError('TARGET_NOT_FOUND', 'Extension validation definition was not found.')
    return current.revision
  }

  async function evaluateCondition(params: Record<string, unknown>, selector: UiDriverWindowSelector): Promise<{ matched: boolean; observed: unknown }> {
    const condition = conditionParams(params)
    const parsed = parseStateCondition(condition, selectedWindowId(options.windowManager, selector, true))
    if (parsed.kind === 'state') {
      const state = stateBridge.registry.find(parsed.predicate)
      return state ? stateObservation(state) : { matched: false, observed: { predicate: parsed.predicate, state: stateBridge.snapshot(selector.webContentsId) } }
    }
    if (parsed.kind === 'event') {
      const afterSeq = numberOr(params.afterSeq, 0)
      const read = stateBridge.events({ afterSeq, types: [parsed.type] })
      return { matched: read.events.length > 0, observed: read }
    }
    const snapshot = await compositeSnapshot(selector)
    rememberSnapshot(snapshot)
    return matchSnapshotCondition(snapshot, condition)
  }

  async function waitUntil(params: Record<string, unknown>, selector: UiDriverWindowSelector, signal?: AbortSignal): Promise<unknown> {
    const timeoutMs = Math.min(numberOr(params.timeoutMs, UI_TEST_HOST_DEFAULT_WAIT_MS), MAX_WAIT_MS)
    const stableForMs = Math.min(numberOr(params.stableForMs, 0), timeoutMs)
    const condition = conditionParams(params)
    const parsed = parseStateCondition(condition, selectedWindowId(options.windowManager, selector, true))
    const startedAt = Date.now()
    if (parsed.kind === 'state') {
      const state = await stateBridge.wait(parsed.predicate, {
        timeoutMs,
        stableForMs,
        ...(typeof params.afterSeq === 'number' ? { afterSeq: numberOr(params.afterSeq, 0) } : {}),
        signal,
      })
      return { ...stateObservation(state), matchedAtSeq: stateBridge.events().latestSeq, revision: state.revision, elapsedMs: Date.now() - startedAt, stableForMs }
    }
    if (parsed.kind === 'event') {
      if (stableForMs > 0) throw new ElectronUiDriverError('UNSUPPORTED', 'stableForMs is not meaningful for one-shot event waits.')
      const afterSeq = typeof params.afterSeq === 'number' ? numberOr(params.afterSeq, 0) : stateBridge.events().latestSeq
      const replay = stateBridge.events({ afterSeq })
      if (replay.droppedBeforeSeq !== undefined) {
        throw new UiValidationError('EVENTS_DROPPED', 'Requested UI validation events are no longer available.', { details: { afterSeq, droppedBeforeSeq: replay.droppedBeforeSeq }, retryable: true })
      }
      const event = replay.events.find(item => item.type === parsed.type)
        ?? await stateBridge.registry.events.waitFor(item => item.type === parsed.type, { afterSeq, timeoutMs, signal })
      return { matched: true, observed: event, matchedAtSeq: event.seq, revision: event.revision, elapsedMs: Date.now() - startedAt }
    }
    if (condition.kind === 'semantic-ready') {
      const webContentsId = selectedWindowId(options.windowManager, selector, true)!
      await stateBridge.wait(semanticReadyAppGate(webContentsId), { timeoutMs, signal })
    }
    const snapshotTimeoutMs = Math.max(1, timeoutMs - (Date.now() - startedAt))
    const initial = await evaluateCondition(params, selector)
    if (initial.matched) {
      if (stableForMs > 0) {
        await delayForStability(stableForMs)
        const stable = await evaluateCondition(params, selector)
        if (stable.matched) return { ...stable, elapsedMs: stableForMs, stableForMs }
      } else {
        return { ...initial, elapsedMs: 0, stableForMs: 0 }
      }
    }
    if (condition.kind === 'text' || condition.kind === 'node' || condition.kind === 'semantic-ready') {
      const conditionTarget = isRecord(condition.target) ? condition.target : undefined
      if (conditionTarget?.kind === 'browser') {
        const deadline = Date.now() + snapshotTimeoutMs
        while (Date.now() < deadline) {
          if (signal?.aborted) throw new ElectronUiDriverError('TIMEOUT', 'BrowserView wait was aborted.')
          const observed = await evaluateCondition(params, selector)
          if (observed.matched) return { ...observed, elapsedMs: Date.now() - startedAt, stableForMs }
          await delayForStability(Math.min(100, Math.max(1, deadline - Date.now())))
        }
        throw new ElectronUiDriverError('TIMEOUT', `BrowserView condition was not met within ${timeoutMs}ms.`)
      }
      const snapshot = await driver.waitForSnapshot(
        selector,
        (candidate) => matchSnapshotCondition(candidate, condition).matched,
        snapshotTimeoutMs,
      ).catch((error) => {
        throw new ElectronUiDriverError('TIMEOUT', `Condition was not met within ${timeoutMs}ms.`, { cause: error instanceof Error ? error.message : String(error) })
      })
      rememberSnapshot(snapshot)
      let observed = matchSnapshotCondition(snapshot, condition)
      if (stableForMs > 0) {
        await delayForStability(stableForMs)
        observed = await evaluateCondition(params, selector)
        if (!observed.matched) throw new ElectronUiDriverError('TIMEOUT', 'Condition did not remain stable for the requested window.')
      }
      return { ...observed, elapsedMs: Date.now() - startedAt, stableForMs }
    }

    const windows = options.windowManager.getAllWindows().map(({ window }) => window)
    if (windows.length === 0) throw new ElectronUiDriverError('NOT_READY', 'No renderer window is available.')

    return await new Promise((resolveWait, rejectWait) => {
      let evaluating = false
      const cleanup = () => {
        clearTimeout(timeout)
        for (const window of windows) {
          window.webContents.removeListener('dom-ready', onChange)
          window.webContents.removeListener('did-stop-loading', onChange)
          window.webContents.removeListener('did-navigate-in-page', onChange)
        }
      }
      const onChange = () => {
        if (evaluating) return
        evaluating = true
        void evaluateCondition(params, selector).then((observed) => {
          if (observed.matched) {
            cleanup()
            resolveWait({ ...observed, elapsedMs: Date.now() - startedAt })
          }
        }).catch((error) => {
          cleanup()
          rejectWait(error)
        }).finally(() => { evaluating = false })
      }
      const timeout = setTimeout(() => {
        cleanup()
        rejectWait(new ElectronUiDriverError('TIMEOUT', `Condition was not met within ${timeoutMs}ms.`))
      }, timeoutMs)
      for (const window of windows) {
        window.webContents.on('dom-ready', onChange)
        window.webContents.on('did-stop-loading', onChange)
        window.webContents.on('did-navigate-in-page', onChange)
      }
    })
  }

  async function waitForRendererSettled(selector: UiDriverWindowSelector, timeoutMs: number): Promise<void> {
    const window = selector.webContentsId !== undefined
      ? options.windowManager.getWindowByWebContentsId(selector.webContentsId)
      : selector.workspaceId
        ? options.windowManager.getWindowByWorkspace(selector.workspaceId)
        : options.windowManager.getAllWindows().length === 1
          ? options.windowManager.getAllWindows()[0]!.window
          : null
    if (!window) throw new ElectronUiDriverError('AMBIGUOUS_TARGET', 'Provide a window selector before opening a route.')
    if (!window.webContents.isLoading()) return
    await new Promise<void>((resolveWait, rejectWait) => {
      const timeout = setTimeout(() => {
        window.webContents.removeListener('did-stop-loading', loaded)
        rejectWait(new ElectronUiDriverError('TIMEOUT', 'Renderer did not settle after route open.'))
      }, Math.min(timeoutMs, MAX_WAIT_MS))
      const loaded = () => {
        clearTimeout(timeout)
        resolveWait()
      }
      window.webContents.once('did-stop-loading', loaded)
    })
  }

  async function captureEvidence(params: Record<string, unknown>, selector: UiDriverWindowSelector): Promise<unknown> {
    const state = stateBridge.snapshot(selectedWindowId(options.windowManager, selector, false))
    const route = state.states.find(item => item.scope === 'route' && item.phase !== 'disposed')?.detail
    let scenarioEvidence = activeScenario ?? null
    if (activeScenario && APP_SHELL_SCENARIO_IDS.has(activeScenario.id as never)) {
      const scenarioState = await callAppShellScenarioAdapter(() => appShellScenarioAdapter(selector).snapshot())
      activeScenario = { ...activeScenario, state: scenarioState }
      scenarioEvidence = activeScenario
    }
    return await evidenceCollector.capture({
      label: typeof params.label === 'string' ? params.label : 'evidence',
      selector,
      ...(typeof params.afterSeq === 'number' ? { afterSeq: numberOr(params.afterSeq, 0) } : {}),
      route,
      scenario: scenarioEvidence,
      seed: activeScenario?.seed,
      verificationLevel: runVerificationLevel,
      clocks: { application: activeScenario?.clock ?? 'real', applicationDomains: activeScenario?.clockDomains ?? [], os: 'not-virtualized', network: 'not-virtualized' },
    })
  }

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => resolveListen())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('UI Test Host did not bind a TCP address.')
  const url = `http://127.0.0.1:${address.port}`
  await atomicWriteJson(manifestPath, {
    protocolVersion: 1,
    runId,
    surface,
    transport: 'http',
    url,
    pid: process.pid,
    readyAt: new Date().toISOString(),
  })

  async function close(): Promise<void> {
    if (!closing) closing = true
    for (const controller of activeWaits) controller.abort('Test Host stopped')
    activeWaits.clear()
    evidenceCollector.dispose()
    backgroundWindows?.dispose()
    driver.dispose()
    if (!server.listening) return
    await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()))
  }

  return { close, url }
}

function conditionParams(params: Record<string, unknown>): Record<string, unknown> {
  return typeof params.predicate === 'object' && params.predicate !== null && !Array.isArray(params.predicate)
    ? params.predicate as Record<string, unknown>
    : params
}

function incrementalSnapshot(previous: UiDriverSnapshot, current: UiDriverSnapshot): Record<string, unknown> {
  const flatten = (snapshot: UiDriverSnapshot) => new Map(
    [
      ...Object.entries(snapshot.regions).flatMap(([region, nodes]) => nodes.map((node) => [`renderer:${stableNodeId(node.ref)}`, { region, node }] as const)),
      ...(snapshot.embeddedSurfaces ?? []).flatMap(surface => surface.nodes.map(node => [
        `${surface.surfaceId}:${stableNodeId(node.ref)}`,
        { region: `embedded:${surface.surfaceId}`, node },
      ] as const)),
    ],
  )
  const before = flatten(previous)
  const after = flatten(current)
  const added: Array<Record<string, unknown>> = []
  const updated: Array<Record<string, unknown>> = []
  const removed: Array<{ nodeId: string; ref: string }> = []
  for (const [nodeId, value] of after) {
    const old = before.get(nodeId)
    if (!old) added.push({ region: value.region, ...value.node })
    else if (JSON.stringify({ ...old.node, ref: undefined, region: old.region }) !== JSON.stringify({ ...value.node, ref: undefined, region: value.region })) {
      updated.push({ region: value.region, ...value.node })
    }
  }
  for (const [nodeId, value] of before) {
    if (!after.has(nodeId)) removed.push({ nodeId, ref: value.node.ref })
  }
  return {
    sinceRevision: previous.revision,
    revision: current.revision,
    full: false,
    window: current.window,
    changes: { added, updated, removed },
  }
}

function stableNodeId(ref: string): string {
  const separator = ref.indexOf(':')
  return separator === -1 ? ref : ref.slice(separator + 1)
}

function matchSnapshotCondition(snapshot: UiDriverSnapshot, condition: Record<string, unknown>): { matched: boolean; observed: unknown } {
  const rendererNodes = Object.values(snapshot.regions).flat()
  const embeddedNodes = (snapshot.embeddedSurfaces ?? []).flatMap(surface => surface.nodes)
  const nodes = [...rendererNodes, ...embeddedNodes]
  if (condition.kind === 'text') {
    const expected = requiredString(condition.value, 'value')
    const exact = condition.exact === true
    const matches = nodes.filter((node) => exact ? node.name === expected : node.name.includes(expected))
    return { matched: matches.length > 0, observed: { count: matches.length, refs: matches.slice(0, 10).map((node) => node.ref) } }
  }
  if (condition.kind === 'semantic-ready') {
    return { matched: nodes.length > 0, observed: { nodeCount: nodes.length, revision: snapshot.revision } }
  }
  if (condition.kind === 'node') {
    const target = typeof condition.target === 'object' && condition.target !== null
      ? condition.target as Record<string, unknown>
      : condition
    const targetNodes = target.kind === 'browser'
      ? (snapshot.embeddedSurfaces ?? [])
          .filter(surface => surface.instanceId === target.instanceId)
          .flatMap(surface => surface.nodes)
      : rendererNodes
    const role = typeof target.role === 'string' ? target.role : undefined
    const name = typeof target.name === 'string' ? target.name : undefined
    const ref = typeof target.ref === 'string' ? target.ref : undefined
    const semanticId = typeof target.semanticId === 'string' ? target.semanticId : undefined
    const testId = typeof target.testId === 'string' ? target.testId : undefined
    const exact = typeof target.exact === 'boolean' ? target.exact : undefined
    const matches = findRendererSnapshotTargets(targetNodes, { role, name, ref, semanticId, testId, exact })
    if (matches.length > 1) {
      throw new ElectronUiDriverError('AMBIGUOUS_TARGET', 'The renderer target matched more than one node.', {
        count: matches.length,
        refs: matches.slice(0, 10).map(node => node.ref),
      })
    }
    const state = typeof condition.state === 'string' ? condition.state : undefined
    const expectedState = condition.equals === undefined ? true : condition.equals
    const stateMatches = state
      ? matches.filter((node) => (node.state as Record<string, unknown>)[state] === expectedState)
      : matches
    return { matched: stateMatches.length === 1, observed: { count: stateMatches.length, refs: stateMatches.slice(0, 10).map((node) => node.ref) } }
  }
  throw new ElectronUiDriverError('UNSUPPORTED', 'Unsupported wait/assert condition.')
}

async function delayForStability(durationMs: number): Promise<void> {
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, durationMs))
}

function verificationLevel(command: string): UiVerificationLevel {
  if (command === 'native') return 'native-verified'
  if (command === 'action' || command === 'browser-key') return 'renderer-verified'
  return 'scenario-verified'
}

function resultVerificationLevel(command: string, result: unknown): UiVerificationLevel {
  if (typeof result === 'object' && result !== null) {
    const level = (result as { verificationLevel?: unknown }).verificationLevel
    if (level === 'scenario-verified' || level === 'renderer-verified' || level === 'native-verified') return level
  }
  return verificationLevel(command)
}

function normalizeMethod(method: string): string {
  const aliases: Record<string, string> = {
    'app.status': 'status',
    'app.shutdown': 'shutdown',
    'app.open': 'open',
    'ui.capabilities': 'capabilities',
    'scenario.apply': 'scenario',
    'ui.windows': 'windows',
    'ui.window': 'window',
    'ui.snapshot': 'snapshot',
    'ui.action': 'action',
    'ui.browserKey': 'browser-key',
    'ui.native': 'native',
    'ui.wait': 'wait',
    'ui.screenshot': 'screenshot',
    'ui.logs': 'logs',
    'ui.resize': 'resize',
    'ui.assert': 'assert',
    'evidence.capture': 'evidence',
  }
  return aliases[method] ?? method
}

function parseSelector(params: Record<string, unknown>): UiDriverWindowSelector {
  return {
    ...(typeof params.webContentsId === 'number' ? { webContentsId: params.webContentsId } : {}),
    ...(typeof params.workspaceId === 'string' ? { workspaceId: params.workspaceId } : {}),
    ...(params.role !== undefined ? { role: requiredWindowRole(params.role) } : {}),
  }
}

function requiredWindowRole(value: unknown): ManagedWindowRole {
  if (value === 'main' || value === 'child-session' || value === 'auxiliary') return value
  throw new ElectronUiDriverError('UNSUPPORTED', 'Window role must be main, child-session, or auxiliary.')
}

function parseExtensionTarget(params: Record<string, unknown>): ExtensionTarget | undefined {
  const target = isRecord(params.target) ? params.target : undefined
  if (target?.kind !== 'extension') return undefined
  return {
    kind: 'extension',
    sessionId: requiredString(target.sessionId, 'target.sessionId'),
    extensionId: requiredString(target.extensionId, 'target.extensionId'),
    ...(typeof target.runtimeId === 'string' ? { runtimeId: requiredString(target.runtimeId, 'target.runtimeId') } : {}),
    ...(typeof target.definitionId === 'string' ? { definitionId: requiredString(target.definitionId, 'target.definitionId') } : {}),
  }
}

function sameExtensionTarget(left: ExtensionTarget | undefined, right: ExtensionTarget): boolean {
  return left?.sessionId === right.sessionId
    && left.extensionId === right.extensionId
    && left.runtimeId === right.runtimeId
    && left.definitionId === right.definitionId
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function callExtensionAdapter<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (error) {
    if (error instanceof ExtensionValidationAdapterError) {
      const supported = ['NOT_READY', 'TARGET_NOT_FOUND', 'AMBIGUOUS_TARGET', 'DISABLED', 'UNSUPPORTED', 'TIMEOUT', 'WINDOW_GONE', 'DRIVER_DISCONNECTED'] as const
      const code = supported.includes(error.code as typeof supported[number]) ? error.code as typeof supported[number] : 'UNSUPPORTED'
      throw new ElectronUiDriverError(code, error.message)
    }
    throw error
  }
}

async function callAppShellScenarioAdapter<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (error) {
    if (error instanceof AppShellScenarioAdapterError) {
      const protocolCodes = ['INVALID_REQUEST', 'SCENARIO_INVALID', 'FAULT_INVALID'] as const
      if (protocolCodes.includes(error.code as typeof protocolCodes[number])) {
        throw new UiValidationError(error.code as typeof protocolCodes[number], error.message)
      }
      const driverCodes = ['NOT_READY', 'TARGET_NOT_FOUND', 'AMBIGUOUS_TARGET', 'DISABLED', 'UNSUPPORTED', 'TIMEOUT', 'WINDOW_GONE', 'DRIVER_DISCONNECTED'] as const
      const code = driverCodes.includes(error.code as typeof driverCodes[number]) ? error.code as typeof driverCodes[number] : 'UNSUPPORTED'
      throw new ElectronUiDriverError(code, error.message)
    }
    throw error
  }
}

function snapshotRevision(value: unknown): number {
  return typeof value === 'object' && value !== null && typeof (value as { revision?: unknown }).revision === 'number'
    ? (value as { revision: number }).revision
    : 0
}

function requiredAction(value: unknown): 'click' | 'fill' | 'select' | 'press' | 'drag' | 'shortcut' | 'clipboard' | 'ime' | 'rich-text' {
  if (value === 'click' || value === 'fill' || value === 'select' || value === 'press' || value === 'drag' || value === 'shortcut' || value === 'clipboard' || value === 'ime' || value === 'rich-text') return value
  throw new ElectronUiDriverError('UNSUPPORTED', 'Unsupported renderer action.')
}

function requiredNativeAction(value: unknown): 'click' | 'fill' | 'select' | 'focus' | 'minimize' | 'maximize' | 'restore' | 'close' {
  if (value === 'click' || value === 'fill' || value === 'select' || value === 'focus' || value === 'minimize' || value === 'maximize' || value === 'restore' || value === 'close') return value
  throw new ElectronUiDriverError('UNSUPPORTED', 'Unsupported native action.')
}

function requiredScenarioId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value)) {
    throw new ElectronUiDriverError('UNSUPPORTED', 'Scenario id must be a registered-style bounded identifier.')
  }
  return value
}

function requiredNativeDialogKind(value: unknown): NativeDialogKind {
  if (value === 'open-file' || value === 'open-directory' || value === 'save-file') return value
  throw new ElectronUiDriverError('UNSUPPORTED', 'Native dialog kind must be open-file, open-directory, or save-file.')
}


function resolveManagedWindow(windowManager: WindowManager, selector: UiDriverWindowSelector) {
  if (selector.webContentsId !== undefined) {
    const window = windowManager.getWindowByWebContentsId(selector.webContentsId)
    if (!window || window.isDestroyed()) throw new ElectronUiDriverError('WINDOW_GONE', 'Renderer window no longer exists.')
    const managed = windowManager.getAllWindows().find(entry => entry.window.webContents.id === selector.webContentsId)
    if (!managed) throw new ElectronUiDriverError('WINDOW_GONE', 'Renderer window is not managed.')
    if ((selector.workspaceId !== undefined && managed.workspaceId !== selector.workspaceId)
      || (selector.role !== undefined && managed.role !== selector.role)) {
      throw new ElectronUiDriverError('TARGET_NOT_FOUND', 'Renderer window does not match the requested workspace and role.')
    }
    return window
  }
  const windows = windowManager.getAllWindows().filter(entry =>
    (selector.workspaceId === undefined || entry.workspaceId === selector.workspaceId)
    && (selector.role === undefined || entry.role === selector.role),
  )
  if (windows.length === 0) throw new ElectronUiDriverError('NOT_READY', 'No renderer window is ready for the requested role and workspace.')
  if (windows.length !== 1) throw new ElectronUiDriverError('AMBIGUOUS_TARGET', 'Provide webContentsId when multiple windows match the requested role and workspace.')
  return windows[0]!.window
}

function selectedWindowId(windowManager: WindowManager, selector: UiDriverWindowSelector, required: boolean): number | undefined {
  if (selector.webContentsId !== undefined) return resolveManagedWindow(windowManager, selector).webContents.id
  if (selector.workspaceId !== undefined) return resolveManagedWindow(windowManager, selector).webContents.id
  if (selector.role !== undefined) return resolveManagedWindow(windowManager, selector).webContents.id
  const windows = windowManager.getAllWindows()
  if (windows.length === 1) return windows[0]!.window.webContents.id
  if (!required) return undefined
  if (windows.length === 0) throw new ElectronUiDriverError('NOT_READY', 'No renderer window is ready.')
  throw new ElectronUiDriverError('AMBIGUOUS_TARGET', 'Provide webContentsId when multiple windows exist.')
}

async function waitForRendererUrl(window: ReturnType<WindowManager['getWindowByWebContentsId']> & object, timeoutMs: number): Promise<string> {
  const current = window.webContents.getURL()
  if (current) return current
  return await new Promise<string>((resolveUrl, rejectUrl) => {
    const loaded = () => {
      const url = window.webContents.getURL()
      if (!url) return
      cleanup()
      resolveUrl(url)
    }
    const cleanup = () => {
      clearTimeout(timeout)
      window.webContents.removeListener('did-finish-load', loaded)
    }
    const timeout = setTimeout(() => {
      cleanup()
      rejectUrl(new ElectronUiDriverError('NOT_READY', 'Renderer URL was not ready before the scenario timeout.'))
    }, Math.min(timeoutMs, MAX_WAIT_MS))
    window.webContents.on('did-finish-load', loaded)
    loaded()
  })
}

function isPoint(value: unknown): value is { x: number; y: number } {
  return typeof value === 'object' && value !== null && typeof (value as { x?: unknown }).x === 'number' && typeof (value as { y?: unknown }).y === 'number'
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 10_000) throw new ElectronUiDriverError('UNSUPPORTED', `${name} must be a bounded non-empty string.`)
  return value
}

function requiredNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ElectronUiDriverError('UNSUPPORTED', `${name} must be a finite number.`)
  return value
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

function boundedArtifactLabel(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value.length === 0) return fallback
  return value.slice(0, 80).replace(/[^A-Za-z0-9._-]/g, '_') || fallback
}

function boundedLogBytes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return 256_000
  return Math.max(1_024, Math.min(value, 1_000_000))
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required when CRAFT_UI_TEST_HOST=1.`)
  return value
}

function authorized(value: string | undefined, token: string): boolean {
  if (!value?.startsWith('Bearer ')) return false
  const supplied = Buffer.from(value.slice(7))
  const expected = Buffer.from(token)
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

async function readCommand(request: IncomingMessage): Promise<CommandRequest> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_REQUEST_BYTES) throw new Error('Request body exceeds maximum size.')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as CommandRequest
}

function validateCommand(body: CommandRequest, runId: string): void {
  if (!body || body.v !== 1 || body.kind !== 'request') throw new Error('Unsupported protocol envelope.')
  if (body.runId !== runId) throw new Error('runId does not match this Test Host.')
  if (typeof body.id !== 'string' || body.id.length < 8 || body.id.length > 128) throw new Error('Invalid request id.')
  if (body.requestId === undefined) body.requestId = body.id
  if (body.requestId !== body.id) throw new Error('requestId and id must match.')
  if (typeof body.method !== 'string' || body.method.length === 0 || body.method.length > 100) throw new Error('Invalid method.')
  if (body.params !== undefined && (typeof body.params !== 'object' || body.params === null || Array.isArray(body.params))) throw new Error('params must be an object.')
}

function failureEnvelope(
  requestId: string,
  runId: string,
  seq: number,
  revision: number,
  verificationLevel: UiVerificationLevel,
  error: unknown,
  additionalDetails?: Record<string, unknown>,
): Record<string, unknown> {
  const knownDriver = error instanceof ElectronUiDriverError
  const knownProtocol = error instanceof UiValidationError
  const known = knownDriver || knownProtocol
  return {
    v: 1,
    kind: 'response',
    id: requestId,
    requestId,
    runId,
    seq,
    revision,
    verificationLevel,
    ok: false,
    error: {
      code: known ? error.code : 'UNSUPPORTED',
      message: error instanceof Error ? error.message : String(error),
      ...((known && error.details) || additionalDetails ? { details: { ...(known ? error.details : {}), ...additionalDetails } } : {}),
      ...(knownProtocol && error.retryable ? { retryable: true } : {}),
    },
  }
}

function boundedPush(target: Array<Record<string, unknown>>, entry: Record<string, unknown>): void {
  target.push(entry)
  if (target.length > 1_000) target.splice(0, target.length - 1_000)
}

function sanitizeArtifactPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128) || 'browser-view'
}

function requiredBrowserViewAction(value: string): 'click' | 'fill' | 'select' {
  if (value === 'click' || value === 'fill' || value === 'select') return value
  throw new ElectronUiDriverError('UNSUPPORTED', `Unsupported BrowserView action: ${value}`)
}

function redactDiagnosticText(value: string, maxLength = 10_000): string {
  return value
    .replace(/([?&](?:token|key|secret|password|credential|auth)[^=]*)=[^&#\s]*/gi, '$1=[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .slice(0, maxLength)
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const data = Buffer.from(JSON.stringify(value))
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(data.length),
    'Cache-Control': 'no-store',
  })
  response.end(data)
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, path)
}
