import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync, readdirSync } from 'fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, dirname, basename } from 'path';
import { clearAllCraftCredentials, getCredentialManager } from '../credentials/index.ts';
import {
  readCraftLlmConnections as readLegacyProviderEntries,
  writeCraftLlmConnections,
} from '@mortise/pi-coding-agent/host-facade';
import { getOrCreateLatestSession, type SessionHeader } from '../sessions/index.ts';
import {
  discoverWorkspacesInDefaultLocation,
  loadWorkspaceConfig,
  saveWorkspaceConfig,
  createWorkspaceAtPath,
  isValidWorkspace,
  closeWorkspaceStorage,
} from '../workspaces/storage.ts';
import { findIconFile } from '../utils/icon.ts';
import { extractWorkspaceSlugFromPath } from '../utils/workspace-slug.ts';
import { initializeDocs } from '../docs/index.ts';
import { expandPath, toPortablePath, getBundledAssetsDir } from '../utils/paths.ts';
import { debug } from '../utils/debug.ts';
import { atomicWriteFileSync, readJsonFileSync } from '../utils/files.ts';
import { CONFIG_DIR } from './paths.ts';
import type { StoredAttachment, StoredMessage } from '@mortise/core/types';
import type { Plan } from '../agent/plan-types.ts';
import type { PermissionMode } from '../agent/mode-manager.ts';
import type { ThinkingLevel } from '../agent/thinking-levels.ts';
import { normalizeThinkingLevel } from '../agent/thinking-levels.ts';
import { parsePermissionMode, PERMISSION_MODE_ORDER } from '../agent/mode-types.ts';
import { type ConfigDefaults } from './config-defaults-schema.ts';
import {
  createDefaultPiExtensionSettings,
  mergePiExtensionSettings,
  normalizePiExtensionSettings,
  type PiExtensionSettings,
  type StoredPiExtensionSettings,
} from './pi-extension-settings.ts';
import { isValidThemeFile } from './validators.ts';
import {
  MultiWriterStore,
  withFileLockSync,
  type JsonValue,
  type RecordPatchOperation,
} from '../storage/index.ts';

// Re-export CONFIG_DIR for convenience (centralized in paths.ts)
export { CONFIG_DIR } from './paths.ts';

// Re-export base types from core (single source of truth)
export type {
  WorkspaceInfo,
  Workspace,
  RemoteServerConfig,
  McpAuthType,
  AuthType,
  OAuthCredentials,
} from '@mortise/core/types';

// Import for local use
import type { RemoteServerConfig, Workspace } from '@mortise/core/types';

import {
  readPiGlobalProviders,
  readPiGlobalSettings,
  savePiGlobalProvider,
  setPiGlobalDefault,
  setPiGlobalDefaultThinkingLevel,
  readPiMortiseBoolean,
  writePiMortiseBoolean,
  readPiShellGuiBoolean,
  writePiShellGuiBoolean,
  type PiGlobalModel,
  type PiGlobalProvider,
} from './pi-global-config.ts';
import {
  DEFAULT_MID_STREAM_BEHAVIOR,
  normalizeMidStreamBehavior,
  type MidStreamBehavior,
} from './midstream-behavior.ts';

type LegacyStoredConfig = StoredConfig & {
  defaultLlmConnection?: string;
  llmConnections?: LegacyProviderEntry[];
};

interface LegacyProviderEntry {
  slug: string;
  name?: string;
  piAuthProvider?: string;
  baseUrl?: string;
  customEndpoint?: { api?: PiGlobalProvider['api'] };
  models?: Array<string | {
    id: string;
    name?: string;
    contextWindow?: number;
    supportsThinking?: boolean;
    supportsImages?: boolean;
  }>;
  defaultModel?: string;
}

function legacyProviderKey(connection: LegacyProviderEntry): string | null {
  const explicit = connection.piAuthProvider?.trim();
  if (explicit) return explicit;
  const slug = connection.slug?.trim();
  if (!slug) return null;
  return slug.startsWith('pi-') ? slug.slice(3) || null : slug;
}

function legacyConnectionModels(connection: LegacyProviderEntry): PiGlobalModel[] | undefined {
  if (!connection.models?.length) return undefined;
  return connection.models.map(model => typeof model === 'string'
    ? { id: model, name: model }
    : {
        id: model.id,
        name: model.name ?? model.id,
        contextWindow: model.contextWindow,
        reasoning: model.supportsThinking,
        input: model.supportsImages ? ['text', 'image'] : ['text'],
      });
}

/**
 * Import retired Mortise connection data into Pi's provider/model files.
 * Existing Pi providers always win, making repeated startup calls idempotent.
 */
function migrateLegacyLlmConfiguration(config: LegacyStoredConfig): void {
  const legacyProviderEntries = readLegacyProviderEntries<LegacyProviderEntry>();
  const legacyConnections = [
    ...(Array.isArray(config.llmConnections) ? config.llmConnections : []),
    ...legacyProviderEntries,
  ];
  if (legacyConnections.length === 0 && !config.defaultLlmConnection) return;

  const providers = readPiGlobalProviders();
  const migratedKeys = new Map<string, string>();
  for (const connection of legacyConnections) {
    if (!connection || typeof connection !== 'object') continue;
    const key = legacyProviderKey(connection);
    if (!key) continue;
    migratedKeys.set(connection.slug, key);
    if (providers[key]) continue;

    const provider: PiGlobalProvider = {
      ...(connection.baseUrl ? { baseUrl: connection.baseUrl } : {}),
      ...(connection.customEndpoint?.api ? { api: connection.customEndpoint.api } : {}),
      models: legacyConnectionModels(connection),
    };
    savePiGlobalProvider(key, provider);
    providers[key] = provider;
  }

  const defaultConnection = legacyConnections.find(
    connection => connection.slug === config.defaultLlmConnection,
  );
  const defaultProvider = defaultConnection
    ? migratedKeys.get(defaultConnection.slug)
    : config.defaultLlmConnection?.startsWith('pi-')
      ? config.defaultLlmConnection.slice(3)
      : undefined;
  const defaultModel = defaultConnection?.defaultModel
    ?? (defaultConnection ? legacyConnectionModels(defaultConnection)?.[0]?.id : undefined)
    ?? (defaultProvider ? providers[defaultProvider]?.models?.[0]?.id : undefined);
  if (defaultProvider && defaultModel && providers[defaultProvider]) {
    void setPiGlobalDefault(defaultProvider, defaultModel).catch(error => {
      debug('[config] Failed to migrate legacy default provider/model:', error);
    });
  }

  // Only clear the compatibility collection after every usable entry has been
  // represented in providers. Invalid entries remain harmlessly ignored.
  if (legacyProviderEntries.length > 0) {
    // The host facade serializes this update with Pi's models.json writers.
    // An empty collection is equivalent to removing the retired metadata.
    writeCraftLlmConnections([]);
  }
}

// Config stored in JSON file (credentials stored in encrypted file, not here)
export interface StoredConfig {
  /** Global behavior when a message arrives while a turn is in progress. */
  midStreamBehavior?: MidStreamBehavior;
  defaultThinkingLevel?: ThinkingLevel;  // App-level default thinking level for new sessions

  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  activeSessionId: string | null;  // Currently active session (primary scope)
  // Notifications
  notificationsEnabled?: boolean;  // Desktop notifications for task completion (default: true)
  // Appearance
  colorTheme?: string;  // ID of selected preset theme (e.g., 'dracula', 'nord'). Default: 'default'
  // Auto-update
  dismissedUpdateVersion?: string;  // Version that user dismissed (skip notifications for this version)
  // Input settings
  autoCapitalisation?: boolean;  // Auto-capitalize first letter when typing (default: true)
  sendMessageKey?: 'enter' | 'cmd-enter';  // Key to send messages (default: 'enter')
  spellCheck?: boolean;  // Enable spell check in input (default: false)
  // Power settings
  keepAwakeWhileRunning?: boolean;  // Prevent screen sleep while sessions are running (default: false)
  // Tool metadata
  richToolDescriptions?: boolean;  // Add intent/action metadata to all tool calls (default: true)
  // Deprecated local mirrors retained for config compatibility; Pi settings are authoritative.
  // Tools
  browserToolEnabled?: boolean;  // Enable built-in browser tool (default: true). Disable for Playwright/Puppeteer.
  dataSourcesEnabled?: boolean;  // Show data sources and expose their tools to sessions (default: false).
  allowRemoteEvaluate?: boolean;  // Allow remote agents to call `browser_tool evaluate` on local browser (default: true).
  // Pi 扩展集成开关：控制全局 pi 扩展加载与 prompt 自动化委托
  piExtensions?: StoredPiExtensionSettings;
  // Pi 壳模式：Mortise 作为 Pi 的薄壳，完全透传 Pi 身份/会话/技能
  piShell?: {
    fullPassthrough?: boolean;  // 完全 Pi 透传：使用 Pi 原生 system prompt，移除 Mortise 身份覆盖。默认 true。
  };
  // Network proxy
  networkProxy?: import('./types.ts').NetworkProxySettings;
  // Windows: path to Git Bash (bash.exe) for the SDK subprocess
  gitBashPath?: string;
  // User chose "Setup later" during onboarding — skip showing onboarding on next launch
  setupDeferred?: boolean;
  // Server mode — embedded remote server settings
  serverConfig?: import('./server-config.ts').ServerConfig;
}

const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const CONFIG_DEFAULTS_FILE = join(CONFIG_DIR, 'config-defaults.json');
const CONFIG_DATABASE_FILE = join(CONFIG_DIR, 'state.sqlite');
const CONFIG_SYNC_BASELINE_FILE = join(CONFIG_DIR, '.config.json.sync');
const CONFIG_RECORD_NAMESPACE = 'config';
const CONFIG_RECORD_KEY = 'root';
const CONFIG_SNAPSHOT = Symbol('mortiseConfigSnapshot');
const CONFIG_WRITER_VERSION = 1;

interface ConfigSnapshot {
  version: number;
  value: StoredConfig;
}

