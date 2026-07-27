import type { WsRpcClient } from '@mortise/server-core/transport'
import { isLocalOnly } from '@mortise/shared/protocol'
import type { ResolvedWorkspaceRoute } from '../shared/app-layout'

export interface WorkspaceRuntimeRegistration {
  route: ResolvedWorkspaceRoute
  client: WsRpcClient
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
        rebound.set(listener, bindRuntimeListener(registration, listener))
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

  has(route: ResolvedWorkspaceRoute): boolean {
    return this.runtimes.has(workspaceRouteKey(route))
  }

  getRegisteredRoutes(): ResolvedWorkspaceRoute[] {
    return [...this.runtimes.values()].map(entry => ({ ...entry.route }))
  }

  get(route: ResolvedWorkspaceRoute): WorkspaceRuntimeRegistration | undefined {
    const entry = this.runtimes.get(workspaceRouteKey(route))
    if (!entry) return undefined
    return {
      route: { ...entry.route },
      client: entry.client,
      targetWorkspaceId: entry.targetWorkspaceId,
      generation: entry.generation,
      dispose: entry.dispose,
    }
  }

  ownsClient(client: WsRpcClient): boolean {
    return [...this.runtimes.values()].some(entry => entry.client === client)
  }

  remove(route: ResolvedWorkspaceRoute): void {
    const key = workspaceRouteKey(route)
    const existing = this.runtimes.get(key)
    if (!existing) return
    this.runtimes.delete(key)
    this.disposeEntry(existing)
  }

  async invoke(route: ResolvedWorkspaceRoute, channel: string, ...args: unknown[]): Promise<unknown> {
    if (isLocalOnly(channel)) {
      throw new Error(`Workspace-scoped invocation cannot use local-only channel: ${channel}`)
    }
    const runtime = this.requireRuntime(route)
    const translatedArgs = translateWorkspaceArgs(args, route.workspaceId, runtime.targetWorkspaceId)
    const result = await runtime.client.invoke(channel, ...translatedArgs)
    return translateRemoteWorkspaceIdentity(result, runtime.targetWorkspaceId, route.workspaceId)
  }

  on(route: ResolvedWorkspaceRoute, channel: string, callback: (...args: any[]) => void): () => void {
    if (isLocalOnly(channel)) {
      throw new Error(`Workspace-scoped subscription cannot use local-only channel: ${channel}`)
    }
    const runtime = this.requireRuntime(route)
    const listener: RuntimeListener = {
      key: workspaceRouteKey(route),
      channel,
      callback,
      unsubscribe: () => {},
      active: true,
    }
    listener.unsubscribe = bindRuntimeListener(runtime, listener)
    runtime.listeners.add(listener)
    return () => {
      if (!listener.active) return
      listener.active = false
      listener.unsubscribe()
      this.runtimes.get(listener.key)?.listeners.delete(listener)
    }
  }

  isChannelAvailable(route: ResolvedWorkspaceRoute, channel: string): boolean {
    if (isLocalOnly(channel)) return false
    const runtime = this.runtimes.get(workspaceRouteKey(route))
    return runtime?.client.isChannelAvailable(channel) ?? false
  }

  private requireRuntime(route: ResolvedWorkspaceRoute): RuntimeEntry {
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

export function workspaceRouteKey(route: Pick<ResolvedWorkspaceRoute, 'workspaceId' | 'locationId'>): string {
  validateRoute(route)
  return `${encodeURIComponent(route.workspaceId)}::${encodeURIComponent(route.locationId)}`
}

function validateRoute(route: Pick<ResolvedWorkspaceRoute, 'workspaceId' | 'locationId'>): void {
  if (typeof route.workspaceId !== 'string' || !route.workspaceId.trim()) {
    throw new Error('Workspace route requires a workspaceId')
  }
  if (typeof route.locationId !== 'string' || !route.locationId.trim()) {
    throw new Error('Workspace route requires a locationId')
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

function bindRuntimeListener(
  runtime: Pick<WorkspaceRuntimeRegistration, 'route' | 'client' | 'targetWorkspaceId'>,
  listener: Pick<RuntimeListener, 'channel' | 'callback'>,
): () => void {
  return runtime.client.on(listener.channel, (...args: any[]) => {
    listener.callback(...args.map(arg => translateRemoteWorkspaceIdentity(
      arg,
      runtime.targetWorkspaceId,
      runtime.route.workspaceId,
    )))
  })
}

/** Restore logical Workspace identity in remote DTOs without rewriting opaque IDs. */
export function translateRemoteWorkspaceIdentity(
  value: unknown,
  targetWorkspaceId: string | undefined,
  logicalWorkspaceId: string,
): unknown {
  if (!targetWorkspaceId || targetWorkspaceId === logicalWorkspaceId) return value
  if (Array.isArray(value)) {
    return value.map(item => translateRemoteWorkspaceIdentity(item, targetWorkspaceId, logicalWorkspaceId))
  }
  if (!isPlainObject(value)) return value

  const translated: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    translated[key] = key === 'workspaceId' && item === targetWorkspaceId
      ? logicalWorkspaceId
      : translateRemoteWorkspaceIdentity(item, targetWorkspaceId, logicalWorkspaceId)
  }
  return translated
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
