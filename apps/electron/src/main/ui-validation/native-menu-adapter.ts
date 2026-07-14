import { createHash, randomUUID } from 'node:crypto'
import type { BrowserWindow, Menu, MenuItem } from 'electron'
import { ElectronUiDriverError, type UiVerificationLevel } from './electron-surface-driver'

export interface NativeMenuNode {
  ref: string
  id?: string
  role: 'menu' | 'menuitem' | 'menuitemcheckbox' | 'menuitemradio' | 'separator'
  name: string
  enabled: boolean
  checked?: boolean
  accelerator?: string
  path: string[]
  actions: Array<'click'>
}

export interface NativeMenuSnapshot {
  revision: number
  nodes: NativeMenuNode[]
  truncated: boolean
}

interface MenuApi {
  getApplicationMenu(): Menu | null
}

const MAX_MENU_NODES = 500

export class ElectronNativeMenuAdapter {
  private revision = 0
  private fingerprint = ''
  private refs = new Map<string, { node: NativeMenuNode; item: MenuItem }>()

  constructor(
    private readonly menu: MenuApi,
    private readonly focusedWindow: () => BrowserWindow | null,
  ) {}

  ready(): boolean { return this.menu.getApplicationMenu() !== null }

  snapshot(): NativeMenuSnapshot {
    const applicationMenu = this.menu.getApplicationMenu()
    if (!applicationMenu) throw new ElectronUiDriverError('UNSUPPORTED', 'Electron application menu is unavailable on this surface.')
    const drafts: Array<{ node: Omit<NativeMenuNode, 'ref'>; item: MenuItem }> = []
    const visit = (items: MenuItem[], parentPath: string[]): void => {
      for (const item of items) {
        if (drafts.length >= MAX_MENU_NODES) return
        const name = bounded(item.label || item.role || item.id || item.type, 300)
        const path = [...parentPath, name || `item-${drafts.length + 1}`]
        const role = item.type === 'separator'
          ? 'separator'
          : item.type === 'checkbox'
            ? 'menuitemcheckbox'
            : item.type === 'radio'
              ? 'menuitemradio'
              : item.submenu
                ? 'menu'
                : 'menuitem'
        const enabled = item.enabled !== false && item.visible !== false
        drafts.push({
          item,
          node: {
            ...(item.id ? { id: bounded(item.id, 200) } : {}),
            role,
            name,
            enabled,
            ...(role === 'menuitemcheckbox' || role === 'menuitemradio' ? { checked: item.checked === true } : {}),
            ...(item.accelerator ? { accelerator: bounded(item.accelerator, 100) } : {}),
            path,
            actions: enabled && role !== 'separator' && !item.submenu ? ['click'] : [],
          },
        })
        if (item.submenu) visit(item.submenu.items, path)
      }
    }
    visit(applicationMenu.items, [])
    const fingerprint = JSON.stringify(drafts.map(({ node }) => node))
    if (fingerprint !== this.fingerprint) {
      this.fingerprint = fingerprint
      this.revision += 1
    }
    this.refs.clear()
    const nodes = drafts.map(({ node, item }, index) => {
      const identity = `${node.id ?? ''}\0${node.path.join('\0')}\0${index}`
      const ref = `m${this.revision}:${createHash('sha256').update(identity).digest('hex').slice(0, 20)}`
      const materialized = { ref, ...node }
      this.refs.set(ref, { node: materialized, item })
      return materialized
    })
    return { revision: this.revision, nodes, truncated: drafts.length >= MAX_MENU_NODES }
  }

  async action(request: { revision: number; ref: string; action: 'click' }): Promise<{
    actionId: string
    verificationLevel: UiVerificationLevel
    beforeRevision: number
    afterRevision: number
    target: Pick<NativeMenuNode, 'ref' | 'role' | 'name'>
    settledBy: string[]
    warnings: string[]
  }> {
    const before = this.snapshot()
    if (request.revision !== before.revision || !request.ref.startsWith(`m${before.revision}:`)) {
      throw new ElectronUiDriverError('STALE_REF', `Menu ref does not belong to revision ${before.revision}.`)
    }
    const resolved = this.refs.get(request.ref)
    if (!resolved) throw new ElectronUiDriverError('TARGET_NOT_FOUND', `Unknown menu target ${request.ref}.`)
    if (!resolved.node.enabled) throw new ElectronUiDriverError('DISABLED', `Menu target ${request.ref} is disabled.`)
    if (!resolved.node.actions.includes(request.action) || typeof resolved.item.click !== 'function') {
      throw new ElectronUiDriverError('UNSUPPORTED', `Menu target ${request.ref} cannot be clicked.`)
    }
    await resolved.item.click(resolved.item, this.focusedWindow(), { triggeredByAccelerator: false })
    const after = this.snapshot()
    return {
      actionId: randomUUID(),
      verificationLevel: 'native-verified',
      beforeRevision: before.revision,
      afterRevision: after.revision,
      target: { ref: request.ref, role: resolved.node.role, name: resolved.node.name },
      settledBy: ['electron-menu-command', 'electron-menu-snapshot'],
      warnings: [],
    }
  }
}

function bounded(value: unknown, max: number): string { return typeof value === 'string' ? value.slice(0, max) : '' }
