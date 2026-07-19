import type { RpcClient } from '@mortise/server-core/transport'
import { isLocalOnly } from '@mortise/shared/protocol'
import type { WorkspaceRoute } from '../shared/app-layout'

export interface WorkspaceRuntimeRegistration {
  route: WorkspaceRoute
  client: RpcClient
  /** Workspace identifier understood by the target server. */
  targetWorkspaceId?: string
  /** Opaque in-memory identity for the runtime configuration. */
  generation?: string
  /** Release transport resources owned by this registration. */
  dispose?: () => void
}

interface RuntimeEntry extends WorkspaceRuntimeRegistration {
  entryId: number
  leases: Set<number>
  listeners: Set<RuntimeListener>
}

interface RuntimeListener {
  key: string
  channel: string
  callback: (...args: any[]) => void
  unsubscribe: () => void
  active: boolean
}

export class WorkspaceRuntimeRegistry {
  private readonly runtimes = new Map<string, RuntimeEntry>()
  private nextEntryId = 1
  private nextLeaseId = 1

  register(registration: WorkspaceRuntimeRegistration): () => void {
    validateRoute(registration.route)
    const key = workspaceRouteKey(registration.route)
    const existing = this.runtimes.get(key)
    const generation = registration.generation ?? 'default'
    if (existing && (existing.client !== registration.client || existing.generation !== generation)) {
      throw new Error(`Workspace runtime already registered for ${key}`)
    }
    if (existing) {
      return this.addLease(key, existing)
    }

    const entry: RuntimeEntry = {
      ...registration,
      generation,
      entryId: this.nextEntryId++,
      leases: new Set(),
      listeners: new Set(),
    }
    this.runtimes.set(key, entry)
    return this.addLease(key, entry)
  }

  /** Replace one route atomically while preserving its active subscriptions. */
  replace(registration: WorkspaceRuntimeRegistration): () => void {
    validateRoute(registration.route)
    const key = workspaceRouteKey(registration.route)
    const generation = registration.generation ?? 'default'
    const existing = this.runtimes.get(key)
    if (!existing) return this.register({ ...registration, generation })
    if (existing.generation === generation) {
      if (existing.client !== registration.client) {
        throw new Error(`Workspace runtime generation collision for ${key}`)
      }
      return this.addLease(key, existing)
    }

    const rebound = new Map<RuntimeListener, () => void>()
    try {
      for (const listener of existing.listeners) {
        rebound.set(listener, registration.client.on(listener.channel, listener.callback))
      }
    } catch (error) {
      for (const unsubscribe of rebound.values()) {
        try { unsubscribe() } catch { /* best-effort rollback */ }
      }
      throw error
    }

    const replacement: RuntimeEntry = {
      ...registration,
      generation,
      entryId: this.nextEntryId++,
      leases: new Set(),
      listeners: existing.listeners,
    }
    this.runtimes.set(key, replacement)

    for (const [listener, unsubscribe] of rebound) {
      const oldUnsubscribe = listener.unsubscribe
      listener.unsubscribe = unsubscribe
      try { oldUnsubscribe() } catch { /* replacement is already authoritative */ }
    }
    existing.listeners = new Set()
    this.disposeEntry(existing)
    return this.addLease(key, replacement)
  }

  /** Move a runtime to a new trusted route while preserving active subscriptions. */
  move(fromRoute: WorkspaceRoute, registration: WorkspaceRuntimeRegistration): () => void {
    validateRoute(fromRoute)
    validateRoute(registration.route)
    const fromKey = workspaceRouteKey(fromRoute)
    const nextKey = workspaceRouteKey(registration.route)
    if (fromKey === nextKey) return this.replace(registration)

    const existing = this.runtimes.get(fromKey)
    const target = this.runtimes.get(nextKey)
    if (!existing) {
      const generation = registration.generation ?? 'default'
      if (!target) return this.register(registration)
      if (target.generation !== generation) {
        throw new Error(`Workspace runtime already registered for ${nextKey}`)
      }
      try { registration.dispose?.() } catch { /* redundant client is not authoritative */ }
      return this.addLease(nextKey, target)
    }
    if (target) {
      throw new Error(`Workspace runtime already registered for ${nextKey}`)
    }

    const rebound = new Map<RuntimeListener, () => void>()
    try {
      for (const listener of existing.listeners) {
        rebound.set(listener, registration.client.on(listener.channel, listener.callback))
      }
    } catch (error) {
      for (const unsubscribe of rebound.values()) {
        try { unsubscribe() } catch { /* best-effort rollback */ }
      }
      throw error
    }

    const replacement: RuntimeEntry = {
      ...registration,
      generation: registration.generation ?? 'default',
      entryId: this.nextEntryId++,
      leases: new Set(),
      listeners: existing.listeners,
    }
    this.runtimes.delete(fromKey)
    this.runtimes.set(nextKey, replacement)

    for (const [listener, unsubscribe] of rebound) {
      const oldUnsubscribe = listener.unsubscribe
      listener.key = nextKey
      listener.unsubscribe = unsubscribe
      try { oldUnsubscribe() } catch { /* moved runtime is already authoritative */ }
    }
    existing.listeners = new Set()
    this.disposeEntry(existing)
    return this.addLease(nextKey, replacement)
  }

