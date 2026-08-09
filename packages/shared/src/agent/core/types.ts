/**
 * Core Agent Types
 *
 * Shared types used by agent backends.
 * These types define the interfaces for core functionality that is
 * provider-agnostic and shared across all agent implementations.
 */

import type { Workspace } from '../../config/storage.ts';
import type { SessionHeader } from '../../sessions/types.ts';

/**
 * Message type for recovery context building.
 * Used when SDK session resume fails and we need to inject previous conversation context.
 */
export interface RecoveryMessage {
  type: 'user' | 'assistant';
  content: string;
}

/**
 * Configuration for PromptBuilder
 */
export interface PromptBuilderConfig {
  /** Workspace configuration */
  workspace: Workspace;
  /** Session configuration */
  session?: SessionHeader;
  /** Whether debug mode is enabled */
  debugMode?: {
    enabled: boolean;
    logFilePath?: string;
  };
  /** System prompt preset ('default' | 'mini' | custom string) */
  systemPromptPreset?: 'default' | 'mini' | string;
  /** Whether running in headless mode */
  isHeadless?: boolean;
}

/**
 * Context block options for building system prompt context
 */
export interface ContextBlockOptions {
  /** Plans folder path */
  plansFolderPath?: string;
  /** Data folder path (transform_data tool output) */
  dataFolderPath?: string;
}

/**
 * Configuration for PathProcessor
 */
export interface PathProcessorConfig {
  /** Home directory (defaults to os.homedir()) */
  homeDir?: string;
}

/**
 * Configuration for ConfigValidator
 */
export interface ConfigValidatorConfig {
  /** Workspace path for config files */
  workspacePath?: string;
}

/**
 * Result of config validation
 */
export interface ConfigValidationResult {
  /** Whether the config is valid */
  valid: boolean;
  /** Validation errors if invalid */
  errors?: string[];
  /** Validation warnings (valid but potentially problematic) */
  warnings?: string[];
}

/**
 * Detected config file type
 */
export type ConfigFileType = 'json' | 'toml' | 'yaml' | null;
