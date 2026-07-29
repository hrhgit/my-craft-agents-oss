import type { ExtensionContributionDeltaV1, ExtensionContributionV1, ExtensionUISurface } from '@mortise/shared/protocol'
import { validateExtensionContributionDeltaV1 } from '@mortise/shared/protocol'

export interface RegisteredExtensionContribution {
  extensionId: string
  backendType: 'electron' | 'webui'
  sessionId: string
  runtimeId: string
  workspaceId?: string
  revision: number
  contribution: ExtensionContributionV1
}

const workspaceKey = (workspaceId?: string) => workspaceId ?? ''
const backendKey = (backendType?: string) => backendType ?? 'electron'
const ownerPrefix = (item: Pick<RegisteredExtensionContribution, 'workspaceId' | 'backendType' | 'extensionId'>) =>
  `${workspaceKey(item.workspaceId)}\0${backendKey(item.backendType)}\0${item.extensionId}\0`
const revisionKey = (delta: ExtensionContributionDeltaV1) =>
  `${workspaceKey(delta.workspaceId)}\0${backendKey(delta.backendType)}\0${delta.extensionId}\0${delta.sessionId}\0${delta.runtimeId}`
const itemKey = (
  item: Pick<RegisteredExtensionContribution, 'workspaceId' | 'backendType' | 'extensionId'>,
  id: string,
) => `${ownerPrefix(item)}${id}`

export class ContributionStore {
  private readonly items = new Map<string, RegisteredExtensionContribution>()
  private readonly revisions = new Map<string, number>()
  private readonly listeners = new Set<() => void>()
  private version = 0

  apply(delta: ExtensionContributionDeltaV1): boolean {
    if (validateExtensionContributionDeltaV1(delta) !== null) return false
    if (!delta.workspaceId || !delta.backendType) return false
    const route = revisionKey(delta)
    if (delta.revision <= (this.revisions.get(route) ?? 0)) return false
    this.revisions.set(route, delta.revision)
    if (delta.operation === 'snapshot') {
      const prefix = ownerPrefix({ ...delta, backendType: delta.backendType })
      for (const [key, item] of this.items) {
        if (key.startsWith(prefix) && item.sessionId === delta.sessionId && item.runtimeId === delta.runtimeId) this.items.delete(key)
      }
      for (const contribution of delta.contributions) {
        const item: RegisteredExtensionContribution = { extensionId: delta.extensionId, backendType: delta.backendType, sessionId: delta.sessionId, runtimeId: delta.runtimeId, workspaceId: delta.workspaceId, revision: delta.revision, contribution }
        this.items.set(itemKey(item, contribution.id), item)
      }
    } else if (delta.operation === 'upsert') {
      const item: RegisteredExtensionContribution = {
        extensionId: delta.extensionId,
        backendType: delta.backendType,
        sessionId: delta.sessionId,
        runtimeId: delta.runtimeId,
        workspaceId: delta.workspaceId,
        revision: delta.revision,
        contribution: delta.contribution,
      }
      this.items.set(itemKey(item, delta.contribution.id), item)
    } else if (delta.operation === 'remove') {
      this.items.delete(itemKey({ ...delta, backendType: delta.backendType }, delta.contributionId))
    } else {
      const prefix = ownerPrefix({ ...delta, backendType: delta.backendType })
      for (const [key, item] of this.items) {
        if (key.startsWith(prefix) && item.sessionId === delta.sessionId && item.runtimeId === delta.runtimeId) this.items.delete(key)
      }
    }
    this.version += 1
    for (const listener of this.listeners) listener()
    return true
  }

