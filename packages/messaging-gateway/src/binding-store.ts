/**
 * BindingStore — workspace-scoped persistence for channel bindings.
 *
 * Stores bindings in an explicit storage directory (passed by the caller).
 * In Electron this is `~/.mortise/workspaces/{wsId}/messaging/`, but tests
 * can point it at any directory.
 */

import { randomUUID } from 'node:crypto'
import type { ChannelBinding, MessagingLogger, PlatformType, RawBindingConfig } from './types'
import { normalizeBindingConfig } from './types'
import { JsonFileStore, NOOP_LOGGER } from './json-file-store'

export class BindingStore extends JsonFileStore<ChannelBinding[]> {
  private bindings: ChannelBinding[] = []
  private changeListener?: () => void

  /** @param storageDir Absolute path to the directory where bindings.json is stored. */
  constructor(storageDir: string, logger: MessagingLogger = NOOP_LOGGER) {
    super(storageDir, 'bindings.json', logger)
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
    config?: RawBindingConfig,
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
      config: normalizeBindingConfig(platform, config),
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
  updateBindingConfig(bindingId: string, patch: RawBindingConfig): ChannelBinding | null {
    const binding = this.bindings.find((b) => b.id === bindingId)
    if (!binding) return null
    // binding.config is canonical BindingConfig (no legacy fields); merging with
    // the raw patch is safe because normalizeBindingConfig strips legacy keys.
    binding.config = normalizeBindingConfig(binding.platform, {
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
    const parsed = this.loadFile()
    if (Array.isArray(parsed)) {
      this.bindings = parsed.map(normalizeBinding)
    } else {
      this.bindings = []
    }
  }

  private save(): void {
    const ok = this.saveFile(this.bindings)
    // 仅在写入成功后触发 listener——否则 UI 会显示重启后消失的幻影 binding。
    if (ok) this.changeListener?.()
  }
}

// ---------------------------------------------------------------------------
// Migration helpers
// ---------------------------------------------------------------------------

function normalizeBinding(raw: ChannelBinding): ChannelBinding {
  return {
    ...raw,
    // Disk-persisted raw.config may still carry legacy `streamResponses`; cast
    // through RawBindingConfig so normalizeBindingConfig strips it before the
    // value reaches runtime code.
    config: normalizeBindingConfig(
      raw.platform,
      (raw.config ?? {}) as unknown as RawBindingConfig,
    ),
  }
}