type ConfigWithSnapshot = StoredConfig & { [CONFIG_SNAPSHOT]?: ConfigSnapshot };

let configStore: MultiWriterStore | null = null;

function getConfigStore(): MultiWriterStore {
  if (!configStore) {
    const writerId = `mortise-${process.pid}-${process.env.MORTISE_WRITER_ID ?? randomUUID()}`;
    configStore = MultiWriterStore.openSync({
      databasePath: CONFIG_DATABASE_FILE,
      writerId,
      writerVersion: CONFIG_WRITER_VERSION,
    });
  }
  return configStore;
}

function canonicalConfigJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalConfigJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalConfigJson(entry)}`)
    .join(',')}}`;
}

function configHash(value: unknown): string {
  return createHash('sha256').update(canonicalConfigJson(value)).digest('hex');
}

function pointerPart(value: string): string {
  return value.replace(/~/g, '~0').replace(/\//g, '~1');
}

function configDiff(base: unknown, next: unknown, path = ''): RecordPatchOperation[] {
  if (canonicalConfigJson(base) === canonicalConfigJson(next)) return [];
  const baseObject = base !== null && typeof base === 'object' && !Array.isArray(base)
    ? base as Record<string, unknown>
    : null;
  const nextObject = next !== null && typeof next === 'object' && !Array.isArray(next)
    ? next as Record<string, unknown>
    : null;
  if (baseObject && nextObject) {
    const keys = new Set([...Object.keys(baseObject), ...Object.keys(nextObject)]);
    return [...keys].sort().flatMap(key => {
      const childPath = `${path}/${pointerPart(key)}`;
      const inBase = Object.prototype.hasOwnProperty.call(baseObject, key);
      const inNext = Object.prototype.hasOwnProperty.call(nextObject, key);
      if (!inNext) {
        return [{
          path: childPath,
          expectedExists: true,
          expectedValue: baseObject[key] as JsonValue,
          remove: true,
        }];
      }
      if (!inBase) {
        return [{
          path: childPath,
          expectedExists: false,
          value: nextObject[key] as JsonValue,
        }];
      }
      return configDiff(baseObject[key], nextObject[key], childPath);
    });
  }
  return [{
    path,
    expectedExists: base !== undefined,
    ...(base !== undefined ? { expectedValue: base as JsonValue } : {}),
    value: next as JsonValue,
  }];
}

function readSyncBaseline(): StoredConfig | null {
  try {
    if (!existsSync(CONFIG_SYNC_BASELINE_FILE)) return null;
    return JSON.parse(readFileSync(CONFIG_SYNC_BASELINE_FILE, 'utf8')) as StoredConfig;
  } catch (error) {
    debug('[config] Ignoring unreadable config sync baseline:', error instanceof Error ? error.message : error);
    return null;
  }
}

function materializeConfig(value: StoredConfig): void {
  atomicWriteFileSync(CONFIG_FILE, JSON.stringify(value, null, 2));
  atomicWriteFileSync(CONFIG_SYNC_BASELINE_FILE, JSON.stringify(value));
}

function attachConfigSnapshot(config: StoredConfig, snapshot: ConfigSnapshot): StoredConfig {
  Object.defineProperty(config, CONFIG_SNAPSHOT, {
    configurable: true,
    enumerable: false,
    value: snapshot,
    writable: true,
  });
  return config;
}

function reconcileLegacyConfigFile(record: ConfigSnapshot): ConfigSnapshot {
  if (!existsSync(CONFIG_FILE)) {
    materializeConfig(record.value);
    return record;
  }
  let fileValue: StoredConfig;
  try {
    fileValue = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as StoredConfig;
  } catch {
    materializeConfig(record.value);
    return record;
  }
  const baseline = readSyncBaseline();
  if (baseline && configHash(fileValue) !== configHash(baseline)) {
    const operations = configDiff(baseline, fileValue);
    if (operations.length > 0) {
      const result = getConfigStore().mutateRecordPatch({
        namespace: CONFIG_RECORD_NAMESPACE,
        key: CONFIG_RECORD_KEY,
        operations,
        expectedVersion: record.version,
        operationId: `legacy-config-${configHash(fileValue)}`,
      });
      if (result.status === 'applied') {
        const value = result.value as unknown as StoredConfig;
        materializeConfig(value);
        return { version: result.version, value };
      }
      debug('[config] Legacy config.json edit conflicted with SQLite authority; preserving SQLite value');
    }
  }
  if (configHash(fileValue) !== configHash(record.value)) materializeConfig(record.value);
  return record;
}

// Track if config-defaults have been synced this session (prevents re-sync on hot reload)
let configDefaultsSynced = false;

/**
 * Sync config-defaults.json from bundled assets.
 * Always writes on launch to ensure defaults are up-to-date with the running version.
 * Follows the same pattern as docs, themes, and other bundled assets.
 *
 * Source of truth: apps/electron/resources/config-defaults.json
 */
/** Minimal config-defaults used when bundled assets aren't available (CI, standalone server). */
const FALLBACK_CONFIG_DEFAULTS: ConfigDefaults = {
  version: '1.0',
  description: 'Default configuration values for Mortise',
  defaults: {
    notificationsEnabled: true,
    colorTheme: 'default',
    autoCapitalisation: true,
    sendMessageKey: 'enter',
    spellCheck: false,
    keepAwakeWhileRunning: false,
    richToolDescriptions: true,
    browserToolEnabled: true,
    dataSourcesEnabled: false,
    allowRemoteEvaluate: true,
    piExtensions: createDefaultPiExtensionSettings(),
    piShell: {
      fullPassthrough: true,
    },
  },
  workspaceDefaults: {
    thinkingLevel: 'medium',
    permissionMode: 'allow-all',
    cyclablePermissionModes: ['safe', 'ask', 'allow-all'],
    localMcpServers: { enabled: true },
  },
};

function syncConfigDefaults(): void {
  if (configDefaultsSynced) return;
  configDefaultsSynced = true;

  // Get bundled config-defaults.json from resources folder
  const bundledDir = getBundledAssetsDir('.');
  if (!bundledDir) {
    debug('[config] No bundled assets dir found - using fallback config-defaults');
    withFileLockSync(CONFIG_DEFAULTS_FILE, () => {
      if (!existsSync(CONFIG_DEFAULTS_FILE)) {
        writeFileSync(CONFIG_DEFAULTS_FILE, JSON.stringify(FALLBACK_CONFIG_DEFAULTS, null, 2), 'utf-8');
      }
    });
    return;
  }

  const bundledFile = join(bundledDir, 'config-defaults.json');
  if (!existsSync(bundledFile)) {
    debug('[config] Bundled config-defaults.json not found at: ' + bundledFile + ' - using fallback');
    withFileLockSync(CONFIG_DEFAULTS_FILE, () => {
      if (!existsSync(CONFIG_DEFAULTS_FILE)) {
        writeFileSync(CONFIG_DEFAULTS_FILE, JSON.stringify(FALLBACK_CONFIG_DEFAULTS, null, 2), 'utf-8');
      }
    });
    return;
  }

  // Sync from bundled file (same pattern as docs)
  const content = readFileSync(bundledFile, 'utf-8');
  withFileLockSync(CONFIG_DEFAULTS_FILE, () => writeFileSync(CONFIG_DEFAULTS_FILE, content, 'utf-8'));
  debug('[config] Synced config-defaults.json from bundled assets');
}

/**
 * Load config defaults from ~/.mortise/config-defaults.json
 * This file is synced from bundled assets on every launch.
 */
export function loadConfigDefaults(): ConfigDefaults {
  if (!existsSync(CONFIG_DEFAULTS_FILE)) {
    throw new Error('config-defaults.json not found at ' + CONFIG_DEFAULTS_FILE + '. Ensure ensureConfigDir() was called at startup.');
  }

  const defaults = readJsonFileSync<ConfigDefaults>(CONFIG_DEFAULTS_FILE);

  const parsedPermissionMode =
    typeof defaults.workspaceDefaults?.permissionMode === 'string'
      ? parsePermissionMode(defaults.workspaceDefaults.permissionMode)
      : null;
  defaults.workspaceDefaults.permissionMode = parsedPermissionMode ?? 'ask';

  const rawCyclable = Array.isArray(defaults.workspaceDefaults?.cyclablePermissionModes)
    ? defaults.workspaceDefaults.cyclablePermissionModes
    : [];

  const normalizedCyclable: PermissionMode[] = [];
  for (const mode of rawCyclable) {
    if (typeof mode !== 'string') continue;
    const parsed = parsePermissionMode(mode);
    if (!parsed) continue;
    if (!normalizedCyclable.includes(parsed)) {
      normalizedCyclable.push(parsed);
    }
  }

  defaults.workspaceDefaults.cyclablePermissionModes =
    normalizedCyclable.length >= 2 ? normalizedCyclable : [...PERMISSION_MODE_ORDER];

  return defaults;
}

/**
 * Ensure config-defaults.json exists and is up-to-date.
 * Syncs from bundled assets on every launch (like docs, themes, permissions).
 */
export function ensureConfigDefaults(): void {
  syncConfigDefaults();
}

let configDirInitialized = false;

const MAX_CONFIG_BACKUPS = 3;
const CONFIG_BACKUP_DATE_RE = /^config\.json\.bak-\d{4}-\d{2}-\d{2}$/;
let corruptConfigBackupPath: string | null = null;

/**
 * Snapshot an existing config.json into a dated file (config.json.bak-YYYY-MM-DD)
 * and keep only the newest MAX_CONFIG_BACKUPS. Runs once at startup, before any
 * path can mutate or (in failure paths) overwrite the workspace registry.
 * Best-effort: failures are logged and swallowed so a backup never blocks startup.
 */
export function backupConfigFile(): void {
  try {
    if (!existsSync(CONFIG_FILE)) return;

    const now = new Date();
    const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const dated = join(CONFIG_DIR, `config.json.bak-${stamp}`);
    // One backup per day, never overwritten: the first snapshot of the day is taken
    // before any mutation, so it holds the good pre-reset state. A second startup that
    // day (e.g. after a reset already nuked the registry) must NOT clobber it.
    if (existsSync(dated)) return;
    writeFileSync(dated, readFileSync(CONFIG_FILE, 'utf-8'), 'utf-8');

    // ISO date in the name → lexical sort is chronological; drop all but the newest few.
    const backups = readdirSync(CONFIG_DIR).filter(f => CONFIG_BACKUP_DATE_RE.test(f)).sort();
    for (const stale of backups.slice(0, Math.max(0, backups.length - MAX_CONFIG_BACKUPS))) {
      try { rmSync(join(CONFIG_DIR, stale)); } catch { /* ignore individual cleanup errors */ }
    }
  } catch (error) {
    debug('[config] backupConfigFile failed:', error instanceof Error ? error.message : error);
  }
}

function backupCorruptConfigFile(reason: unknown): void {
  try {
    if (!existsSync(CONFIG_FILE)) return;
    if (corruptConfigBackupPath && existsSync(corruptConfigBackupPath)) return;

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    corruptConfigBackupPath = join(CONFIG_DIR, `config.json.corrupt-${stamp}`);
    copyFileSync(CONFIG_FILE, corruptConfigBackupPath);
    debug(
      '[config] Backed up unreadable config.json to',
      corruptConfigBackupPath,
      'reason:',
      reason instanceof Error ? reason.message : reason,
    );
  } catch (backupError) {
    debug('[config] backupCorruptConfigFile failed:', backupError instanceof Error ? backupError.message : backupError);
  }
}

export function ensureConfigDir(): void {
  if (configDirInitialized) return;

  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }

  // Snapshot an existing config.json (dated, keep last 3) before anything can
  // mutate or — in a failure path — overwrite the workspace registry.
  backupConfigFile();
  // Initialize bundled docs (creates ~/.mortise/docs/ with sources.md, agents.md, permissions.md)
  initializeDocs();

  // Initialize config defaults
  ensureConfigDefaults();

  // Initialize tool icons (CLI tool icons for turn card display)
  ensureToolIcons();

  configDirInitialized = true;
}

