/**
 * AutomationSystem - Unified Facade for the Automations System
 *
 * Single entry point that:
 * - Creates EventBus instance (per workspace)
 * - Creates and registers all handlers
 * - Loads automations.json configuration
 * - Manages scheduler service
 * - Provides diffing for session metadata changes
 * - Provides dispose() for cleanup
 *
 * Benefits:
 * - No global state - each AutomationSystem instance is self-contained
 * - Easy to create for testing
 * - SessionManager uses ~30 lines instead of ~300
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveAutomationsConfigPath, generateShortId } from './resolve-config-path.ts';
import { compactAutomationHistorySync } from './history-store.ts';
import { createLogger } from '../utils/debug.ts';
import { WorkspaceEventBus, type EventPayloadMap } from './event-bus.ts';
import { PromptHandler, EventLogHandler, WebhookHandler, type AutomationsConfigProvider } from './handlers/index.ts';
import { type AutomationsConfig, type AutomationEvent, type AutomationMatcher, type PendingPrompt, type WebhookActionResult, type AppEvent, type AgentEvent, type AgentAutomationInput } from './types.ts';
import { validateAutomationsConfig } from './validation.ts';
import { matcherMatchesAgentEvent } from './utils.ts';
import { SchedulerService, type SchedulerTickPayload } from '../scheduler/scheduler-service.ts';
import { atomicWriteFileSync } from '../utils/files.ts';
import { withFileLockSync } from '../storage/index.ts';

const log = createLogger('automation-system');

const RETIRED_ORGANIZATION_EVENTS = new Set([
  'LabelAdd',
  'LabelRemove',
  'LabelConfigChange',
  'FlagChange',
  'SessionStatusChange',
  'TodoStateChange',
]);
const RETIRED_ORGANIZATION_FIELDS = new Set([
  'labels',
  'sessionStatus',
  'isFlagged',
  'isArchived',
  'archivedAt',
]);

function conditionReferencesRetiredField(condition: unknown): boolean {
  if (!condition || typeof condition !== 'object') return false;
  const value = condition as Record<string, unknown>;
  if (value.condition === 'state' && typeof value.field === 'string') {
    return RETIRED_ORGANIZATION_FIELDS.has(value.field);
  }
  return Array.isArray(value.conditions) && value.conditions.some(conditionReferencesRetiredField);
}

/** Remove legacy organization automations without broadening their trigger conditions. */
export function cleanRetiredOrganizationAutomations(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const root = raw as Record<string, unknown>;
  const eventMap = (root.automations ?? root.tasks ?? root.hooks) as Record<string, unknown> | undefined;
  if (!eventMap || typeof eventMap !== 'object') return false;

  let changed = false;
  for (const event of Object.keys(eventMap)) {
    if (RETIRED_ORGANIZATION_EVENTS.has(event)) {
      delete eventMap[event];
      changed = true;
      continue;
    }

    const matchers = eventMap[event];
    if (!Array.isArray(matchers)) continue;
    const retained = matchers.filter(matcher => {
      if (!matcher || typeof matcher !== 'object') return true;
      const value = matcher as Record<string, unknown>;
      const hasRetiredProperty = [...RETIRED_ORGANIZATION_FIELDS].some(field =>
        Object.prototype.hasOwnProperty.call(value, field)
      );
      const hasRetiredCondition = Array.isArray(value.conditions)
        && value.conditions.some(conditionReferencesRetiredField);
      return !hasRetiredProperty && !hasRetiredCondition;
    });
    if (retained.length !== matchers.length) {
      eventMap[event] = retained;
      changed = true;
    }
  }
  return changed;
}

// Re-export SessionMetadataSnapshot from types (single source of truth)
export type { SessionMetadataSnapshot } from './types.ts';
import type { SessionMetadataSnapshot } from './types.ts';

// ============================================================================
// AutomationSystem Options
// ============================================================================

