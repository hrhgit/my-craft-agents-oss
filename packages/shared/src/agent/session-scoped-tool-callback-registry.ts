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

import type { SubagentFn } from './subagent-tool.ts';
import type { BrowserPaneFns } from './browser-tools.ts';
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
   * Callback for the subagent tool.
   * Each Agent backend delegates to its onSubagent callback.
   */
  subagentFn?: SubagentFn;

  /**
   * Browser pane functions for browser_* tools.
   * Set by the Electron session manager — wraps BrowserPaneManager
   * with the session's bound browser instance.
   */
  browserPaneFns?: BrowserPaneFns;

  /** List sessions in the workspace with pagination. */
  listSessionsFn?: (options?: import('@mortise/session-tools-core').ListSessionsOptions) => import('@mortise/session-tools-core').ListSessionsResult;
  /** Create and publish an ordinary Session with its first message. */
  createSessionFn?: (request: import('@mortise/session-tools-core').CreateSessionRequest) => Promise<import('@mortise/session-tools-core').CreateSessionResult>;
  /** Read a bounded projection of an ordinary Session. */
  readSessionFn?: (sessionId: string, options?: import('@mortise/session-tools-core').ReadSessionOptions) => Promise<import('@mortise/session-tools-core').ReadSessionResult>;
  /** Send a normal user message to another ordinary Session. */
  sendMessageToSessionFn?: (request: import('@mortise/session-tools-core').SendMessageToSessionRequest) => Promise<import('@mortise/session-tools-core').SendMessageToSessionResult>;
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