export function loadStoredConfig(): StoredConfig | null {
  try {
    ensureConfigDir();
    const store = getConfigStore();
    let record: ConfigSnapshot | null = null;
    const storedRecord = store.getRecord(CONFIG_RECORD_NAMESPACE, CONFIG_RECORD_KEY);
    if (storedRecord) {
      record = reconcileLegacyConfigFile({
        version: storedRecord.version,
        value: storedRecord.value as unknown as StoredConfig,
      });
    } else {
      if (!existsSync(CONFIG_FILE)) return null;
      const imported = readJsonFileSync<StoredConfig & {
      defaultLlmConnection?: string;
      llmConnections?: LegacyProviderEntry[];
      migrationsApplied?: unknown;
      }>(CONFIG_FILE);
      const importedStorage: StoredConfig = Array.isArray(imported.workspaces)
        ? {
            ...imported,
            workspaces: imported.workspaces.map(ws => ({
              ...ws,
              rootPath: toPortablePath(ws.rootPath),
            })),
          }
        : imported as StoredConfig;
      const importedResult = store.mutateRecord({
        namespace: CONFIG_RECORD_NAMESPACE,
        key: CONFIG_RECORD_KEY,
        value: importedStorage as unknown as JsonValue,
        expectedVersion: null,
        operationId: `import-config-${configHash(importedStorage)}`,
      });
      if (importedResult.status !== 'applied') return null;
      record = {
        version: importedResult.version,
        value: importedResult.value as unknown as StoredConfig,
      };
      materializeConfig(record.value);
    }

    const config = JSON.parse(JSON.stringify(record.value)) as StoredConfig & {
      defaultLlmConnection?: string;
      llmConnections?: LegacyProviderEntry[];
      migrationsApplied?: unknown;
    };

    let legacyMigrationSucceeded = true;
    try {
      migrateLegacyLlmConfiguration(config);
    } catch (migrationError) {
      legacyMigrationSucceeded = false;
      debug(
        '[config] Failed to migrate legacy LLM configuration; preserving it for retry:',
        migrationError instanceof Error ? migrationError.message : migrationError,
      );
    }

    // Retired connection storage is removed only after Pi accepted the
    // migration. Keeping it on a transient Pi failure prevents a later config
    // save from discarding the user's provider definitions before retrying.
    if (legacyMigrationSucceeded) {
      delete config.defaultLlmConnection;
      delete config.llmConnections;
    }
    delete config.migrationsApplied;

    // Must have workspaces array
    if (!Array.isArray(config.workspaces)) {
      backupCorruptConfigFile(new Error('config.workspaces is missing or invalid'));
      return null;
    }

    // Expand path variables (~ and ${HOME}) for portability
    for (const workspace of config.workspaces) {
      workspace.rootPath = expandPath(workspace.rootPath);
    }

    // Validate active workspace exists
    const activeWorkspace = config.workspaces.find(w => w.id === config.activeWorkspaceId);
    if (!activeWorkspace) {
      // Default to first workspace
      config.activeWorkspaceId = config.workspaces[0]?.id || null;
    }

    // Ensure workspace folder structure exists for all workspaces.
    // Failures here are non-fatal — the workspace will be re-created on next access.
    for (const workspace of config.workspaces) {
      if (!isValidWorkspace(workspace.rootPath)) {
        try {
          createWorkspaceAtPath(workspace.rootPath, workspace.name);
        } catch (wsError) {
          debug('[config] Failed to create workspace at', workspace.rootPath, ':', wsError instanceof Error ? wsError.message : wsError);
        }
      }
    }

    return attachConfigSnapshot(config, {
      version: record.version,
      value: record.value,
    });
  } catch (error) {
    debug('[config] loadStoredConfig failed:', error instanceof Error ? error.message : error);
    backupCorruptConfigFile(error);
    return null;
  }
}

export function saveConfig(config: StoredConfig): void {
  ensureConfigDir();

  // Convert paths to portable form (~ prefix) for cross-machine compatibility
  const legacyConfig = config as StoredConfig & {
    defaultLlmConnection?: unknown;
    llmConnections?: unknown;
    migrationsApplied?: unknown;
  };
  // Successful migrations remove retired fields in loadStoredConfig. If a
  // migration failed, retain those fields so this save does not erase data that
  // still needs to be imported on a later launch.
  const { migrationsApplied: _migrationsApplied, ...currentConfig } = legacyConfig;
  const storageConfig: StoredConfig = {
    ...currentConfig,
    workspaces: config.workspaces.map(ws => ({
      ...ws,
      rootPath: toPortablePath(ws.rootPath),
    })),
  };

  const store = getConfigStore();
  const snapshot = (config as ConfigWithSnapshot)[CONFIG_SNAPSHOT];
  let result;
  if (snapshot) {
    const operations = configDiff(snapshot.value, storageConfig);
    if (operations.length === 0) return;
    result = store.mutateRecordPatch({
      namespace: CONFIG_RECORD_NAMESPACE,
      key: CONFIG_RECORD_KEY,
      operations,
      expectedVersion: snapshot.version,
      operationId: `config-patch-${randomUUID()}`,
    });
  } else {
    const current = store.getRecord(CONFIG_RECORD_NAMESPACE, CONFIG_RECORD_KEY);
    result = store.mutateRecord({
      namespace: CONFIG_RECORD_NAMESPACE,
      key: CONFIG_RECORD_KEY,
      value: storageConfig as unknown as JsonValue,
      expectedVersion: current?.version ?? null,
      operationId: `config-replace-${randomUUID()}`,
    });
  }
  if (result.status !== 'applied') {
    throw new Error(`Configuration write conflicted with another backend (version ${result.currentVersion ?? 'missing'})`);
  }
  materializeConfig(result.value as unknown as StoredConfig);
  attachConfigSnapshot(config, {
    version: result.version,
    value: result.value as unknown as StoredConfig,
  });
}

export function getMidStreamBehavior(): MidStreamBehavior {
  return normalizeMidStreamBehavior(loadStoredConfig()?.midStreamBehavior)
    ?? DEFAULT_MID_STREAM_BEHAVIOR;
}

export function setMidStreamBehavior(value: unknown): boolean {
  const behavior = normalizeMidStreamBehavior(value);
  if (!behavior) return false;
  const config = loadStoredConfig();
  if (!config) return false;
  config.midStreamBehavior = behavior;
  saveConfig(config);
  return true;
}

/**
 * Get whether desktop notifications are enabled.
 * Defaults to true if not set.
 */
export function getNotificationsEnabled(): boolean {
  const config = loadStoredConfig();
  if (config?.notificationsEnabled !== undefined) {
    return config.notificationsEnabled;
  }
  const defaults = loadConfigDefaults();
  return defaults.defaults.notificationsEnabled;
}

/**
 * Set whether desktop notifications are enabled.
 */
export function setNotificationsEnabled(enabled: boolean): void {
  const config = loadStoredConfig();
  if (!config) return;
  config.notificationsEnabled = enabled;
  saveConfig(config);
}

/**
 * Get whether auto-capitalisation is enabled.
 * Defaults to true if not set.
 */
export function getAutoCapitalisation(): boolean {
  const config = loadStoredConfig();
  if (config?.autoCapitalisation !== undefined) {
    return config.autoCapitalisation;
  }
  const defaults = loadConfigDefaults();
  return defaults.defaults.autoCapitalisation;
}

/**
 * Set whether auto-capitalisation is enabled.
 */
export function setAutoCapitalisation(enabled: boolean): void {
  const config = loadStoredConfig();
  if (!config) return;
  config.autoCapitalisation = enabled;
  saveConfig(config);
}

/**
 * Get the key combination used to send messages.
 * Defaults to 'enter' if not set.
 */
export function getSendMessageKey(): 'enter' | 'cmd-enter' {
  const config = loadStoredConfig();
  if (config?.sendMessageKey !== undefined) {
    return config.sendMessageKey;
  }
  const defaults = loadConfigDefaults();
  return defaults.defaults.sendMessageKey;
}

