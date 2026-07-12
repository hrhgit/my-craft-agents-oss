/**
 * Session Tools Core - Source Helpers
 *
 * Utilities for loading and working with source configurations.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { readSessionHeader, sanitizeSessionId, tryGetSessionFilePath } from '@craft-agent/shared/sessions';
import { expandPath, stripBom } from '@craft-agent/shared/utils';
import type { SourceConfig } from './types.ts';

/**
 * Returns true if the source slug contains no path separators or traversal.
 * basename() strips directory components, so if it differs from the input,
 * the slug contained separators and is unsafe.
 */
function isSafeSlug(slug: string): boolean {
  if (!slug || slug === '.' || slug === '..') {
    return false;
  }
  return basename(slug) === slug;
}

/**
 * Validate a source slug for use in file paths.
 * Pure path-construction helpers throw on invalid slugs; read/existence
 * helpers use isSafeSourceSlug to return null/false instead.
 */
function validateSourceSlug(sourceSlug: string): void {
  if (!isSafeSlug(sourceSlug)) {
    throw new Error('Invalid source slug: path separators not allowed');
  }
}

function validateSkillSlug(skillSlug: string): void {
  if (!isSafeSlug(skillSlug)) {
    throw new Error('Invalid skill slug: path separators not allowed');
  }
}

/**
 * Get the path to a source's directory
 */
export function getSourcePath(workspaceRootPath: string, sourceSlug: string): string {
  validateSourceSlug(sourceSlug);
  return join(workspaceRootPath, 'sources', sourceSlug);
}

/**
 * Get the path to a source's config.json
 */
export function getSourceConfigPath(workspaceRootPath: string, sourceSlug: string): string {
  return join(getSourcePath(workspaceRootPath, sourceSlug), 'config.json');
}

/**
 * Get the path to a source's guide.md
 */
export function getSourceGuidePath(workspaceRootPath: string, sourceSlug: string): string {
  return join(getSourcePath(workspaceRootPath, sourceSlug), 'guide.md');
}

/**
 * Check if a source directory exists
 */
export function sourceExists(workspaceRootPath: string, sourceSlug: string): boolean {
  if (!isSafeSlug(sourceSlug)) {
    return false;
  }
  return existsSync(getSourcePath(workspaceRootPath, sourceSlug));
}

/**
 * Check if a source config file exists
 */
export function sourceConfigExists(workspaceRootPath: string, sourceSlug: string): boolean {
  if (!isSafeSlug(sourceSlug)) {
    return false;
  }
  return existsSync(getSourceConfigPath(workspaceRootPath, sourceSlug));
}

/**
 * Load a source configuration from disk.
 * Returns null if the config doesn't exist or is invalid.
 */
export function loadSourceConfig(
  workspaceRootPath: string,
  sourceSlug: string
): SourceConfig | null {
  if (!isSafeSlug(sourceSlug)) {
    return null;
  }
  const configPath = getSourceConfigPath(workspaceRootPath, sourceSlug);

  if (!existsSync(configPath)) {
    return null;
  }

  try {
    const content = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(stripBom(content)) as SourceConfig;
    return config;
  } catch {
    return null;
  }
}

/**
 * List all source slugs in a workspace
 */
export function listSourceSlugs(workspaceRootPath: string): string[] {
  const sourcesDir = join(workspaceRootPath, 'sources');

  if (!existsSync(sourcesDir)) {
    return [];
  }

  try {
    const entries = readdirSync(sourcesDir);
    return entries.filter((entry) => {
      const entryPath = join(sourcesDir, entry);
      return statSync(entryPath).isDirectory();
    });
  } catch {
    return [];
  }
}

/**
 * Get the path to a skill's directory
 */
export function getSkillPath(workspaceRootPath: string, skillSlug: string): string {
  validateSkillSlug(skillSlug);
  return join(workspaceRootPath, '.pi', 'skills', skillSlug);
}

/**
 * Get the path to a skill's SKILL.md file
 */
export function getSkillMdPath(workspaceRootPath: string, skillSlug: string): string {
  return join(getSkillPath(workspaceRootPath, skillSlug), 'SKILL.md');
}

// ============================================================
// Session State Helpers
// ============================================================

/**
 * Read the session's workingDirectory from the persisted session header.
 *
 * Reads the workspace-scoped Pi projection path at
 * ~/.pi/agent/sessions/{encoded-cwd}/{timestamp}_{sessionId}.jsonl.
 *
 * Returns undefined if the session file doesn't exist, can't be parsed,
 * or has no workingDirectory set. Never throws.
 */
export function resolveSessionWorkingDirectory(
  workspacePath: string,
  sessionId: string
): string | undefined {
  // sanitizeSessionId as path traversal defense (basename strips any path components).
  const safeSessionId = sanitizeSessionId(sessionId);

  // Read only the workspace bucket without scanning the global Pi sessions root.
  const piSessionFile = tryGetSessionFilePath(workspacePath, safeSessionId);
  if (!piSessionFile) return undefined;
  const workingDirectory = readSessionHeader(piSessionFile)?.workingDirectory;
  return workingDirectory ? expandPath(workingDirectory) : undefined;
}

/**
 * Generate a unique request ID for auth requests
 */
export function generateRequestId(prefix: string = 'req'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ============================================================
// Credential Mode Helpers
// ============================================================

import type { CredentialInputMode } from './types.ts';
export type { CredentialInputMode } from './types.ts';

/**
 * Detect the effective credential input mode based on source config and requested mode.
 *
 * Auto-upgrades to 'multi-header' when source has headerNames array, regardless of
 * what mode was explicitly requested. This ensures Datadog-like sources (with
 * headerNames: ["DD-API-KEY", "DD-APPLICATION-KEY"]) always use multi-header UI.
 *
 * @param source - Source configuration (may be null if source not found)
 * @param requestedMode - Mode explicitly requested in tool call
 * @param requestedHeaderNames - Header names explicitly provided in tool call
 * @returns Effective mode to use
 */
export function detectCredentialMode(
  source: { api?: { headerNames?: string[] }; mcp?: { headerNames?: string[] } } | null,
  requestedMode: CredentialInputMode,
  requestedHeaderNames?: string[]
): CredentialInputMode {
  // Use provided headerNames or fall back to source config (API or MCP)
  const effectiveHeaderNames = requestedHeaderNames || source?.api?.headerNames || source?.mcp?.headerNames;

  // If we have headerNames, always use multi-header mode
  if (effectiveHeaderNames && effectiveHeaderNames.length > 0) {
    return 'multi-header';
  }

  return requestedMode;
}

/**
 * Get effective header names from request args or source config.
 *
 * @param source - Source configuration
 * @param requestedHeaderNames - Header names explicitly provided in tool call
 * @returns Array of header names or undefined
 */
export function getEffectiveHeaderNames(
  source: { api?: { headerNames?: string[] }; mcp?: { headerNames?: string[] } } | null,
  requestedHeaderNames?: string[]
): string[] | undefined {
  return requestedHeaderNames || source?.api?.headerNames || source?.mcp?.headerNames;
}
