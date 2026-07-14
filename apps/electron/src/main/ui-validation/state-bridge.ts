import { ipcMain, type IpcMainEvent, type WebContents } from 'electron'
import {
  UI_VALIDATION_STATE_SCOPES,
  UiValidationScopedStateRegistry,
  type UiValidationScopedStateSnapshot,
  type UiValidationScopedStateUpdate,
  type UiValidationScopedWait,
  type UiValidationScopedWaitOptions,
  type UiValidationEventReadResult,
} from '@craft-agent/shared/ui-validation'
import type { UiValidationRendererStateBatch } from '../../shared/ui-validation-state-bridge'
import { PRELOAD_LOCAL_CHANNELS } from '../../shared/ipc-channels'

const MAX_BATCH_STATES = 2_000

export class ElectronUiValidationStateBridge {
  readonly registry = new UiValidationScopedStateRegistry(1_024)
  private readonly trackedSenders = new Set<number>()
  private installed = false

  install(options: { enabled: boolean; isPackaged: boolean }): void {
    if (!options.enabled) return
    if (options.isPackaged || process.env.NODE_ENV === 'production') {
      throw new Error('UI validation state IPC is forbidden in packaged or production runtime.')
    }
    if (this.installed) return
    this.installed = true
    ipcMain.on(PRELOAD_LOCAL_CHANNELS.UI_VALIDATION_STATE_PUBLISH, this.handlePublish)
    ipcMain.on(PRELOAD_LOCAL_CHANNELS.UI_VALIDATION_STATE_DISPOSE, this.handleDispose)
  }

  dispose(): void {
    if (!this.installed) return
    this.installed = false
    ipcMain.removeListener(PRELOAD_LOCAL_CHANNELS.UI_VALIDATION_STATE_PUBLISH, this.handlePublish)
    ipcMain.removeListener(PRELOAD_LOCAL_CHANNELS.UI_VALIDATION_STATE_DISPOSE, this.handleDispose)
  }

  snapshot(windowId?: number): UiValidationScopedStateSnapshot {
    const snapshot = this.registry.snapshot
    if (windowId === undefined) return snapshot
    return { ...snapshot, states: snapshot.states.filter(state => state.windowId === String(windowId)) }
  }

  events(options: { afterSeq?: number; limit?: number; types?: readonly string[] } = {}): UiValidationEventReadResult {
    return this.registry.readEvents(options)
  }

  async wait(predicate: UiValidationScopedWait, options: UiValidationScopedWaitOptions = {}) {
    return await this.registry.waitFor(predicate, options)
  }

  setNativeDriverState(webContentsId: number, phase: UiValidationScopedStateUpdate['phase'], detail?: Record<string, unknown>): void {
    this.registry.update({
      scope: 'native-driver',
      phase,
      detail: { platform: process.platform, adapter: process.platform === 'win32' ? 'windows-electron' : 'electron', ...detail },
    }, String(webContentsId))
  }

  private readonly handlePublish = (event: IpcMainEvent, payload: unknown): void => {
    const batch = validateBatch(payload)
    this.trackSender(event.sender)
    const windowId = String(event.sender.id)
    const incomingSessionIds = new Set(batch.states
      .filter(state => state.scope === 'session' && state.entityId)
      .map(state => state.entityId!))
    const incomingExtensionIds = new Set(batch.states
      .filter(state => state.scope === 'extension' && state.entityId)
      .map(state => state.entityId!))
    for (const existing of this.snapshot(event.sender.id).states) {
      if (existing.scope === 'session' && existing.entityId && existing.phase !== 'disposed' && !incomingSessionIds.has(existing.entityId)) {
        this.registry.update({ scope: 'session', entityId: existing.entityId, phase: 'disposed' }, windowId)
      }
      if (existing.scope === 'extension' && existing.entityId && existing.phase !== 'disposed' && !incomingExtensionIds.has(existing.entityId)) {
        this.registry.update({ scope: 'extension', entityId: existing.entityId, phase: 'disposed' }, windowId)
      }
    }
    this.registry.updateMany(batch.states, windowId)
    this.setNativeDriverState(event.sender.id, event.sender.isDestroyed() ? 'disposed' : 'ready', {
      destroyed: event.sender.isDestroyed(),
      loading: event.sender.isLoading(),
    })
  }

  private readonly handleDispose = (event: IpcMainEvent): void => {
    this.registry.disposeWindow(String(event.sender.id))
  }

  private trackSender(sender: WebContents): void {
    if (this.trackedSenders.has(sender.id)) return
    this.trackedSenders.add(sender.id)
    sender.once('destroyed', () => {
      this.trackedSenders.delete(sender.id)
      this.registry.disposeWindow(String(sender.id))
    })
    sender.once('render-process-gone', (_event, details) => {
      this.registry.update({
        scope: 'app',
        phase: 'error',
        error: { code: 'RENDERER_GONE', message: `Renderer process exited: ${details.reason}` },
      }, String(sender.id))
      this.setNativeDriverState(sender.id, 'error', { reason: details.reason, exitCode: details.exitCode })
    })
  }
}

let bridge: ElectronUiValidationStateBridge | undefined

export function installUiValidationStateBridge(options: { enabled: boolean; isPackaged: boolean }): ElectronUiValidationStateBridge | undefined {
  if (!options.enabled) return undefined
  bridge ??= new ElectronUiValidationStateBridge()
  bridge.install(options)
  return bridge
}

export function getUiValidationStateBridge(): ElectronUiValidationStateBridge | undefined {
  return bridge
}

function validateBatch(value: unknown): UiValidationRendererStateBatch {
  if (!value || typeof value !== 'object') throw new Error('UI validation state batch must be an object.')
  const batch = value as Partial<UiValidationRendererStateBatch>
  if (batch.version !== 1 || !Array.isArray(batch.states) || batch.states.length > MAX_BATCH_STATES) throw new Error('Invalid UI validation state batch.')
  for (const state of batch.states) validateUpdate(state)
  return batch as UiValidationRendererStateBatch
}

function validateUpdate(value: unknown): asserts value is UiValidationScopedStateUpdate {
  if (!value || typeof value !== 'object') throw new Error('Invalid UI validation scoped state.')
  const state = value as Partial<UiValidationScopedStateUpdate>
  if (!UI_VALIDATION_STATE_SCOPES.includes(state.scope as never)) throw new Error('Invalid UI validation state scope.')
  if (!['booting', 'loading', 'ready', 'busy', 'error', 'disposed'].includes(String(state.phase))) throw new Error('Invalid UI validation state phase.')
  if (state.entityId !== undefined && (typeof state.entityId !== 'string' || state.entityId.length > 300)) throw new Error('Invalid UI validation state entityId.')
  if (JSON.stringify(value).length > 32_000) throw new Error('UI validation scoped state is too large.')
}
