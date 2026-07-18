import { randomUUID } from 'node:crypto'
import type { AccessibilityNode } from '../browser-cdp'
import type { BrowserEmbeddedValidationSurface, BrowserPaneManager } from '../browser-pane-manager'
import { ElectronUiDriverError } from './electron-ui-driver-error'

const MAX_BROWSER_SNAPSHOT_NODES = 500
const SENSITIVE_FIELD_PATTERN = /password|passcode|secret|token|api\s*key|credential|authorization|private\s*key/i

type BrowserAction = 'click' | 'fill' | 'select'

export interface BrowserViewSemanticNode {
  ref: string
  role: string
  name: string
  value?: string
  description?: string
  state: { focused?: boolean; checked?: boolean; disabled?: boolean }
  bounds?: { x: number; y: number; width: number; height: number }
  hit?: boolean
  obscuredBy?: string
  actions: BrowserAction[]
  actionModes: { semantic: []; physical: BrowserAction[] }
}

export interface BrowserViewSurfaceSnapshot extends BrowserEmbeddedValidationSurface {
  kind: 'browser-view'
  revision: number
  nodes: BrowserViewSemanticNode[]
  truncated: boolean
  error?: { message: string }
}

export interface BrowserViewActionRequest {
  instanceId: string
  revision: number
  ref: string
  action: BrowserAction
  value?: string
}

interface SurfaceState {
  revision: number
  fingerprint?: string
  refs: Map<string, { rawRef: string; node: BrowserViewSemanticNode }>
}

export class ElectronBrowserViewSurfaceAdapter {
  private readonly states = new Map<string, SurfaceState>()

  constructor(private readonly manager: BrowserPaneManager) {}

  async snapshot(hostWebContentsId: number): Promise<BrowserViewSurfaceSnapshot[]> {
    const surfaces = this.manager.listEmbeddedValidationSurfaces(hostWebContentsId)
    const live = new Set(surfaces.map(surface => surface.instanceId))
    for (const instanceId of this.states.keys()) if (!live.has(instanceId)) this.states.delete(instanceId)
    return await Promise.all(surfaces.map(async (surface): Promise<BrowserViewSurfaceSnapshot> => {
      try {
        return await this.materialize(surface)
      } catch (error) {
        return {
          ...surface,
          kind: 'browser-view',
          revision: this.states.get(surface.instanceId)?.revision ?? 0,
          nodes: [],
          truncated: true,
          error: { message: error instanceof Error ? error.message : String(error) },
        }
      }
    }))
  }

  async action(hostWebContentsId: number, request: BrowserViewActionRequest): Promise<Record<string, unknown>> {
    const before = (await this.snapshot(hostWebContentsId)).find(surface => surface.instanceId === request.instanceId)
    if (!before) throw new ElectronUiDriverError('TARGET_NOT_FOUND', `BrowserView is not embedded in window ${hostWebContentsId}: ${request.instanceId}`)
    if (before.error) throw new ElectronUiDriverError('DRIVER_DISCONNECTED', `BrowserView semantic snapshot is unavailable: ${before.error.message}`)
    if (before.revision !== request.revision) {
      throw new ElectronUiDriverError('STALE_REF', `BrowserView ref belongs to revision ${request.revision}; current revision is ${before.revision}.`, {
        instanceId: request.instanceId,
        requestedRevision: request.revision,
        currentRevision: before.revision,
      })
    }
    const state = this.states.get(request.instanceId)!
    const resolved = state.refs.get(request.ref)
    if (!resolved) throw new ElectronUiDriverError('TARGET_NOT_FOUND', `Unknown BrowserView target ref ${request.ref}.`)
    if (resolved.node.state.disabled) throw new ElectronUiDriverError('DISABLED', `BrowserView target ${request.ref} is disabled.`)
    if (!resolved.node.actions.includes(request.action)) {
      throw new ElectronUiDriverError('UNSUPPORTED', `${request.action} is not valid for BrowserView ${resolved.node.role}.`)
    }

    if (request.action === 'click') await this.manager.clickElement(request.instanceId, resolved.rawRef)
    else if (request.action === 'fill') {
      if (request.value === undefined) throw new ElectronUiDriverError('INVALID_REQUEST', 'BrowserView fill requires value.')
      await this.manager.fillElement(request.instanceId, resolved.rawRef, request.value)
    } else {
      if (request.value === undefined) throw new ElectronUiDriverError('INVALID_REQUEST', 'BrowserView select requires value.')
      await this.manager.selectOption(request.instanceId, resolved.rawRef, request.value)
    }

    const after = (await this.snapshot(hostWebContentsId)).find(surface => surface.instanceId === request.instanceId)
    if (!after) throw new ElectronUiDriverError('WINDOW_GONE', `BrowserView disappeared after ${request.action}: ${request.instanceId}`)
    return {
      actionId: randomUUID(),
      beforeRevision: before.revision,
      afterRevision: after.revision,
      targetResolved: {
        kind: 'browser',
        instanceId: request.instanceId,
        ref: request.ref,
        role: resolved.node.role,
        name: resolved.node.name,
      },
      settledBy: ['browser-cdp-input', 'browser-accessibility-snapshot'],
      warnings: [],
      mode: 'physical',
      verificationLevel: 'renderer-verified',
    }
  }