export interface AutomationSystemOptions {
  /** Workspace root path (where automations.json lives) */
  workspaceRootPath: string;
  /** Workspace ID for logging and events */
  workspaceId: string;
  /** Working directory for command execution */
  workingDir?: string;
  /** Active source slugs for permission rules */
  activeSourceSlugs?: string[];
  /** Whether to start the scheduler service (default: false) */
  enableScheduler?: boolean;
  /** Called when prompts are ready to be executed */
  onPromptsReady?: (prompts: PendingPrompt[]) => void;
  /** Called when webhook results are available */
  onWebhookResults?: (results: WebhookActionResult[]) => void;
  /** Called when an error occurs during automation execution */
  onError?: (event: AutomationEvent, error: Error) => void;
  /** Called when events are lost after retries */
  onEventLost?: (events: string[], error: Error) => void;
  /**
   * 是否将 prompt automation 委托给 pi prompt-automation 扩展执行。
   * 对应配置项 `piExtensions.delegatePromptAutomation`，默认 false（mortise 自行处理）。
   * 启用后 prompt action 走 {@link onDelegatePrompts} 回调而非 {@link onPromptsReady}。
   */
  delegatePromptAutomation?: boolean;
  /**
   * 委托给 pi prompt-automation 扩展执行时的回调。
   * 仅当 {@link delegatePromptAutomation} 为 true 时被调用。
   */
  onDelegatePrompts?: (prompts: PendingPrompt[]) => void | Promise<void>;
}

// ============================================================================
// AutomationSystem Implementation
// ============================================================================

export class AutomationSystem implements AutomationsConfigProvider {
  readonly eventBus: WorkspaceEventBus;

  private readonly options: AutomationSystemOptions;
  private config: AutomationsConfig | null = null;
  private promptHandler: PromptHandler | null = null;
  private webhookHandler: WebhookHandler | null = null;
  private eventLogHandler: EventLogHandler | null = null;
  private scheduler: SchedulerService | null = null;
  private disposed = false;

  // Session metadata tracking (moved from SessionManager)
  private readonly lastKnownMetadata: Map<string, SessionMetadataSnapshot> = new Map();

  constructor(options: AutomationSystemOptions) {
    this.options = options;
    this.eventBus = new WorkspaceEventBus(options.workspaceId);

    // Load configuration
    this.loadConfig();

    // Create handlers
    this.createHandlers();

    // Start scheduler if enabled
    if (options.enableScheduler) {
      this.startScheduler();
    }

    log.debug(`[AutomationSystem] Created for workspace: ${options.workspaceId}`);
  }

  // ============================================================================
  // Configuration
  // ============================================================================

  /**
   * Read, parse, and validate automations.json. Shared pipeline for loadConfig/reloadConfig.
   * Returns the raw parsed JSON alongside validation results (avoids re-reading for backfillIds).
   */
  private readAndValidateConfig(configPath: string): { raw: unknown; validation: import('./types.ts').AutomationsValidationResult } {
    const raw = withFileLockSync(configPath, () => {
      const latest = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (cleanRetiredOrganizationAutomations(latest)) {
        atomicWriteFileSync(configPath, JSON.stringify(latest, null, 2) + '\n');
        log.debug('[AutomationSystem] Removed retired organization automations');
      }
      return latest;
    });
    const validation = validateAutomationsConfig(raw);
    return { raw, validation };
  }

  /**
   * Load automations configuration from automations.json.
   */
  private loadConfig(): void {
    const configPath = resolveAutomationsConfigPath(this.options.workspaceRootPath);

    if (!existsSync(configPath)) {
      log.debug(`[AutomationSystem] No automations config found at ${configPath}`);
      this.config = { automations: {} };
      return;
    }

    try {
      const { raw, validation } = this.readAndValidateConfig(configPath);

      if (!validation.valid) {
        console.warn('[AutomationSystem] Invalid automations config:', validation.errors);
        this.config = { automations: {} };
        return;
      }

      this.config = validation.config;
      this.backfillIds(configPath, raw);
      this.rotateHistory();
      const actionCount = this.getActionCount();
      log.debug(`[AutomationSystem] Loaded ${actionCount} actions from ${configPath}`);
    } catch (e) {
      const error = e instanceof Error ? e.message : 'Unknown error';
      console.warn('[AutomationSystem] Failed to load automations config:', error);
      this.config = { automations: {} };
    }
  }

  /**
   * Reload automations configuration.
   * Call this when automations.json changes.
   */
  reloadConfig(): { success: boolean; automationCount: number; errors: string[] } {
    const configPath = resolveAutomationsConfigPath(this.options.workspaceRootPath);

    if (!existsSync(configPath)) {
      this.config = { automations: {} };
      return { success: true, automationCount: 0, errors: [] };
    }

    try {
      const { raw, validation } = this.readAndValidateConfig(configPath);

      if (!validation.valid) {
        return { success: false, automationCount: 0, errors: validation.errors };
      }

      this.config = validation.config;
      this.backfillIds(configPath, raw);
      const actionCount = this.getActionCount();
      log.debug(`[AutomationSystem] Reloaded ${actionCount} actions`);
      return { success: true, automationCount: actionCount, errors: [] };
    } catch (e) {
      const error = e instanceof Error ? e.message : 'Unknown error';
      return { success: false, automationCount: 0, errors: [`Failed to parse JSON: ${error}`] };
    }
  }

