/**
 * Workspace Storage
 *
 * CRUD operations for workspaces.
 * Workspaces can be stored anywhere on disk via rootPath.
 * Default location: ~/.mortise/workspaces/
 */

import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import {
  CONFIG_DIR,
  MORTISE_PROJECT_SKILLS_DIR,
  MORTISE_SESSIONS_DIR,
  encodeWorkspaceSessionBucket,
} from '../config/paths.ts';
import { MultiWriterStore, type JsonValue } from '../storage/index.ts';
import type {
  WorkspaceConfig,
  CreateWorkspaceInput,
  LoadedWorkspace,
  WorkspaceSummary,
} from './types.ts';
import {
  getWorkspaceConfigRecordIdentity,
} from './state-contract.ts';
export {
  getWorkspaceConfigRecordIdentity,
  normalizeWorkspaceRecordNamespace,
  WORKSPACE_CONFIG_RECORD_KEY,
} from './state-contract.ts';

const DEFAULT_WORKSPACES_DIR = join(CONFIG_DIR, 'workspaces');
const WORKSPACE_STORE_FILE = join(CONFIG_DIR, 'state.sqlite');
const WORKSPACE_SNAPSHOT = Symbol('mortiseWorkspaceSnapshot');
const WORKSPACE_WRITER_VERSION = 1;
let workspaceStore: MultiWriterStore | null = null;

interface WorkspaceSnapshot {
  version: number;
  value: WorkspaceConfig;
}

type WorkspaceWithSnapshot = WorkspaceConfig & { [WORKSPACE_SNAPSHOT]?: WorkspaceSnapshot };

const CURRENT_WORKSPACE_KEYS = new Set(['id', 'name', 'slug', 'defaults', 'createdAt', 'updatedAt']);
const CURRENT_WORKSPACE_DEFAULT_KEYS = new Set(['colorTheme']);
const RETIRED_WORKSPACE_DEFAULT_KEYS = new Set(['permissionMode', 'cyclablePermissionModes']);

function parseCurrentWorkspaceConfig(value: unknown): WorkspaceConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some(key => !CURRENT_WORKSPACE_KEYS.has(key))
    || typeof record.id !== 'string'
    || typeof record.name !== 'string'
    || typeof record.slug !== 'string'
    || typeof record.createdAt !== 'number' || !Number.isFinite(record.createdAt)
    || typeof record.updatedAt !== 'number' || !Number.isFinite(record.updatedAt)
  ) return null;

  const projected: WorkspaceConfig = {
    id: record.id,
    name: record.name,
    slug: record.slug,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
  if (record.defaults !== undefined) {
    if (!record.defaults || typeof record.defaults !== 'object' || Array.isArray(record.defaults)) return null;
    const rawDefaults = record.defaults as Record<string, unknown>;
    if (Object.keys(rawDefaults).some(key => (
      !CURRENT_WORKSPACE_DEFAULT_KEYS.has(key) && !RETIRED_WORKSPACE_DEFAULT_KEYS.has(key)
    ))) return null;
    const defaults: NonNullable<WorkspaceConfig['defaults']> = {};
    if (rawDefaults.colorTheme !== undefined) {
      if (typeof rawDefaults.colorTheme !== 'string') return null;
      defaults.colorTheme = rawDefaults.colorTheme;
    }
    projected.defaults = defaults;
  }
  return projected;
}

function getWorkspaceStore(): MultiWriterStore {
  if (!workspaceStore) {
    workspaceStore = MultiWriterStore.openSync({
      databasePath: WORKSPACE_STORE_FILE,
      writerId: `workspace-${process.pid}-${randomUUID()}`,
      writerVersion: WORKSPACE_WRITER_VERSION,
    });
  }
  return workspaceStore;
}

export function closeWorkspaceStorage(): void {
  workspaceStore?.close();
  workspaceStore = null;
}

function attachWorkspaceSnapshot(config: WorkspaceConfig, snapshot: WorkspaceSnapshot): WorkspaceConfig {
  Object.defineProperty(config, WORKSPACE_SNAPSHOT, {
    configurable: true,
    enumerable: false,
    value: snapshot,
    writable: true,
  });
  return config;
}

// ============================================================
// Path Utilities
// ============================================================

/**
 * Get the default workspaces directory (~/.mortise/workspaces/)
 */
export function getDefaultWorkspacesDir(): string {
  return DEFAULT_WORKSPACES_DIR;
}

/**
 * Ensure default workspaces directory exists
 */
export function ensureDefaultWorkspacesDir(): void {
  if (!existsSync(DEFAULT_WORKSPACES_DIR)) {
    mkdirSync(DEFAULT_WORKSPACES_DIR, { recursive: true });
  }
}

