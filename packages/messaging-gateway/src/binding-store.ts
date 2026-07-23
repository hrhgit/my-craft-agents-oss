/**
 * BindingStore — workspace-scoped persistence for channel bindings.
 *
 * Stores bindings in an explicit storage directory (passed by the caller).
 * In Electron this is `~/.mortise/workspaces/{wsId}/messaging/`, but tests
 * can point it at any directory.
 */

import { randomUUID } from 'node:crypto'
import type { BindingConfig, ChannelBinding, MessagingLogger, PlatformType } from './types'
import { createBindingConfig } from './types'
import { NOOP_LOGGER, SqliteRecordStore } from './sqlite-record-store'

export class BindingStore extends SqliteRecordStore<ChannelBinding[]> {
  private bindings: ChannelBinding[] = []
  private changeListener?: () => void

  /** @param storageDir Absolute path to the messaging state directory. */
  constructor(storageDir: string, logger: MessagingLogger = NOOP_LOGGER) {
    super(storageDir, 'bindings', logger)
    this.load()
  }

  /** Register a callback fired after any mutation is persisted. */
  onChange(fn: () => void): void {
    this.changeListener = fn
  }

  // -------------------------------------------------------------------------
  // Query
  // -------------------------------------------------------------------------

  /**
   * Find the active binding for a (platform, channelId, threadId) tuple.
   * `threadId` distinguishes Telegram supergroup forum topics from each
   * other and from the supergroup's General topic / DMs (undefined).
   *
   * Bindings created without `threadId` (DMs, pre-topics-feature data)
   * only match calls passing `threadId === undefined`.
   */
  findByChannel(platform: PlatformType, channelId: string, threadId?: number): ChannelBinding | undefined {
    return this.bindings.find(
      (b) =>
        b.platform === platform &&
        b.channelId === channelId &&
        (b.threadId ?? undefined) === threadId &&
        b.enabled,
    )
  }

  findBySession(sessionId: string): ChannelBinding[] {
    return this.bindings.filter((b) => b.sessionId === sessionId && b.enabled)
  }

  getAll(): ChannelBinding[] {
    return [...this.bindings]
  }

  // -------------------------------------------------------------------------
  // Mutation
  // -------------------------------------------------------------------------

  bind(
    workspaceId: string,
    sessionId: string,
    platform: PlatformType,
    channelId: string,
    channelName?: string,
    config?: Partial<BindingConfig>,
    threadId?: number,
  ): ChannelBinding {
    // One channel → one session: evict any existing binding for the
    // (platform, channelId, threadId) tuple. Different topics in the same
    // supergroup are independently bindable.
    this.bindings = this.bindings.filter(
      (b) => !(b.platform === platform && b.channelId === channelId && (b.threadId ?? undefined) === threadId),
    )

    const binding: ChannelBinding = {
      id: randomUUID(),
      workspaceId,
      sessionId,
      platform,
      channelId,
      ...(threadId !== undefined ? { threadId } : {}),
      channelName,
      enabled: true,
      createdAt: Date.now(),
      config: createBindingConfig(platform, config),
    }

    this.bindings.push(binding)
    this.save()
    this.log.info('binding created', {
      event: 'binding_created',
      workspaceId,
      sessionId,
      platform,
      channelId,
      threadId,
      bindingId: binding.id,
      channelName,
    })
    return binding
  }

  /**
   * Update a binding's `BindingConfig` in place — preserves `id`,
   * `createdAt`, `channelId`, etc. Returns the updated binding (or null
   * if the id wasn't found).
   *
   * Use this instead of `bind()` when you only need to change config
   * fields like `accessMode` or `allowedSenderIds`. `bind()` evicts and
   * re-creates with a fresh UUID, which silently rotates the binding id
   * and breaks anything keyed on it (audit logs, deep links, stale UI
   * closures).
   */
  updateBindingConfig(bindingId: string, patch: Partial<BindingConfig>): ChannelBinding | null {
    const binding = this.bindings.find((b) => b.id === bindingId)
    if (!binding) return null
    binding.config = createBindingConfig(binding.platform, {
      ...binding.config,
      ...patch,
    })
    this.save()
    this.log.info('binding config updated', {
      event: 'binding_config_updated',
      bindingId,
      platform: binding.platform,
      patchedKeys: Object.keys(patch),
    })
    return binding
  }