/**
 * Set the key combination used to send messages.
 */
export function setSendMessageKey(key: 'enter' | 'cmd-enter'): void {
  const config = loadStoredConfig();
  if (!config) return;
  config.sendMessageKey = key;
  saveConfig(config);
}

/**
 * Get whether spell check is enabled in the input.
 */
export function getSpellCheck(): boolean {
  const config = loadStoredConfig();
  if (config?.spellCheck !== undefined) {
    return config.spellCheck;
  }
  const defaults = loadConfigDefaults();
  return defaults.defaults.spellCheck;
}

/**
 * Set whether spell check is enabled in the input.
 */
export function setSpellCheck(enabled: boolean): void {
  const config = loadStoredConfig();
  if (!config) return;
  config.spellCheck = enabled;
  saveConfig(config);
}

/**
 * Get whether screen should stay awake while sessions are running.
 * Defaults to false if not set.
 */
export function getKeepAwakeWhileRunning(): boolean {
  const config = loadStoredConfig();
  if (config?.keepAwakeWhileRunning !== undefined) {
    return config.keepAwakeWhileRunning;
  }
  const defaults = loadConfigDefaults();
  return defaults.defaults.keepAwakeWhileRunning;
}

/**
 * Set whether screen should stay awake while sessions are running.
 */
export function setKeepAwakeWhileRunning(enabled: boolean): void {
  const config = loadStoredConfig();
  if (!config) return;
  config.keepAwakeWhileRunning = enabled;
  saveConfig(config);
}

/**
 * Get whether rich tool descriptions are enabled.
 * When enabled, all tool calls include intent and display name metadata.
 * Defaults to true if not set.
 */
export function getRichToolDescriptions(): boolean {
  const config = loadStoredConfig();
  if (config?.richToolDescriptions !== undefined) {
    return config.richToolDescriptions;
  }
  return true;
}

/**
 * Set whether rich tool descriptions are enabled.
 */
export function setRichToolDescriptions(enabled: boolean): void {
  const config = loadStoredConfig();
  if (!config) return;
  config.richToolDescriptions = enabled;
  saveConfig(config);
}

export function getExtendedPromptCache(): boolean {
  return readPiMortiseBoolean('extendedPromptCache', false);
}

export async function setExtendedPromptCache(enabled: boolean): Promise<void> {
  await writePiMortiseBoolean('extendedPromptCache', enabled);
}

export function getEnable1MContext(): boolean {
  return readPiMortiseBoolean('enable1MContext', false);
}

export async function setEnable1MContext(enabled: boolean): Promise<void> {
  await writePiMortiseBoolean('enable1MContext', enabled);
}

export function getRtkEnabled(): boolean {
  return readPiMortiseBoolean('rtkEnabled', false);
}

export async function setRtkEnabled(enabled: boolean): Promise<void> {
  await writePiMortiseBoolean('rtkEnabled', enabled);
}

/**
 * Get whether the built-in browser tool is enabled.
 * When disabled, browser_tool is not included in session tools.
 * Source of truth: Pi `~/.pi/agent/settings.json.shellGui.mortise.browserToolEnabled`.
 * Defaults to true if not set.
 */
export function getBrowserToolEnabled(): boolean {
  return readPiShellGuiBoolean('mortise', 'browserToolEnabled', true);
}

/**
 * Set whether the built-in browser tool is enabled.
 * Persists to Pi `~/.pi/agent/settings.json.shellGui.mortise.browserToolEnabled`.
 */
export async function setBrowserToolEnabled(enabled: boolean): Promise<void> {
  await writePiShellGuiBoolean('mortise', 'browserToolEnabled', enabled);

  // Clear session tool caches so all sessions pick up the change immediately.
  // Lazy import to avoid circular dependency (storage ← session-scoped-tools ← storage).
  import('../agent/session-scoped-tools.ts').then(m => m.invalidateAllSessionToolsCaches()).catch(() => {});
}

/**
 * Get whether Mortise data sources are available in the UI and agent runtime.
 * Uses the bundled default when the user has not explicitly chosen a value.
 */
export function getDataSourcesEnabled(): boolean {
  const config = loadStoredConfig();
  if (config?.dataSourcesEnabled !== undefined) {
    return config.dataSourcesEnabled;
  }
  return loadConfigDefaults().defaults.dataSourcesEnabled;
}

/** Persist the global data-source feature toggle. */
export function setDataSourcesEnabled(enabled: boolean): void {
  const config = loadStoredConfig();
  if (!config) return;
  config.dataSourcesEnabled = enabled;
  saveConfig(config);
}

/**
 * Whether remote agents may call `browser_tool evaluate <expression>` against this
 * desktop client's local browser. The check is enforced inside the local capability
 * dispatcher; the remote server cannot override it.
 *
 * Defaults to true. Users can flip it off in Settings → AI → Advanced if they don't
 * trust the remote workspaces they connect to.
 */
export function getAllowRemoteEvaluate(): boolean {
  const config = loadStoredConfig();
  if (config?.allowRemoteEvaluate !== undefined) {
    return config.allowRemoteEvaluate;
  }
  const defaults = loadConfigDefaults();
  return defaults.defaults.allowRemoteEvaluate;
}

export function setAllowRemoteEvaluate(allowed: boolean): void {
  const config = loadStoredConfig();
  if (!config) return;
  config.allowRemoteEvaluate = allowed;
  saveConfig(config);
}

// ============================================================
// Pi Extensions 集成开关
// 默认值来自 config-defaults.json (piExtensions.delegatePromptAutomation)
// ============================================================

function getDefaultPiExtensionSettings(): PiExtensionSettings {
  const defaults = loadConfigDefaults();
  return normalizePiExtensionSettings(defaults.defaults.piExtensions);
}

/**
 * 获取完整 Pi 扩展设置。
 * 兼容旧配置：不再支持的字段会在规范化时被忽略。
 */
export function getPiExtensionSettings(): PiExtensionSettings {
  const defaults = getDefaultPiExtensionSettings();
  const config = loadStoredConfig();
  return normalizePiExtensionSettings(config?.piExtensions, defaults);
}

/**
 * 覆盖保存完整 Pi 扩展设置。
 */
export function setPiExtensionSettings(settings: StoredPiExtensionSettings): PiExtensionSettings {
  const config = loadStoredConfig();
  const normalized = normalizePiExtensionSettings(settings, getDefaultPiExtensionSettings());
  if (!config) return normalized;
  config.piExtensions = normalized;
  saveConfig(config);
  return normalized;
}

/**
 * 局部更新 Pi 扩展设置。
 */
export function updatePiExtensionSettings(patch: StoredPiExtensionSettings): PiExtensionSettings {
  const current = getPiExtensionSettings();
  const next = mergePiExtensionSettings(current, patch);
  const config = loadStoredConfig();
  if (!config) return next;
  config.piExtensions = next;
  saveConfig(config);
  return next;
}

/**
 * 是否将 automation 的 prompt 触发执行路径委托给 pi prompt-automation 扩展。
 * 默认 false。
 */
export function getPiExtensionsDelegatePromptAutomation(): boolean {
  const config = loadStoredConfig();
  if (config?.piExtensions?.delegatePromptAutomation !== undefined) {
    return Boolean(config.piExtensions.delegatePromptAutomation);
  }
  // 透传（壳）模式下默认委托给 Pi 扩展；否则默认 false
  if (getPiShellFullPassthrough()) {
    return true;
  }
  return getPiExtensionSettings().delegatePromptAutomation;
}

/**
 * 设置是否委托 automation prompt 给 pi prompt-automation 扩展。
 */
export function setPiExtensionsDelegatePromptAutomation(delegate: boolean): void {
  updatePiExtensionSettings({ delegatePromptAutomation: delegate });
}

// ============================================================
// Pi 壳模式开关
// 默认值来自 config-defaults.json (piShell.fullPassthrough)
// ============================================================

/**
 * 是否启用完全 Pi 透传（壳模式）。
 * 默认 true。为 true 时使用 Pi 原生 system prompt，移除 Mortise 身份覆盖；
 * 为 false 时回退到 Mortise 独立身份模式（应用 applySystemPromptOverride）。
 * Source of truth: Pi `~/.pi/agent/settings.json.shellGui.mortise.piShellFullPassthrough`.
 */
export function getPiShellFullPassthrough(): boolean {
  return readPiShellGuiBoolean('mortise', 'piShellFullPassthrough', true);
}

/**
 * 设置是否启用完全 Pi 透传（壳模式）。
 * Persists to Pi `~/.pi/agent/settings.json.shellGui.mortise.piShellFullPassthrough`.
 */
export async function setPiShellFullPassthrough(enabled: boolean): Promise<void> {
  await writePiShellGuiBoolean('mortise', 'piShellFullPassthrough', enabled);
}

/**
 * Get persisted Git Bash path (Windows only).
 * Used to set CLAUDE_CODE_GIT_BASH_PATH for the SDK subprocess.
 */
export function getGitBashPath(): string | undefined {
  const config = loadStoredConfig();
  return config?.gitBashPath;
}

/**
 * Set Git Bash path (Windows only).
 * Persists to config so it survives app restarts.
 * Returns false if the config could not be loaded (path not persisted).
 */
export function setGitBashPath(path: string): boolean {
  const config = loadStoredConfig();
  if (!config) {
    console.warn('[storage] Failed to persist Git Bash path: config could not be loaded');
    return false;
  }
  config.gitBashPath = path;
  saveConfig(config);
  return true;
}

/**
 * Clear persisted Git Bash path (Windows only).
 * Used when the stored path is stale or invalid.
 */
export function clearGitBashPath(): void {
  const config = loadStoredConfig();
  if (!config || !config.gitBashPath) return;
  delete config.gitBashPath;
  saveConfig(config);
}

