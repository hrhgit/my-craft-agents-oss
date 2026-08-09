import type { StoredSession, SessionHeader } from './types.js'
import {
  ensureSharedPiTreeSessionFileAsync,
  ensureSessionsDir,
  ensureSessionDir,
} from './storage.js'
import { toPortablePath } from '../utils/paths.js'
import { readSessionHeader } from './jsonl.js'
import { debug } from '../utils/debug.js'
import { existsSync } from 'node:fs'

interface PendingWrite {
  data: StoredSession
  timer: ReturnType<typeof setTimeout>
}

interface HeaderMetadataSignature {
  name?: string
  hasUnread?: boolean
  lastReadMessageId?: string
}

export class SessionPersistenceError extends Error {
  readonly code = 'SESSION_PERSISTENCE_FAILED' as const
  readonly retryable: boolean
  readonly sessionId: string
  readonly cause: unknown
  readonly data: { sessionId: string; retryable: boolean }

  constructor(sessionId: string, cause: unknown) {
    super(`Failed to persist session ${sessionId}: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'SessionPersistenceError'
    this.retryable = (cause as { retryable?: unknown } | null)?.retryable !== false
    this.sessionId = sessionId
    this.cause = cause
    this.data = { sessionId, retryable: this.retryable }
  }
}

class CanonicalSessionHeaderRejectedError extends Error {
  readonly code = 'SESSION_HEADER_REJECTED' as const
  readonly retryable = false

  constructor(treeFilePath: string) {
    super(`Canonical Session header was rejected after metadata write: ${treeFilePath}`)
    this.name = 'CanonicalSessionHeaderRejectedError'
  }
}

class CanonicalSessionMetadataMismatchError extends Error {
  readonly code = 'SESSION_METADATA_MISMATCH' as const
  readonly retryable = false

  constructor(treeFilePath: string, intended: string, persisted: string) {
    super(`Canonical Session metadata does not match the requested durable state: ${treeFilePath} (intended=${intended}, persisted=${persisted})`)
    this.name = 'CanonicalSessionMetadataMismatchError'
  }
}

function getHeaderMetadataSignature(header: SessionHeader): string {
  const signature: HeaderMetadataSignature = {
    name: header.name,
    hasUnread: header.hasUnread,
    lastReadMessageId: header.lastReadMessageId,
  }
  return JSON.stringify(signature)
}

/**
 * Debounced async session persistence queue.
 * Prevents main thread blocking by using async writes and coalescing
 * rapid successive persist calls into a single write.
 *
 * IMPORTANT: Writes are serialized per-session to prevent race conditions
 * when rapid successive flushes (e.g., clearSessionForRecovery + onSdkSessionIdUpdate)
 * would otherwise write to the same .tmp file concurrently.
 */
class SessionPersistenceQueue {
  private static readonly CANCELLED_TOMBSTONE_TTL_MS = 5 * 60 * 1000

  private pending = new Map<string, PendingWrite>()
  private writeInProgress = new Map<string, Promise<void>>()
  private lastWrittenHeaderSignature = new Map<string, string>()
  private failedWrites = new Map<string, SessionPersistenceError>()
  private cancelling = new Set<string>()
  private cancelled = new Map<string, number>()
  private debounceMs: number

  constructor(debounceMs = 500) {
    this.debounceMs = debounceMs
  }

  /**
   * Queue a session for persistence. If a write is already pending for this
   * session, it will be replaced with the new data and the timer reset.
   */
  enqueue(session: StoredSession): void {
    const sessionId = session.mortiseId
    if (!sessionId) {
      console.error('[PersistenceQueue] Refusing to enqueue session without mortiseId')
      return
    }

    if (this.isCancelled(sessionId, session) || this.cancelling.has(sessionId)) {
      debug(`[PersistenceQueue] Ignoring enqueue for cancelled session ${sessionId}`)
      return
    }

    const normalizedSession: StoredSession = {
      ...session,
      mortiseId: sessionId,
    }

    const existing = this.pending.get(sessionId)
    if (existing) {
      clearTimeout(existing.timer)
    }

    const timer = setTimeout(() => {
      // Debounced writes are best-effort until a caller explicitly flushes;
      // retain the error for that flush rather than creating an unhandled
      // rejection from the timer callback.
      void this.trackWrite(sessionId).catch(() => {})
    }, this.debounceMs)

    this.pending.set(sessionId, { data: normalizedSession, timer })
  }

  private pruneCancelled(now = Date.now()): void {
    for (const [sessionId, cancelledAt] of this.cancelled) {
      if (now - cancelledAt > SessionPersistenceQueue.CANCELLED_TOMBSTONE_TTL_MS) {
        this.cancelled.delete(sessionId)
      }
    }
  }

  private isCancelled(sessionId: string, session: StoredSession): boolean {
    this.pruneCancelled()
    const cancelledAt = this.cancelled.get(sessionId)
    if (cancelledAt === undefined) return false

    // A newly created session that reuses the deleted ID must be persistable;
    // stale writes from the deleted session carry the older createdAt value.
    if (typeof session.createdAt === 'number' && session.createdAt > cancelledAt) {
      this.cancelled.delete(sessionId)
      return false
    }

    return true
  }

  private trackWrite(sessionId: string): Promise<void> {
    const previousWrite = this.writeInProgress.get(sessionId)
    const writePromise = (async () => {
      if (previousWrite) {
        await previousWrite
      }
      await this.write(sessionId)
    })()

    this.writeInProgress.set(sessionId, writePromise)
    void writePromise.then(
      () => {
        if (this.writeInProgress.get(sessionId) === writePromise) {
          this.writeInProgress.delete(sessionId)
        }
      },
      () => {
        if (this.writeInProgress.get(sessionId) === writePromise) {
          this.writeInProgress.delete(sessionId)
        }
      },
    )
    return writePromise
  }

  /**
   * Write a session to disk immediately in Pi tree JSONL v3 format.
   *
   * The write path is unconditionally Pi tree JSONL v3. Legacy Mortise JSONL
   * transcripts are neither accepted here nor read by the runtime storage
   * layer.
   *
   * Pi tree format:
   *   Line 1:  {type:"session", version:3, id, timestamp, cwd, mortise?: {...}}
   *   Line 2+: tree entries (message, compaction, branch_summary, etc.)
   *
   * Mortise-specific metadata is merged into the header's `mortise` field via
   * writeTreeSessionMortiseMetadata(). The Pi entry body is owned by the Pi
   * runtime and is not rewritten by Mortise.
   */
  private async write(sessionId: string): Promise<void> {
    const entry = this.pending.get(sessionId)
    if (!entry) return

    this.pending.delete(sessionId)

    try {
      const { data } = entry
      ensureSessionsDir(data.workspaceId)
      ensureSessionDir(data.workspaceId, sessionId)

      // Prepare session with portable paths for cross-machine compatibility
      const storageSession: StoredSession = {
        ...data,
        workspaceRootPath: toPortablePath(data.workspaceRootPath),
        sdkCwd: data.sdkCwd ? toPortablePath(data.sdkCwd) : toPortablePath(data.workspaceRootPath),
        lastUsedAt: data.lastUsedAt ?? Date.now(),
      }

      // Create/update the Pi tree JSONL file and merge Mortise metadata into its header.
      const intendedHeaderSignature = getHeaderMetadataSignature(storageSession as SessionHeader)
      const treeFilePath = await ensureSharedPiTreeSessionFileAsync(storageSession, {
        workspaceId: data.workspaceId,
        lastWrittenHeaderSignature: this.lastWrittenHeaderSignature.get(sessionId),
      })
      if (!existsSync(treeFilePath)) {
        // Ordinary pre-assistant Sessions remain drafts. Pi will atomically
        // publish the canonical JSONL when the first assistant message exists.
        this.failedWrites.delete(sessionId)
        return
      }
      const header = readSessionHeader(treeFilePath)
      if (!header) {
        throw new CanonicalSessionHeaderRejectedError(treeFilePath)
      }
      const persistedHeaderSignature = getHeaderMetadataSignature(header)
      if (persistedHeaderSignature !== intendedHeaderSignature) {
        throw new CanonicalSessionMetadataMismatchError(treeFilePath, intendedHeaderSignature, persistedHeaderSignature)
      }
      this.lastWrittenHeaderSignature.set(sessionId, persistedHeaderSignature)
      debug(`[PersistenceQueue] Updated Pi tree session metadata ${sessionId} -> ${treeFilePath}`)

      // Write succeeded — clear any previous failure flag for this session.
      this.failedWrites.delete(sessionId)
    } catch (error) {
      const persistenceError = new SessionPersistenceError(sessionId, error)
      this.failedWrites.set(sessionId, persistenceError)
      console.error(`[PersistenceQueue] ${persistenceError.message}`)
      throw persistenceError
    }
  }

  /**
   * Immediately flush a specific session if pending.
   * Waits for any in-progress write to complete before starting a new one
   * to prevent race conditions on the shared .tmp file.
   */
  async flush(sessionId: string): Promise<void> {
    const entry = this.pending.get(sessionId)
    if (entry) {
      clearTimeout(entry.timer)

      // Start new write and track it
      await this.trackWrite(sessionId)
    }

    const inProgress = this.writeInProgress.get(sessionId)
    if (inProgress) {
      await inProgress
    }
    const failure = this.failedWrites.get(sessionId)
    if (failure) throw failure
  }

  /**
   * Cancel a pending write for a session (e.g., when deleting the session).
   *
   * In addition to clearing the pending debounced timer, this also awaits any
   * in-progress write so the caller can safely delete the on-disk files
   * without the in-progress write resurrecting them (or their mortise metadata
   * sidecar) after this returns. Idempotent: multiple calls for the same
   * sessionId are safe.
   */
  async cancel(sessionId: string, options: { preventFutureEnqueue?: boolean } = {}): Promise<void> {
    this.pruneCancelled()
    if (options.preventFutureEnqueue) {
      this.cancelled.set(sessionId, Date.now())
    }
    this.cancelling.add(sessionId)
    try {
      const entry = this.pending.get(sessionId)
      if (entry) {
        clearTimeout(entry.timer)
      }

      // Wait for any in-progress write to complete so it cannot resurrect
      // files deleted by the caller (e.g. deleteSession) after this returns.
      const inProgress = this.writeInProgress.get(sessionId)
      if (inProgress) {
        await inProgress.catch(() => {})
      }

      // Delete after awaiting in-progress writes. Any enqueue that sneaks in
      // while cancel() is waiting is cleared here instead of firing later.
      const latestEntry = this.pending.get(sessionId)
      if (latestEntry) {
        clearTimeout(latestEntry.timer)
        this.pending.delete(sessionId)
        debug(`[PersistenceQueue] Cancelled pending write for session ${sessionId}`)
      }
      this.lastWrittenHeaderSignature.delete(sessionId)
      this.failedWrites.delete(sessionId)
    } finally {
      this.cancelling.delete(sessionId)
    }
  }

  /**
   * Flush all pending sessions. Call this on app quit.
   */
  async flushAll(): Promise<void> {
    const sessionIds = new Set([
      ...this.pending.keys(),
      ...this.writeInProgress.keys(),
    ])
    await Promise.all(Array.from(sessionIds, id => this.flush(id)))
  }

  /**
   * Check if a session has a pending write.
   */
  hasPending(sessionId: string): boolean {
    return this.pending.has(sessionId)
  }

  /**
   * Check if the most recent write for a session failed. Callers/monitoring
   * can inspect the latest failed write. Critical callers should use flush(),
   * which propagates the same typed error; this method is diagnostic only.
   */
  hasFailedWrite(sessionId: string): boolean {
    return this.failedWrites.has(sessionId)
  }

  /**
   * Get the metadata signature of the last header we wrote for a session.
   * Used by ConfigWatcher to suppress self-triggered metadata change events.
   */
  getLastWrittenSignature(sessionId: string): string | undefined {
    return this.lastWrittenHeaderSignature.get(sessionId)
  }

  /**
   * Get count of pending writes.
   */
  get pendingCount(): number {
    return this.pending.size
  }
}

// Singleton instance
export const sessionPersistenceQueue = new SessionPersistenceQueue()

// Named exports for testing/customization
export { SessionPersistenceQueue, getHeaderMetadataSignature }
