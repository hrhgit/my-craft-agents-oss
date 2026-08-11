/**
 * Session Tool Context Factory
 *
 * Creates a SessionToolContext implementation with full access
 * to Electron internals, credential managers, MCP validation, etc.
 *
 * This enables the shared handlers in session-tools-core to work with
 * the app backend's full feature set.
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import type {
  SessionToolContext,
  SessionToolCallbacks,
  FileSystemInterface,
} from '@mortise/session-tools-core';
import { getSessionPlansPath } from '../sessions/storage.ts';

// Re-export types that may be needed by consumers
export type { SessionToolContext, SessionToolCallbacks } from '@mortise/session-tools-core';

/**
 * Options for creating a session tool context.
 */
export interface SessionToolContextOptions {
  sessionId: string;
  workspaceId: string;
  workspacePath: string;
  onPlanSubmitted: (planPath: string) => void;
}

/**
 * Create a SessionToolContext with full capabilities.
 *
 * This provides:
 * - Full file system access
 * - Session self-management bindings (attached externally)
 */
export function createSessionToolContext(options: SessionToolContextOptions): SessionToolContext {
  const { sessionId, workspaceId, workspacePath, onPlanSubmitted } = options;

  // File system implementation
  const fs: FileSystemInterface = {
    exists: (path: string) => existsSync(path),
    readFile: (path: string) => readFileSync(path, 'utf-8'),
    readFileBuffer: (path: string) => readFileSync(path),
    writeFile: (path: string, content: string) => writeFileSync(path, content, 'utf-8'),
    isDirectory: (path: string) => existsSync(path) && statSync(path).isDirectory(),
    readdir: (path: string) => readdirSync(path),
    stat: (path: string) => {
      const stats = statSync(path);
      return {
        size: stats.size,
        isDirectory: () => stats.isDirectory(),
      };
    },
  };

  // Callbacks implementation
  const callbacks: SessionToolCallbacks = {
    onPlanSubmitted,
  };

  // Build context
  const context: SessionToolContext = {
    sessionId,
    workspacePath,
    plansFolderPath: getSessionPlansPath(workspaceId, sessionId),
    callbacks,
    fs,
    // Session self-management bindings are attached externally via
    // attachSessionSelfManagementBindings() — not part of the factory.
  };

  return context;
}