// Note: getDefaultWorkingDirectory/setDefaultWorkingDirectory removed.
// Workspace root is the only cwd; legacy defaults.workingDirectory is migrated
// away and no longer participates in session storage or execution routing.
// Note: getDefaultPermissionMode/getEnabledPermissionModes removed
// Permission settings are now stored per-workspace in workspace config.json (defaults.permissionMode, defaults.cyclablePermissionModes)

export function getConfigPath(): string {
  return CONFIG_FILE;
}

/**
 * Clear all configuration and credentials (for logout).
 * Deletes config file and credentials file.
 */
export async function clearAllConfig(): Promise<void> {
  closeWorkspaceStorage();
  if (configStore) {
    configStore.close();
    configStore = null;
  }
  // Delete config file
  if (existsSync(CONFIG_FILE)) {
    rmSync(CONFIG_FILE);
  }
  for (const stateFile of [CONFIG_DATABASE_FILE, `${CONFIG_DATABASE_FILE}-wal`, `${CONFIG_DATABASE_FILE}-shm`, CONFIG_SYNC_BASELINE_FILE]) {
    if (existsSync(stateFile)) rmSync(stateFile);
  }

  // Delete credentials file
  const credentialsFile = join(CONFIG_DIR, 'credentials.enc');
  if (existsSync(credentialsFile)) {
    rmSync(credentialsFile);
  }

  try {
    clearAllCraftCredentials();
  } catch (error) {
    debug('[config] Failed to clear mortise credentials from pi auth.json:', error instanceof Error ? error.message : error);
  }

  // Optionally: Delete workspace data (conversations)
  const workspacesDir = join(CONFIG_DIR, 'workspaces');
  if (existsSync(workspacesDir)) {
    rmSync(workspacesDir, { recursive: true });
  }
}

// ============================================
// Workspace Management Functions
// ============================================

/**
 * Generate a unique workspace ID.
 * Uses a random UUID-like format.
 */
export function generateWorkspaceId(): string {
  // Generate random bytes and format as UUID-like string (8-4-4-4-12)
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Find workspace icon file at workspace_root/icon.*
 * Returns absolute path to icon file if found, null otherwise
 */
export function findWorkspaceIcon(rootPath: string): string | null {
  return findIconFile(rootPath) ?? null;
}

export function getWorkspaces(): Workspace[] {
  const config = loadStoredConfig();
  const workspaces = config?.workspaces || [];

  // Resolve workspace names from folder config and local icons
  return workspaces.map(w => {
    // Read name from workspace folder config (single source of truth)
    const wsConfig = loadWorkspaceConfig(w.rootPath);
    const name = wsConfig?.name || basename(w.rootPath) || 'Untitled';

    // If workspace has a stored iconUrl that's a remote URL, use it
    // Otherwise check for local icon file
    let iconUrl = w.iconUrl;
    if (!iconUrl || (!iconUrl.startsWith('http://') && !iconUrl.startsWith('https://'))) {
      const localIcon = findWorkspaceIcon(w.rootPath);
      if (localIcon) {
        // Convert absolute path to file:// URL for Electron renderer
        // Append mtime as cache-buster so UI refreshes when icon changes
        try {
          const mtime = statSync(localIcon).mtimeMs;
          iconUrl = `file://${localIcon}?t=${mtime}`;
        } catch {
          iconUrl = `file://${localIcon}`;
        }
      }
    }

    const slug = extractWorkspaceSlugFromPath(w.rootPath, w.id);
    return { ...w, name, slug, iconUrl };
  });
}

export function getActiveWorkspace(): Workspace | null {
  const config = loadStoredConfig();
  if (!config || !config.activeWorkspaceId) {
    return config?.workspaces[0] || null;
  }
  return config.workspaces.find(w => w.id === config.activeWorkspaceId) || config.workspaces[0] || null;
}

/**
 * Find a workspace by name (case-insensitive) or ID.
 * Useful for CLI -w flag to specify workspace.
 */
export function getWorkspaceByNameOrId(nameOrId: string): Workspace | null {
  const workspaces = getWorkspaces();
  return workspaces.find(w =>
    w.id === nameOrId ||
    w.name.toLowerCase() === nameOrId.toLowerCase()
  ) || null;
}

export function updateWorkspaceRemoteServer(
  workspaceId: string,
  remoteServer: RemoteServerConfig,
): void {
  const config = loadStoredConfig();
  if (!config) return;
  const ws = config.workspaces.find(w => w.id === workspaceId);
  if (!ws) throw new Error('Workspace not found');
  ws.remoteServer = remoteServer;
  saveConfig(config);
}

export function setActiveWorkspace(workspaceId: string): void {
  const config = loadStoredConfig();
  if (!config) return;

  const workspace = config.workspaces.find(w => w.id === workspaceId);
  if (!workspace) return;

  config.activeWorkspaceId = workspaceId;
  saveConfig(config);
}

/**
 * Atomically switch to a workspace and load/create a session.
 * This prevents race conditions by doing both operations together.
 *
 * @param workspaceId The ID of the workspace to switch to
 * @returns The workspace and session, or null if workspace not found
 */
export async function switchWorkspaceAtomic(workspaceId: string): Promise<{ workspace: Workspace; session: SessionHeader } | null> {
  const config = loadStoredConfig();
  if (!config) return null;

  const workspace = config.workspaces.find(w => w.id === workspaceId);
  if (!workspace) return null;

  // Get or create the latest session for this workspace
  const session = await getOrCreateLatestSession(workspace.rootPath);

  // Update active workspace in config
  config.activeWorkspaceId = workspaceId;
  workspace.lastAccessedAt = Date.now();
  saveConfig(config);

  return { workspace, session };
}

/**
 * Add a workspace to the global config.
 * @param workspace - Workspace data (must include rootPath)
 */
export function addWorkspace(workspace: Omit<Workspace, 'id' | 'createdAt' | 'slug'>): Workspace {
  const config = loadStoredConfig();
  if (!config) {
    throw new Error('No config found');
  }

  const slug = extractWorkspaceSlugFromPath(workspace.rootPath, '');

  // Check if workspace with same rootPath already exists
  const existing = config.workspaces.find(w => w.rootPath === workspace.rootPath);
  if (existing) {
    // Update existing workspace with new settings
    const updated: Workspace = {
      ...existing,
      ...workspace,
      slug,
      id: existing.id,
      createdAt: existing.createdAt,
    };
    const existingIndex = config.workspaces.indexOf(existing);
    config.workspaces[existingIndex] = updated;
    saveConfig(config);
    return updated;
  }

  const newWorkspace: Workspace = {
    ...workspace,
    slug,
    id: generateWorkspaceId(),
    createdAt: Date.now(),
  };

  // Create workspace folder structure if it doesn't exist
  if (!isValidWorkspace(newWorkspace.rootPath)) {
    createWorkspaceAtPath(newWorkspace.rootPath, newWorkspace.name);
  }

  config.workspaces.push(newWorkspace);

  // If this is the only workspace, make it active
  if (config.workspaces.length === 1) {
    config.activeWorkspaceId = newWorkspace.id;
  }

  saveConfig(config);
  return newWorkspace;
}

/**
 * Sync workspaces by discovering workspaces in the default location
 * that aren't already tracked in the global config.
 * Call this on app startup.
 */
export function syncWorkspaces(): void {
  const config = loadStoredConfig();
  if (!config) return;

  const discoveredPaths = discoverWorkspacesInDefaultLocation();
  const trackedPaths = new Set(config.workspaces.map(w => w.rootPath));

  let added = false;
  for (const rootPath of discoveredPaths) {
    if (trackedPaths.has(rootPath)) continue;

    // Load the workspace config to get name
    const wsConfig = loadWorkspaceConfig(rootPath);
    if (!wsConfig) continue;

    const newWorkspace: Workspace = {
      id: wsConfig.id || generateWorkspaceId(),
      name: wsConfig.name,
      slug: extractWorkspaceSlugFromPath(rootPath, ''),
      rootPath,
      createdAt: wsConfig.createdAt || Date.now(),
    };

    config.workspaces.push(newWorkspace);
    added = true;
  }

  if (added) {
    // If no active workspace, set to first
    if (!config.activeWorkspaceId && config.workspaces.length > 0) {
      config.activeWorkspaceId = config.workspaces[0]!.id;
    }
    saveConfig(config);
  }
}

export async function removeWorkspace(workspaceId: string): Promise<boolean> {
  const config = loadStoredConfig();
  if (!config) return false;

  const index = config.workspaces.findIndex(w => w.id === workspaceId);
  if (index === -1) return false;

  config.workspaces.splice(index, 1);

  // If we removed the active workspace, switch to first available
  if (config.activeWorkspaceId === workspaceId) {
    config.activeWorkspaceId = config.workspaces[0]?.id || null;
  }

  saveConfig(config);

  // Clean up credential store credentials for this workspace
  const manager = getCredentialManager();
  await manager.deleteWorkspaceCredentials(workspaceId);

  // Delete workspace data directory (sessions, plans, etc.)
  const workspaceDataDir = join(WORKSPACES_DIR, workspaceId);
  if (existsSync(workspaceDataDir)) {
    try {
      rmSync(workspaceDataDir, { recursive: true });
    } catch (error) {
      console.error(`[storage] Failed to delete workspace data directory: ${workspaceDataDir}`, error);
    }
  }

  return true;
}

// Note: renameWorkspace() was removed - workspace names are now stored only in folder config
// Use updateWorkspaceSetting('name', ...) to rename workspaces via the folder config

// ============================================
// Workspace Conversation Persistence
// ============================================

const WORKSPACES_DIR = join(CONFIG_DIR, 'workspaces');

function ensureWorkspaceDir(workspaceId: string): string {
  const dir = join(WORKSPACES_DIR, workspaceId);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}


// Re-export types from core for convenience
export type { StoredAttachment, StoredMessage } from '@mortise/core/types';

export interface WorkspaceConversation {
  messages: StoredMessage[];
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    contextTokens: number;
    costUsd: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  };
  savedAt: number;
}

