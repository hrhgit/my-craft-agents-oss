/**
 * Shared infrastructure for the unified network interceptor.
 *
 * The interceptor runs as a preload script in SDK subprocesses (Claude, Copilot, Pi).
 * This module provides the common pieces:
 * - toolMetadataStore (in-process metadata sharing for interceptor hooks)
 * - LastApiError (error capture for error handler)
 * - Logging utilities
 * - Config reading (richToolDescriptions, mortise.agent runtime settings)
 */

import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, appendFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from './config/paths.ts';
import { readPiMortiseBoolean } from './config/pi-global-config.ts';

// ============================================================================
// CONSTANTS
// ============================================================================

/** Packaged apps run from inside an app.asar archive */
export const IS_PACKAGED = process.argv.some(arg => arg.includes('app.asar'));

/** Enable interceptor logging in dev mode (not packaged), disable in production */
export const INTERCEPTOR_LOGGING_ENABLED = !IS_PACKAGED;

export const DEBUG = INTERCEPTOR_LOGGING_ENABLED &&
  (process.argv.includes('--debug') || process.env.MORTISE_DEBUG === '1');

/** Config file path for reading settings in the SDK subprocess */
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

/** Session directory — set by env var (subprocess) or setSessionDir() (main process) */
let _sessionDir: string | null = process.env.MORTISE_SESSION_DIR || null;

// ============================================================================
// LOGGING
// ============================================================================

export const LOG_DIR = join(CONFIG_DIR, 'logs');
export const LOG_FILE = join(LOG_DIR, 'interceptor.log');

// Ensure log directory exists at module load
try {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
} catch {
  // Ignore - logging will silently fail if dir can't be created
}

// Rotate log file if older than 1 day
const MAX_LOG_AGE_MS = 24 * 60 * 60 * 1000;
try {
  if (existsSync(LOG_FILE)) {
    const stat = statSync(LOG_FILE);
    if (Date.now() - stat.mtimeMs > MAX_LOG_AGE_MS) {
      const prevLog = LOG_FILE + '.prev';
      renameSync(LOG_FILE, prevLog);
    }
  }
} catch {
  // Ignore — rotation is best-effort
}

export function debugLog(...args: unknown[]) {
  if (!DEBUG) return;
  const timestamp = new Date().toISOString();
  const message = `${timestamp} [interceptor] ${args.map((a) => {
    if (typeof a === 'object') {
      try {
        return JSON.stringify(a);
      } catch (e) {
        const keys = a && typeof a === 'object' ? Object.keys(a as object).join(', ') : 'unknown';
        return `[CYCLIC STRUCTURE, keys: ${keys}] (error: ${e})`;
      }
    }
    return String(a);
  }).join(' ')}`;
  try {
    appendFileSync(LOG_FILE, message + '\n');
  } catch {
    // Silently fail if can't write to log file
  }
}

// ============================================================================
// CONFIG READING
// ============================================================================

/**
 * Read and cache config.json for the duration of a single request cycle.
 * Multiple interceptor functions can call this without redundant file reads.
 * Cache expires after 100ms to pick up changes between requests.
 */
let _cachedConfig: Record<string, unknown> | null = null;
let _cacheTimestamp = 0;
const CONFIG_CACHE_TTL_MS = 100;

function getInterceptorConfig(): Record<string, unknown> | null {
  const now = Date.now();
  if (_cachedConfig && (now - _cacheTimestamp) < CONFIG_CACHE_TTL_MS) return _cachedConfig;
  try {
    const content = readFileSync(CONFIG_FILE, 'utf-8');
    _cachedConfig = JSON.parse(content);
    _cacheTimestamp = now;
    return _cachedConfig;
  } catch {
    return null;
  }
}

/** Reset the config cache. Used by tests to ensure fresh reads after writing config. */
export function _resetConfigCacheForTesting(): void {
  _cachedConfig = null;
  _cacheTimestamp = 0;
}

/**
 * Check if rich tool descriptions are enabled (adds _intent/_displayName to all tools).
 * Reads from config.json via shared cache — the file is small and this runs once per API request.
 * Defaults to true if config is unreadable or field is not set.
 */
export function isRichToolDescriptionsEnabled(): boolean {
  const config = getInterceptorConfig();
  if (config?.richToolDescriptions !== undefined) {
    return config.richToolDescriptions as boolean;
  }
  return true;
}

/**
 * Check if extended prompt cache (1h TTL) is enabled.
 * When enabled, the interceptor upgrades all cache_control blocks from 5m to 1h TTL.
 * Source of truth is ~/.pi/agent/settings.json (`mortise.agent.extendedPromptCache`).
 */
export function isExtendedPromptCacheEnabled(): boolean {
  return readPiMortiseBoolean('extendedPromptCache', false);
}

/**
 * Check if 1M context window is enabled.
 * When disabled, the interceptor strips the context-1m beta header.
 * Defaults to false — the 1M beta requires Anthropic Tier 4+, so it's opt-in
 * to avoid 400 "Invalid Request" on lower-tier API keys (issue #567).
 * Source of truth is ~/.pi/agent/settings.json (`mortise.agent.enable1MContext`).
 */
export function is1MContextEnabled(): boolean {
  return readPiMortiseBoolean('enable1MContext', false);
}

