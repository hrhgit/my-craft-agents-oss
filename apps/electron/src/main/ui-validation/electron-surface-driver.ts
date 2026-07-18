import { clipboard, type BrowserWindow } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { UI_VALIDATION_DEFAULT_TIMEOUT_MS } from '@craft-agent/shared/ui-validation'
import type { AccessibilityNode, UiBusinessSemanticSnapshot } from '../browser-cdp'
import { UiValidationBrowserCDP } from './browser-cdp-driver'
import { captureRendererDriverDiagnosticFallback } from './main-process-diagnostics'
import type { ManagedWindow, ManagedWindowRole, WindowManager } from '../window-manager'
import { ElectronUiDriverError } from './electron-ui-driver-error'
import type { BrowserViewSurfaceSnapshot } from './browser-view-surface-adapter'

export { ElectronUiDriverError } from './electron-ui-driver-error'

export type UiVerificationLevel = 'scenario-verified' | 'renderer-verified' | 'native-verified'

export interface UiDriverWindowSelector {
  webContentsId?: number
  workspaceId?: string
  role?: ManagedWindowRole
}

export interface UiDriverSnapshotNode {
  ref: string
  semanticId?: string
  testId?: string
  role: string
  name: string
  value?: string
  description?: string
  state: {
    focused?: boolean
    checked?: boolean
    disabled?: boolean
  }
  bounds?: { x: number; y: number; width: number; height: number }
  hit?: boolean
  obscuredBy?: string
  actions: Array<'click' | 'fill' | 'select' | 'press' | 'drag' | 'shortcut' | 'clipboard' | 'ime' | 'rich-text'>
  actionModes?: {
    semantic: Array<'click' | 'fill' | 'select' | 'press' | 'drag' | 'shortcut' | 'clipboard' | 'ime' | 'rich-text'>
    physical: Array<'click' | 'fill' | 'select' | 'press' | 'drag' | 'shortcut' | 'clipboard' | 'ime' | 'rich-text'>
  }
}

export interface UiDriverSnapshot {
  revision: number
  window: {
    webContentsId: number
    workspaceId: string | null
    role: ManagedWindowRole
    sessionId?: string
    parentWebContentsId?: number
    title: string
    url: string
    bounds: { x: number; y: number; width: number; height: number }
  }
  regions: {
    navigation: UiDriverSnapshotNode[]
    sidebar: UiDriverSnapshotNode[]
    main: UiDriverSnapshotNode[]
    dialog: UiDriverSnapshotNode[]
    notification: UiDriverSnapshotNode[]
  }
  truncated: boolean
  embeddedSurfaces?: BrowserViewSurfaceSnapshot[]
}

export interface UiDriverActionRequest {
  revision: number
  ref: string
  action: 'click' | 'fill' | 'select' | 'press' | 'drag' | 'shortcut' | 'clipboard' | 'ime' | 'rich-text'
  mode?: 'semantic' | 'physical'
  value?: string
  key?: string
  modifiers?: Array<'shift' | 'control' | 'alt' | 'meta'>
  to?: { x: number; y: number }
}

export interface UiDriverActionReceipt {
  actionId: string
  verificationLevel: UiVerificationLevel
  beforeRevision: number
  afterRevision: number
  targetResolved: Pick<UiDriverSnapshotNode, 'ref' | 'role' | 'name'>
  settledBy: string[]
  warnings: string[]
  mode: 'semantic' | 'physical'
  observed?: { focused?: boolean; hit?: boolean; obscuredBy?: string }
}

interface DriverWindowState {
  cdp: UiValidationBrowserCDP
  revision: number
  fingerprint?: string
  business?: UiBusinessSemanticSnapshot | null
  refs: Map<string, { cdpRef?: string; semanticId?: string; selector?: string; node: UiDriverSnapshotNode }>
}

