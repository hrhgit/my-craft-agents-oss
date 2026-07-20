/**
 * Session Tool Context Factory
 *
 * Creates a SessionToolContext implementation with full access
 * to Electron internals, credential managers, MCP validation, etc.
 *
 * This enables the shared handlers in session-tools-core to work with
 * the app backend's full feature set.
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'fs';
import { join } from 'path';
import { CONFIG_DIR } from '../config/paths.ts';
import type {
  SessionToolContext,
  SessionToolCallbacks,
  FileSystemInterface,
  ValidatorInterface,
  DeveloperFeedback,
} from '@mortise/session-tools-core';
import {
  validateConfig,
  validatePreferences,
  validateAll,
  validateSkill,
  validateAllPermissions,
  validateToolIcons,
} from '../config/validators.ts';
import { validateAutomations } from '../automations/index.ts';
import { debug } from '../utils/debug.ts';
import { getSessionPlansPath, getSessionPath, getSessionDataPath } from '../sessions/storage.ts';
import { updatePreferences as updatePreferencesImpl } from '../config/preferences.ts';
import { createPiSkillResolver } from '../pi/pi-skill-resolver.ts';

// Re-export types that may be needed by consumers
export type { SessionToolContext, SessionToolCallbacks } from '@mortise/session-tools-core';

/**
 * Options for creating a session tool context.
 */
export interface SessionToolContextOptions {
  sessionId: string;
  workspacePath: string;
  workingDirectory?: string;
  getWorkingDirectory?: () => string | undefined;
  onPlanSubmitted: (planPath: string) => void;
}

/**
 * Create a SessionToolContext with full capabilities.
 *
 * This provides:
 * - Full file system access
 * - Full Zod validators
 * - Workspace-aware validators and preferences
 */
export function createSessionToolContext(options: SessionToolContextOptions): SessionToolContext {
  const { sessionId, workspacePath, onPlanSubmitted } = options;

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

  // Validators implementation
  const validators: ValidatorInterface = {
    validateConfig: () => validateConfig(),
    validatePreferences: () => validatePreferences(),
    validatePermissions: (wsPath: string) => validateAllPermissions(wsPath),
    validateAutomations: (wsPath: string) => validateAutomations(wsPath),
    validateToolIcons: () => validateToolIcons(),
    validateAll: (wsPath: string) => validateAll(wsPath),
    validateSkill: (wsPath: string, slug: string) => validateSkill(wsPath, slug),
  };

  // Build context
  const context: SessionToolContext = {
    sessionId,
    workspacePath,
    get workingDirectory() { return options.getWorkingDirectory?.() ?? options.workingDirectory; },
    get skillPaths() { return createPiSkillResolver(this.workingDirectory).getSkillPaths().map(e => e.dir); },
    get skillsPath() { return this.skillPaths?.[0] ?? ''; },
    plansFolderPath: getSessionPlansPath(workspacePath, sessionId),
    sessionPath: getSessionPath(workspacePath, sessionId),
    dataPath: getSessionDataPath(workspacePath, sessionId),
    callbacks,
    fs,
    validators,
    updatePreferences: (updates: Record<string, unknown>) => {
      updatePreferencesImpl(updates as any);
    },
    submitFeedback: (feedback: DeveloperFeedback) => {
      const feedbackDir = join(CONFIG_DIR, 'feedback');
      mkdirSync(feedbackDir, { recursive: true });
      const filePath = join(feedbackDir, `${feedback.id}.json`);
      writeFileSync(filePath, JSON.stringify(feedback, null, 2), 'utf-8');
      debug('session-tool-context', `Developer feedback written to ${filePath}`);
    },
    // Session self-management bindings are attached externally via
    // attachSessionSelfManagementBindings() — not part of the factory.
  };

  return context;
}
