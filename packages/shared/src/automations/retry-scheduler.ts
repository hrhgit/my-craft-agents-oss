/**
 * RetryScheduler - Persistent retry queue for failed webhooks
 *
 * When immediate retries (seconds-scale) are exhausted and a webhook still fails,
 * it's added to a persistent JSONL queue file. The scheduler checks the queue
 * every 60 seconds and retries at increasing intervals:
 *   - 1st deferred: 5 minutes
 *   - 2nd deferred: 30 minutes
 *   - 3rd deferred: 1 hour
 *
 * After all deferred attempts fail, the entry is removed and a final history
 * entry is written. Queue entries survive app restarts.
 */

import { readFile, appendFile } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'node:crypto';
import { createLogger } from '../utils/debug.ts';
import { atomicWriteFileSync } from '../utils/files.ts';
import { withFileLock } from '../storage/index.ts';
import { executeWebhookRequest, createWebhookHistoryEntry } from './webhook-utils.ts';
import { AUTOMATIONS_RETRY_QUEUE_FILE } from './constants.ts';
import { appendAutomationHistoryEntry } from './history-store.ts';
import type { WebhookAction, WebhookActionResult } from './types.ts';

const log = createLogger('retry-scheduler');

// Deferred retry delays: 5m, 30m, 1h
const DEFERRED_DELAYS_MS = [
  5 * 60_000,    // 5 minutes
  30 * 60_000,   // 30 minutes
  60 * 60_000,   // 1 hour
];

const MAX_DEFERRED_ATTEMPTS = DEFERRED_DELAYS_MS.length;

/** Queue tick interval (how often we check the queue file) */
const TICK_INTERVAL_MS = 60_000; // 1 minute

// ============================================================================
// Queue Entry
// ============================================================================

export interface RetryQueueEntry {
  /** Unique entry ID */
  id: string;
  /** Matcher ID (for history correlation) */
  matcherId: string;
  /** The webhook action with expanded values (no env vars needed at retry time) */
  action: WebhookAction;
  /** Expanded URL (post-env-expansion) for safe logging */
  expandedUrl: string;
  /** Number of deferred attempts already made (0 = first deferred pending) */
  deferredAttempt: number;
  /** Timestamp when the next retry should happen */
  nextRetryAt: number;
  /** Timestamp when this entry was created */
  createdAt: number;
  /** Last error message */
  lastError?: string;
  /** Cross-process claim lease. Expired leases are reclaimable after crashes. */
  leaseOwner?: string;
  leaseExpiresAt?: number;
}

// ============================================================================
// RetryScheduler
// ============================================================================

export interface RetrySchedulerOptions {
  workspaceRootPath: string;
}

export class RetryScheduler {
  private readonly workspaceRootPath: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private processing = false;
  private readonly workerId = `retry-${process.pid}-${randomUUID()}`;

  constructor(options: RetrySchedulerOptions) {
    this.workspaceRootPath = options.workspaceRootPath;
  }