// Save workspace conversation (messages + token usage)
export function saveWorkspaceConversation(
  workspaceId: string,
  messages: StoredMessage[],
  tokenUsage: WorkspaceConversation['tokenUsage']
): void {
  const dir = ensureWorkspaceDir(workspaceId);
  const filePath = join(dir, 'conversation.json');

  const conversation: WorkspaceConversation = {
    messages,
    tokenUsage,
    savedAt: Date.now(),
  };

  try {
    withFileLockSync(filePath, () => writeFileSync(filePath, JSON.stringify(conversation, null, 2), 'utf-8'));
  } catch (e) {
    // Handle cyclic structures or other serialization errors
    console.error(`[storage] [CYCLIC STRUCTURE] Failed to save workspace conversation:`, e);
    console.error(`[storage] Message count: ${messages.length}, message types: ${messages.map(m => m.type).join(', ')}`);
    // Try to save with sanitized messages
    try {
      const sanitizedMessages = messages.map((m, i) => {
        let safeToolInput = m.toolInput;
        if (m.toolInput) {
          try {
            JSON.stringify(m.toolInput);
          } catch (inputErr) {
            console.error(`[storage] [CYCLIC STRUCTURE] in message ${i} toolInput (tool: ${m.toolName}), keys: ${Object.keys(m.toolInput).join(', ')}, error: ${inputErr}`);
            safeToolInput = { error: '[non-serializable input]' };
          }
        }
        return { ...m, toolInput: safeToolInput };
      });
      const sanitizedConversation: WorkspaceConversation = {
        messages: sanitizedMessages,
        tokenUsage,
        savedAt: Date.now(),
      };
      withFileLockSync(filePath, () => writeFileSync(filePath, JSON.stringify(sanitizedConversation, null, 2), 'utf-8'));
      console.error(`[storage] Saved sanitized workspace conversation successfully`);
    } catch (e2) {
      console.error(`[storage] Failed to save even sanitized workspace conversation:`, e2);
    }
  }
}

// Load workspace conversation
export function loadWorkspaceConversation(workspaceId: string): WorkspaceConversation | null {
  const filePath = join(WORKSPACES_DIR, workspaceId, 'conversation.json');

  try {
    if (!existsSync(filePath)) {
      return null;
    }
    return readJsonFileSync<WorkspaceConversation>(filePath);
  } catch {
    return null;
  }
}

// Get workspace data directory path
export function getWorkspaceDataPath(workspaceId: string): string {
  return join(WORKSPACES_DIR, workspaceId);
}

// Clear workspace conversation
export function clearWorkspaceConversation(workspaceId: string): void {
  const filePath = join(WORKSPACES_DIR, workspaceId, 'conversation.json');
  if (existsSync(filePath)) {
    withFileLockSync(filePath, () => writeFileSync(filePath, '{}', 'utf-8'));
  }

  // Also clear any active plan (plans are session-scoped)
  clearWorkspacePlan(workspaceId);
}

// ============================================
// Plan Storage (Session-Scoped)
// Plans are stored per-workspace and cleared with /clear
// ============================================

/**
 * Save a plan for a workspace.
 * Plans are session-scoped - they persist during the session but are
 * cleared when the user runs /clear or starts a new session.
 */
export function saveWorkspacePlan(workspaceId: string, plan: Plan): void {
  const dir = ensureWorkspaceDir(workspaceId);
  const filePath = join(dir, 'plan.json');
  withFileLockSync(filePath, () => writeFileSync(filePath, JSON.stringify(plan, null, 2), 'utf-8'));
}

/**
 * Load the current plan for a workspace.
 * Returns null if no plan exists.
 */
export function loadWorkspacePlan(workspaceId: string): Plan | null {
  const filePath = join(WORKSPACES_DIR, workspaceId, 'plan.json');

  try {
    if (!existsSync(filePath)) {
      return null;
    }
    return readJsonFileSync<Plan>(filePath);
  } catch {
    return null;
  }
}

/**
 * Clear the plan for a workspace.
 * Called when user runs /clear or cancels a plan.
 */
export function clearWorkspacePlan(workspaceId: string): void {
  const filePath = join(WORKSPACES_DIR, workspaceId, 'plan.json');
  if (existsSync(filePath)) {
    rmSync(filePath);
  }
}

// ============================================
// Session Input Drafts
// Persists composer state (text + attachments) per session across app restarts.
// Two shapes for attachments:
//  - Track P: { path, name } — absolute path captured via webUtils.getPathForFile
//    (file-picker / OS drag). Re-read on hydrate via file:readUserAttachment RPC.
//  - Track C: { path, name, content } — inline content for paste / web-drag Files
//    that never existed on disk. Hydrate reconstructs directly from the stored bytes.
// ============================================

const DRAFTS_FILE = join(CONFIG_DIR, 'drafts.json');
const DRAFTS_SYNC_BASELINE_FILE = join(CONFIG_DIR, '.drafts.json.sync');
const DRAFTS_RECORD_NAMESPACE = 'drafts';
const DRAFTS_RECORD_KEY = 'root';

export interface DraftAttachmentContent {
  type: 'image' | 'pdf' | 'text' | 'office' | 'audio' | 'unknown';
  mimeType: string;
  size: number;
  base64?: string;
  text?: string;
  thumbnailBase64?: string;
}

export interface DraftAttachmentRef {
  path: string;
  name: string;
  /** Inline content for attachments without a real filesystem path (paste, web-drag).
   *  When present, hydrate reconstructs from these bytes and skips any disk read. */
  content?: DraftAttachmentContent;
}

export interface SessionDraft {
  text: string;
  attachments?: DraftAttachmentRef[];
}

interface DraftsData {
  drafts: Record<string, SessionDraft>;
  updatedAt: number;
}

interface DraftsRecord {
  version: number;
  value: DraftsData;
}

const ATTACHMENT_CONTENT_TYPES = new Set(['image', 'pdf', 'text', 'office', 'audio', 'unknown']);

function isAbsoluteDraftPath(p: string): boolean {
  if (!p) return false;
  if (p.startsWith('/')) return true;
  if (/^[A-Za-z]:[\\/]/.test(p)) return true;
  return false;
}

function isDraftAttachmentContent(value: unknown): value is DraftAttachmentContent {
  if (!value || typeof value !== 'object') return false;
  const c = value as DraftAttachmentContent;
  if (!ATTACHMENT_CONTENT_TYPES.has(c.type as string)) return false;
  if (typeof c.mimeType !== 'string') return false;
  if (typeof c.size !== 'number') return false;
  if (c.base64 !== undefined && typeof c.base64 !== 'string') return false;
  if (c.text !== undefined && typeof c.text !== 'string') return false;
  if (c.thumbnailBase64 !== undefined && typeof c.thumbnailBase64 !== 'string') return false;
  return true;
}

function isDraftAttachmentRef(value: unknown): value is DraftAttachmentRef {
  if (!value || typeof value !== 'object') return false;
  const ref = value as DraftAttachmentRef;
  if (typeof ref.path !== 'string' || typeof ref.name !== 'string') return false;
  if (ref.content !== undefined && !isDraftAttachmentContent(ref.content)) return false;
  // Post-migration guard: refs without content MUST have an absolute path. This rejects
  // the broken 0.8.11 shape (synthetic path === filename, no content) on first load —
  // user sees empty drafts once instead of attachments silently disappearing forever.
  if (ref.content === undefined && !isAbsoluteDraftPath(ref.path)) return false;
  return true;
}

function isSessionDraft(value: unknown): value is SessionDraft {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as SessionDraft;
  if (typeof candidate.text !== 'string') return false;
  if (candidate.attachments !== undefined) {
    if (!Array.isArray(candidate.attachments)) return false;
    if (!candidate.attachments.every(isDraftAttachmentRef)) return false;
  }
  return true;
}

function isEmptyDraft(draft: SessionDraft): boolean {
  return !draft.text && (!draft.attachments || draft.attachments.length === 0);
}

/**
 * Load all drafts from disk. Entries that don't parse as SessionDraft
 * (e.g. pre-upgrade string drafts) are discarded silently.
 */
function normalizeDraftsData(raw: unknown): DraftsData {
  const candidate = raw && typeof raw === 'object' ? raw as { drafts?: Record<string, unknown>; updatedAt?: number } : {};
  const drafts: Record<string, SessionDraft> = {};
  for (const [sessionId, value] of Object.entries(candidate.drafts ?? {})) {
    if (isSessionDraft(value)) drafts[sessionId] = value;
  }
  return {
    drafts,
    updatedAt: typeof candidate.updatedAt === 'number' ? candidate.updatedAt : 0,
  };
}

function materializeDrafts(data: DraftsData): void {
  atomicWriteFileSync(DRAFTS_FILE, JSON.stringify(data, null, 2));
  atomicWriteFileSync(DRAFTS_SYNC_BASELINE_FILE, JSON.stringify(data));
}

function loadLegacyDrafts(): DraftsData {
  try {
    if (!existsSync(DRAFTS_FILE)) return { drafts: {}, updatedAt: 0 };
    return normalizeDraftsData(readJsonFileSync<unknown>(DRAFTS_FILE));
  } catch {
    return { drafts: {}, updatedAt: 0 };
  }
}

