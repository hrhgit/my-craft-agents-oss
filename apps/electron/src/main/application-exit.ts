import type { SavedWindow } from './window-state'

interface ExitManagedWindow {
  role: 'main' | 'child-session' | 'auxiliary'
  parentWebContentsId?: number
  window: {
    isDestroyed(): boolean
    webContents: { id: number }
  }
}

export interface GracefulExitWindowManager {
  getAllWindows(): ExitManagedWindow[]
  closeWindowGracefully(webContentsId: number): Promise<void>
}

interface RestoredWindow {
  setBounds(bounds: SavedWindow['bounds']): void
  webContents: { id: number }
}

interface RecoverableManagedWindow extends ExitManagedWindow {
  workspaceId: string
  sessionId?: string
  parentWebContentsId?: number
  customTitle?: string
  window: ExitManagedWindow['window'] & {
    getBounds(): SavedWindow['bounds']
    webContents: { id: number; getURL(): string }
  }
}

export interface RecoverableExitWindowManager {
  getAllWindows(): RecoverableManagedWindow[]
  getWindowStates(): SavedWindow[]
  createWindow(options: {
    workspaceId: string
    focused?: boolean
    restoreUrl?: string
  }): RestoredWindow
  createChildSessionWindow(sessionId: string, options: {
    workspaceId: string
    title?: string
    width: number
    height: number
    parentWebContentsId?: number
  }): RestoredWindow
}

export interface RecoverableWindowSnapshot {
  sourceWebContentsId: number
  role: 'main' | 'child-session'
  workspaceId: string
  bounds: SavedWindow['bounds']
  url?: string
  focused?: boolean
  sessionId?: string
  customTitle?: string
  parentSourceWebContentsId?: number
}

export type BeforeQuitDecision = 'start' | 'wait' | 'allow'

/**
 * Electron does not await async before-quit listeners. This gate keeps a
 * second quit request from bypassing an in-flight renderer flush while still
 * allowing the final, explicitly committed app.quit() call through.
 */
export class BeforeQuitGate {
  private phase: 'idle' | 'preparing' | 'committed' = 'idle'

  enter(event: { preventDefault(): void }): BeforeQuitDecision {
    if (this.phase === 'committed') return 'allow'
    event.preventDefault()
    if (this.phase === 'preparing') return 'wait'
    this.phase = 'preparing'
    return 'start'
  }

  cancel(): void {
    this.phase = 'idle'
  }

  commit(): void {
    this.phase = 'committed'
  }

  isPreparing(): boolean {
    return this.phase === 'preparing'
  }
}

export type UpdateQuitRollback = () => void | Promise<void>

/** Idempotent recovery shared by thrown and event-reported updater failures. */
export class UpdateQuitRecovery {
  private failed = false
  private failure: unknown
  private recoveryPromise: Promise<void> | null = null

  constructor(private readonly rollback: void | UpdateQuitRollback) {}

  fail(error: unknown, markFailed: (error: unknown) => void): Promise<void> {
    if (!this.failed) {
      this.failed = true
      this.failure = error
      markFailed(error)
      this.recoveryPromise = Promise.resolve().then(() => this.rollback?.())
    }
    return this.recoveryPromise ?? Promise.resolve()
  }

  getFailure(): unknown | null {
    return this.failed ? this.failure : null
  }
}

export function updateQuitFailureWithRecovery(
  installError: unknown,
  recoveryError: unknown,
): AggregateError {
  return new AggregateError(
    [installError, recoveryError],
    'Update installation failed and the application window could not be restored',
  )
}

export interface UpdateQuitTransactionOptions {
  prepare: () => void | UpdateQuitRollback | Promise<void | UpdateQuitRollback>
  install: () => void
  markFailed: (error: unknown) => void
  onPrepared?: (recovery: UpdateQuitRecovery) => void
}