  /**
   * Start the scheduler. Checks queue every minute.
   */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_INTERVAL_MS);
    log.debug('[RetryScheduler] Started');
    // Run an initial tick after a short delay (don't block startup)
    setTimeout(() => this.tick(), 5_000);
  }

  /**
   * Stop the scheduler and clean up.
   */
  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    log.debug('[RetryScheduler] Disposed');
  }

  /**
   * Enqueue a failed webhook for deferred retry.
   * Called by WebhookHandler when immediate retries are exhausted.
   */
  async enqueue(
    matcherId: string,
    action: WebhookAction,
    expandedUrl: string,
    lastError?: string,
  ): Promise<void> {
    const entry: RetryQueueEntry = {
      id: `${matcherId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      matcherId,
      action,
      expandedUrl,
      deferredAttempt: 0,
      nextRetryAt: Date.now() + DEFERRED_DELAYS_MS[0]!,
      createdAt: Date.now(),
      lastError,
    };

    const queuePath = join(this.workspaceRootPath, AUTOMATIONS_RETRY_QUEUE_FILE);
    await withFileLock(queuePath, () => appendFile(queuePath, JSON.stringify(entry) + '\n', 'utf-8'));
    log.debug(`[RetryScheduler] Enqueued ${entry.id} — next retry in ${DEFERRED_DELAYS_MS[0]! / 60_000}m`);
  }

  /**
   * Process the queue: read entries, retry those that are due, rewrite the queue.
   */
  private async tick(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      const queuePath = join(this.workspaceRootPath, AUTOMATIONS_RETRY_QUEUE_FILE);

      const now = Date.now();
      const claimed = await withFileLock(queuePath, async () => {
        const entries = await this.readQueue(queuePath);
        const selected: RetryQueueEntry[] = [];
        const leased = entries.map(entry => {
          const leaseExpired = !entry.leaseExpiresAt || entry.leaseExpiresAt <= now;
          if (entry.nextRetryAt > now || !leaseExpired) return entry;
          const claimedEntry = {
            ...entry,
            leaseOwner: this.workerId,
            leaseExpiresAt: now + 120_000,
          };
          selected.push(claimedEntry);
          return claimedEntry;
        });
        if (selected.length > 0) this.writeQueue(queuePath, leased);
        return selected;
      });

      for (const entry of claimed) {

        // Attempt retry
        log.debug(`[RetryScheduler] Retrying ${entry.id} (deferred attempt ${entry.deferredAttempt + 1}/${MAX_DEFERRED_ATTEMPTS})`);
        let result: WebhookActionResult;
        try {
          result = await executeWebhookRequest(entry.action, { timeoutMs: 30_000 });
        } catch (err) {
          result = {
            type: 'webhook',
            url: entry.expandedUrl,
            statusCode: 0,
            success: false,
            error: err instanceof Error ? err.message : 'Unknown error',
          };
        }

        if (result.success) {
          // Success — write history entry and drop from queue
          log.debug(`[RetryScheduler] ${entry.id} succeeded on deferred attempt ${entry.deferredAttempt + 1}`);
          const historyEntry = createWebhookHistoryEntry({
            matcherId: entry.matcherId,
            ok: true,
            method: entry.action.method,
            url: entry.expandedUrl,
            statusCode: result.statusCode,
            durationMs: result.durationMs ?? 0,
            attempts: entry.deferredAttempt + 1,
          });
          try {
            await appendAutomationHistoryEntry(this.workspaceRootPath, historyEntry);
          } catch (e) {
            log.debug(`[RetryScheduler] Failed to write history: ${e}`);
          }
          await this.settleClaim(queuePath, entry, null);
        } else if (entry.deferredAttempt + 1 >= MAX_DEFERRED_ATTEMPTS) {
          // Final attempt failed — write permanent failure to history
          log.debug(`[RetryScheduler] ${entry.id} permanently failed after ${MAX_DEFERRED_ATTEMPTS} deferred attempts`);
          const historyEntry = createWebhookHistoryEntry({
            matcherId: entry.matcherId,
            ok: false,
            method: entry.action.method,
            url: entry.expandedUrl,
            statusCode: result.statusCode,
            durationMs: result.durationMs ?? 0,
            attempts: entry.deferredAttempt + 1,
            error: result.error ?? 'Unknown error',
          });
          try {
            await appendAutomationHistoryEntry(this.workspaceRootPath, historyEntry);
          } catch (e) {
            log.debug(`[RetryScheduler] Failed to write history: ${e}`);
          }
          await this.settleClaim(queuePath, entry, null);
        } else {
          // Still retryable — schedule next deferred attempt
          const nextDelay = DEFERRED_DELAYS_MS[entry.deferredAttempt + 1]!;
          const retry: RetryQueueEntry = {
            ...entry,
            deferredAttempt: entry.deferredAttempt + 1,
            nextRetryAt: Date.now() + nextDelay,
            lastError: result.error,
          };
          delete retry.leaseOwner;
          delete retry.leaseExpiresAt;
          await this.settleClaim(queuePath, entry, retry);
          log.debug(`[RetryScheduler] ${entry.id} failed — next retry in ${nextDelay / 60_000}m`);
        }
      }
    } catch (err) {
      log.debug(`[RetryScheduler] Tick error: ${err}`);
    } finally {
      this.processing = false;
    }
  }

  private async readQueue(queuePath: string): Promise<RetryQueueEntry[]> {
    let raw: string;
    try {
      raw = await readFile(queuePath, 'utf-8');
    } catch {
      return [];
    }
    const entries: RetryQueueEntry[] = [];
    for (const line of raw.trim().split('\n').filter(Boolean)) {
      try { entries.push(JSON.parse(line) as RetryQueueEntry); } catch { /* drop malformed lines */ }
    }
    return entries;
  }

  private writeQueue(queuePath: string, entries: RetryQueueEntry[]): void {
    const content = entries.length > 0
      ? entries.map(entry => JSON.stringify(entry)).join('\n') + '\n'
      : '';
    atomicWriteFileSync(queuePath, content);
  }

  private async settleClaim(
    queuePath: string,
    claimed: RetryQueueEntry,
    replacement: RetryQueueEntry | null,
  ): Promise<void> {
    await withFileLock(queuePath, async () => {
      const entries = await this.readQueue(queuePath);
      const index = entries.findIndex(entry =>
        entry.id === claimed.id && entry.leaseOwner === this.workerId
      );
      if (index < 0) return;
      if (replacement) entries[index] = replacement;
      else entries.splice(index, 1);
      this.writeQueue(queuePath, entries);
    });
  }

}