function loadDraftRecord(): DraftsRecord | null {
  ensureConfigDir();
  const store = getConfigStore();
  const stored = store.getRecord(DRAFTS_RECORD_NAMESPACE, DRAFTS_RECORD_KEY);
  if (stored) {
    const value = normalizeDraftsData(stored.value);
    let fileValue: DraftsData | null = null;
    try {
      if (existsSync(DRAFTS_FILE)) fileValue = normalizeDraftsData(readJsonFileSync<unknown>(DRAFTS_FILE));
    } catch {
      fileValue = null;
    }
    let baseline: DraftsData | null = null;
    try {
      if (existsSync(DRAFTS_SYNC_BASELINE_FILE)) baseline = normalizeDraftsData(JSON.parse(readFileSync(DRAFTS_SYNC_BASELINE_FILE, 'utf8')));
    } catch {
      baseline = null;
    }
    if (fileValue && baseline && configHash(fileValue) !== configHash(baseline)) {
      const operations = configDiff(baseline, fileValue);
      if (operations.length > 0) {
        const result = store.mutateRecordPatch({
          namespace: DRAFTS_RECORD_NAMESPACE,
          key: DRAFTS_RECORD_KEY,
          operations,
          expectedVersion: stored.version,
          operationId: `legacy-drafts-${configHash(fileValue)}`,
        });
        if (result.status === 'applied') {
          const next = normalizeDraftsData(result.value);
          materializeDrafts(next);
          return { version: result.version, value: next };
        }
      }
    }
    if (!fileValue || configHash(fileValue) !== configHash(value)) materializeDrafts(value);
    return { version: stored.version, value };
  }

  if (!existsSync(DRAFTS_FILE)) return null;
  const imported = loadLegacyDrafts();
  const result = store.mutateRecord({
    namespace: DRAFTS_RECORD_NAMESPACE,
    key: DRAFTS_RECORD_KEY,
    value: imported as unknown as JsonValue,
    expectedVersion: null,
    operationId: `import-drafts-${configHash(imported)}`,
  });
  if (result.status !== 'applied') return null;
  const value = normalizeDraftsData(result.value);
  materializeDrafts(value);
  return { version: result.version, value };
}

function ensureDraftRecord(): DraftsRecord {
  const existing = loadDraftRecord();
  if (existing) return existing;
  const empty: DraftsData = { drafts: {}, updatedAt: 0 };
  const result = getConfigStore().mutateRecord({
    namespace: DRAFTS_RECORD_NAMESPACE,
    key: DRAFTS_RECORD_KEY,
    value: empty as unknown as JsonValue,
    expectedVersion: null,
    operationId: `create-drafts-${randomUUID()}`,
  });
  if (result.status !== 'applied') throw new Error('Unable to initialize draft storage');
  materializeDrafts(empty);
  return { version: result.version, value: empty };
}

function loadDraftsData(): DraftsData {
  return loadDraftRecord()?.value ?? { drafts: {}, updatedAt: 0 };
}

/**
 * Get the persisted draft for a session (text + attachment refs).
 */
export function getSessionDraft(sessionId: string): SessionDraft | null {
  const data = loadDraftsData();
  return data.drafts[sessionId] ?? null;
}

/**
 * Set the draft for a session. Empty drafts (no text and no attachments)
 * are removed from disk.
 */
export function setSessionDraft(sessionId: string, draft: SessionDraft): void {
  const record = ensureDraftRecord();
  const existing = record.value.drafts[sessionId];
  const next = isEmptyDraft(draft)
    ? undefined
    : {
        text: draft.text,
        ...(draft.attachments && draft.attachments.length > 0
          ? { attachments: draft.attachments.map(normalizeDraftAttachment) }
          : {}),
      };
  if (configHash(existing) === configHash(next)) return;

  const result = getConfigStore().mutateRecordPatch({
    namespace: DRAFTS_RECORD_NAMESPACE,
    key: DRAFTS_RECORD_KEY,
    operations: [{
      path: `/drafts/${pointerPart(sessionId)}`,
      expectedExists: existing !== undefined,
      ...(existing !== undefined ? { expectedValue: existing as unknown as JsonValue } : {}),
      ...(next === undefined ? { remove: true } : { value: next as unknown as JsonValue }),
    }],
    expectedVersion: record.version,
    operationId: `draft-${randomUUID()}`,
  });
  if (result.status !== 'applied') throw new Error(`Draft write conflicted for session ${sessionId}`);
  materializeDrafts(normalizeDraftsData(result.value));
}

function normalizeDraftAttachment(ref: DraftAttachmentRef): DraftAttachmentRef {
  const base: DraftAttachmentRef = { path: ref.path, name: ref.name };
  if (ref.content && isDraftAttachmentContent(ref.content)) {
    const c = ref.content;
    base.content = {
      type: c.type,
      mimeType: c.mimeType,
      size: c.size,
      ...(c.base64 !== undefined ? { base64: c.base64 } : {}),
      ...(c.text !== undefined ? { text: c.text } : {}),
      ...(c.thumbnailBase64 !== undefined ? { thumbnailBase64: c.thumbnailBase64 } : {}),
    };
  }
  return base;
}

export function deleteSessionDraft(sessionId: string): void {
  const record = loadDraftRecord();
  const existing = record?.value.drafts[sessionId];
  if (!record || existing === undefined) return;
  const result = getConfigStore().mutateRecordPatch({
    namespace: DRAFTS_RECORD_NAMESPACE,
    key: DRAFTS_RECORD_KEY,
    operations: [{
      path: `/drafts/${pointerPart(sessionId)}`,
      expectedExists: true,
      expectedValue: existing as unknown as JsonValue,
      remove: true,
    }],
    expectedVersion: record.version,
    operationId: `delete-draft-${randomUUID()}`,
  });
  if (result.status !== 'applied') throw new Error(`Draft delete conflicted for session ${sessionId}`);
  materializeDrafts(normalizeDraftsData(result.value));
}

/**
 * Get all drafts as a record keyed by sessionId.
 */
export function getAllSessionDrafts(): Record<string, SessionDraft> {
  const data = loadDraftsData();
  return data.drafts;
}

// ============================================
// Theme Storage (App-level only)
// ============================================

import type { ThemeOverrides, ThemeFile, PresetTheme } from './theme.ts';

const APP_THEME_FILE = join(CONFIG_DIR, 'theme.json');
const APP_THEMES_DIR = join(CONFIG_DIR, 'themes');

/**
 * Get the path to the app-level theme override file (~/.mortise/theme.json).
 */
export function getAppThemePath(): string {
  return APP_THEME_FILE;
}

// Track if preset themes have been synced this session (prevents re-init on hot reload)
let presetsInitialized = false;

/**
 * Get the app-level themes directory.
 * Preset themes are stored at ~/.mortise/themes/
 */
export function getAppThemesDir(): string {
  return APP_THEMES_DIR;
}

/**
 * Load app-level theme overrides
 */
export function loadAppTheme(): ThemeOverrides | null {
  try {
    if (!existsSync(APP_THEME_FILE)) {
      return null;
    }
    return readJsonFileSync<ThemeOverrides>(APP_THEME_FILE);
  } catch {
    return null;
  }
}

/**
 * Save app-level theme overrides
 */
export function saveAppTheme(theme: ThemeOverrides): void {
  ensureConfigDir();
  withFileLockSync(APP_THEME_FILE, () => writeFileSync(APP_THEME_FILE, JSON.stringify(theme, null, 2), 'utf-8'));
}


// ============================================
// Preset Themes (app-level)
// ============================================

/**
 * Sync bundled preset themes to disk on launch.
 * Preserves user customizations:
 * - If file doesn't exist → copy from bundle
 * - If file exists but is invalid/corrupt → copy from bundle (auto-heal)
 * - If file exists and is valid → skip (preserve user changes)
 *
 * User-created custom theme files (with non-bundled filenames) are untouched.
 * User color overrides live in theme.json (separate file) and are never touched.
 */
export function ensurePresetThemes(): void {
  // Skip if already initialized this session (prevents re-init on hot reload)
  if (presetsInitialized) {
    return;
  }
  presetsInitialized = true;

  const themesDir = getAppThemesDir();

  // Create themes directory if it doesn't exist
  if (!existsSync(themesDir)) {
    mkdirSync(themesDir, { recursive: true });
  }

  // Resolve bundled themes directory via shared asset resolver
  const bundledThemesDir = getBundledAssetsDir('themes');
  if (!bundledThemesDir) {
    return;
  }

  // Copy bundled preset themes to disk, preserving user customizations.
  // - If file doesn't exist → copy from bundle
  // - If file exists but is invalid/corrupt → copy from bundle (auto-heal)
  // - If file exists and is valid → skip (preserve user changes)
  try {
    const bundledFiles = readdirSync(bundledThemesDir).filter(f => f.endsWith('.json'));
    for (const file of bundledFiles) {
      const srcPath = join(bundledThemesDir, file);
      const destPath = join(themesDir, file);

      // Skip if file exists and is valid (preserve user customizations)
      if (existsSync(destPath) && isValidThemeFile(destPath)) {
        continue;
      }

      // Copy from bundle (new file or auto-heal corrupt file)
      const content = readFileSync(srcPath, 'utf-8');
      writeFileSync(destPath, content, 'utf-8');
    }
  } catch {
    // Ignore errors - themes are optional
  }
}

/**
 * Load all preset themes from app themes directory.
 * Returns array of PresetTheme objects sorted by name.
 */
export function loadPresetThemes(): PresetTheme[] {
  ensurePresetThemes();

  const themesDir = getAppThemesDir();
  if (!existsSync(themesDir)) {
    return [];
  }

  const themes: PresetTheme[] = [];

  try {
    const files = readdirSync(themesDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const id = file.replace('.json', '');
      const path = join(themesDir, file);
      try {
        const theme = readJsonFileSync<ThemeFile>(path);
        // Resolve relative backgroundImage paths to file:// URLs
        const resolvedTheme = resolveThemeBackgroundImage(theme, path);
        themes.push({ id, path, theme: resolvedTheme });
      } catch {
        // Skip invalid theme files
      }
    }
  } catch {
    return [];
  }

  // Sort by name (default first, then alphabetically)
  return themes.sort((a, b) => {
    if (a.id === 'default') return -1;
    if (b.id === 'default') return 1;
    return (a.theme.name || a.id).localeCompare(b.theme.name || b.id);
  });
}

/**
 * Get MIME type from file extension for data URL encoding.
 */
function getMimeType(filePath: string): string {
  const ext = filePath.toLowerCase().split('.').pop();
  switch (ext) {
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'svg': return 'image/svg+xml';
    default: return 'application/octet-stream';
  }
}

