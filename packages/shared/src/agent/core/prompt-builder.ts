/**
 * PromptBuilder - System Prompt and Context Building
 *
 * Provides recovery context and preference helpers. Mortise intentionally
 * does not generate per-turn runtime context blocks.
 *
 * Key responsibilities:
 * - Format recovery context for session resume failures
 * - Format user preferences for prompt injection
 */

import { formatPreferencesForPrompt } from '../../config/preferences.ts';
import { requirePrimaryLocalWorkspaceRoot } from '@mortise/core/types';
import type {
  PromptBuilderConfig,
  ContextBlockOptions,
  RecoveryMessage,
} from './types.ts';

/**
 * PromptBuilder provides utilities for building prompts and context blocks.
 *
 * Usage:
 * ```typescript
 * const promptBuilder = new PromptBuilder({
 *   workspace,
 *   session,
 *   debugMode: { enabled: true },
 * });
 *
 * // Build context blocks for a user message
 * const contextParts = promptBuilder.buildContextParts({
 *   plansFolderPath: '/path/to/plans',
 * });
 * ```
 */
export class PromptBuilder {
  private config: PromptBuilderConfig;
  private workspaceRootPath: string;
  private pinnedPreferencesPrompt: string | null = null;

  constructor(config: PromptBuilderConfig) {
    this.config = config;
    this.workspaceRootPath = requirePrimaryLocalWorkspaceRoot(config.workspace);
  }

  // ============================================================
  // Context Building
  // ============================================================

  /**
   * Build all context parts for a user message (volatile blocks first, then
   * stable blocks). Returns an array of strings that should be prepended to the
   * user message.
   *
   * This is the Claude path: it composes {@link buildVolatileContextParts} and
   * {@link buildStableContextParts} so the output is byte-identical to the
   * pre-split version. Callers that place volatile vs stable context in different locations
   * (e.g. the Pi adapter, to preserve prompt caching — issue #862) should call
   * the two halves directly instead of this method.
   *
   * @param options - Context building options
   * @returns Array of context strings
   */
  buildContextParts(options: ContextBlockOptions): string[] {
    void options;
    return [];
  }

  /**
   * Volatile context blocks — content that can change every turn, so it must
   * ride the user-message tail rather than the cached system prefix (issue
   * #862). Folding these into the system prompt re-stamps the cache prefix each
   * turn and kills prompt-cache reuse for all downstream history.
   *
   * @param options - Context building options
   */
  buildVolatileContextParts(options: ContextBlockOptions): string[] {
    void options;
    return [];
  }

  /**
   * Stable context blocks — content that is invariant across a session, so it
   * can safely live in the cached system prefix (issue #862).
   *
   * Blocks (in order):
   *  1. workspace capabilities
   *  2. working directory, when available
   *
   * Pure and idempotent: holds no one-shot state, so it is safe to call any
   * number of times per turn.
   */
  buildStableContextParts(): string[] {
    return [];
  }

  /**
   * Get working directory context for prompt injection.
   */
  getWorkingDirectoryContext(): string | null {
    return null;
  }

  // ============================================================
  // Recovery Context
  // ============================================================

  /**
   * Build recovery context from previous messages when SDK resume fails.
   * Called when we detect an empty response during resume.
   *
   * @param messages - Previous messages to include in recovery context
   * @returns Formatted recovery context string, or null if no messages
   */
  buildRecoveryContext(messages?: RecoveryMessage[]): string | null {
    if (!messages || messages.length === 0) {
      return null;
    }

    // Format messages as a conversation block
    const formattedMessages = messages.map((m) => {
      const role = m.type === 'user' ? 'User' : 'Assistant';
      // Truncate very long messages to avoid bloating context
      const content = m.content.length > 1000
        ? m.content.slice(0, 1000) + '...[truncated]'
        : m.content;
      return `[${role}]: ${content}`;
    }).join('\n\n');

    return `<conversation_recovery>
This session was interrupted and is being restored. Here is the recent conversation context:

${formattedMessages}

Please continue the conversation naturally from where we left off.
</conversation_recovery>

`;
  }

  // ============================================================
  // User Preferences
  // ============================================================

  /**
   * Format user preferences for prompt injection.
   * Preferences are pinned on first call to ensure consistency within a session.
   *
   * @param forceRefresh - Force refresh of cached preferences
   * @returns Formatted preferences string
   */
  formatPreferences(forceRefresh = false): string {
    // Return pinned preferences if available (ensures session consistency)
    if (this.pinnedPreferencesPrompt && !forceRefresh) {
      return this.pinnedPreferencesPrompt;
    }

    // Load and format preferences (function loads internally)
    this.pinnedPreferencesPrompt = formatPreferencesForPrompt();
    return this.pinnedPreferencesPrompt;
  }

  /**
   * Clear pinned preferences (called on session clear).
   */
  clearPinnedPreferences(): void {
    this.pinnedPreferencesPrompt = null;
  }

  // ============================================================
  // Configuration Accessors
  // ============================================================

  /**
   * Update the workspace configuration.
   */
  setWorkspace(workspace: PromptBuilderConfig['workspace']): void {
    this.config.workspace = workspace;
    this.workspaceRootPath = requirePrimaryLocalWorkspaceRoot(workspace);
  }

  /**
   * Update the session configuration.
   */
  setSession(session: PromptBuilderConfig['session']): void {
    this.config.session = session;
  }

  /**
   * Get the workspace root path.
   */
  getWorkspaceRootPath(): string {
    return this.workspaceRootPath;
  }

  /**
   * Check if debug mode is enabled.
   */
  isDebugMode(): boolean {
    return this.config.debugMode?.enabled ?? false;
  }

  /**
   * Get the system prompt preset.
   */
  getSystemPromptPreset(): string {
    return this.config.systemPromptPreset ?? 'default';
  }
}