  /**
   * Backfill missing IDs on matchers in the raw config.
   * Operates on the already-parsed raw JSON to avoid re-reading from disk.
   * Only writes if IDs were actually missing — no-op on subsequent loads.
   */
  private backfillIds(configPath: string, raw: unknown): void {
    try {
      void raw;
      withFileLockSync(configPath, () => {
        const latest = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
        const eventMap = (latest.automations ?? latest.tasks ?? latest.hooks) as Record<string, unknown[]> | undefined;
        if (!eventMap) return;

        let changed = false;
        for (const matchers of Object.values(eventMap)) {
          if (!Array.isArray(matchers)) continue;
          for (const m of matchers as Record<string, unknown>[]) {
            if (!m.id) { m.id = generateShortId(); changed = true; }
          }
        }

        if (changed) {
          atomicWriteFileSync(configPath, JSON.stringify(latest, null, 2) + '\n');
          log.debug('[AutomationSystem] Backfilled missing matcher IDs');
        }
      });
    } catch {
      // Non-critical — IDs will be backfilled on next mutation via IPC
    }
  }

  /**
   * Compact automations-history.jsonl on startup: two-tier retention.
   * 1) Keep only the last N entries per automation ID.
   * 2) If total still exceeds the global cap, drop oldest globally.
   * Runs synchronously during init — single-threaded, no race with concurrent appends.
   */
  private rotateHistory(): void {
    try {
      compactAutomationHistorySync(this.options.workspaceRootPath);
    } catch {
      // Non-critical — compaction failure doesn't affect functionality
    }
  }

  /**
   * Get total number of actions.
   */
  private getActionCount(): number {
    if (!this.config) return 0;
    return Object.values(this.config.automations).reduce(
      (sum, matchers) => sum + (matchers?.reduce((s, m) => s + m.actions.length, 0) ?? 0),
      0
    );
  }

  // ============================================================================
  // AutomationsConfigProvider Implementation
  // ============================================================================

  getConfig(): AutomationsConfig | null {
    return this.config;
  }

  getMatchersForEvent(event: AutomationEvent): AutomationMatcher[] {
    return this.config?.automations[event] ?? [];
  }

  // ============================================================================
  // Handlers
  // ============================================================================

  /**
   * Create and register all handlers.
   */
  private createHandlers(): void {
    // Prompt handler
    this.promptHandler = new PromptHandler(
      {
        workspaceId: this.options.workspaceId,
        workspaceRootPath: this.options.workspaceRootPath,
        onPromptsReady: this.options.onPromptsReady,
        onError: this.options.onError,
        delegatePromptAutomation: this.options.delegatePromptAutomation,
        onDelegatePrompts: this.options.onDelegatePrompts,
      },
      this
    );
    this.promptHandler.subscribe(this.eventBus);

    // Webhook handler
    this.webhookHandler = new WebhookHandler(
      {
        workspaceId: this.options.workspaceId,
        workspaceRootPath: this.options.workspaceRootPath,
        onWebhookResults: this.options.onWebhookResults,
        onError: this.options.onError,
      },
      this
    );
    this.webhookHandler.subscribe(this.eventBus);

    // Event log handler
    this.eventLogHandler = new EventLogHandler({
      workspaceRootPath: this.options.workspaceRootPath,
      workspaceId: this.options.workspaceId,
      onEventLost: this.options.onEventLost,
    });
    this.eventLogHandler.subscribe(this.eventBus);

    log.debug(`[AutomationSystem] Handlers created and subscribed`);
  }

  // ============================================================================
  // Scheduler
  // ============================================================================

  /**
   * Start the scheduler service.
   */
  private startScheduler(): void {
    if (this.scheduler) return;

    this.scheduler = new SchedulerService(async (payload: SchedulerTickPayload) => {
      await this.eventBus.emit('SchedulerTick', {
        workspaceId: this.options.workspaceId,
        timestamp: Date.now(),
        localTime: payload.localTime,
        utcTime: payload.timestamp,
      });
    });

    this.scheduler.start();
    log.debug(`[AutomationSystem] Scheduler started`);
  }

  /**
   * Stop the scheduler service.
   */
  stopScheduler(): void {
    if (this.scheduler) {
      this.scheduler.stop();
      this.scheduler = null;
      log.debug(`[AutomationSystem] Scheduler stopped`);
    }
  }