  resetRuntime(sessionId: string, runtimeId: string, workspaceId?: string, backendType: 'electron' | 'webui' = 'electron'): void {
    let changed = false
    for (const [key, item] of this.items) {
      if (item.workspaceId !== workspaceId || item.backendType !== backendType || item.sessionId !== sessionId || item.runtimeId !== runtimeId) continue
      this.items.delete(key)
      changed = true
    }
    const revisionSuffix = `\0${sessionId}\0${runtimeId}`
    const revisionPrefix = `${workspaceKey(workspaceId)}\0${backendType}\0`
    for (const key of this.revisions.keys()) {
      if (!key.startsWith(revisionPrefix) || !key.endsWith(revisionSuffix)) continue
      this.revisions.delete(key)
      changed = true
    }
    if (!changed) return
    this.version += 1
    for (const listener of this.listeners) listener()
  }

  list(
    sessionId: string,
    surface?: ExtensionUISurface,
    workspaceId?: string | null,
  ): RegisteredExtensionContribution[] {
    return Array.from(this.items.values()).filter(item =>
      item.sessionId === sessionId
      && (workspaceId === undefined || item.workspaceId === workspaceId)
      && (surface === undefined || item.contribution.surface === surface))
  }

  listWorkspaceContent(sessionId: string, workspaceId?: string | null): RegisteredExtensionContribution[] {
    const admittedSandboxKeys = selectAdmittedWorkspaceContentSandboxKeys(this.items.values(), workspaceId)
    const candidates = Array.from(this.items.values()).filter(item => {
      if (item.contribution.surface !== 'workspace.content') return false
      if (workspaceId !== undefined && item.workspaceId !== workspaceId) return false
      if (isSandboxContribution(item) && !admittedSandboxKeys.has(workspaceContentInstanceKey(item))) return false
      const scope = item.contribution.workspaceContent?.scope ?? 'session'
      if (scope === 'session') return item.sessionId === sessionId
      if (scope === 'workspace') return Boolean(workspaceId) && item.workspaceId === workspaceId
      return true
    })

    candidates.sort((a, b) =>
      Number(b.sessionId === sessionId) - Number(a.sessionId === sessionId)
      || Number(b.workspaceId === workspaceId) - Number(a.workspaceId === workspaceId)
      || b.revision - a.revision
      || a.runtimeId.localeCompare(b.runtimeId)
      || a.sessionId.localeCompare(b.sessionId))

    const singletonKeys = new Set<string>()
    return candidates.filter(item => {
      if ((item.contribution.workspaceContent?.instancePolicy ?? 'singleton') === 'multiple') return true
      const scope = item.contribution.workspaceContent?.scope ?? 'session'
      const key = `${scope}\0${item.extensionId}\0${item.contribution.id}`
      if (singletonKeys.has(key)) return false
      singletonKeys.add(key)
      return true
    })
  }

