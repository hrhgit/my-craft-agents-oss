/**
 * Pi CLI Global Config (~/.pi/agent/)
 *
 * Reads/writes the Pi CLI's global configuration files:
 * - models.json:   provider definitions (baseUrl, apiKey, api, models)
 * - settings.json: defaultProvider, defaultModel, defaultThinkingLevel,
 *                  shellGui.*, extensionConfig.*
 * - auth.json:     OAuth credentials (usually empty for custom-endpoint providers)
 *
 * This is the single source of truth for "pure Pi + custom provider" mode.
 * Typed settings.json fields are written through Pi's public SettingsManager;
 * models.json provider CRUD and Pi-opaque craft.agent.* settings are still raw
 * file edits because Pi does not expose typed setters for those domains.
 * Credentials live in ~/.pi/agent/auth.json. The subprocess loads credentials
 * from ~/.pi/agent/auth.json.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'fs';
import { SettingsManager } from '@earendil-works/pi-coding-agent';
import type { LlmConnection } from './llm-connections.ts';
import { PI_MODELS_FILE, PI_SETTINGS_FILE, PI_AUTH_FILE, PI_AGENT_DIR } from './paths';
import { atomicWriteFileSync } from '../utils/files.ts';

export type PiCustomApi =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-generative-ai';

export interface PiGlobalModel {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: ('text' | 'image')[];
  contextWindow?: number;
  maxTokens?: number;
  thinkingLevelMap?: Record<string, string | null>;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  headers?: Record<string, string>;
  [key: string]: unknown;
}

export interface PiGlobalProvider {
  baseUrl?: string;
  apiKey?: string;
  api?: PiCustomApi;
  authHeader?: boolean;
  headers?: Record<string, string>;
  models?: PiGlobalModel[];
  [key: string]: unknown;
}

export interface PiGlobalModelsFile {
  providers?: Record<string, PiGlobalProvider>;
  /** Craft-owned connection metadata; Pi ModelRegistry ignores this top-level field. */
  craftConnections?: LlmConnection[];
  [key: string]: unknown;
}