/** Run update preparation and synchronously hand off to electron-updater. */
export async function runUpdateQuitTransaction({
  prepare,
  install,
  markFailed,
  onPrepared,
}: UpdateQuitTransactionOptions): Promise<void> {
  let rollback: void | UpdateQuitRollback
  try {
    rollback = await prepare()
  } catch (error) {
    markFailed(error)
    throw error
  }

  const recovery = new UpdateQuitRecovery(rollback)
  onPrepared?.(recovery)
  try {
    install()
  } catch (error) {
    // Restore observable update state before windows are recreated so a new
    // renderer never boots into a stale "installing" state.
    try {
      await recovery.fail(error, markFailed)
    } catch (rollbackError) {
      throw updateQuitFailureWithRecovery(error, rollbackError)
    }
    throw error
  }

  // electron-updater may emit an error synchronously and return instead of
  // throwing. The event handler records it on the shared recovery object.
  const eventFailure = recovery.getFailure()
  if (eventFailure !== null) {
    try {
      await recovery.fail(eventFailure, markFailed)
    } catch (recoveryError) {
      throw updateQuitFailureWithRecovery(eventFailure, recoveryError)
    }
    throw eventFailure
  }
}

/** Capture in-process recovery data without adding child windows to window-state.json. */
export function captureRecoverableWindowSnapshot(
  windowManager: RecoverableExitWindowManager | null | undefined,
): RecoverableWindowSnapshot[] {
  if (!windowManager) return []
  const savedMains = windowManager.getWindowStates()
  let mainIndex = 0

  return windowManager.getAllWindows().flatMap((managed): RecoverableWindowSnapshot[] => {
    if (managed.role === 'auxiliary') return []
    const sourceWebContentsId = managed.window.webContents.id
    const bounds = managed.window.getBounds()
    if (managed.role === 'main') {
      const saved = savedMains[mainIndex++]
      return [{
        sourceWebContentsId,
        role: 'main',
        workspaceId: managed.workspaceId,
        bounds,
        url: managed.window.webContents.getURL() || saved?.url,
        focused: saved?.focused,
      }]
    }
    return [{
      sourceWebContentsId,
      role: 'child-session',
      workspaceId: managed.workspaceId,
      bounds,
      url: managed.window.webContents.getURL() || undefined,
      sessionId: managed.sessionId,
      customTitle: managed.customTitle,
      parentSourceWebContentsId: managed.parentWebContentsId,
    }]
  })
}

function mainWindowKey(workspaceId: string, url: string | undefined): string {
  return JSON.stringify([workspaceId, url ?? ''])
}

/** Recreate main and child windows lost during a cancelled in-process quit. */
export function restoreRecoverableWindows(
  windowManager: RecoverableExitWindowManager | null | undefined,
  snapshot: readonly RecoverableWindowSnapshot[],
): number {
  if (!windowManager || snapshot.length === 0) return 0

  const current = windowManager.getAllWindows()
  const currentBySourceId = new Map(current.map(managed => [managed.window.webContents.id, managed]))
  const currentMainsByKey = new Map<string, RecoverableManagedWindow[]>()
  for (const managed of current) {
    if (managed.role !== 'main') continue
    const key = mainWindowKey(managed.workspaceId, managed.window.webContents.getURL() || undefined)
    const matches = currentMainsByKey.get(key) ?? []
    matches.push(managed)
    currentMainsByKey.set(key, matches)
  }

  const restoredIds = new Map<number, number>()
  const matchedCurrentIds = new Set<number>()
  let restored = 0
  for (const saved of snapshot.filter(item => item.role === 'main')) {
    const exact = currentBySourceId.get(saved.sourceWebContentsId)
    if (exact?.role === 'main') {
      restoredIds.set(saved.sourceWebContentsId, exact.window.webContents.id)
      matchedCurrentIds.add(exact.window.webContents.id)
      continue
    }

    const keyMatches = currentMainsByKey.get(mainWindowKey(saved.workspaceId, saved.url)) ?? []
    const equivalent = keyMatches.find(candidate => !matchedCurrentIds.has(candidate.window.webContents.id))
    if (equivalent) {
      restoredIds.set(saved.sourceWebContentsId, equivalent.window.webContents.id)
      matchedCurrentIds.add(equivalent.window.webContents.id)
      continue
    }

    const window = windowManager.createWindow({
      workspaceId: saved.workspaceId,
      focused: saved.focused,
      restoreUrl: saved.url,
    })
    window.setBounds(saved.bounds)
    restoredIds.set(saved.sourceWebContentsId, window.webContents.id)
    restored += 1
  }

  for (const saved of snapshot.filter(item => item.role === 'child-session')) {
    const exact = currentBySourceId.get(saved.sourceWebContentsId)
    if (exact?.role === 'child-session') {
      restoredIds.set(saved.sourceWebContentsId, exact.window.webContents.id)
      continue
    }
    if (!saved.sessionId) continue

    const parentWebContentsId = saved.parentSourceWebContentsId == null
      ? undefined
      : restoredIds.get(saved.parentSourceWebContentsId)
    const window = windowManager.createChildSessionWindow(saved.sessionId, {
      workspaceId: saved.workspaceId,
      title: saved.customTitle,
      width: saved.bounds.width,
      height: saved.bounds.height,
      parentWebContentsId,
    })
    window.setBounds(saved.bounds)
    restoredIds.set(saved.sourceWebContentsId, window.webContents.id)
    restored += 1
  }
  return restored
}