  private async materialize(surface: BrowserEmbeddedValidationSurface): Promise<BrowserViewSurfaceSnapshot> {
    const accessibility = await this.manager.getAccessibilitySnapshot(surface.instanceId)
    let state = this.states.get(surface.instanceId)
    if (!state) {
      state = { revision: 0, refs: new Map() }
      this.states.set(surface.instanceId, state)
    }
    const fingerprint = JSON.stringify(accessibility.nodes.map(node => [
      node.ref, node.role, node.name, node.value, node.description,
      node.focused ?? false, node.checked ?? false, node.disabled ?? false,
      node.bounds, node.hit, node.obscuredBy,
    ]))
    if (state.fingerprint !== fingerprint) {
      state.fingerprint = fingerprint
      state.revision += 1
    }
    state.refs.clear()
    const nodes = accessibility.nodes.slice(0, MAX_BROWSER_SNAPSHOT_NODES).map(node => this.node(surface.instanceId, state!, node))
    return {
      ...surface,
      kind: 'browser-view',
      url: redactUrl(accessibility.url),
      title: accessibility.title.slice(0, 500),
      revision: state.revision,
      nodes,
      truncated: accessibility.nodes.length > nodes.length,
    }
  }

  private node(instanceId: string, state: SurfaceState, raw: AccessibilityNode): BrowserViewSemanticNode {
    const actions = actionsFor(raw)
    const ref = `b${state.revision}:${sanitize(instanceId)}:${raw.ref.replace(/^@/, '')}`
    const semanticLabel = `${raw.name} ${raw.description ?? ''}`
    const node: BrowserViewSemanticNode = {
      ref,
      role: raw.role,
      name: raw.name.slice(0, 500),
      ...(raw.value !== undefined ? { value: SENSITIVE_FIELD_PATTERN.test(semanticLabel) ? '[REDACTED]' : raw.value.slice(0, 2_000) } : {}),
      ...(raw.description ? { description: raw.description.slice(0, 500) } : {}),
      state: {
        ...(raw.focused ? { focused: true } : {}),
        ...(raw.checked ? { checked: true } : {}),
        ...(raw.disabled ? { disabled: true } : {}),
      },
      ...(raw.bounds ? { bounds: raw.bounds } : {}),
      ...(typeof raw.hit === 'boolean' ? { hit: raw.hit } : {}),
      ...(raw.obscuredBy ? { obscuredBy: raw.obscuredBy.slice(0, 200) } : {}),
      actions,
      actionModes: { semantic: [], physical: actions },
    }
    state.refs.set(ref, { rawRef: raw.ref, node })
    return node
  }
}

function actionsFor(node: AccessibilityNode): BrowserAction[] {
  if (node.disabled) return []
  if (node.role === 'textbox' || node.role === 'searchbox') return ['click', 'fill']
  if (node.role === 'combobox' || node.role === 'listbox') return ['click', 'select']
  return ['click']
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_')
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return ''
  }
}