const MAX_SNAPSHOT_NODES = 500
const DIALOG_ROLES = new Set(['dialog', 'alertdialog'])
const NOTIFICATION_ROLES = new Set(['alert', 'status'])
const NAVIGATION_ROLES = new Set(['navigation', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio'])
const SIDEBAR_ROLES = new Set(['complementary', 'tree', 'treeitem'])
const SENSITIVE_FIELD_PATTERN = /password|passcode|secret|token|api\s*key|credential|authorization|private\s*key/i
const DRIVER_ACTIONS = new Set<UiDriverSnapshotNode['actions'][number]>(['click', 'fill', 'select', 'press', 'drag', 'shortcut', 'clipboard', 'ime', 'rich-text'])

function snapshotValue(node: AccessibilityNode): string | undefined {
  if (node.value === undefined) return undefined
  const semanticLabel = `${node.name} ${node.description ?? ''}`
  if (SENSITIVE_FIELD_PATTERN.test(semanticLabel)) return '[REDACTED]'
  return node.value.slice(0, 2_000)
}

function actionsFor(node: AccessibilityNode): UiDriverSnapshotNode['actions'] {
  if (node.disabled) return []
  switch (node.role) {
    case 'textbox':
    case 'searchbox':
      return ['click', 'fill', 'press']
    case 'combobox':
    case 'listbox':
      return ['click', 'select', 'press']
    case 'button':
    case 'link':
    case 'checkbox':
    case 'radio':
    case 'switch':
    case 'tab':
    case 'menuitem':
    case 'menuitemcheckbox':
    case 'menuitemradio':
    case 'option':
    case 'treeitem':
      return ['click', 'press']
    case 'row':
    case 'listitem':
      return ['click']
    default:
      return ['click']
  }
}

function toInputModifiers(modifiers: UiDriverActionRequest['modifiers']): Array<'shift' | 'control' | 'alt' | 'meta'> {
  return modifiers ? [...modifiers] : []
}

export class ElectronUiSurfaceDriver {
  private readonly states = new Map<number, DriverWindowState>()
  private disposed = false

  constructor(private readonly windowManager: WindowManager) {}

  ready(): { ready: boolean; windowCount: number } {
    const windows = this.windowManager.getAllWindows()
    return { ready: !this.disposed && windows.length > 0, windowCount: windows.length }
  }

  windows(): Array<{
    webContentsId: number
    workspaceId: string | null
    role: ManagedWindowRole
    sessionId?: string
    parentWebContentsId?: number
    title: string
    focused: boolean
    visible: boolean
  }> {
    this.ensureConnected()
    return this.windowManager.getAllWindows().map(({ window, workspaceId, role, sessionId, parentWebContentsId }) => ({
      webContentsId: window.webContents.id,
      workspaceId: workspaceId ?? null,
      role,
      ...(sessionId ? { sessionId } : {}),
      ...(parentWebContentsId != null ? { parentWebContentsId } : {}),
      title: window.getTitle(),
      focused: window.isFocused(),
      visible: window.isVisible(),
    }))
  }

  async snapshot(selector: UiDriverWindowSelector = {}): Promise<UiDriverSnapshot> {
    const window = this.resolveWindow(selector)
    const state = this.stateFor(window)
    try {
      const ax = await state.cdp.getAccessibilitySnapshot()
      state.business = await state.cdp.getUiBusinessSemanticSnapshot()
      return this.materializeSnapshot(window, state, ax, state.business)
    } catch (error) {
      throw await rendererDriverDisconnected(error)
    }
  }

  async waitForSnapshot(
    selector: UiDriverWindowSelector,
    predicate: (snapshot: UiDriverSnapshot) => boolean,
    timeoutMs = UI_VALIDATION_DEFAULT_TIMEOUT_MS,
  ): Promise<UiDriverSnapshot> {
    const window = this.resolveWindow(selector)
    const state = this.stateFor(window)
    let current = await this.snapshot({ webContentsId: window.webContents.id })
    if (predicate(current)) return current
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now()
      const baselineBusinessRevision = state.business?.revision ?? -1
      const controller = new AbortController()
      let axMaterialized: UiDriverSnapshot | undefined
      const axWait = state.cdp.waitForAccessibilitySnapshot((ax) => {
        axMaterialized = this.materializeSnapshot(window, state, ax, state.business)
        return predicate(axMaterialized)
      }, { timeoutMs: remaining, signal: controller.signal }).then(() => axMaterialized!)
      const businessWait = state.cdp.waitForUiBusinessSemanticSnapshot(
        snapshot => (snapshot?.revision ?? -1) > baselineBusinessRevision,
        { timeoutMs: remaining, signal: controller.signal },
      ).then(async business => {
        state.business = business
        const ax = await state.cdp.getAccessibilitySnapshot()
        return this.materializeSnapshot(window, state, ax, business)
      })
      try {
        current = await Promise.race([axWait, businessWait])
      } catch (error) {
        if (Date.now() >= deadline) break
        throw error
      } finally {
        controller.abort()
      }
      if (predicate(current)) return current
    }
    throw new ElectronUiDriverError('TIMEOUT', 'Semantic snapshot did not become ready.')
  }

  private materializeSnapshot(window: BrowserWindow, state: DriverWindowState, ax: Awaited<ReturnType<UiValidationBrowserCDP['getAccessibilitySnapshot']>>, business: UiBusinessSemanticSnapshot | null | undefined): UiDriverSnapshot {
    const fingerprint = JSON.stringify({ ax: ax.nodes.map((node) => [
      node.ref, node.role, node.name, node.value, node.description,
      node.focused ?? false, node.checked ?? false, node.disabled ?? false,
    ]), business })
    if (state.fingerprint !== fingerprint) {
      state.fingerprint = fingerprint
      state.revision += 1
    }
    state.refs.clear()

    const regions: UiDriverSnapshot['regions'] = {
      navigation: [],
      sidebar: [],
      main: [],
      dialog: [],
      notification: [],
    }

    let count = 0
    const businessRoleNames = new Set<string>()
    for (const semantic of business?.nodes ?? []) {
      if (count >= MAX_SNAPSHOT_NODES) break
      const semanticActions = (semantic.actionModes?.semantic ?? semantic.actions)
        .filter((action): action is UiDriverSnapshotNode['actions'][number] => DRIVER_ACTIONS.has(action as UiDriverSnapshotNode['actions'][number]))
      const physicalActions = (semantic.actionModes?.physical ?? [])
        .filter((action): action is UiDriverSnapshotNode['actions'][number] => DRIVER_ACTIONS.has(action as UiDriverSnapshotNode['actions'][number]))
      const node: UiDriverSnapshotNode = {
        ref: `r${state.revision}:business.${semantic.id.replace(/[^A-Za-z0-9._-]/g, '_')}`,
        semanticId: semantic.id,
        ...(semantic.testId ? { testId: semantic.testId } : {}),
        role: semantic.role,
        name: semantic.name.slice(0, 500),
        ...(semantic.value !== undefined ? { value: semantic.value } : {}),
        ...(semantic.description ? { description: semantic.description.slice(0, 500) } : {}),
        state: {
          ...(semantic.state?.focused === true ? { focused: true } : {}),
          ...(semantic.state?.checked === true ? { checked: true } : {}),
          ...(semantic.state?.disabled === true ? { disabled: true } : {}),
        },
        ...(semantic.bounds ? { bounds: semantic.bounds } : {}),
        ...(typeof semantic.hit === 'boolean' ? { hit: semantic.hit } : {}),
        ...(semantic.obscuredBy ? { obscuredBy: semantic.obscuredBy.slice(0, 200) } : {}),
        actions: semantic.state?.disabled === true ? [] : [...new Set([...semanticActions, ...physicalActions])],
        actionModes: semantic.state?.disabled === true
          ? { semantic: [], physical: [] }
          : { semantic: semanticActions, physical: physicalActions },
      }
      state.refs.set(node.ref, { semanticId: semantic.id, selector: semantic.domSelector, node })
      businessRoleNames.add(`${semantic.role}\0${semantic.name}`)
      addToRegion(regions, node)
      count += 1
    }

    for (const axNode of ax.nodes) {
      if (count >= MAX_SNAPSHOT_NODES) break
      if (businessRoleNames.has(`${axNode.role}\0${axNode.name}`)) continue
      const value = snapshotValue(axNode)
      const node: UiDriverSnapshotNode = {
        ref: `r${state.revision}:${axNode.ref.slice(1)}`,
        role: axNode.role,
        name: axNode.name.slice(0, 500),
        ...(value !== undefined ? { value } : {}),
        ...(axNode.description ? { description: axNode.description.slice(0, 500) } : {}),
        state: {
          ...(axNode.focused ? { focused: true } : {}),
          ...(axNode.checked ? { checked: true } : {}),
          ...(axNode.disabled ? { disabled: true } : {}),
        },
        ...(axNode.bounds ? { bounds: axNode.bounds } : {}),
        ...(typeof axNode.hit === 'boolean' ? { hit: axNode.hit } : {}),
        ...(axNode.obscuredBy ? { obscuredBy: axNode.obscuredBy.slice(0, 200) } : {}),
        actions: actionsFor(axNode),
      }
      state.refs.set(node.ref, { cdpRef: axNode.ref, node })

      addToRegion(regions, node)
      count += 1
    }

    return {
      revision: state.revision,
      window: {
        webContentsId: window.webContents.id,
        workspaceId: this.windowManager.getWorkspaceForWindow(window.webContents.id),
        ...this.windowIdentity(window),
        title: ax.title,
        url: redactUrl(ax.url),
        bounds: window.getBounds(),
      },
      regions,
      truncated: ax.nodes.length + (business?.nodes.length ?? 0) > count || business?.truncated === true,
    }
  }

  async action(selector: UiDriverWindowSelector, request: UiDriverActionRequest): Promise<UiDriverActionReceipt> {
    const window = this.resolveWindow(selector)
    const boundSelector = { ...selector, webContentsId: window.webContents.id }
    const state = this.stateFor(window)
    // Refresh the live AX tree before trusting a revision-bound ref. A renderer
    // mutation between snapshot and action must invalidate the old ref even if
    // the caller did not explicitly request another snapshot.
    await this.snapshot(boundSelector)
    if (request.revision !== state.revision) {
      throw new ElectronUiDriverError('STALE_REF', `Ref belongs to revision ${request.revision}; current revision is ${state.revision}.`, {
        requestedRevision: request.revision,
        currentRevision: state.revision,
      })
    }
    const refRevision = /^r(\d+):/.exec(request.ref)?.[1]
    if (refRevision === undefined || Number(refRevision) !== state.revision) {
      throw new ElectronUiDriverError('STALE_REF', `Target ref ${request.ref} does not belong to revision ${state.revision}.`, {
        ref: request.ref,
        currentRevision: state.revision,
      })
    }
    const resolved = state.refs.get(request.ref)
    if (!resolved) throw new ElectronUiDriverError('TARGET_NOT_FOUND', `Unknown target ref ${request.ref}.`)
    if (resolved.node.state.disabled) throw new ElectronUiDriverError('DISABLED', `Target ${request.ref} is disabled.`)
    if (!resolved.node.actions.includes(request.action)) {
      throw new ElectronUiDriverError('UNSUPPORTED', `${request.action} is not valid for ${resolved.node.role}.`)
    }

    const beforeRevision = state.revision
    const mode = request.mode ?? 'physical'
    if (resolved.node.actionModes && !resolved.node.actionModes[mode].includes(request.action)) {
      throw new ElectronUiDriverError('UNSUPPORTED', `${request.action} is not declared for ${mode} operation on this component.`)
    }
    let interaction: { focused?: boolean; hit?: boolean; obscuredBy?: string } | undefined
    if (mode === 'semantic') {
      if (!resolved.semanticId) throw new ElectronUiDriverError('UNSUPPORTED', 'This target has no command-backed business semantic action.')
      try {
        await state.cdp.invokeUiBusinessSemanticAction({ id: resolved.semanticId, action: request.action, ...(request.value === undefined ? {} : { value: request.value }) })
      } catch (error) {
        throw new ElectronUiDriverError('UNSUPPORTED', error instanceof Error ? error.message : String(error))
      }
    } else {
      if (resolved.selector) {
        const check = await state.cdp.inspectSemanticSelector(resolved.selector)
        if (check.count !== 1) throw new ElectronUiDriverError(check.count === 0 ? 'TARGET_NOT_FOUND' : 'AMBIGUOUS_TARGET', 'Stable semantic selector no longer resolves uniquely.', { selector: resolved.selector, count: check.count })
        if (!check.visible) throw new ElectronUiDriverError('TARGET_NOT_FOUND', 'Target is not visible in the viewport.', { selector: resolved.selector })
        if (!check.hit) throw new ElectronUiDriverError('TARGET_NOT_FOUND', 'Target is obscured at its interaction point.', { selector: resolved.selector, obscuredBy: check.obscuredBy })
        interaction = { focused: check.focused, hit: check.hit, ...(check.obscuredBy ? { obscuredBy: check.obscuredBy } : {}) }
        resolved.cdpRef = await state.cdp.resolveSemanticSelectorRef(resolved.selector)
      }
      if (!resolved.cdpRef) throw new ElectronUiDriverError('TARGET_NOT_FOUND', 'Target no longer has a physical renderer node.')
    if (request.action === 'click') {
      await state.cdp.clickElement(resolved.cdpRef)
    } else if (request.action === 'fill') {
      if (request.value === undefined) throw new ElectronUiDriverError('UNSUPPORTED', 'fill requires value.')
      await state.cdp.fillElement(resolved.cdpRef, request.value)
    } else if (request.action === 'select') {
      if (request.value === undefined) throw new ElectronUiDriverError('UNSUPPORTED', 'select requires value.')
      await state.cdp.selectOption(resolved.cdpRef, request.value)
    } else if (request.action === 'drag') {
      if (!request.to) throw new ElectronUiDriverError('UNSUPPORTED', 'drag requires destination coordinates.')
      const geometry = await state.cdp.getElementGeometry(resolved.cdpRef)
      await state.cdp.drag(geometry.clickPoint.x, geometry.clickPoint.y, request.to.x, request.to.y)
    } else if (request.action === 'clipboard') {
      if (request.value === undefined) throw new ElectronUiDriverError('UNSUPPORTED', 'clipboard requires value.')
      const priorClipboard = clipboard.readText()
      try {
        clipboard.writeText(request.value)
        await state.cdp.clickElement(resolved.cdpRef)
        window.webContents.paste()
      } finally {
        clipboard.writeText(priorClipboard)
      }
    } else if (request.action === 'ime') {
      if (request.value === undefined) throw new ElectronUiDriverError('UNSUPPORTED', 'ime requires value.')
      await state.cdp.composeTextElement(resolved.cdpRef, request.value)
    } else if (request.action === 'rich-text') {
      if (request.value === undefined) throw new ElectronUiDriverError('UNSUPPORTED', 'rich-text requires value.')
      await state.cdp.replaceTextElement(resolved.cdpRef, request.value)
    } else {
      if (!request.key) throw new ElectronUiDriverError('UNSUPPORTED', 'press requires key.')
      await state.cdp.focusElement(resolved.cdpRef)
      window.webContents.sendInputEvent({
        type: 'keyDown',
        keyCode: request.key,
        modifiers: toInputModifiers(request.modifiers),
      })
      window.webContents.sendInputEvent({
        type: 'keyUp',
        keyCode: request.key,
        modifiers: toInputModifiers(request.modifiers),
      })
    }
    }

    const after = await this.snapshot(boundSelector)
    if (resolved.selector) {
      const observed = await state.cdp.inspectSemanticSelector(resolved.selector)
      interaction = {
        focused: observed.focused,
        hit: observed.hit,
        ...(observed.obscuredBy ? { obscuredBy: observed.obscuredBy } : {}),
      }
    }
    const physicalAction = mode === 'physical' && request.action !== 'select'
    return {
      actionId: randomUUID(),
      verificationLevel: physicalAction ? 'renderer-verified' : 'scenario-verified',
      beforeRevision,
      afterRevision: after.revision,
      targetResolved: { ref: request.ref, role: resolved.node.role, name: resolved.node.name },
      settledBy: mode === 'semantic' ? ['semantic-command-ack', 'accessibility-snapshot'] : ['input-dispatched', 'accessibility-snapshot'],
      warnings: request.action === 'select' && mode === 'physical' ? ['select uses the component selection adapter and is scenario-verified'] : [],
      mode,
      ...(interaction ? { observed: interaction } : {}),
    }
  }

  async screenshot(selector: UiDriverWindowSelector, outputPath: string): Promise<{ path: string; width: number; height: number; webContentsId: number }> {
    const window = this.resolveWindow(selector)
    await mkdir(dirname(outputPath), { recursive: true })
    const image = await window.webContents.capturePage()
    const size = image.getSize()
    await writeFile(outputPath, image.toPNG())
    return { path: outputPath, width: size.width, height: size.height, webContentsId: window.webContents.id }
  }

  resize(selector: UiDriverWindowSelector, width: number, height: number): void {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 320 || height < 240 || width > 7680 || height > 4320) {
      throw new ElectronUiDriverError('UNSUPPORTED', 'Viewport is outside supported bounds.')
    }
    this.resolveWindow(selector).setContentSize(width, height)
  }

  async logs(runtimeLogPath: string, maxBytes = 256_000): Promise<string> {
    const data = await readFile(runtimeLogPath)
    return data.subarray(Math.max(0, data.length - maxBytes)).toString('utf8')
  }

  async electronWindowAction(
    selector: UiDriverWindowSelector,
    action: 'focus' | 'minimize' | 'maximize' | 'restore' | 'close',
  ): Promise<UiVerificationLevel> {
    const window = this.resolveWindow(selector)
    if (action === 'focus') {
      if (window.isMinimized()) window.restore()
      if (!window.isVisible()) window.show()
      window.focus()
    } else if (action === 'minimize') window.minimize()
    else if (action === 'maximize') window.maximize()
    else if (action === 'restore') window.restore()
    else {
      const webContentsId = window.webContents.id
      await new Promise<void>((resolve, reject) => {
        const onClosed = () => {
          clearTimeout(timeout)
          resolve()
        }
        const timeout = setTimeout(() => {
          window.removeListener('closed', onClosed)
          reject(new ElectronUiDriverError('TIMEOUT', `Window ${webContentsId} did not close within ${UI_VALIDATION_DEFAULT_TIMEOUT_MS / 1_000} seconds.`))
        }, UI_VALIDATION_DEFAULT_TIMEOUT_MS)
        window.once('closed', onClosed)
        window.close()
      })
    }
    return 'native-verified'
  }

  dispose(): void {
    for (const state of this.states.values()) state.cdp.detach()
    this.states.clear()
    this.disposed = true
  }

  private ensureConnected(): void {
    if (this.disposed) throw new ElectronUiDriverError('DRIVER_DISCONNECTED', 'Electron UI driver is disposed.')
  }

  private resolveWindow(selector: UiDriverWindowSelector): BrowserWindow {
    this.ensureConnected()
    if (selector.webContentsId !== undefined) {
      const window = this.windowManager.getWindowByWebContentsId(selector.webContentsId)
      if (!window || window.isDestroyed()) throw new ElectronUiDriverError('WINDOW_GONE', `Window ${selector.webContentsId} no longer exists.`)
      const managed = this.windowManager.getAllWindows().find(entry => entry.window.webContents.id === selector.webContentsId)
      if (!managed) throw new ElectronUiDriverError('WINDOW_GONE', `Window ${selector.webContentsId} is not managed.`)
      if ((selector.workspaceId && managed.workspaceId !== selector.workspaceId) || (selector.role && managed.role !== selector.role)) {
        throw new ElectronUiDriverError('TARGET_NOT_FOUND', 'Window does not match the requested workspace and role.', {
          requested: selector,
          actual: { workspaceId: managed.workspaceId, role: managed.role },
        })
      }
      return window
    }

    const candidates = this.windowManager.getAllWindows().filter(entry =>
      (selector.workspaceId === undefined || entry.workspaceId === selector.workspaceId)
      && (selector.role === undefined || entry.role === selector.role),
    )
    if (candidates.length === 0) throw new ElectronUiDriverError('NOT_READY', 'No matching renderer window is ready.')
    if (candidates.length > 1) {
      throw new ElectronUiDriverError('AMBIGUOUS_TARGET', 'More than one renderer window matches the requested role and workspace; provide webContentsId.', {
        selector,
        windows: candidates.map(candidate => ({ webContentsId: candidate.window.webContents.id, workspaceId: candidate.workspaceId, role: candidate.role })),
      })
    }
    return candidates[0]!.window
  }

  private windowIdentity(window: BrowserWindow): Pick<ManagedWindow, 'role' | 'sessionId' | 'parentWebContentsId'> {
    const managed = this.windowManager.getAllWindows().find(entry => entry.window.webContents.id === window.webContents.id)
    if (!managed) throw new ElectronUiDriverError('WINDOW_GONE', `Window ${window.webContents.id} is not managed.`)
    return {
      role: managed.role,
      ...(managed.sessionId ? { sessionId: managed.sessionId } : {}),
      ...(managed.parentWebContentsId != null ? { parentWebContentsId: managed.parentWebContentsId } : {}),
    }
  }

  private stateFor(window: BrowserWindow): DriverWindowState {
    const id = window.webContents.id
    let state = this.states.get(id)
    if (!state) {
      state = { cdp: new UiValidationBrowserCDP(window.webContents), revision: 0, refs: new Map() }
      this.states.set(id, state)
      window.webContents.once('destroyed', () => {
        state?.cdp.detach()
        this.states.delete(id)
      })
    }
    return state
  }
}

async function rendererDriverDisconnected(error: unknown): Promise<ElectronUiDriverError> {
  const fallback = await captureRendererDriverDiagnosticFallback(error)
  return new ElectronUiDriverError('DRIVER_DISCONNECTED', 'Electron renderer CDP driver is unavailable.', {
    cause: fallback.cause,
    fallback,
  })
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value)
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return ''
  }
}

function addToRegion(regions: UiDriverSnapshot['regions'], node: UiDriverSnapshotNode): void {
  if (DIALOG_ROLES.has(node.role)) regions.dialog.push(node)
  else if (NOTIFICATION_ROLES.has(node.role)) regions.notification.push(node)
  else if (NAVIGATION_ROLES.has(node.role)) regions.navigation.push(node)
  else if (SIDEBAR_ROLES.has(node.role)) regions.sidebar.push(node)
  else regions.main.push(node)
}