  // ============================================================================
  // Session Metadata Diffing
  // ============================================================================

  /**
   * Update session metadata and emit events for changes.
   *
   * This replaces the diffing logic that was in SessionManager.
   * Call this whenever session metadata changes.
   *
   * @param sessionId - The session ID
   * @param next - The new metadata snapshot
   * @returns The events that were emitted
   */
  async updateSessionMetadata(
    sessionId: string,
    next: SessionMetadataSnapshot
  ): Promise<AppEvent[]> {
    const prev = this.lastKnownMetadata.get(sessionId) ?? {};
    const emittedEvents: AppEvent[] = [];
    const timestamp = Date.now();

    // Common fields for all events
    const sessionName = next.sessionName;
    // Permission mode change
    if (prev.permissionMode !== next.permissionMode) {
      await this.eventBus.emit('PermissionModeChange', {
        sessionId,
        sessionName,
        workspaceId: this.options.workspaceId,
        timestamp,
        oldMode: prev.permissionMode ?? '',
        newMode: next.permissionMode ?? '',
      });
      emittedEvents.push('PermissionModeChange');
    }

    // Update stored metadata
    this.lastKnownMetadata.set(sessionId, { ...next });

    if (emittedEvents.length > 0) {
      log.debug(`[AutomationSystem] Emitted ${emittedEvents.length} events for session ${sessionId}: ${emittedEvents.join(', ')}`);
    }

    return emittedEvents;
  }

  /**
   * Remove session metadata tracking.
   * Call this when a session is deleted.
   */
  removeSessionMetadata(sessionId: string): void {
    this.lastKnownMetadata.delete(sessionId);
    log.debug(`[AutomationSystem] Removed metadata for session ${sessionId}`);
  }

  /**
   * Get stored metadata for a session.
   */
  getSessionMetadata(sessionId: string): SessionMetadataSnapshot | undefined {
    return this.lastKnownMetadata.get(sessionId);
  }

  /**
   * Set initial metadata for a session (without emitting events).
   * Call this when loading existing sessions.
   */
  setInitialSessionMetadata(sessionId: string, metadata: SessionMetadataSnapshot): void {
    this.lastKnownMetadata.set(sessionId, { ...metadata });
  }

  // ============================================================================
  // Direct Event Emission
  // ============================================================================

  /**
   * Emit an event directly (for edge cases).
   */
  async emit<T extends AutomationEvent>(event: T, payload: EventPayloadMap[T]): Promise<void> {
    await this.eventBus.emit(event, payload);
  }

  // ============================================================================
  // Agent Event Execution (Backend-Agnostic)
  // ============================================================================

  /**
   * Execute agent event automations directly from backend runtime events.
   * This is the backend-agnostic entry point for agent events from automations.json.
   *
   * For each matching automation matcher, builds env vars and evaluates matching.
   * Command execution has been removed — all automation actions now go through prompt-based
   * execution (creating agent sessions via PromptHandler).
   * Catches all errors — automations must never break the agent flow.
   *
   * @param signal - Optional AbortSignal for cancelling automation execution on abort
   * @returns Number of matched matchers (for diagnostics/testing)
   */
  async executeAgentEvent(event: AgentEvent, input: AgentAutomationInput, signal?: AbortSignal): Promise<number> {
    if (!this.config) return 0;

    const matchers = this.config.automations[event];
    if (!matchers?.length) return 0;

    let matchedCount = 0;

    for (const matcher of matchers) {
      if (!matcherMatchesAgentEvent(matcher, event, input)) continue;

      matchedCount++;

      // Note: Command execution has been removed. Prompt-based execution for
      // backend events is not yet implemented. This method currently only
      // validates matching (including condition gating) — actual execution is a no-op.
      log.debug(`[AutomationSystem] Matched ${event} automation (prompt-based execution pending)`);
    }

    return matchedCount;
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  /**
   * Check if the system has been disposed.
   */
  isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Dispose the automation system, cleaning up all resources.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;

    log.debug(`[AutomationSystem] Disposing for workspace: ${this.options.workspaceId}`);

    // Stop scheduler
    this.stopScheduler();

    // Dispose handlers
    this.promptHandler?.dispose();
    this.webhookHandler?.dispose();
    await this.eventLogHandler?.dispose();

    // Dispose event bus
    this.eventBus.dispose();

    // Clear metadata
    this.lastKnownMetadata.clear();

    this.disposed = true;
    log.debug(`[AutomationSystem] Disposed`);
  }
}