export interface CommittedExitCleanup {
  name: string
  run: () => void | Promise<void>
}

/** Cleanup is best-effort after windows close; failure must not strand the process. */
export async function runCommittedExit(
  cleanups: readonly CommittedExitCleanup[],
  onCleanupError: (name: string, error: unknown) => void,
  finalize: () => void | Promise<void>,
): Promise<void> {
  for (const cleanup of cleanups) {
    try {
      await cleanup.run()
    } catch (error) {
      try {
        onCleanupError(cleanup.name, error)
      } catch {
        // Logging must never become another reason to strand a committed exit.
      }
    }
  }
  await finalize()
}

/**
 * Build a stable post-order close plan so every descendant flushes before its
 * ancestor can trigger WindowManager's cascading child close behavior.
 * Invalid orphan/cyclic graphs degrade deterministically without duplication.
 */
export function buildGracefulWindowCloseOrder(
  windows: readonly ExitManagedWindow[],
): ExitManagedWindow[] {
  const candidates = windows.filter(managed => managed.role !== 'auxiliary')
  const byId = new Map(candidates.map(managed => [managed.window.webContents.id, managed]))
  const childrenByParent = new Map<number, ExitManagedWindow[]>()
  for (const managed of candidates) {
    const parentId = managed.parentWebContentsId
    if (parentId == null || !byId.has(parentId)) continue
    const children = childrenByParent.get(parentId) ?? []
    children.push(managed)
    childrenByParent.set(parentId, children)
  }

  const state = new Map<number, 'visiting' | 'done'>()
  const ordered: ExitManagedWindow[] = []
  const visit = (managed: ExitManagedWindow) => {
    const id = managed.window.webContents.id
    const currentState = state.get(id)
    if (currentState === 'done' || currentState === 'visiting') return
    state.set(id, 'visiting')
    for (const child of childrenByParent.get(id) ?? []) visit(child)
    state.set(id, 'done')
    ordered.push(managed)
  }

  for (const managed of candidates) visit(managed)
  return ordered
}

export async function closeRendererWindowsGracefully(
  windowManager: GracefulExitWindowManager | null | undefined,
): Promise<void> {
  if (!windowManager) return

  const roots = buildGracefulWindowCloseOrder(windowManager.getAllWindows())
  for (const managed of roots) {
    if (!managed.window.isDestroyed()) {
      await windowManager.closeWindowGracefully(managed.window.webContents.id)
    }
  }

  // Defensive cleanup for an orphan auxiliary whose owner disappeared.
  for (const managed of windowManager.getAllWindows()) {
    if (!managed.window.isDestroyed()) {
      await windowManager.closeWindowGracefully(managed.window.webContents.id)
    }
  }
}
