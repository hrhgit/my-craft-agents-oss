import { randomUUID } from 'node:crypto'
import type { BrowserWindow, OpenDialogOptions, SaveDialogOptions } from 'electron'
import { UI_VALIDATION_DEFAULT_TIMEOUT_MS, UI_VALIDATION_MAX_WAIT_MS } from '@craft-agent/shared/ui-validation'
import { ElectronUiDriverError } from './electron-surface-driver'

export type NativeDialogKind = 'open-file' | 'open-directory' | 'save-file'
export type NativeDialogPhase = 'opening' | 'completed' | 'error'

export interface NativeDialogRecord {
  dialogId: string
  kind: NativeDialogKind
  phase: NativeDialogPhase
  openedAt: string
  completedAt?: string
  canceled?: boolean
  selectionCount?: number
  error?: string
}

export interface NativeDialogApi {
  showOpenDialog(window: BrowserWindow, options: OpenDialogOptions): Promise<{ canceled: boolean; filePaths: string[] }>
  showSaveDialog(window: BrowserWindow, options: SaveDialogOptions): Promise<{ canceled: boolean; filePath?: string }>
}

const MAX_RECORDS = 16

export class ElectronNativeDialogAdapter {
  private readonly records = new Map<string, NativeDialogRecord>()
  private readonly waiters = new Map<string, Set<(record: NativeDialogRecord) => void>>()
  private activeDialogId?: string

  constructor(
    private readonly api: NativeDialogApi,
    private readonly onChanged: (record: NativeDialogRecord) => void = () => undefined,
  ) {}

  open(window: BrowserWindow, input: { kind: NativeDialogKind; title?: string }): NativeDialogRecord {
    if (this.activeDialogId) throw new ElectronUiDriverError('NOT_READY', 'A native dialog is already active.', { dialogId: this.activeDialogId })
    if (window.isDestroyed()) throw new ElectronUiDriverError('WINDOW_GONE', 'Cannot open a native dialog for a destroyed window.')
    const kind = input.kind
    if (!['open-file', 'open-directory', 'save-file'].includes(kind)) {
      throw new ElectronUiDriverError('UNSUPPORTED', `Unsupported native dialog kind: ${String(kind)}`)
    }
    const title = boundedTitle(input.title)
    const record: NativeDialogRecord = { dialogId: randomUUID(), kind, phase: 'opening', openedAt: new Date().toISOString() }
    this.activeDialogId = record.dialogId
    this.remember(record)

    const operation = kind === 'save-file'
      ? this.api.showSaveDialog(window, { ...(title ? { title } : {}) })
          .then(result => ({ canceled: result.canceled, selectionCount: result.filePath ? 1 : 0 }))
      : this.api.showOpenDialog(window, {
          ...(title ? { title } : {}),
          properties: kind === 'open-directory' ? ['openDirectory'] : ['openFile'],
        }).then(result => ({ canceled: result.canceled, selectionCount: result.filePaths.length }))

    void operation.then(
      result => this.complete(record.dialogId, { phase: 'completed', ...result }),
      error => this.complete(record.dialogId, { phase: 'error', error: error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000) }),
    )
    return structuredClone(record)
  }

  status(dialogId?: string): NativeDialogRecord | { activeDialogId?: string; records: NativeDialogRecord[] } {
    if (dialogId) {
      const record = this.records.get(dialogId)
      if (!record) throw new ElectronUiDriverError('TARGET_NOT_FOUND', `Unknown native dialog ${dialogId}.`)
      return structuredClone(record)
    }
    return { ...(this.activeDialogId ? { activeDialogId: this.activeDialogId } : {}), records: [...this.records.values()].map(item => structuredClone(item)) }
  }

  async wait(
    dialogId: string,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<NativeDialogRecord> {
    const current = this.records.get(dialogId)
    if (!current) throw new ElectronUiDriverError('TARGET_NOT_FOUND', `Unknown native dialog ${dialogId}.`)
    if (current.phase !== 'opening') return structuredClone(current)
    const timeoutMs = options.timeoutMs ?? UI_VALIDATION_DEFAULT_TIMEOUT_MS
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > UI_VALIDATION_MAX_WAIT_MS) {
      throw new ElectronUiDriverError('INVALID_REQUEST', `Native dialog wait timeout must be between 1 and ${UI_VALIDATION_MAX_WAIT_MS}ms.`)
    }

    return await new Promise<NativeDialogRecord>((resolveWait, rejectWait) => {
      const finish = (record: NativeDialogRecord) => {
        cleanup()
        resolveWait(structuredClone(record))
      }
      const onAbort = () => {
        cleanup()
        rejectWait(new ElectronUiDriverError('DRIVER_DISCONNECTED', 'Native dialog wait was aborted.'))
      }
      const cleanup = () => {
        clearTimeout(timeout)
        options.signal?.removeEventListener('abort', onAbort)
        const listeners = this.waiters.get(dialogId)
        listeners?.delete(finish)
        if (listeners?.size === 0) this.waiters.delete(dialogId)
      }
      const timeout = setTimeout(() => {
        cleanup()
        rejectWait(new ElectronUiDriverError('TIMEOUT', `Native dialog ${dialogId} did not complete within ${timeoutMs}ms.`))
      }, timeoutMs)
      const listeners = this.waiters.get(dialogId) ?? new Set()
      listeners.add(finish)
      this.waiters.set(dialogId, listeners)
      options.signal?.addEventListener('abort', onAbort, { once: true })

      // Close the gap between the initial state check and waiter registration.
      const latest = this.records.get(dialogId)
      if (latest && latest.phase !== 'opening') finish(latest)
    })
  }

  private complete(dialogId: string, update: Pick<NativeDialogRecord, 'phase'> & Partial<Pick<NativeDialogRecord, 'canceled' | 'selectionCount' | 'error'>>): void {
    const current = this.records.get(dialogId)
    if (!current) return
    const next: NativeDialogRecord = { ...current, ...update, completedAt: new Date().toISOString() }
    this.records.set(dialogId, next)
    if (this.activeDialogId === dialogId) this.activeDialogId = undefined
    this.onChanged(structuredClone(next))
    for (const resolveWait of this.waiters.get(dialogId) ?? []) resolveWait(next)
  }

  private remember(record: NativeDialogRecord): void {
    this.records.set(record.dialogId, record)
    while (this.records.size > MAX_RECORDS) this.records.delete(this.records.keys().next().value!)
    this.onChanged(structuredClone(record))
  }
}

function boundedTitle(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length < 1 || value.length > 200) {
    throw new ElectronUiDriverError('INVALID_REQUEST', 'Native dialog title must contain 1 to 200 characters.')
  }
  return value
}