/**
 * Get workspace root path from ID
 * @param workspaceId - Workspace ID
 * @returns Absolute path to workspace root in default location
 */
export function getWorkspacePath(workspaceId: string): string {
  return join(DEFAULT_WORKSPACES_DIR, workspaceId);
}

/**
 * Get path to workspace skills directory
 * @param rootPath - Absolute path to workspace root folder
 */
export function getWorkspaceSkillsPath(rootPath: string): string {
  return join(rootPath, MORTISE_PROJECT_SKILLS_DIR);
}

// ------------------------------------------------------------
// Session view aggregation
// ------------------------------------------------------------

/**
 * Resolve the cwd used for a workspace.
 *
 * Complete-unification semantics: workspace = cwd = Pi session bucket =
 * configuration scope.
 */
export function getWorkspaceCwd(rootPath: string): string {
  return rootPath;
}

/**
 * Get the Mortise sessions directory for a workspace root bucket.
 *
 * Returns `~/.mortise/agent/sessions/{workspace-bucket}/` — the bucket where
 * this workspace's sessions live. The bucket is keyed by stable Workspace ID.
 */
export function getWorkspaceSessionsDir(workspaceId: string): string {
  return join(MORTISE_SESSIONS_DIR, encodeWorkspaceSessionBucket(workspaceId));
}

/**
 * Count Mortise sessions for a workspace by scanning
 * `~/.mortise/agent/sessions/{encoded-workspace-root}/`.
 *
 * Counts flat Pi tree JSONL files. Does not read headers, so corrupt files
 * that `listSessions` would skip are still counted here — the count is a close
 * approximation, not an exact match to the rendered list length.
 */
export function countSessionsByCwd(workspaceId: string): number {
  const dir = getWorkspaceSessionsDir(workspaceId);
  if (!existsSync(dir)) return 0;
  try {
    let count = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) count++;
    }
    return count;
  } catch {
    return 0;
  }
}

// ============================================================
// Config Operations
// ============================================================

/**
 * Load the canonical workspace configuration from state.sqlite.
 * Retired workspace-local JSON files are neither read nor modified.
 * @param rootPath - Absolute path to workspace root folder
 */
export function loadWorkspaceConfig(rootPath: string): WorkspaceConfig | null {
  try {
    const store = getWorkspaceStore();
    const identity = getWorkspaceConfigRecordIdentity(rootPath);
    const stored = store.getRecord(identity.namespace, identity.key);
    if (!stored) return null;
    const config = parseCurrentWorkspaceConfig(JSON.parse(JSON.stringify(stored.value)));
    if (!config) return null;
    return attachWorkspaceSnapshot(config, { version: stored.version, value: config });
  } catch {
    return null;
  }
}

/**
 * Save the canonical workspace configuration to state.sqlite.
 * @param rootPath - Absolute path to workspace root folder
 */
export function saveWorkspaceConfig(rootPath: string, config: WorkspaceConfig): void {
  const canonicalConfig = parseCurrentWorkspaceConfig(config);
  if (!canonicalConfig) throw new Error('Invalid current workspace configuration');
  if (!existsSync(rootPath)) {
    mkdirSync(rootPath, { recursive: true });
  }

  const storageConfig: WorkspaceConfig = {
    ...canonicalConfig,
    ...(canonicalConfig.defaults ? { defaults: { ...canonicalConfig.defaults } } : {}),
    updatedAt: Date.now(),
  };

  const store = getWorkspaceStore();
  const identity = getWorkspaceConfigRecordIdentity(rootPath);
  const snapshot = (config as WorkspaceWithSnapshot)[WORKSPACE_SNAPSHOT];
  const current = store.getRecord(identity.namespace, identity.key);
  const result = store.mutateRecord({
    namespace: identity.namespace,
    key: identity.key,
    value: storageConfig as unknown as JsonValue,
    expectedVersion: snapshot?.version ?? current?.version ?? null,
    operationId: `workspace-config-${randomUUID()}`,
  });
  if (result.status !== 'applied') {
    throw new Error(`Workspace configuration write conflicted for ${rootPath}`);
  }
  const persisted = result.value as unknown as WorkspaceConfig;
  attachWorkspaceSnapshot(config, { version: result.version, value: persisted });
}

// ============================================================
// Load Operations
// ============================================================

/**
 * Load workspace with summary info from a rootPath
 * @param rootPath - Absolute path to workspace root folder
 */