  getVersion = (): number => this.version
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

export interface SurfaceLayout {
  visible: RegisteredExtensionContribution[]
  menuOverflow: RegisteredExtensionContribution[]
  collapsedOverflow: RegisteredExtensionContribution[]
  /** Compatibility view for callers that only need all non-visible items. */
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

function workspaceContentInstanceKey(item: RegisteredExtensionContribution): string {
  const scope = item.contribution.workspaceContent?.scope ?? 'session'
  const base = `${scope}\0${item.extensionId}\0${item.contribution.id}`
  if ((item.contribution.workspaceContent?.instancePolicy ?? 'singleton') === 'multiple') {
    return `${base}\0${workspaceKey(item.workspaceId)}\0${item.sessionId}\0${item.runtimeId}`
  }
  if (scope === 'session') return `${base}\0${item.sessionId}`
  if (scope === 'workspace') return `${base}\0${workspaceKey(item.workspaceId)}`
  return base
}

function selectAdmittedWorkspaceContentSandboxKeys(
  items: Iterable<RegisteredExtensionContribution>,
  workspaceId?: string | null,
): Set<string> {
  const representatives = new Map<string, RegisteredExtensionContribution>()
  for (const item of items) {
    if (item.contribution.surface !== 'workspace.content' || !isSandboxContribution(item)) continue
    if (workspaceId !== undefined && item.workspaceId !== workspaceId) continue
    const key = workspaceContentInstanceKey(item)
    const current = representatives.get(key)
    if (!current || compareWorkspaceContentAdmission(item, current) < 0) representatives.set(key, item)
  }
  return new Set([...representatives.entries()]
    .sort(([, a], [, b]) => compareWorkspaceContentAdmission(a, b))
    .slice(0, MAX_ACTIVE_SANDBOX_APPS_PER_SURFACE)
    .map(([key]) => key))
}

function compareWorkspaceContentAdmission(
  a: RegisteredExtensionContribution,
  b: RegisteredExtensionContribution,
): number {
  return (b.contribution.priority ?? 0) - (a.contribution.priority ?? 0)
    || (a.contribution.order ?? 0) - (b.contribution.order ?? 0)
    || a.extensionId.localeCompare(b.extensionId)
    || a.contribution.id.localeCompare(b.contribution.id)
    || a.sessionId.localeCompare(b.sessionId)
    || a.runtimeId.localeCompare(b.runtimeId)
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
  resolve(surface: ExtensionUISurface, items: RegisteredExtensionContribution[], capacityOverride?: number): SurfaceLayout {
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
      const remainder = sorted.filter(item => item !== winner && item.contribution.overflow !== 'hide')
      return splitOverflow(surface, winner ? [winner] : [], remainder)
    }
    const capacity = capacityOverride ?? SURFACE_CAPACITY[surface] ?? Number.POSITIVE_INFINITY
    const visible: RegisteredExtensionContribution[] = []
    const overflow: RegisteredExtensionContribution[] = []
    let activeSandboxApps = 0
    const blocks = groupAllocationBlocks(sorted)
    for (const block of blocks) {
      const sandboxCount = block.filter(isSandboxContribution).length
      const forcedOverflow = block.some(item => item.contribution.collapse === 'always')
      const exceedsCapacity = visible.length + block.length > capacity
      const exceedsSandboxBudget = activeSandboxApps + sandboxCount > MAX_ACTIVE_SANDBOX_APPS_PER_SURFACE
      if (forcedOverflow || exceedsCapacity || exceedsSandboxBudget) {
        overflow.push(...block.filter(item => item.contribution.overflow !== 'hide'))
      } else {
        visible.push(...block)
        activeSandboxApps += sandboxCount
      }
    }
    return splitOverflow(surface, visible, overflow)
  }
}

function groupAllocationBlocks(items: RegisteredExtensionContribution[]): RegisteredExtensionContribution[][] {
  const grouped = new Map<string, RegisteredExtensionContribution[]>()
  const blocks: RegisteredExtensionContribution[][] = []
  for (const item of items) {
    const group = item.contribution.group
    if (!group) {
      blocks.push([item])
      continue
    }
    const existing = grouped.get(group)
    if (existing) existing.push(item)
    else {
      const block = [item]
      grouped.set(group, block)
      blocks.push(block)
    }
  }
  return blocks
}

function splitOverflow(
  surface: ExtensionUISurface,
  visible: RegisteredExtensionContribution[],
  overflow: RegisteredExtensionContribution[],
): SurfaceLayout {
  const compact = ['composer.toolbar', 'composer.status', 'window.topLeft', 'window.topRight', 'navigation.item', 'session.badge'].includes(surface)
  const menuOverflow = overflow.filter(item => (item.contribution.overflow ?? (compact ? 'menu' : 'collapse')) === 'menu')
  const collapsedOverflow = overflow.filter(item => (item.contribution.overflow ?? (compact ? 'menu' : 'collapse')) === 'collapse')
  return { visible, menuOverflow, collapsedOverflow, overflow: [...menuOverflow, ...collapsedOverflow] }
}

export function responsiveSurfaceCapacity(surface: ExtensionUISurface, viewportWidth: number): number | undefined {
  const base = SURFACE_CAPACITY[surface]
  if (base === undefined) return undefined
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return base
  const unit = ['composer.toolbar', 'composer.status', 'window.topLeft', 'window.topRight'].includes(surface) ? 128 : 180
  return Math.max(1, Math.min(base, Math.floor(viewportWidth / unit)))
}
