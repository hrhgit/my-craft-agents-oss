/**
 * Session Tools Core - Context Interface
 *
 * Defines the abstract context interface that both Claude (in-process)
 * and Codex (subprocess) implementations must provide.
 *
 * This enables writing tool handlers once and running them in both environments.
 */

import type { ToolResult } from './types.ts';

// ============================================================
// Callback Interface
// ============================================================

/**
 * Callbacks for session tool operations.
 * Both Claude and Codex implement this interface differently:
 * - Claude: Direct function calls via registry
 * - Codex: JSON messages over stderr
 */
export interface SessionToolCallbacks {
  /**
   * Called when a plan is submitted.
   * Claude: calls onPlanSubmitted callback
   * Codex: sends __CALLBACK__ message to stderr
   */
  onPlanSubmitted(planPath: string): void;
}

// ============================================================
// File System Interface
// ============================================================

/**
 * File system abstraction for portability.
 * Allows mocking in tests and different implementations in different environments.
 */
export interface FileSystemInterface {
  /** Check if file/directory exists */
  exists(path: string): boolean;

  /** Read file as UTF-8 string */
  readFile(path: string): string;

  /** Read file as Buffer (for binary/images) */
  readFileBuffer(path: string): Buffer;

  /** Write file */
  writeFile(path: string, content: string): void;

  /** Check if path is a directory */
  isDirectory(path: string): boolean;

  /** List directory contents */
  readdir(path: string): string[];

  /** Get file stats */
  stat(path: string): { size: number; isDirectory(): boolean };
}

// ============================================================
// Validator Interface
// ============================================================

/**
 * Config validation interface.
 * Claude uses full Zod validators from packages/shared.
 * Codex uses simplified validators from session-tools-core.
 */
export interface ValidatorInterface {
  validateConfig(): import('./types.js').ValidationResult;
  validatePreferences(): import('./types.js').ValidationResult;
  validatePermissions(workspaceRootPath: string): import('./types.js').ValidationResult;
  validateAutomations(workspaceRootPath: string): import('./types.js').ValidationResult;
  validateToolIcons(): import('./types.js').ValidationResult;
  validateAll(workspaceRootPath: string): import('./types.js').ValidationResult;
  validateSkill(workspaceRootPath: string, skillSlug: string): import('./types.js').ValidationResult;
}

// ============================================================
// Session Tool Context
// ============================================================

/**
 * Main context interface for session tools.
 *
 * Both Claude and Codex create their own implementation of this interface:
 * - Claude: createClaudeContext() with direct access to Electron internals
 * - Codex: createCodexContext() with callback IPC and limited capabilities
 */
export interface SessionToolContext {
  // ============================================================
  // Session Info
  // ============================================================

  /** Unique session identifier */
  sessionId: string;

  /** Absolute path to workspace folder (~/.mortise/workspaces/{id}) */
  workspacePath: string;

  /** Path to skills folder within workspace */
  get skillsPath(): string;

  /** Ordered Pi skill roots (global and optional project-level) */
  skillPaths?: string[];

  /** Path to session's plans folder */
  plansFolderPath: string;

  /** Working directory (project root) for the session, if set */
  workingDirectory?: string;

  // ============================================================
  // Callbacks (transport-agnostic)
  // ============================================================

  callbacks: SessionToolCallbacks;

  // ============================================================
  // File System
  // ============================================================

  fs: FileSystemInterface;

  // ============================================================
  // Validators (optional - may use basic or full)
  // ============================================================

  validators?: ValidatorInterface;

  // ============================================================
  // Preferences (for update_user_preferences)
  // ============================================================

  /**
   * Submit developer feedback. Injected by each backend:
   * - Claude: writes JSON files to ~/.mortise/feedback/
   * - Codex/Pi: could send over IPC or write directly
   */
  submitFeedback?(feedback: import('./types.ts').DeveloperFeedback): void;

  /**
   * Update user preferences. Injected by each backend:
   * - Claude: calls updatePreferences() from config/preferences.ts
   * - Codex/session-mcp-server: writes directly to preferences.json
   * - Pi: calls updatePreferences() from config/preferences.ts
   */
  updatePreferences?(updates: Record<string, unknown>): void;

  // ============================================================
  // Session Queries
  // ============================================================

  /** Get detailed info about a session. Defaults to current session if no ID given. Injected by backend. */
  getSessionInfo?(sessionId?: string): SessionInfo | null;

  /** List sessions in the workspace with pagination. Injected by backend. */
  listSessions?(options?: ListSessionsOptions): ListSessionsResult;

  // ============================================================
  // Inter-Session Messaging
  // ============================================================

  /** Send a message to another session. Injected by backend (SessionManager). */
  sendAgentMessage?(sessionId: string, message: string, attachments?: Array<{ path: string; name?: string }>): Promise<void>;

  // ============================================================
  // Messaging Gateway (for list/unbind messaging channels)
  // ============================================================

  /** Get messaging bindings for a session. Injected by backend when messaging is configured. */
  getMessagingBindings?(sessionId: string): Array<{
    platform: string;
    channelId: string;
    /** Telegram supergroup forum topic id; undefined for DMs / non-Telegram. */
    threadId?: number;
    channelName?: string;
    enabled: boolean;
  }>;

  /** Unbind messaging channels from a session. Returns count of removed bindings. */
  unbindMessagingChannel?(sessionId: string, platform?: string): number;

  // ============================================================
  // Session Paths (for transform_data / render_template)
  // ============================================================

  /**
   * Absolute path to the session directory.
   * Used by transform_data for resolving input files.
   */
  sessionPath?: string;

  /**
   * Absolute path to the session's data directory.
   * Used by transform_data and render_template for output files.
   */
  dataPath?: string;
}

// ============================================================
// Session Query Types
// ============================================================

/** Full metadata for a single session (returned by get_session_info). */
export interface SessionInfo {
  id: string;
  name: string;
  permissionMode: string;
  createdAt: number;
  updatedAt?: number;
  workingDirectory?: string;
  provider?: string;
  model?: string;
  isActive: boolean;
}

/** Compact session summary (returned by list_sessions). */
export interface SessionListItem {
  id: string;
  name: string;
  createdAt: number;
}

/** Options for list_sessions filtering and pagination. */
export interface ListSessionsOptions {
  search?: string;
  sortBy?: 'recent' | 'name';
  limit?: number;
  offset?: number;
}

/** Paginated result from list_sessions. */
export interface ListSessionsResult {
  total: number;
  returned: number;
  sessions: SessionListItem[];
}

// ============================================================
// Context Factory Helpers
// ============================================================

/**
 * Create a basic file system implementation using Node.js fs.
 */
export function createNodeFileSystem(): FileSystemInterface {
  // Dynamic import to work in both environments
  const fs = require('node:fs');

  return {
    exists: (path: string) => fs.existsSync(path),
    readFile: (path: string) => fs.readFileSync(path, 'utf-8'),
    readFileBuffer: (path: string) => fs.readFileSync(path),
    writeFile: (path: string, content: string) => fs.writeFileSync(path, content, 'utf-8'),
    isDirectory: (path: string) => fs.existsSync(path) && fs.statSync(path).isDirectory(),
    readdir: (path: string) => fs.readdirSync(path),
    stat: (path: string) => {
      const stats = fs.statSync(path);
      return {
        size: stats.size,
        isDirectory: () => stats.isDirectory(),
      };
    },
  };
}
