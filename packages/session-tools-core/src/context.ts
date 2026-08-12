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

  /** Path to session's plans folder */
  plansFolderPath: string;

  // ============================================================
  // Callbacks (transport-agnostic)
  // ============================================================

  callbacks: SessionToolCallbacks;

  // ============================================================
  // File System
  // ============================================================

  fs: FileSystemInterface;

  // ============================================================
  // Session Queries
  // ============================================================

  /** List sessions in the workspace with pagination. Injected by backend. */
  listSessions?(options?: ListSessionsOptions): ListSessionsResult;

  /** Create and publish an ordinary Session with its first user message. */
  createSession?(request: CreateSessionRequest): Promise<CreateSessionResult>;

  /** Read a bounded projection of one Session's current Pi tree branch. */
  readSession?(sessionId: string, options?: ReadSessionOptions): Promise<ReadSessionResult>;

  // ============================================================
  // Inter-Session Messaging
  // ============================================================

  /** Send a normal user message to another Session through the shared delivery path. */
  sendMessageToSession?(request: SendMessageToSessionRequest): Promise<SendMessageToSessionResult>;

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
}

// ============================================================
// Session Query Types
// ============================================================

export type SessionCoordinationStatus = 'idle' | 'running' | 'deleting'

/** Compact metadata returned by list/read coordination operations. */
export interface SessionSummary {
  id: string;
  name: string;
  preview?: string;
  createdAt: number;
  updatedAt?: number;
  status: SessionCoordinationStatus;
  provider?: string;
  model?: string;
}

export type SessionListItem = SessionSummary

/** Options for list_sessions filtering and pagination. */
export interface ListSessionsOptions {
  search?: string;
  sortBy?: 'recent' | 'name';
  limit?: number;
  cursor?: string;
}

/** Paginated result from list_sessions. */
export interface ListSessionsResult {
  sessions: SessionListItem[];
  nextCursor?: string;
  hasMore: boolean;
}

export interface CreateSessionRequest {
  message: string;
  name?: string;
  provider?: string;
  model?: string;
  thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  sourceSessionId: string;
}

export interface CreateSessionResult {
  sessionId: string;
  messageId: string;
  operationId: string;
  publication: 'pending' | 'published';
}

export interface ReadSessionOptions {
  cursor?: string;
  turnLimit?: number;
  branchNodeId?: string;
  maxCharsPerItem?: number;
}

export interface SessionReadTurn {
  id: string;
  user: string;
  agent?: string;
  userTruncated?: boolean;
  agentTruncated?: boolean;
  startedAt?: number;
  completedAt?: number;
}

export interface ReadSessionResult {
  session: SessionSummary;
  branch: {
    leafId: string | null;
    currentLeafId: string | null;
    isCurrent: boolean;
  };
  turns: SessionReadTurn[];
  nextCursor?: string;
  hasMore: boolean;
}

export interface SendMessageToSessionRequest {
  sessionId: string;
  message: string;
  delivery?: 'followUp' | 'steer';
  attachments?: Array<{ path: string; name?: string }>;
  sourceSessionId: string;
}

export interface SendMessageToSessionResult {
  accepted: true;
  operationId: string;
  messageId: string;
  delivery: 'followUp' | 'steer';
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