// ============================================================================
// LAST API ERROR
// ============================================================================

/**
 * Store the last API error for the error handler to access.
 * Uses file-based storage to reliably share across process boundaries.
 */
export interface LastApiError {
  status: number;
  statusText: string;
  message: string;
  timestamp: number;
}

const MAX_ERROR_AGE_MS = 5 * 60 * 1000; // 5 minutes

function getErrorFilePath(): string {
  // Prefer session-scoped file to avoid cross-session error consumption.
  if (_sessionDir) return join(_sessionDir, 'api-error.json');
  // Fallback for legacy/non-session contexts.
  return join(CONFIG_DIR, 'api-error.json');
}

function getStoredError(sessionDir?: string): LastApiError | null {
  const errorFile = sessionDir ? join(sessionDir, 'api-error.json') : getErrorFilePath();
  try {
    if (!existsSync(errorFile)) return null;
    const content = readFileSync(errorFile, 'utf-8');
    const error = JSON.parse(content) as LastApiError;
    try {
      unlinkSync(errorFile);
      debugLog(`[getStoredError] Popped error file`);
    } catch {
      // Ignore delete errors
    }
    return error;
  } catch {
    return null;
  }
}

export function setStoredError(error: LastApiError | null): void {
  const errorFile = getErrorFilePath();
  try {
    if (error) {
      writeFileSync(errorFile, JSON.stringify(error));
      debugLog(`[setStoredError] Wrote error to file: ${error.status} ${error.message}`);
    } else {
      try {
        unlinkSync(errorFile);
      } catch {
        // File might not exist
      }
    }
  } catch (e) {
    debugLog(`[setStoredError] Failed to write: ${e}`);
  }
}

export function getLastApiError(sessionDir?: string): LastApiError | null {
  const error = getStoredError(sessionDir);
  if (error) {
    const age = Date.now() - error.timestamp;
    if (age < MAX_ERROR_AGE_MS) {
      debugLog(`[getLastApiError] Found error (age ${age}ms): ${error.status}`);
      return error;
    }
    debugLog(`[getLastApiError] Error too old (${age}ms > ${MAX_ERROR_AGE_MS}ms)`);
  }
  return null;
}

// ============================================================================
// TOOL METADATA STORE
// ============================================================================

/**
 * Metadata extracted from tool_use inputs by the SSE stripping/capture stream.
 * Keyed by tool_use_id, consumed by tool-matching.ts / event-adapter.ts.
 */
export interface ToolMetadata {
  intent?: string;
  displayName?: string;
  timestamp: number;
}

/**
 * In-process metadata store for tool display metadata.
 *
 * Pi now carries this data on typed `tool_execution_start` events via the host
 * hooks resolver, so Mortise no longer uses `{sessionDir}/tool-metadata.json` as
 * a cross-process side channel. `sessionDir` arguments are retained as no-op
 * compatibility while older callers are cleaned up.
 */

const MAX_TOOL_METADATA_AGE_MS = 10 * 60 * 1000; // 10 minutes

// In-memory Map for same-process lookups.
const _metadataMap = new Map<string, ToolMetadata>();

function pruneExpiredToolMetadata(now = Date.now()): void {
  for (const [toolUseId, metadata] of _metadataMap) {
    if (now - metadata.timestamp > MAX_TOOL_METADATA_AGE_MS) {
      _metadataMap.delete(toolUseId);
    }
  }
}

export const toolMetadataStore = {
  /**
   * Sets the active session dir for other interceptor side data (API errors).
   * Metadata itself no longer reads from or writes to this directory.
   */
  setSessionDir(dir: string): void {
    _sessionDir = dir;
  },

  /** Store metadata in memory for same-process lookups */
  set(toolUseId: string, metadata: ToolMetadata): void {
    const now = Date.now();
    pruneExpiredToolMetadata(now);
    if (now - metadata.timestamp > MAX_TOOL_METADATA_AGE_MS) return;
    _metadataMap.set(toolUseId, metadata);
  },

  /**
   * Read metadata from memory. The sessionDir argument is ignored and retained
   * for compatibility.
   */
  get(toolUseId: string, _sessionDir?: string): ToolMetadata | undefined {
    const metadata = _metadataMap.get(toolUseId);
    if (!metadata) return undefined;
    if (Date.now() - metadata.timestamp > MAX_TOOL_METADATA_AGE_MS) {
      _metadataMap.delete(toolUseId);
      return undefined;
    }
    return metadata;
  },

  delete(toolUseId: string): void {
    _metadataMap.delete(toolUseId);
  },

  get size(): number {
    return _metadataMap.size;
  },

  /** Clear all in-memory entries. Used by tests to prevent cross-file state leaks. */
  _clearForTesting(): void {
    _metadataMap.clear();
  },
};

// ============================================================================
// METADATA SCHEMA DEFINITIONS
// ============================================================================

/** Schema for _displayName field added to tool definitions */
export const displayNameSchema = {
  type: 'string',
  description: 'REQUIRED: Human-friendly name for this action (2-4 words, e.g., "List Folders", "Search Documents", "Create Task")',
};

/** Schema for _intent field added to tool definitions */
export const intentSchema = {
  type: 'string',
  description: 'REQUIRED: Describe what you are trying to accomplish with this tool call (1-2 sentences)',
};