export function loadWorkspace(rootPath: string): LoadedWorkspace | null {
  const config = loadWorkspaceConfig(rootPath);
  if (!config) return null;

  // Ensure plugin manifest exists (migration for existing workspaces)
  ensurePluginManifest(rootPath, config.name);

  // Workspace skills are created on demand under {cwd}/.mortise/skills/.
  // Do not create the retired {rootPath}/skills/ or Pi-owned .pi/skills paths.

  return {
    config,
    sessionCount: countSessionsByCwd(config.id),
  };
}

/**
 * Get workspace summary from a rootPath
 * @param rootPath - Absolute path to workspace root folder
 */
export function getWorkspaceSummary(rootPath: string): WorkspaceSummary | null {
  const config = loadWorkspaceConfig(rootPath);
  if (!config) return null;

  return {
    slug: config.slug,
    name: config.name,
    sessionCount: countSessionsByCwd(config.id),
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
  };
}

// ============================================================
// Create/Delete Operations
// ============================================================

/**
 * Generate URL-safe slug from name
 */
export function generateSlug(name: string): string {
  let slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 50);

  if (!slug) {
    slug = 'workspace';
  }

  return slug;
}

/**
 * Generate a unique folder path for a workspace by appending a numeric suffix
 * if the slug-based folder already exists.
 * E.g., "my-workspace", "my-workspace-2", "my-workspace-3", ...
 *
 * @param name - Display name to derive the slug from
 * @param baseDir - Parent directory where workspace folders live (e.g., ~/.mortise/workspaces/)
 * @returns Full path to a unique, non-existing folder
 */
export function generateUniqueWorkspacePath(name: string, baseDir: string): string {
  const slug = generateSlug(name);
  let candidate = join(baseDir, slug);

  if (!existsSync(candidate)) {
    return candidate;
  }

  // Append numeric suffix until we find a non-existing path
  let counter = 2;
  while (existsSync(join(baseDir, `${slug}-${counter}`))) {
    counter++;
  }

  return join(baseDir, `${slug}-${counter}`);
}

/**
 * Create workspace folder structure at a given path
 * @param rootPath - Absolute path where workspace folder will be created
 * @param name - Display name for the workspace
 * @param defaults - Optional default settings for new sessions
 * @returns The created WorkspaceConfig
 */
export function createWorkspaceAtPath(
  rootPath: string,
  name: string,
  defaults?: WorkspaceConfig['defaults'],
  workspaceId?: string,
): WorkspaceConfig {
  const now = Date.now();
  const slug = generateSlug(name);

  // Only explicitly supplied workspace presentation defaults are persisted.
  const workspaceDefaults: WorkspaceConfig['defaults'] = {
    ...defaults, // User-provided defaults override global defaults
  };

  const candidate: WorkspaceConfig = {
    id: workspaceId ?? `ws_${randomUUID().slice(0, 8)}`,
    name,
    slug,
    defaults: workspaceDefaults,
    createdAt: now,
    updatedAt: now,
  };
  const config = parseCurrentWorkspaceConfig(candidate)!;

  // Create workspace directory structure.
  // No `sessions/` subdirectory is created — sessions are
  // aggregated by cwd from `~/.mortise/agent/sessions/{encoded-cwd}/` .
  // No `skills/` subdirectory is created. Workspace skills are created on
  // demand under `{projectRoot}/.mortise/skills/`; retired root-level and
  // Pi-owned project skill paths are not read or materialized.
  mkdirSync(rootPath, { recursive: true });

  // Save config
  saveWorkspaceConfig(rootPath, config);

  // Initialize plugin manifest for SDK integration (enables skills, commands, agents)
  ensurePluginManifest(rootPath, name);

  return config;
}

/**
 * Ensure the filesystem/config portion of a Workspace is ready for use.
 *
 * Workspace topology is persisted by WorkspaceTopologyStore, but the local
 * root also owns a SQLite config record and the plugin manifest.  Keeping
 * these checks here gives every creation/reconnect path the same idempotent
 * repair behavior instead of each caller writing a different subset.
 */
export function ensureWorkspaceStorage(
  rootPath: string,
  workspaceId: string,
  workspaceName: string,
  options: { persistConfig?: boolean; defaults?: WorkspaceConfig['defaults'] } = {},
): WorkspaceConfig | null {
  mkdirSync(rootPath, { recursive: true });
  const persistConfig = options.persistConfig ?? true;
  if (!persistConfig) return null;

  const current = loadWorkspaceConfig(rootPath);
  if (!current) {
    return createWorkspaceAtPath(rootPath, workspaceName, options.defaults, workspaceId);
  }

  // The topology identity is canonical.  Repair old records that were
  // created before topology IDs were passed into createWorkspaceAtPath.
  const identityChanged = current.id !== workspaceId;
  if (identityChanged) current.id = workspaceId;
  ensurePluginManifest(rootPath, workspaceName);
  if (identityChanged) saveWorkspaceConfig(rootPath, current);
  return current;
}