  has(route: WorkspaceRoute): boolean {
    return this.runtimes.has(workspaceRouteKey(route))
  }

  getRegisteredRoutes(): WorkspaceRoute[] {
    return [...this.runtimes.values()].map(entry => ({ ...entry.route }))
  }

  remove(route: WorkspaceRoute): void {
    const key = workspaceRouteKey(route)
    const existing = this.runtimes.get(key)
    if (!existing) return
    this.runtimes.delete(key)
    this.disposeEntry(existing)
  }

  removeWorkspace(workspaceId: string, exceptRoute?: WorkspaceRoute): void {
    const exceptKey = exceptRoute ? workspaceRouteKey(exceptRoute) : null
    for (const [key, entry] of this.runtimes) {
      if (entry.route.workspaceId !== workspaceId || key === exceptKey) continue
      this.runtimes.delete(key)
      this.disposeEntry(entry)
    }
  }

  async invoke(route: WorkspaceRoute, channel: string, ...args: unknown[]): Promise<unknown> {
    if (isLocalOnly(channel)) {
      throw new Error(`Workspace-scoped invocation cannot use local-only channel: ${channel}`)
    }
    const runtime = this.requireRuntime(route)
    const translatedArgs = translateWorkspaceArgs(args, route.workspaceId, runtime.targetWorkspaceId)
    return runtime.client.invoke(channel, ...translatedArgs)
  }

  on(route: WorkspaceRoute, channel: string, callback: (...args: any[]) => void): () => void {
    if (isLocalOnly(channel)) {
      throw new Error(`Workspace-scoped subscription cannot use local-only channel: ${channel}`)
    }
    const runtime = this.requireRuntime(route)
    const listener: RuntimeListener = {
      key: workspaceRouteKey(route),
      channel,
      callback,
      unsubscribe: runtime.client.on(channel, callback),
      active: true,
    }
    runtime.listeners.add(listener)
    return () => {
      if (!listener.active) return
      listener.active = false
      listener.unsubscribe()
      this.runtimes.get(listener.key)?.listeners.delete(listener)
    }
  }

  isChannelAvailable(route: WorkspaceRoute, channel: string): boolean {
    if (isLocalOnly(channel)) return false
    const runtime = this.runtimes.get(workspaceRouteKey(route))
    const client = runtime?.client as (RpcClient & { isChannelAvailable?: (channel: string) => boolean }) | undefined
    return client?.isChannelAvailable?.(channel) ?? false
  }

  private requireRuntime(route: WorkspaceRoute): RuntimeEntry {
    validateRoute(route)
    const key = workspaceRouteKey(route)
    const runtime = this.runtimes.get(key)
    if (!runtime) throw new Error(`Workspace runtime is not registered: ${key}`)
    return runtime
  }

  private addLease(key: string, entry: RuntimeEntry): () => void {
    const leaseId = this.nextLeaseId++
    entry.leases.add(leaseId)
    let released = false
    return () => {
      if (released) return
      released = true
      const current = this.runtimes.get(key)
      if (!current || current.entryId !== entry.entryId) return
      current.leases.delete(leaseId)
      if (current.leases.size > 0) return
      this.runtimes.delete(key)
      this.disposeEntry(current)
    }
  }

  private disposeEntry(entry: RuntimeEntry): void {
    for (const listener of entry.listeners) {
      listener.active = false
      try { listener.unsubscribe() } catch { /* best-effort cleanup */ }
    }
    entry.listeners.clear()
    try { entry.dispose?.() } catch { /* best-effort transport cleanup */ }
  }
}

export function workspaceRouteKey(route: WorkspaceRoute): string {
  validateRoute(route)
  return `${encodeURIComponent(route.serverId)}::${encodeURIComponent(route.workspaceId)}`
}

function validateRoute(route: WorkspaceRoute): void {
  if (!route || typeof route.serverId !== 'string' || !route.serverId.trim()) {
    throw new Error('Workspace route requires a serverId')
  }
  if (typeof route.workspaceId !== 'string' || !route.workspaceId.trim()) {
    throw new Error('Workspace route requires a workspaceId')
  }
}

function translateWorkspaceArgs(args: unknown[], localId: string, targetId?: string): unknown[] {
  if (!targetId || targetId === localId) return args
  return args.map(arg => {
    if (arg === localId) return targetId
    if (arg && typeof arg === 'object' && !Array.isArray(arg) && 'workspaceId' in arg) {
      const value = arg as Record<string, unknown>
      if (value.workspaceId === localId) return { ...value, workspaceId: targetId }
    }
    return arg
  })
}
