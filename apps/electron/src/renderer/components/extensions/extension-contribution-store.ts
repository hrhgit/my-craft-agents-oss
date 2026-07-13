import type { ExtensionContributionDeltaV1, ExtensionContributionV1, ExtensionUISurface } from '@craft-agent/shared/protocol'
import { validateExtensionContributionDeltaV1 } from '@craft-agent/shared/protocol'

export interface RegisteredExtensionContribution {
  extensionId: string
  sessionId: string
  runtimeId: string
  revision: number
  contribution: ExtensionContributionV1
}

const routeKey = (delta: ExtensionContributionDeltaV1) => `${delta.sessionId}\0${delta.runtimeId}\0${delta.extensionId}`
const itemKey = (item: Pick<RegisteredExtensionContribution, 'sessionId' | 'runtimeId' | 'extensionId'>, id: string) =>
  `${item.sessionId}\0${item.runtimeId}\0${item.extensionId}\0${id}`

export class ContributionStore {
  private readonly items = new Map<string, RegisteredExtensionContribution>()
  private readonly revisions = new Map<string, number>()
  private readonly listeners = new Set<() => void>()
  private version = 0

  apply(delta: ExtensionContributionDeltaV1): boolean {
    if (validateExtensionContributionDeltaV1(delta) !== null) return false
    const route = routeKey(delta)
    if (delta.revision <= (this.revisions.get(route) ?? 0)) return false
    this.revisions.set(route, delta.revision)
    if (delta.operation === 'snapshot') {
      const prefix = `${delta.sessionId}\0${delta.runtimeId}\0${delta.extensionId}\0`
      for (const key of this.items.keys()) if (key.startsWith(prefix)) this.items.delete(key)
      for (const contribution of delta.contributions) {
        const item: RegisteredExtensionContribution = { extensionId: delta.extensionId, sessionId: delta.sessionId, runtimeId: delta.runtimeId, revision: delta.revision, contribution }
        this.items.set(itemKey(item, contribution.id), item)
      }
    } else if (delta.operation === 'upsert') {
      const item: RegisteredExtensionContribution = {
        extensionId: delta.extensionId,
        sessionId: delta.sessionId,
        runtimeId: delta.runtimeId,
        revision: delta.revision,
        contribution: delta.contribution,
      }
      this.items.set(itemKey(item, delta.contribution.id), item)
    } else if (delta.operation === 'remove') {
      this.items.delete(itemKey(delta, delta.contributionId))
    } else {
      const prefix = `${delta.sessionId}\0${delta.runtimeId}\0${delta.extensionId}\0`
      for (const key of this.items.keys()) if (key.startsWith(prefix)) this.items.delete(key)
    }
    this.version += 1
    for (const listener of this.listeners) listener()
    return true
  }

  resetRuntime(sessionId: string, runtimeId: string): void {
    const prefix = `${sessionId}\0${runtimeId}\0`
    let changed = false
    for (const key of this.items.keys()) {
      if (!key.startsWith(prefix)) continue
      this.items.delete(key)
      changed = true
    }
    for (const key of this.revisions.keys()) {
      if (!key.startsWith(prefix)) continue
      this.revisions.delete(key)
      changed = true
    }
    if (!changed) return
    this.version += 1
    for (const listener of this.listeners) listener()
  }

  list(sessionId: string, surface?: ExtensionUISurface): RegisteredExtensionContribution[] {
    return Array.from(this.items.values()).filter(item =>
      item.sessionId === sessionId && (surface === undefined || item.contribution.surface === surface))
  }

  getVersion = (): number => this.version
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

export interface SurfaceLayout {
  visible: RegisteredExtensionContribution[]
  overflow: RegisteredExtensionContribution[]
}

const SURFACE_CAPACITY: Partial<Record<ExtensionUISurface, number>> = {
  'composer.above': 3,
  'composer.below': 3,
  'composer.toolbar': 4,
  'composer.status': 4,
  'window.topLeft': 2,
  'window.topRight': 2,
  'sidebar.header': 2,
  'sidebar.section': 5,
  'sidebar.footer': 2,
}
const MAX_ACTIVE_SANDBOX_APPS_PER_SURFACE = 4

function isSandboxContribution(item: RegisteredExtensionContribution): boolean {
  return item.contribution.content.type === 'sandbox-app'
}

export function selectMountableOverflow(layout: SurfaceLayout): RegisteredExtensionContribution[] {
  let availableSandboxSlots = Math.max(
    0,
    MAX_ACTIVE_SANDBOX_APPS_PER_SURFACE - layout.visible.filter(isSandboxContribution).length,
  )
  return layout.overflow.filter(item => {
    if (!isSandboxContribution(item)) return true
    if (availableSandboxSlots === 0) return false
    availableSandboxSlots -= 1
    return true
  })
}

export class SurfaceLayoutManager {
  resolve(surface: ExtensionUISurface, items: RegisteredExtensionContribution[]): SurfaceLayout {
    const sorted = [...items].sort((a, b) =>
      (a.contribution.collapse === 'never' ? -1 : a.contribution.collapse === 'always' ? 1 : 0)
      - (b.contribution.collapse === 'never' ? -1 : b.contribution.collapse === 'always' ? 1 : 0)
      ||
      (b.contribution.priority ?? 0) - (a.contribution.priority ?? 0)
      || (a.contribution.order ?? 0) - (b.contribution.order ?? 0)
      || a.extensionId.localeCompare(b.extensionId)
      || a.contribution.id.localeCompare(b.contribution.id))
    const exclusive = sorted.filter(item => item.contribution.exclusive || item.contribution.surface.endsWith('.replace'))
    if (exclusive.length > 0) {
      const winner = exclusive[0]
      return { visible: winner ? [winner] : [], overflow: sorted.filter(item => item !== winner && item.contribution.overflow !== 'hide') }
    }
    const capacity = SURFACE_CAPACITY[surface] ?? Number.POSITIVE_INFINITY
    const visible: RegisteredExtensionContribution[] = []
    const overflow: RegisteredExtensionContribution[] = []
    let activeSandboxApps = 0
    for (const item of sorted) {
      const isSandbox = isSandboxContribution(item)
      const exceedsSandboxBudget = isSandbox && activeSandboxApps >= MAX_ACTIVE_SANDBOX_APPS_PER_SURFACE
      if (item.contribution.collapse === 'always' || visible.length >= capacity || exceedsSandboxBudget) {
        if (item.contribution.overflow !== 'hide') overflow.push(item)
        continue
      }
      visible.push(item)
      if (isSandbox) activeSandboxApps += 1
    }
    return { visible, overflow }
  }
}
