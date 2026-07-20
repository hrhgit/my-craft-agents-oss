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
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'fs';
import { join } from 'path';
import { createHash, randomUUID } from 'crypto';
import { atomicWriteFileSync, readJsonFileSync } from '../utils/files.ts';
import { CONFIG_DIR, PI_SESSIONS_DIR, encodePiSessionCwd } from '../config/paths.ts';
import { loadConfigDefaults } from '../config/storage.ts';
import { MultiWriterStore, type JsonValue } from '../storage/index.ts';
import { parsePermissionMode, PERMISSION_MODE_ORDER } from '../agent/mode-types.ts';
import type {
  WorkspaceConfig,
  CreateWorkspaceInput,
  LoadedWorkspace,
  WorkspaceSummary,
} from './types.ts';

const DEFAULT_WORKSPACES_DIR = join(CONFIG_DIR, 'workspaces');
const LEGACY_WORKSPACE_AI_DEFAULT_KEYS = ['provider', 'model', 'thinkingLevel'] as const;
const RETIRED_WORKSPACE_ORGANIZATION_PATHS = ['labels', 'statuses', 'views.json'] as const;
const WORKSPACE_STORE_FILE = join(CONFIG_DIR, 'state.sqlite');
const WORKSPACE_SNAPSHOT = Symbol('mortiseWorkspaceSnapshot');
const WORKSPACE_WRITER_VERSION = 1;
let workspaceStore: MultiWriterStore | null = null;

interface WorkspaceSnapshot {
  version: number;
  value: WorkspaceConfig;
}

type WorkspaceWithSnapshot = WorkspaceConfig & { [WORKSPACE_SNAPSHOT]?: WorkspaceSnapshot };

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

function workspaceRecordKey(rootPath: string): string {
  return rootPath.replace(/\\/g, '/');
}

function workspaceHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function materializeWorkspaceConfig(rootPath: string, config: WorkspaceConfig): void {
  atomicWriteFileSync(join(rootPath, 'config.json'), JSON.stringify(config, null, 2));
  atomicWriteFileSync(join(rootPath, '.mortise-config.sync'), JSON.stringify(config));
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

function removeRetiredWorkspaceOrganization(rootPath: string): void {
  for (const relativePath of RETIRED_WORKSPACE_ORGANIZATION_PATHS) {
    const target = join(rootPath, relativePath);
    if (!existsSync(target)) continue;
    try {
      rmSync(target, { recursive: true });
    } catch (error) {
      console.warn(`[workspaces] Failed to remove retired organization path: ${target}`, error);
    }
  }
}

function removeLegacyWorkspaceAiDefaults(config: WorkspaceConfig): boolean {
  if (!config.defaults) return false;

  const defaults = config.defaults as unknown as Record<string, unknown>;
  let removed = false;
  for (const key of LEGACY_WORKSPACE_AI_DEFAULT_KEYS) {
    if (key in defaults) {
      delete defaults[key];
      removed = true;
    }
  }
  return removed;
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
  return join(rootPath, '.pi', 'skills');
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
 * Get the Pi sessions directory for a workspace root bucket.
 *
 * Returns `~/.pi/agent/sessions/{encoded-cwd}/` — the bucket where this
 * workspace's sessions live. The encoded cwd is always the workspace root.
 */
export function getWorkspacePiSessionsDir(rootPath: string): string {
  const encodedCwd = encodePiSessionCwd(getWorkspaceCwd(rootPath));
  return join(PI_SESSIONS_DIR, encodedCwd);
}

/**
 * Count Pi sessions for a workspace by scanning
 * `~/.pi/agent/sessions/{encoded-workspace-root}/`.
 *
 * Counts flat Pi tree JSONL files. Does not read headers, so corrupt files
 * that `listSessions` would skip are still counted here — the count is a close
 * approximation, not an exact match to the rendered list length.
 */
export function countSessionsByCwd(rootPath: string): number {
  const dir = getWorkspacePiSessionsDir(rootPath);
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
 * Load workspace config.json from a workspace folder
 * @param rootPath - Absolute path to workspace root folder
 */
export function loadWorkspaceConfig(rootPath: string): WorkspaceConfig | null {
  const configPath = join(rootPath, 'config.json');
  removeRetiredWorkspaceOrganization(rootPath);

  try {
    const store = getWorkspaceStore();
    const key = workspaceRecordKey(rootPath);
    const stored = store.getRecord(key, 'root');
    let version: number;
    let config: WorkspaceConfig;
    if (stored) {
      config = JSON.parse(JSON.stringify(stored.value)) as WorkspaceConfig;
      version = stored.version;

      // A pre-protocol backend may have edited the compatibility JSON. Import
      // it only against the version observed here; a concurrent new writer
      // then produces a conflict instead of silently overwriting its update.
      if (existsSync(configPath)) {
        try {
          const fileConfig = readJsonFileSync<WorkspaceConfig>(configPath);
          const syncPath = join(rootPath, '.mortise-config.sync');
          const baseline = existsSync(syncPath)
            ? JSON.parse(readFileSync(syncPath, 'utf8')) as WorkspaceConfig
            : null;
          if (baseline && workspaceHash(fileConfig) !== workspaceHash(baseline)
            && workspaceHash(fileConfig) !== workspaceHash(config)) {
            const imported = store.mutateRecord({
              namespace: key,
              key: 'root',
              value: fileConfig as unknown as JsonValue,
              expectedVersion: version,
              operationId: `legacy-workspace-${workspaceHash(fileConfig)}`,
            });
            if (imported.status === 'applied') {
              config = imported.value as unknown as WorkspaceConfig;
              version = imported.version;
            }
          }
        } catch {
          // Keep the SQLite authority when the compatibility file is invalid.
        }
      }
      materializeWorkspaceConfig(rootPath, config);
    } else {
      if (!existsSync(configPath)) return null;
      config = readJsonFileSync<WorkspaceConfig>(configPath);
      const imported = store.mutateRecord({
        namespace: key,
        key: 'root',
        value: config as unknown as JsonValue,
        expectedVersion: null,
        operationId: `import-workspace-${workspaceHash(config)}`,
      });
      if (imported.status !== 'applied') return null;
      config = imported.value as unknown as WorkspaceConfig;
      version = imported.version;
      materializeWorkspaceConfig(rootPath, config);
    }

    // Compatibility: accept canonical or legacy permission mode names on read
    if (config.defaults?.permissionMode && typeof config.defaults.permissionMode === 'string') {
      const parsed = parsePermissionMode(config.defaults.permissionMode);
      config.defaults.permissionMode = parsed ?? undefined;
    }

    if (Array.isArray(config.defaults?.cyclablePermissionModes)) {
      const normalized = config.defaults.cyclablePermissionModes
        .map(mode => (typeof mode === 'string' ? parsePermissionMode(mode) : null))
        .filter((mode): mode is NonNullable<typeof mode> => !!mode)
        .filter((mode, index, arr) => arr.indexOf(mode) === index);

      config.defaults.cyclablePermissionModes = normalized.length >= 2
        ? normalized
        : [...PERMISSION_MODE_ORDER];
    }

    if (removeLegacyWorkspaceAiDefaults(config)) {
      config.updatedAt = Date.now();
      try {
        const normalized = store.mutateRecord({
          namespace: key,
          key: 'root',
          value: config as unknown as JsonValue,
          expectedVersion: version,
          operationId: `normalize-workspace-${workspaceHash(config)}`,
        });
        if (normalized.status === 'applied') {
          config = normalized.value as unknown as WorkspaceConfig;
          version = normalized.version;
          materializeWorkspaceConfig(rootPath, config);
        }
      } catch {
        // Keep the cleaned in-memory config when a read-only workspace cannot be migrated.
      }
    }

    return attachWorkspaceSnapshot(config, { version, value: config });
  } catch {
    return null;
  }
}

/**
 * Save workspace config.json to a workspace folder
 * @param rootPath - Absolute path to workspace root folder
 */
export function saveWorkspaceConfig(rootPath: string, config: WorkspaceConfig): void {
  if (!existsSync(rootPath)) {
    mkdirSync(rootPath, { recursive: true });
  }

  const storageConfig: WorkspaceConfig = {
    ...config,
    defaults: config.defaults ? { ...config.defaults } : undefined,
    updatedAt: Date.now(),
  };
  removeLegacyWorkspaceAiDefaults(storageConfig);

  const store = getWorkspaceStore();
  const key = workspaceRecordKey(rootPath);
  const snapshot = (config as WorkspaceWithSnapshot)[WORKSPACE_SNAPSHOT];
  const current = store.getRecord(key, 'root');
  const result = store.mutateRecord({
    namespace: key,
    key: 'root',
    value: storageConfig as unknown as JsonValue,
    expectedVersion: snapshot?.version ?? current?.version ?? null,
    operationId: `workspace-config-${randomUUID()}`,
  });
  if (result.status !== 'applied') {
    throw new Error(`Workspace configuration write conflicted for ${rootPath}`);
  }
  const persisted = result.value as unknown as WorkspaceConfig;
  materializeWorkspaceConfig(rootPath, persisted);
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

  // M11: No longer create the legacy {rootPath}/skills/ directory here.
  // Task 10 migrated skills to {cwd}/.pi/skills/ (Pi native path); creating
  // the old folder misleads users into placing skills in the wrong location.

  return {
    config,
    sessionCount: countSessionsByCwd(rootPath),
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
    sessionCount: countSessionsByCwd(rootPath),
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
  defaults?: WorkspaceConfig['defaults']
): WorkspaceConfig {
  const now = Date.now();
  const slug = generateSlug(name);

  // Load global defaults from config-defaults.json
  const globalDefaults = loadConfigDefaults();

  // Only workspace-scoped defaults are accepted here. AI defaults are global.
  const workspaceDefaults: WorkspaceConfig['defaults'] = {
    permissionMode: globalDefaults.workspaceDefaults.permissionMode,
    cyclablePermissionModes: globalDefaults.workspaceDefaults.cyclablePermissionModes,
    ...defaults, // User-provided defaults override global defaults
  };

  const config: WorkspaceConfig = {
    id: `ws_${randomUUID().slice(0, 8)}`,
    name,
    slug,
    defaults: workspaceDefaults,
    createdAt: now,
    updatedAt: now,
  };

  // Create workspace directory structure.
  // No `sessions/` subdirectory is created — sessions are
  // aggregated by cwd from `~/.pi/agent/sessions/{encoded-cwd}/` .
  //  No `skills/` subdirectory is created — workspace-level skills
  // migrated to `{projectRoot}/.pi/skills/`. The legacy `{rootPath}/skills/`
  // directory is no longer read by anyone (F18 removed the last legacy
  // workspace-skill fallback paths in pre-tool-use.ts and skill-validate.ts;
  // the stale `loadWorkspaceSkills` reference previously documented here
  // does not exist in the codebase).
  mkdirSync(rootPath, { recursive: true });

  // Save config
  saveWorkspaceConfig(rootPath, config);

  removeRetiredWorkspaceOrganization(rootPath);

  // Initialize plugin manifest for SDK integration (enables skills, commands, agents)
  ensurePluginManifest(rootPath, name);

  return config;
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
 * Check if a valid workspace exists at a path
 * @param rootPath - Absolute path to check
 */
export function isValidWorkspace(rootPath: string): boolean {
  return existsSync(join(rootPath, 'config.json'));
}

/**
 * Rename a workspace (updates config.json in the workspace folder)
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
 * Discover workspace folders in the default location that have valid config.json
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