/**
 * Resolve relative backgroundImage paths to data URLs.
 * If the backgroundImage is a relative path (no protocol), resolve it relative to the theme's directory,
 * read the file, and convert it to a data URL. This is necessary because the renderer process
 * cannot access file:// URLs directly when running on localhost in dev mode.
 * @param theme - Theme object to process
 * @param themePath - Absolute path to the theme's JSON file
 */
function resolveThemeBackgroundImage(theme: ThemeFile, themePath: string): ThemeFile {
  if (!theme.backgroundImage) {
    return theme;
  }

  // Check if it's already an absolute URL (has protocol like http://, https://, data:)
  const hasProtocol = /^[a-z][a-z0-9+.-]*:/i.test(theme.backgroundImage);
  if (hasProtocol) {
    return theme;
  }

  // It's a relative path - resolve it relative to the theme's directory
  const themeDir = dirname(themePath);
  const absoluteImagePath = join(themeDir, theme.backgroundImage);

  // Read the file and convert to data URL so renderer can use it
  // (file:// URLs are blocked in renderer when running on localhost)
  try {
    if (!existsSync(absoluteImagePath)) {
      console.warn(`Theme background image not found: ${absoluteImagePath}`);
      return theme;
    }

    const imageBuffer = readFileSync(absoluteImagePath);
    const base64 = imageBuffer.toString('base64');
    const mimeType = getMimeType(absoluteImagePath);
    const dataUrl = `data:${mimeType};base64,${base64}`;

    return {
      ...theme,
      backgroundImage: dataUrl,
    };
  } catch (error) {
    console.warn(`Failed to read theme background image: ${absoluteImagePath}`, error);
    return theme;
  }
}

/**
 * Load a specific preset theme by ID.
 * @param id - Theme ID (filename without .json)
 */
export function loadPresetTheme(id: string): PresetTheme | null {
  const themesDir = getAppThemesDir();
  const path = join(themesDir, `${id}.json`);

  if (!existsSync(path)) {
    return null;
  }

  try {
    const theme = readJsonFileSync<ThemeFile>(path);
    // Resolve relative backgroundImage paths to file:// URLs
    const resolvedTheme = resolveThemeBackgroundImage(theme, path);
    return { id, path, theme: resolvedTheme };
  } catch {
    return null;
  }
}

/**
 * Get the path to the app-level preset themes directory.
 */
export function getPresetThemesDir(): string {
  return getAppThemesDir();
}

/**
 * Reset a preset theme to its bundled default.
 * Copies the bundled version over the user's version.
 * Resolves bundled path automatically via getBundledAssetsDir('themes').
 * @param id - Theme ID to reset
 */
export function resetPresetTheme(id: string): boolean {
  // Resolve bundled themes directory via shared asset resolver
  const bundledThemesDir = getBundledAssetsDir('themes');
  if (!bundledThemesDir) {
    return false;
  }

  const bundledPath = join(bundledThemesDir, `${id}.json`);
  const themesDir = getAppThemesDir();
  const destPath = join(themesDir, `${id}.json`);

  if (!existsSync(bundledPath)) {
    return false;
  }

  try {
    const content = readFileSync(bundledPath, 'utf-8');
    if (!existsSync(themesDir)) {
      mkdirSync(themesDir, { recursive: true });
    }
    writeFileSync(destPath, content, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

// ============================================
// Color Theme Selection (stored in config)
// ============================================

/**
 * Get the currently selected color theme ID.
 * Returns 'default' if not set.
 */
export function getColorTheme(): string {
  const config = loadStoredConfig();
  if (config?.colorTheme !== undefined) {
    return config.colorTheme;
  }
  const defaults = loadConfigDefaults();
  return defaults.defaults.colorTheme;
}

/**
 * Set the color theme ID.
 */
export function setColorTheme(themeId: string): void {
  const config = loadStoredConfig();
  if (!config) return;
  config.colorTheme = themeId;
  saveConfig(config);
}

// ============================================
// Auto-Update Dismissed Version
// ============================================

/**
 * Get the dismissed update version.
 * Returns null if no version is dismissed.
 */
export function getDismissedUpdateVersion(): string | null {
  const config = loadStoredConfig();
  return config?.dismissedUpdateVersion ?? null;
}

/**
 * Set the dismissed update version.
 * Pass the version string to dismiss notifications for that version.
 */
export function setDismissedUpdateVersion(version: string): void {
  const config = loadStoredConfig();
  if (!config) return;
  config.dismissedUpdateVersion = version;
  saveConfig(config);
}

/**
 * Clear the dismissed update version.
 * Call this when a new version is released (or on successful update).
 */
export function clearDismissedUpdateVersion(): void {
  const config = loadStoredConfig();
  if (!config) return;
  delete config.dismissedUpdateVersion;
  saveConfig(config);
}

/**
 * Get the app-level default thinking level for new sessions.
 * Source of truth: Pi `~/.pi/agent/settings.json.defaultThinkingLevel`.
 */
export function getDefaultThinkingLevel(): ThinkingLevel {
  const piSettings = readPiGlobalSettings();
  if (piSettings.defaultThinkingLevel) {
    const normalized = normalizeThinkingLevel(piSettings.defaultThinkingLevel);
    if (normalized) return normalized;
  }
  const defaults = loadConfigDefaults();
  return normalizeThinkingLevel(defaults.workspaceDefaults.thinkingLevel) ?? 'medium';
}

/**
 * Set the app-level default thinking level for new sessions.
 * Persists to Pi `~/.pi/agent/settings.json.defaultThinkingLevel` so the Pi
 * subprocess picks it up immediately. No longer writes to Mortise config.json.
 *
 * @returns true if persisted, false if validation failed
 */
export async function setDefaultThinkingLevel(level: unknown): Promise<boolean> {
  const normalized = normalizeThinkingLevel(level);
  if (!normalized) return false;
  await setPiGlobalDefaultThinkingLevel(normalized);
  return true;
}

// ============================================
// Network Proxy Settings
// ============================================

import type { NetworkProxySettings } from './types.ts';

function normalizeProxyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function normalizeNetworkProxySettings(
  settings: NetworkProxySettings,
): NetworkProxySettings {
  return {
    enabled: Boolean(settings.enabled),
    httpProxy: normalizeProxyString(settings.httpProxy),
    httpsProxy: normalizeProxyString(settings.httpsProxy),
    noProxy: normalizeProxyString(settings.noProxy),
  };
}

/**
 * Get the current network proxy settings.
 * Returns undefined if not configured.
 */
export function getNetworkProxySettings(): NetworkProxySettings | undefined {
  const config = loadStoredConfig();
  return config?.networkProxy;
}

/**
 * Persist network proxy settings.
 * Deletes the key when disabled and all proxy fields are empty.
 */
export function setNetworkProxySettings(settings: NetworkProxySettings): void {
  const config = loadStoredConfig();
  if (!config) return;

  const normalized = normalizeNetworkProxySettings(settings);

  // Remove the key entirely when proxy is disabled and all fields are blank
  if (!normalized.enabled && !normalized.httpProxy && !normalized.httpsProxy && !normalized.noProxy) {
    delete config.networkProxy;
  } else {
    config.networkProxy = normalized;
  }

  saveConfig(config);
}

// ============================================
// Setup Deferred (user skipped onboarding)
// ============================================

export function isSetupDeferred(): boolean {
  return loadStoredConfig()?.setupDeferred === true;
}

export function setSetupDeferred(deferred: boolean): void {
  const config = loadStoredConfig();
  if (!config) return;
  if (deferred) {
    config.setupDeferred = true;
  } else {
    delete config.setupDeferred;
  }
  saveConfig(config);
}

// ============================================
// Tool Icons (CLI tool icons for turn card display)
// ============================================

const TOOL_ICONS_DIR_NAME = 'tool-icons';

/**
 * Returns the path to the tool-icons directory: ~/.mortise/tool-icons/
 */
export function getToolIconsDir(): string {
  return join(CONFIG_DIR, TOOL_ICONS_DIR_NAME);
}

/**
 * Ensure tool-icons directory exists and has bundled defaults.
 * Resolves bundled path automatically via getBundledAssetsDir('tool-icons').
 * Copies bundled tool-icons.json and icon files on first run.
 * Only copies files that don't already exist (preserves user customizations).
 */
export function ensureToolIcons(): void {
  const toolIconsDir = getToolIconsDir();

  // Create tool-icons directory if it doesn't exist
  if (!existsSync(toolIconsDir)) {
    mkdirSync(toolIconsDir, { recursive: true });
  }

  // Resolve bundled tool-icons directory via shared asset resolver
  const bundledToolIconsDir = getBundledAssetsDir('tool-icons');
  if (!bundledToolIconsDir) {
    return;
  }

  // Copy each bundled file if it doesn't exist in the target dir
  // This includes tool-icons.json and all icon files (png, ico, svg, jpg)
  try {
    const bundledFiles = readdirSync(bundledToolIconsDir);
    for (const file of bundledFiles) {
      const destPath = join(toolIconsDir, file);
      if (!existsSync(destPath)) {
        const srcPath = join(bundledToolIconsDir, file);
        copyFileSync(srcPath, destPath);
      }
    }
  } catch {
    // Ignore errors — tool icons are optional enhancement
  }
}

// ============================================
// Server Mode Configuration
// ============================================

import { DEFAULT_SERVER_CONFIG, type ServerConfig } from './server-config.ts';

/**
 * Get the current server configuration.
 * Returns defaults if not yet configured.
 */
export function getServerConfig(): ServerConfig {
  const config = loadStoredConfig();
  return config?.serverConfig ?? { ...DEFAULT_SERVER_CONFIG };
}

/**
 * Persist server configuration.
 * Auto-generates a stable auth token on first enable if none exists.
 */
export function setServerConfig(serverConfig: ServerConfig): void {
  const config = loadStoredConfig();
  if (!config) return;

  // Generate a stable token when first enabled (or if token is missing)
  if (serverConfig.enabled && !serverConfig.token) {
    serverConfig.token = randomUUID();
  }

  config.serverConfig = serverConfig;
  saveConfig(config);
}