/**
 * Delete a workspace folder and all its contents
 * @param rootPath - Absolute path to workspace root folder
 */
export function deleteWorkspaceFolder(rootPath: string): boolean {
  if (!existsSync(rootPath)) return false;

  try {
    rmSync(rootPath, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check whether a workspace directory has a canonical SQLite record.
 * @param rootPath - Absolute path to check
 */
export function isValidWorkspace(rootPath: string): boolean {
  if (!existsSync(rootPath)) return false;
  return loadWorkspaceConfig(rootPath) !== null;
}

/**
 * Rename a workspace in the canonical SQLite record.
 * @param rootPath - Absolute path to workspace root folder
 * @param newName - New display name
 */
export function renameWorkspaceFolder(rootPath: string, newName: string): boolean {
  const config = loadWorkspaceConfig(rootPath);
  if (!config) return false;

  config.name = newName.trim();
  saveWorkspaceConfig(rootPath, config);
  return true;
}

// ============================================================
// Auto-Discovery (for default workspace location)
// ============================================================

/**
 * Discover workspace folders in the default location that have SQLite records.
 * Returns paths to valid workspaces found in ~/.mortise/workspaces/
 */
export function discoverWorkspacesInDefaultLocation(): string[] {
  const discovered: string[] = [];

  if (!existsSync(DEFAULT_WORKSPACES_DIR)) {
    return discovered;
  }

  try {
    const entries = readdirSync(DEFAULT_WORKSPACES_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const rootPath = join(DEFAULT_WORKSPACES_DIR, entry.name);
      if (isValidWorkspace(rootPath)) {
        discovered.push(rootPath);
      }
    }
  } catch {
    // Ignore errors scanning directory
  }

  return discovered;
}

// ============================================================
// Workspace Color Theme
// ============================================================

/**
 * Get the color theme setting for a workspace.
 * Returns undefined if workspace uses the app default.
 *
 * @param rootPath - Absolute path to workspace root folder
 * @returns Theme ID or undefined (inherit from app default)
 */
export function getWorkspaceColorTheme(rootPath: string): string | undefined {
  const config = loadWorkspaceConfig(rootPath);
  return config?.defaults?.colorTheme;
}

/**
 * Set the color theme for a workspace.
 * Pass undefined to clear and use app default.
 *
 * @param rootPath - Absolute path to workspace root folder
 * @param themeId - Preset theme ID or undefined to inherit
 */
export function setWorkspaceColorTheme(rootPath: string, themeId: string | undefined): void {
  const config = loadWorkspaceConfig(rootPath);
  if (!config) return;

  // Validate theme ID if provided (skip for undefined = inherit default)
  // Only allow alphanumeric characters, hyphens, and underscores (max 64 chars)
  if (themeId && themeId !== 'default') {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(themeId)) {
      console.warn(`[workspace-storage] Invalid theme ID rejected: ${themeId}`);
      return;
    }
  }

  // Initialize defaults if not present
  if (!config.defaults) {
    config.defaults = {};
  }

  if (themeId) {
    config.defaults.colorTheme = themeId;
  } else {
    delete config.defaults.colorTheme;
  }

  saveWorkspaceConfig(rootPath, config);
}

// ============================================================
// Exports
// ============================================================

// ============================================================
// Plugin Manifest (for SDK plugin integration)
// ============================================================

/**
 * Ensure workspace has a .claude-plugin/plugin.json manifest.
 * This allows the workspace to be loaded as an SDK plugin,
 * enabling skills, commands, and agents from the workspace.
 *
 * @param rootPath - Absolute path to workspace root folder
 * @param workspaceName - Display name for the workspace (used in plugin name)
 */
export function ensurePluginManifest(rootPath: string, workspaceName: string): void {
  const pluginDir = join(rootPath, '.claude-plugin');
  const manifestPath = join(pluginDir, 'plugin.json');

  if (existsSync(manifestPath)) return;

  // Create .claude-plugin directory
  if (!existsSync(pluginDir)) {
    mkdirSync(pluginDir, { recursive: true });
  }

  // Create minimal plugin manifest
  const manifest = {
    name: `mortise-workspace-${workspaceName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    version: '1.0.0',
  };

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

export { CONFIG_DIR, DEFAULT_WORKSPACES_DIR };
