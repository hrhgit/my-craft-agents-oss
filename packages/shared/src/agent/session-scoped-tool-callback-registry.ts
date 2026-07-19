/**
 * Session-Scoped Tool Callback Registry
 *
 * Extracted from session-scoped-tools.ts to break the dependency between
 * the callback registry (shared across agent paths) and the SDK adapter
 * layer.
 *
 * The registry is a simple Map keyed by sessionId. Each backend registers
 * callbacks when a session starts and merges additional callbacks (e.g.
 * browser pane functions) as they become available.
 */

import type { SpawnSessionFn } from './spawn-session-tool.ts';
import type { BrowserPaneFns } from './browser-tools.ts';
import type { AuthRequest } from '@mortise/session-tools-core';
import { debug } from '../utils/debug.ts';

/**
 * Callbacks that can be registered per-session
 */
export interface SessionScopedToolCallbacks {
  /**
   * Called when a plan is submitted (plan workflow now handled by pi plan-mode extension).
   * Receives the path to the plan markdown file.
   */
  onPlanSubmitted?: (planPath: string) => void;

  /**
   * Called when authentication is requested via OAuth/credential tools.
   * The auth UI should be shown and execution paused.
   */
  onAuthRequest?: (request: AuthRequest) => void;

  /**
   * Callback for spawn_session tool — creates an independent session and sends initial prompt.
   * Each agent backend delegates to its onSpawnSession callback.
   */
  spawnSessionFn?: SpawnSessionFn;

  /**
   * Browser pane functions for browser_* tools.
   * Set by the Electron session manager — wraps BrowserPaneManager
   * with the session's bound browser instance.
   */
  browserPaneFns?: BrowserPaneFns;

  /** Get detailed info about a session (defaults to current). */
  getSessionInfoFn?: (sessionId?: string) => import('@mortise/session-tools-core').SessionInfo | null;
  /** List sessions in the workspace with pagination. */
  listSessionsFn?: (options?: import('@mortise/session-tools-core').ListSessionsOptions) => import('@mortise/session-tools-core').ListSessionsResult;
  /** Send a message to another session (inter-session messaging). */
  sendAgentMessageFn?: (sessionId: string, message: string, attachments?: Array<{ path: string; name?: string }>) => Promise<void>;
  /**
   * Activate a source in the running session (source_test auto-enable flow).
   * Wired by SessionManager to the per-session onSourceActivationRequest callback
   * plus a backend-aware readiness signal (Pi vs Claude).
   */
  activateSourceInSessionFn?: (sourceSlug: string) => Promise<{
    ok: boolean;
    reason?: string;
    availability?: 'immediate' | 'next-turn';
  }>;
  /** Get messaging bindings for a session. */
  getMessagingBindingsFn?: (sessionId: string) => Array<{ platform: string; channelId: string; threadId?: number; channelName?: string; enabled: boolean }>;
  /** Unbind messaging channels from a session. Returns count of removed bindings. */
  unbindMessagingChannelFn?: (sessionId: string, platform?: string) => number;
}

// Registry of callbacks keyed by sessionId
const sessionScopedToolCallbackRegistry = new Map<string, SessionScopedToolCallbacks>();

/**
 * Register callbacks for a specific session
 */
export function registerSessionScopedToolCallbacks(
  sessionId: string,
  callbacks: SessionScopedToolCallbacks
): void {
  sessionScopedToolCallbackRegistry.set(sessionId, callbacks);
  debug('session-scoped-tools', `Registered callbacks for session ${sessionId}`);
}

/**
 * Merge additional callbacks into an existing session's callback set.
 * Used by the Electron session manager to add browser pane functions
 * after the agent has already registered its core callbacks.
 */
export function mergeSessionScopedToolCallbacks(
  sessionId: string,
  callbacks: Partial<SessionScopedToolCallbacks>
): void {
  const existing = sessionScopedToolCallbackRegistry.get(sessionId) ?? {};
  sessionScopedToolCallbackRegistry.set(sessionId, { ...existing, ...callbacks });
  debug('session-scoped-tools', `Merged callbacks for session ${sessionId}`);
}

/**
 * Unregister callbacks for a session
 */
export function unregisterSessionScopedToolCallbacks(sessionId: string): void {
  sessionScopedToolCallbackRegistry.delete(sessionId);
  debug('session-scoped-tools', `Unregistered callbacks for session ${sessionId}`);
}

/**
 * Get callbacks for a session
 */
export function getSessionScopedToolCallbacks(sessionId: string): SessionScopedToolCallbacks | undefined {
  return sessionScopedToolCallbackRegistry.get(sessionId);
}