  unbind(platform: PlatformType, channelId: string, threadId?: number): boolean {
    const before = this.bindings.length
    this.bindings = this.bindings.filter(
      (b) => !(b.platform === platform && b.channelId === channelId && (b.threadId ?? undefined) === threadId),
    )
    if (this.bindings.length !== before) {
      this.save()
      this.log.info('binding removed by channel', {
        event: 'binding_removed',
        platform,
        channelId,
        threadId,
      })
      return true
    }
    return false
  }

  unbindById(bindingId: string): boolean {
    const binding = this.bindings.find((b) => b.id === bindingId)
    if (!binding) return false
    this.bindings = this.bindings.filter((b) => b.id !== bindingId)
    this.save()
    this.log.info('binding removed by id', {
      event: 'binding_removed',
      bindingId,
      workspaceId: binding.workspaceId,
      sessionId: binding.sessionId,
      platform: binding.platform,
      channelId: binding.channelId,
    })
    return true
  }

  unbindSession(sessionId: string, platform?: PlatformType): number {
    const removedBindings = this.bindings.filter((b) => {
      if (b.sessionId !== sessionId) return false
      if (platform && b.platform !== platform) return false
      return true
    })
    if (removedBindings.length === 0) return 0

    this.bindings = this.bindings.filter((b) => !removedBindings.includes(b))
    this.save()
    this.log.info('bindings removed by session', {
      event: 'binding_removed',
      sessionId,
      platform,
      removedCount: removedBindings.length,
      bindingIds: removedBindings.map((b) => b.id),
    })
    return removedBindings.length
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private load(): void {
    const parsed = this.loadRecord()
    if (Array.isArray(parsed) && parsed.every(isCanonicalBinding)) {
      this.bindings = parsed
    } else {
      this.bindings = []
      if (parsed !== null) {
        this.log.error('rejected bindings outside the current schema', {
          event: 'binding_schema_rejected',
          databasePath: this.databasePath,
          recordKey: this.recordKey,
        })
      }
    }
  }

  private save(): void {
    const ok = this.saveRecord(this.bindings)
    // 仅在写入成功后触发 listener——否则 UI 会显示重启后消失的幻影 binding。
    if (ok) this.changeListener?.()
  }
}

function isCanonicalBinding(value: unknown): value is ChannelBinding {
  if (!isRecord(value) || !isCanonicalBindingConfig(value.config)) return false
  return (
    typeof value.id === 'string' &&
    typeof value.workspaceId === 'string' &&
    typeof value.sessionId === 'string' &&
    (value.platform === 'telegram' || value.platform === 'whatsapp' || value.platform === 'lark') &&
    typeof value.channelId === 'string' &&
    (value.threadId === undefined || typeof value.threadId === 'number') &&
    (value.channelName === undefined || typeof value.channelName === 'string') &&
    typeof value.enabled === 'boolean' &&
    typeof value.createdAt === 'number'
  )
}

function isCanonicalBindingConfig(value: unknown): value is BindingConfig {
  if (!isRecord(value)) return false
  const canonicalKeys = new Set([
    'responseMode',
    'showToolActivity',
    'approvalChannel',
    'editIntervalMs',
    'accessMode',
    'allowedSenderIds',
  ])
  const keys = Object.keys(value)
  return (
    keys.length === canonicalKeys.size &&
    keys.every((key) => canonicalKeys.has(key)) &&
    (value.responseMode === 'streaming' || value.responseMode === 'progress' || value.responseMode === 'final_only') &&
    typeof value.showToolActivity === 'boolean' &&
    (value.approvalChannel === 'chat' || value.approvalChannel === 'app') &&
    typeof value.editIntervalMs === 'number' &&
    (value.accessMode === 'inherit' || value.accessMode === 'allow-list' || value.accessMode === 'open') &&
    Array.isArray(value.allowedSenderIds) &&
    value.allowedSenderIds.every((id) => typeof id === 'string')
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