export interface PiGlobalSettings {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: string;
  craft?: {
    agent?: Record<string, unknown>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

const corruptPiFileBackups = new Set<string>();

function backupCorruptPiFile(filePath: string, label: string, reason: unknown): void {
  try {
    if (!existsSync(filePath)) return;
    if (corruptPiFileBackups.has(filePath)) return;

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${filePath}.corrupt-${stamp}`;
    copyFileSync(filePath, backupPath);
    corruptPiFileBackups.add(filePath);
    console.error(
      `[pi-global-config] Backed up unreadable ${label} to ${backupPath}:`,
      reason instanceof Error ? reason.message : reason,
    );
  } catch (backupError) {
    console.error(
      `[pi-global-config] Failed to back up unreadable ${label}:`,
      backupError instanceof Error ? backupError.message : backupError,
    );
  }
}

function normalizePiGlobalModelsFile(parsed: unknown): PiGlobalModelsFile {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('models.json root must be an object');
  }
  const file = parsed as PiGlobalModelsFile;
  if (!file.providers || typeof file.providers !== 'object' || Array.isArray(file.providers)) {
    file.providers = {};
  }
  return file;
}

function readPiGlobalModelsFileStrict(): PiGlobalModelsFile {
  if (!existsSync(PI_MODELS_FILE)) return { providers: {} };
  try {
    return normalizePiGlobalModelsFile(JSON.parse(readFileSync(PI_MODELS_FILE, 'utf-8')));
  } catch (error) {
    backupCorruptPiFile(PI_MODELS_FILE, 'models.json', error);
    throw error;
  }
}

/**
 * Create a Pi SettingsManager for the global ~/.pi/agent/settings.json file.
 *
 * SettingsManager requires a cwd so it can also resolve project settings. Craft's
 * global-config helpers intentionally operate on the global file only, matching
 * the previous raw-file behavior, so callers read via getGlobalSettings() and
 * writes use SettingsManager's global setters followed by flush().
 */
function createPiGlobalSettingsManager(): SettingsManager {
  return SettingsManager.create(PI_AGENT_DIR, PI_AGENT_DIR);
}

async function flushPiSettings(manager: SettingsManager): Promise<void> {
  await manager.flush();
  const errors = manager.drainErrors();
  if (errors.length > 0) {
    throw errors[0]!.error;
  }
}

// ===== Reads =====

export function readPiGlobalModelsFile(): PiGlobalModelsFile {
  try {
    if (!existsSync(PI_MODELS_FILE)) return { providers: {} };
    return normalizePiGlobalModelsFile(JSON.parse(readFileSync(PI_MODELS_FILE, 'utf-8')));
  } catch (error) {
    backupCorruptPiFile(PI_MODELS_FILE, 'models.json', error);
    return { providers: {} };
  }
}

export function readPiGlobalProviders(): Record<string, PiGlobalProvider> {
  return readPiGlobalModelsFile().providers ?? {};
}

export function readPiCraftLlmConnections(): LlmConnection[] {
  const connections = readPiGlobalModelsFile().craftConnections;
  return Array.isArray(connections) ? connections : [];
}

export function writePiCraftLlmConnections(connections: LlmConnection[]): void {
  mutatePiGlobalModelsFile((file) => {
    file.providers = file.providers ?? {};
    file.craftConnections = connections;
  });
}

export function upsertPiCraftLlmConnection(connection: LlmConnection): void {
  mutatePiGlobalModelsFile((file) => {
    const connections = Array.isArray(file.craftConnections) ? file.craftConnections : [];
    const index = connections.findIndex(c => c.slug === connection.slug);
    file.craftConnections = index === -1
      ? [...connections, connection]
      : connections.map((existing, i) => i === index ? connection : existing);
  });
}

export function deletePiCraftLlmConnection(slug: string): boolean {
  let deleted = false;
  mutatePiGlobalModelsFile((file) => {
    const connections = Array.isArray(file.craftConnections) ? file.craftConnections : [];
    const next = connections.filter(c => c.slug !== slug);
    if (next.length === connections.length) return false;
    file.craftConnections = next;
    deleted = true;
  });
  return deleted;
}

export function readPiGlobalSettings(): PiGlobalSettings {
  try {
    return createPiGlobalSettingsManager().getGlobalSettings() as PiGlobalSettings;
  } catch (error) {
    backupCorruptPiFile(PI_SETTINGS_FILE, 'settings.json', error);
    return {};
  }
}

// ===== auth.json (OAuth / IAM credentials) =====

/**
 * Pi auth.json credential for a single provider.
 * Mirrors the PiCredential union used by Pi RpcClient (api_key | oauth | iam).
 */
export interface PiGlobalAuthCredential {
  type: 'api_key' | 'oauth' | 'iam';
  /** api_key: the key */
  key?: string;
  /** oauth: access token */
  access?: string;
  /** oauth: refresh token */
  refresh?: string;
  /** oauth: expiry in milliseconds */
  expires?: number;
  /** oauth: OIDC id token (OpenAI/Codex) */
  idToken?: string;
  /** iam: AWS access key id */
  accessKeyId?: string;
  /** iam: AWS secret access key */
  secretAccessKey?: string;
  /** iam: AWS region */
  region?: string;
  /** iam: AWS session token */
  sessionToken?: string;
}

/**
 * Pi auth.json top-level structure.
 * Keyed by provider name (e.g. 'anthropic', 'openai', 'github-copilot').
 */
export interface PiGlobalAuthFile {
  providers?: Record<string, PiGlobalAuthCredential>;
  [key: string]: unknown;
}

/**
 * Read ~/.pi/agent/auth.json. Returns null if the file does not exist or
 * cannot be parsed. Used by pi-global-sync to keep OAuth/IAM credentials in
 * ~/.pi/agent/auth.json so getPiAuth() can resolve them by slug.
 */
export function readPiGlobalAuth(): PiGlobalAuthFile | null {
  if (!existsSync(PI_AUTH_FILE)) return null;
  try {
    const raw = readFileSync(PI_AUTH_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as PiGlobalAuthFile;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Mask apiKey for list display: first 7 + last 4 chars. */
export function maskApiKey(key: string | undefined): string {
  if (!key) return '';
  if (key.length <= 11) return key;
  return `${key.slice(0, 7)}...${key.slice(-4)}`;
}

export interface PiGlobalProviderForDisplay {
  key: string;
  provider: PiGlobalProvider;
  apiKeyMasked: string;
  modelCount: number;
}

export function readPiGlobalProvidersForDisplay(): PiGlobalProviderForDisplay[] {
  const providers = readPiGlobalProviders();
  return Object.entries(providers)
    .map(([key, provider]) => ({
      key,
      provider,
      apiKeyMasked: maskApiKey(provider.apiKey),
      modelCount: provider.models?.length ?? 0,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

// ===== Writes =====

function ensurePiAgentDir(): void {
  if (!existsSync(PI_AGENT_DIR)) {
    mkdirSync(PI_AGENT_DIR, { recursive: true });
  }
}

const PI_FILE_LOCK_STALE_MS = 30_000;
const PI_FILE_LOCK_RETRY_DELAY_MS = 20;
const PI_FILE_LOCK_RETRY_COUNT = 100;

function sleepSync(ms: number): void {
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, ms);
}

function tryAcquirePiFileLock(filePath: string): (() => void) | null {
  const lockDir = `${filePath}.lock`;
  try {
    mkdirSync(lockDir);
    return () => {
      try { rmSync(lockDir, { recursive: true, force: true }); } catch {}
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
    try {
      const lockStat = statSync(lockDir);
      if (lockStat.mtimeMs < Date.now() - PI_FILE_LOCK_STALE_MS) {
        rmSync(lockDir, { recursive: true, force: true });
      }
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw statError;
      }
    }
    return null;
  }
}

function acquirePiFileLock(filePath: string): () => void {
  let lastError: unknown;
  for (let attempt = 1; attempt <= PI_FILE_LOCK_RETRY_COUNT; attempt++) {
    const release = tryAcquirePiFileLock(filePath);
    if (release) return release;
    lastError = new Error(`Lock contention on ${filePath}`);
    if (attempt < PI_FILE_LOCK_RETRY_COUNT) {
      sleepSync(PI_FILE_LOCK_RETRY_DELAY_MS);
    }
  }
  throw (lastError as Error) ?? new Error(`Failed to acquire file lock: ${filePath}`);
}

function acquirePiSettingsFileLock(): () => void {
  return acquirePiFileLock(PI_SETTINGS_FILE);
}

function acquirePiModelsFileLock(): () => void {
  return acquirePiFileLock(PI_MODELS_FILE);
}

function mutatePiGlobalSettings(mutator: (settings: PiGlobalSettings) => boolean | void): void {
  ensurePiAgentDir();
  const release = acquirePiSettingsFileLock();
  try {
    const settings = existsSync(PI_SETTINGS_FILE)
      ? (() => {
          try {
            return JSON.parse(readFileSync(PI_SETTINGS_FILE, 'utf-8')) as PiGlobalSettings;
          } catch (error) {
            backupCorruptPiFile(PI_SETTINGS_FILE, 'settings.json', error);
            throw error;
          }
        })()
      : {};
    const shouldWrite = mutator(settings);
    if (shouldWrite === false) return;
    atomicWriteFileSync(PI_SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } finally {
    release();
  }
}

function mutatePiGlobalModelsFile(mutator: (file: PiGlobalModelsFile) => boolean | void): void {
  ensurePiAgentDir();
  const release = acquirePiModelsFileLock();
  try {
    const file = readPiGlobalModelsFileStrict();
    const shouldWrite = mutator(file);
    if (shouldWrite === false) return;
    atomicWriteFileSync(PI_MODELS_FILE, JSON.stringify(file, null, 2));
  } finally {
    release();
  }
}

function writePiGlobalSettings(settings: PiGlobalSettings): void {
  mutatePiGlobalSettings((current) => {
    for (const key of Object.keys(current)) {
      delete current[key];
    }
    Object.assign(current, settings);
  });
}

/** Provider key must be a lowercase slug (a-z0-9 plus hyphens). */
export function isValidProviderKey(key: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(key);
}

export function savePiGlobalProvider(key: string, provider: PiGlobalProvider): void {
  if (!isValidProviderKey(key)) {
    throw new Error(`Invalid provider key: ${key} (must be lowercase slug a-z0-9-)`);
  }
  mutatePiGlobalModelsFile((file) => {
    file.providers = file.providers ?? {};
    file.providers[key] = provider;
  });
}

export async function deletePiGlobalProvider(key: string): Promise<void> {
  mutatePiGlobalModelsFile((file) => {
    if (!file.providers?.[key]) return false;
    delete file.providers[key];
  });
  // If deleted provider was default, clear default. Pi SettingsManager exposes
  // typed setters but no clear/unset API for these fields, so this one branch
  // remains a direct settings.json edit.
  mutatePiGlobalSettings((settings) => {
    if (settings.defaultProvider === key) {
      delete settings.defaultProvider;
      delete settings.defaultModel;
      return;
    }
    return false;
  });
}

export async function setPiGlobalDefault(
  provider: string,
  model: string,
  thinkingLevel?: string,
): Promise<void> {
  // 'custom-endpoint' is a Pi SDK internal provider name registered by the
  // subprocess — it must never be persisted as the default in settings.json
  // (it doesn't exist in models.json, so pi-global-sync can't resolve it).
  if (provider === 'custom-endpoint') {
    throw new Error(
      "Refusing to set 'custom-endpoint' as default provider — it is an internal provider name. Use a real provider key from models.json instead.",
    );
  }
  const manager = createPiGlobalSettingsManager();
  manager.setDefaultModelAndProvider(provider, model);
  if (thinkingLevel !== undefined) {
    manager.setDefaultThinkingLevel(thinkingLevel as Parameters<SettingsManager['setDefaultThinkingLevel']>[0]);
  }
  await flushPiSettings(manager);
}

/**
 * Set only the top-level `defaultThinkingLevel` in ~/.pi/agent/settings.json
 * without touching defaultProvider/defaultModel. This is the authoritative
 * SoT read by the pi subprocess; craft's setDefaultThinkingLevel() mirrors
 * its value here so the subprocess picks it up immediately.
 */
export async function setPiGlobalDefaultThinkingLevel(level: string): Promise<void> {
  const manager = createPiGlobalSettingsManager();
  manager.setDefaultThinkingLevel(level as Parameters<SettingsManager['setDefaultThinkingLevel']>[0]);
  await flushPiSettings(manager);
}

// ===== Craft agent runtime namespace (craft.agent.*) =====
//
// Craft-only UI/window preferences stay in ~/.craft-agent/config.json. Runtime
// toggles that affect agent behavior live in ~/.pi/agent/settings.json under
// craft.agent.* so Pi/Craft subprocesses read the same source of truth.

export type PiCraftAgentSettings = Record<string, unknown>;

export function readPiCraftAgentSettings(): PiCraftAgentSettings {
  const settings = readPiGlobalSettings();
  const craft = settings.craft;
  if (!craft || typeof craft !== 'object') return {};
  const agent = (craft as { agent?: unknown }).agent;
  if (!agent || typeof agent !== 'object') return {};
  return agent as PiCraftAgentSettings;
}

export function readPiCraftAgentSetting(key: string, fallback: unknown): unknown {
  const value = readPiCraftAgentSettings()[key];
  return value != null ? value : fallback;
}

export function readPiCraftAgentBoolean(key: string, fallback = false): boolean {
  const value = readPiCraftAgentSetting(key, fallback);
  return typeof value === 'boolean' ? value : fallback;
}

export function writePiCraftAgentSettingsBulk(updates: Record<string, unknown>): void {
  mutatePiGlobalSettings((settings) => {
    const craft = settings.craft && typeof settings.craft === 'object' ? settings.craft : {};
    const agent = craft.agent && typeof craft.agent === 'object' ? craft.agent : {};
    settings.craft = craft;
    settings.craft.agent = {
      ...(agent as Record<string, unknown>),
      ...updates,
    };
  });
}

export function writePiCraftAgentSetting(key: string, value: unknown): void {
  writePiCraftAgentSettingsBulk({ [key]: value });
}

export function writePiCraftAgentBoolean(key: string, value: boolean): void {
  writePiCraftAgentSetting(key, value);
}

// ===== 扩展命名空间（extensionConfig.<name>.*）=====
//
// Task 7：扩展级 model/enabled/concurrency 已回归 ~/.pi/agent/settings.json 的
// `extensionConfig.<name>.*` typed 命名空间。读取时兼容旧 `extensions.<name>.*`，
// 写入时统一走 Pi SettingsManager 的 setExtensionConfig().

/**
 * settings.json 中扩展配置命名空间的松散结构。
 * 键为扩展 id（如 'repo-memory'、'trace-audit'），值为该扩展的配置对象。
 */
export type PiExtensionNamespaceSettings = Record<string, Record<string, unknown>>;

/**
 * 读取 settings.json 的扩展配置命名空间整体（typed 覆盖 legacy）。
 * 文件缺失或字段缺失时返回空对象。
 */
export function readPiExtensionNamespace(): PiExtensionNamespaceSettings {
  const settings = readPiGlobalSettings() as PiGlobalSettings & {
    extensionConfig?: PiExtensionNamespaceSettings;
    extensions?: PiExtensionNamespaceSettings;
  };
  return {
    ...(settings.extensions && typeof settings.extensions === 'object' ? settings.extensions : {}),
    ...(settings.extensionConfig && typeof settings.extensionConfig === 'object' ? settings.extensionConfig : {}),
  };
}

/**
 * 读取某个扩展在 settings.json 的 `extensionConfig.<name>` 配置对象。
 */
function readPiExtensionConfig(name: string): Record<string, unknown> {
  const settings = readPiGlobalSettings() as PiGlobalSettings & {
    extensionConfig?: PiExtensionNamespaceSettings;
    extensions?: PiExtensionNamespaceSettings;
  };
  const typedEntry = settings.extensionConfig?.[name];
  if (typedEntry && typeof typedEntry === 'object') return typedEntry;
  const legacyEntry = settings.extensions?.[name];
  if (legacyEntry && typeof legacyEntry === 'object') return legacyEntry;
  return {};
}

/**
 * 写入某个扩展在 settings.json 的 `extensionConfig.<name>` 配置对象（整体覆盖）。
 */
async function writePiExtensionConfig(name: string, config: Record<string, unknown>): Promise<void> {
  const manager = createPiGlobalSettingsManager();
  manager.setExtensionConfig(name, config);
  await flushPiSettings(manager);
}

/**
 * 读取 `extensionConfig.<name>.enabled`。字段缺失时返回 fallback（默认 true，与 Pi SDK 行为一致）。
 */
export function readPiExtensionEnabled(name: string, fallback = true): boolean {
  const config = readPiExtensionConfig(name);
  const value = config.enabled;
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * 写入 `extensionConfig.<name>.enabled`。保留该扩展已有的其他字段。
 */
export async function writePiExtensionEnabled(name: string, enabled: boolean): Promise<void> {
  const config = readPiExtensionConfig(name);
  config.enabled = enabled;
  await writePiExtensionConfig(name, config);
}

/**
 * 读取 `extensionConfig.<name>.model`。字段缺失时返回 fallback。
 */
export function readPiExtensionModel(name: string, fallback = ''): string {
  const config = readPiExtensionConfig(name);
  const value = config.model;
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

/**
 * 写入 `extensionConfig.<name>.model`。保留该扩展已有的其他字段。
 */
export async function writePiExtensionModel(name: string, model: string): Promise<void> {
  const config = readPiExtensionConfig(name);
  config.model = model;
  await writePiExtensionConfig(name, config);
}

/**
 * 读取 `extensionConfig.<name>.concurrency`。字段缺失或非法时返回 fallback。
 */
export function readPiExtensionConcurrency(name: string, fallback: number): number {
  const config = readPiExtensionConfig(name);
  const value = config.concurrency;
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.round(value));
}

/**
 * 写入 `extensionConfig.<name>.concurrency`。保留该扩展已有的其他字段。
 */
export async function writePiExtensionConcurrency(name: string, concurrency: number): Promise<void> {
  const config = readPiExtensionConfig(name);
  config.concurrency = Math.max(1, Math.round(concurrency));
  await writePiExtensionConfig(name, config);
}

// ===== Shell GUI 命名空间（shellGui.<name>.*）=====
//
// craft shell 的 GUI 开关与 agent 行为字段（showStatusBadge/widgetVisible/
// planMode.* / craft 全局开关等）回归 ~/.pi/agent/settings.json 的 `shellGui.<name>.*`
// 命名空间。pi CLI 单独运行时忽略此字段（pi settings-manager.ts 中 shellGui 为可选）。

/**
 * settings.json 中 `shellGui` 命名空间下单个 shell 的配置对象（松散结构）。
 * 与 pi settings-manager.ts 的 ShellGuiNamespaceSettings 对齐。
 */
export type PiShellGuiNamespaceSettings = Record<string, unknown>;

/**
 * 读取 settings.json 的 `shellGui` 命名空间整体。
 * 文件缺失或字段缺失时返回空对象。
 */
export function readPiShellGuiNamespace(): Record<string, PiShellGuiNamespaceSettings> {
  const settings = readPiGlobalSettings();
  const shellGui = (settings as { shellGui?: unknown }).shellGui;
  if (!shellGui || typeof shellGui !== 'object') return {};
  return shellGui as Record<string, PiShellGuiNamespaceSettings>;
}

/**
 * 读取某个 shell 在 settings.json 的 `shellGui.<name>` 配置对象。
 */
function readPiShellGuiConfig(name: string): PiShellGuiNamespaceSettings {
  const ns = readPiShellGuiNamespace();
  const entry = ns[name];
  if (!entry || typeof entry !== 'object') return {};
  return entry as PiShellGuiNamespaceSettings;
}

/**
 * 写入某个 shell 在 settings.json 的 `shellGui.<name>` 配置对象（整体覆盖）。
 */
async function writePiShellGuiConfig(name: string, config: PiShellGuiNamespaceSettings): Promise<void> {
  const manager = createPiGlobalSettingsManager();
  manager.setShellGuiEntry(name, config);
  await flushPiSettings(manager);
}

/**
 * 读取 `shellGui.<name>.<key>`。字段缺失时返回 fallback。
 */
export function readPiShellGuiSetting(name: string, key: string, fallback: unknown): unknown {
  const config = readPiShellGuiConfig(name);
  const value = (config as Record<string, unknown>)[key];
  // F30: Use `!= null` so an explicitly-stored JSON `null` also falls back to
  // the default. Previously only `undefined` triggered the fallback, which
  // meant a `null` value persisted in settings.json would be returned as-is
  // and bypass downstream defaults (e.g. disabling a feature that should
  // fall back to its default when unset).
  return value != null ? value : fallback;
}

/**
 * 写入 `shellGui.<name>.<key>`。保留该 shell 已有的其他字段。
 */
export async function writePiShellGuiSetting(name: string, key: string, value: unknown): Promise<void> {
  const manager = createPiGlobalSettingsManager();
  manager.setShellGuiSetting(name, key, value);
  await flushPiSettings(manager);
}

/**
 * 批量写入多个 `shellGui.<name>.<key>` 字段，仅执行一次 read-modify-write。
 *
 * F2 修复：替代多次独立调用 writePiShellGuiSetting/writePiShellGuiBoolean，
 * 避免每次都读全文件→改一字段→写全文件造成的竞态窗口与性能开销。
 *
 * @param updates 形如 `{ 'craft': { enabled: true, ... }, 'subagent': { reviewEnabled: false } }` 的对象
 */
export async function writePiShellGuiSettingsBulk(
  updates: Record<string, Record<string, unknown>>,
): Promise<void> {
  const manager = createPiGlobalSettingsManager();
  for (const [name, fields] of Object.entries(updates)) {
    for (const [key, value] of Object.entries(fields)) {
      manager.setShellGuiSetting(name, key, value);
    }
  }
  await flushPiSettings(manager);
}

/**
 * 读取 `shellGui.<name>.<key>` 作为布尔值。字段缺失或类型不符时返回 fallback。
 */
export function readPiShellGuiBoolean(name: string, key: string, fallback = true): boolean {
  const value = readPiShellGuiSetting(name, key, fallback);
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * 写入 `shellGui.<name>.<key>` 作为布尔值。保留该 shell 已有的其他字段。
 */
export async function writePiShellGuiBoolean(name: string, key: string, value: boolean): Promise<void> {
  await writePiShellGuiSetting(name, key, value);
}

/**
 * 删除某个 shell 在 settings.json 的 `shellGui.<name>` 整个命名空间。
 * 用于迁移回滚或清理。命名空间不存在时无副作用。
 */
export async function deletePiShellGuiEntry(name: string): Promise<void> {
  const ns = readPiShellGuiNamespace();
  if (!(name in ns)) return;
  const manager = createPiGlobalSettingsManager();
  manager.deleteShellGuiEntry(name);
  await flushPiSettings(manager);
}

// ===== Fetch models from custom endpoint (/v1/models) =====

export interface FetchedEndpointModel {
  id: string;
  name?: string;
  ownedBy?: string;
}

/**
 * Fetch model list from a custom OpenAI-compatible endpoint.
 * Tries `${baseUrl}/models` with Bearer auth.
 */
export async function fetchModelsForEndpoint(
  baseUrl: string,
  apiKey: string,
  options?: { timeoutMs?: number },
): Promise<FetchedEndpointModel[]> {
  const timeoutMs = options?.timeoutMs ?? 15_000;
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (!trimmed) throw new Error('baseUrl is required');
  const url = trimmed + '/models';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`HTTP ${resp.status}: ${body.slice(0, 500)}`);
    }
    const data = (await resp.json()) as {
      data?: Array<{ id: string; owned_by?: string }>;
      models?: Array<{ id: string; owned_by?: string }>;
    };
    const list = data.data ?? data.models ?? [];
    return list.map((m) => ({
      id: m.id,
      name: m.id,
      ownedBy: m.owned_by,
    }));
  } finally {
    clearTimeout(timer);
  }
}
