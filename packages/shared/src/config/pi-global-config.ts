/**
 * Pi CLI Global Config facade.
 *
 * This is the single source of truth for "pure Pi + custom provider" mode.
 * Mortise keeps this module as a compatibility wrapper for older settings IPC
 * handlers, but storage reads/writes go through Pi's host facade.
 */

import { existsSync, mkdirSync, watch, type FSWatcher } from 'fs';
import { DefaultPackageManager, SettingsManager } from '@mortise/pi-coding-agent';
import {
  deleteGlobalApiKey as deletePiHostGlobalApiKey,
  deleteGlobalProvider as deletePiHostGlobalProvider,
  deleteShellGuiEntry as deletePiHostShellGuiEntry,
  hasGlobalProviderAuth as hasPiHostGlobalProviderAuth,
  maskApiKey as maskPiHostApiKey,
  migrateGlobalProviderApiKeysToAuth as migratePiHostGlobalProviderApiKeysToAuth,
  readMortiseSettings as readPiHostMortiseSettings,
  readExtensionConfig as readPiHostExtensionConfig,
  readExtensionNamespace as readPiHostExtensionNamespace,
  readGlobalAuthFile as readPiHostGlobalAuthFile,
  readGlobalApiKey as readPiHostGlobalApiKey,
  readGlobalCredential as readPiHostGlobalCredential,
  readGlobalModelsFile as readPiHostGlobalModelsFile,
  readGlobalProviders as readPiHostGlobalProviders,
  readGlobalProvidersForDisplay as readPiHostGlobalProvidersForDisplay,
  readGlobalSettings as readPiHostGlobalSettings,
  readShellGuiEntry as readPiHostShellGuiEntry,
  readShellGuiNamespace as readPiHostShellGuiNamespace,
  saveGlobalProvider as savePiHostGlobalProvider,
  setDefaultThinkingLevel as setPiHostDefaultThinkingLevel,
  setExtensionConfig as setPiHostExtensionConfig,
  setGlobalApiKey as setPiHostGlobalApiKey,
  setGlobalDefault as setPiHostGlobalDefault,
  setShellGuiEntry as setPiHostShellGuiEntry,
  writeMortiseSettingsBulk as writePiHostMortiseSettingsBulk,
  type HostGlobalProvider,
} from '@mortise/pi-coding-agent/host-facade';
import type { PiExtensionCatalogEntry, PiExtensionCatalogResult, PiExtensionConfigPatch, PiExtensionSettingField, PiExtensionSettingScalar } from './pi-extension-settings.ts';
import type { PiCustomApi, PiGlobalModel, PiGlobalProvider } from './pi-provider-models.ts';
import { PI_AGENT_DIR } from './paths';

export {
  piProviderModelSupportsImages,
  setPiProviderModelSupportsImages,
} from './pi-provider-models.ts';
export type { PiCustomApi, PiGlobalModel, PiGlobalProvider } from './pi-provider-models.ts';

export interface PiGlobalModelsFile {
  providers?: Record<string, PiGlobalProvider>;
  [key: string]: unknown;
}

export interface PiGlobalSettings {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: string;
  mortise?: {
    agent?: Record<string, unknown>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

// ===== Reads =====

export function readPiGlobalModelsFile(): PiGlobalModelsFile {
  try {
    return readPiHostGlobalModelsFile() as PiGlobalModelsFile;
  } catch (error) {
    console.error('[pi-global-config] Failed to read Pi models config:', error);
    return { providers: {} };
  }
}

export function readPiGlobalProviders(): Record<string, PiGlobalProvider> {
  return readPiHostGlobalProviders() as Record<string, PiGlobalProvider>;
}

export function getPiGlobalProvider(key: string): PiGlobalProvider | null {
  return readPiGlobalProviders()[key] ?? null;
}

export function readPiGlobalSettings(): PiGlobalSettings {
  try {
    return readPiHostGlobalSettings() as PiGlobalSettings;
  } catch (error) {
    console.error('[pi-global-config] Failed to read Pi settings config:', error);
    return {};
  }
}

// ===== auth.json (provider credentials) =====

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
 * Mortise-owned credentials live under opaque `mortise.*` keys in the same file,
 * so helpers below always narrow entries before treating them as Pi credentials.
 */
export type PiGlobalAuthFile = Record<string, unknown>;

/**
 * Read Pi's auth storage via the host facade. Returns null for an empty store
 * to preserve the historical wrapper contract.
 */
export function readPiGlobalAuth(): PiGlobalAuthFile | null {
  try {
    const auth = readPiHostGlobalAuthFile() as PiGlobalAuthFile;
    return Object.keys(auth).length > 0 ? auth : null;
  } catch {
    return null;
  }
}

function isPiGlobalAuthCredential(value: unknown): value is PiGlobalAuthCredential {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const type = (value as { type?: unknown }).type;
  return type === 'api_key' || type === 'oauth' || type === 'iam';
}

export function readPiGlobalCredential(providerKey: string): PiGlobalAuthCredential | undefined {
  const credential = readPiHostGlobalCredential(providerKey);
  return isPiGlobalAuthCredential(credential) ? credential : undefined;
}

export function readPiGlobalApiKey(providerKey: string): string | undefined {
  return readPiHostGlobalApiKey(providerKey);
}

export function hasPiGlobalProviderAuth(providerKey: string | undefined): boolean {
  return hasPiHostGlobalProviderAuth(providerKey);
}

/** Minimal legacy connection shape accepted during provider migration. */
type LegacyPiConnectionReference = {
  slug: string;
  piAuthProvider?: string;
  providerType?: string;
};

export function getPiGlobalProviderKeyForConnection(
  connection: LegacyPiConnectionReference | null | undefined,
): string | undefined {
  if (!connection) return undefined;
  const inferredFromSlug = inferPiGlobalProviderKeyFromSlug(connection.slug);
  if (connection.providerType === 'pi') {
    return connection.piAuthProvider || inferredFromSlug;
  }
  return inferredFromSlug || connection.piAuthProvider;
}

export function hasPiGlobalAuthForConnection(
  connection: LegacyPiConnectionReference | null | undefined,
): boolean {
  if (!connection) return false;
  if (connection.providerType !== 'pi' && connection.providerType !== 'pi_compat') return false;
  const providerKey = getPiGlobalProviderKeyForConnection(connection);
  if (!providerKey) return false;
  return connection.providerType === 'pi'
    ? hasPiGlobalProviderAuth(providerKey)
    : !!readPiGlobalProviders()[providerKey] && hasPiGlobalProviderAuth(providerKey);
}

function inferPiGlobalProviderKeyFromSlug(slug: string): string | undefined {
  if (!slug.startsWith('pi-')) return undefined;
  const key = slug.slice('pi-'.length);
  // pi-api-key is a generic onboarding slug; the provider is piAuthProvider.
  if (key === 'api-key' || /^api-key-\d+$/.test(key)) return undefined;
  return key;
}

/** Mask apiKey for list display: first 7 + last 4 chars. */
export function maskApiKey(key: string | undefined): string {
  return maskPiHostApiKey(key);
}

export interface PiGlobalProviderForDisplay {
  key: string;
  provider: PiGlobalProvider;
  apiKeyMasked: string;
  modelCount: number;
}

export function readPiGlobalProvidersForDisplay(): PiGlobalProviderForDisplay[] {
  return readPiHostGlobalProvidersForDisplay() as PiGlobalProviderForDisplay[];
}

// ===== Writes =====

function ensurePiAgentDir(): void {
  if (!existsSync(PI_AGENT_DIR)) {
    mkdirSync(PI_AGENT_DIR, { recursive: true });
  }
}

/**
 * Watch Pi's global model/default-provider config without exposing
 * ~/.pi/agent path handling to higher-level config watchers.
 */
export function watchPiGlobalModelsFile(onModelsChanged: () => void): FSWatcher {
  ensurePiAgentDir();
  return watch(PI_AGENT_DIR, (_eventType, filename) => {
    if (!filename) return;
    if (filename === 'models.json' || filename === 'settings.json' || filename === 'auth.json') {
      onModelsChanged();
    }
  });
}

/** Provider key must be a lowercase slug (a-z0-9 plus hyphens). */
export function isValidProviderKey(key: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(key);
}

function assertValidProviderKey(key: string): void {
  if (!isValidProviderKey(key)) {
    throw new Error(`Invalid provider key: ${key} (must be lowercase slug a-z0-9-)`);
  }
}

function normalizeApiKeyInput(apiKey: string | undefined): string | undefined {
  const trimmed = apiKey?.trim();
  if (!trimmed || trimmed.includes('••')) return undefined;
  return trimmed;
}

export function sanitizePiGlobalProvider(provider: PiGlobalProvider): PiGlobalProvider {
  const { apiKey: _apiKey, ...rest } = provider as PiGlobalProvider & { apiKey?: unknown };
  return rest;
}

function isVersionPathSegment(segment: string | undefined): boolean {
  return typeof segment === 'string' && /^v\d+(?:beta)?$/i.test(segment);
}

function isOpenRouterHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === 'openrouter.ai' || lower.endsWith('.openrouter.ai');
}

function usesRootOpenAiCompatibleBaseUrl(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === 'ai-gateway.vercel.sh' || lower.endsWith('.ai-gateway.vercel.sh');
}

function stripTrailingEndpointSegments(segments: string[]): string[] {
  const next = [...segments];
  const lower = () => next.map(segment => segment.toLowerCase());
  const removeSuffix = (suffix: string[]): boolean => {
    const parts = lower();
    if (parts.length < suffix.length) return false;
    const offset = parts.length - suffix.length;
    if (!suffix.every((part, index) => parts[offset + index] === part)) return false;
    next.splice(offset, suffix.length);
    return true;
  };

  let changed = true;
  while (changed) {
    changed = removeSuffix(['chat', 'completions'])
      || removeSuffix(['responses'])
      || removeSuffix(['messages'])
      || removeSuffix(['models']);
  }
  return next;
}

function collapseDuplicateTrailingVersionSegments(segments: string[]): string[] {
  const next = [...segments];
  while (
    next.length >= 2
    && isVersionPathSegment(next.at(-1))
    && next.at(-1)?.toLowerCase() === next.at(-2)?.toLowerCase()
  ) {
    next.pop();
  }
  return next;
}

function setUrlPathSegments(url: URL, segments: string[]): void {
  url.pathname = segments.length > 0 ? `/${segments.join('/')}` : '/';
}

function hasAnyVersionPathSegment(segments: string[]): boolean {
  return segments.some(isVersionPathSegment);
}

/**
 * Normalize the provider API base URL as Pi's runtime expects it.
 *
 * OpenAI-compatible SDK calls expect /v1 in the base URL; Anthropic SDK calls
 * append /v1/messages themselves; Google GenAI expects the version in baseUrl
 * because Pi passes apiVersion="" to the client.
 */
export function normalizePiCustomEndpointBaseUrl(
  baseUrl: string | undefined,
  api: PiCustomApi = 'openai-completions',
): string | undefined {
  const trimmed = baseUrl?.trim();
  if (!trimmed) return undefined;

  const url = new URL(trimmed);
  url.hash = '';
  url.search = '';

  let segments = url.pathname
    .split('/')
    .filter(Boolean);
  segments = collapseDuplicateTrailingVersionSegments(stripTrailingEndpointSegments(segments));

  if (api === 'anthropic-messages') {
    while (isVersionPathSegment(segments.at(-1))) {
      segments.pop();
    }
  } else if (api === 'google-generative-ai') {
    if (!hasAnyVersionPathSegment(segments)) {
      segments.push('v1beta');
    }
  } else if (isOpenRouterHost(url.hostname)) {
    const lowerPath = segments.map(segment => segment.toLowerCase()).join('/');
    if (!lowerPath || lowerPath === 'v1' || lowerPath === 'api') {
      segments = ['api', 'v1'];
    }
  } else if (!hasAnyVersionPathSegment(segments) && !usesRootOpenAiCompatibleBaseUrl(url.hostname)) {
    segments.push('v1');
  }

  segments = collapseDuplicateTrailingVersionSegments(segments);
  setUrlPathSegments(url, segments);
  return normalizeUrlWithoutTrailingSlash(url);
}

export function setPiGlobalApiKey(providerKey: string, apiKey: string): void {
  assertValidProviderKey(providerKey);
  const trimmed = normalizeApiKeyInput(apiKey);
  if (!trimmed) return;
  setPiHostGlobalApiKey(providerKey, trimmed);
}

export function deletePiGlobalApiKey(providerKey: string): void {
  assertValidProviderKey(providerKey);
  deletePiHostGlobalApiKey(providerKey);
}

export interface PiGlobalApiKeyMigrationResult {
  migrated: number;
  removedFromModels: number;
  changed: boolean;
}

export function migratePiGlobalProviderApiKeysToAuth(): PiGlobalApiKeyMigrationResult {
  return migratePiHostGlobalProviderApiKeysToAuth();
}

export function savePiGlobalProvider(key: string, provider: PiGlobalProvider, apiKey?: string): void {
  assertValidProviderKey(key);
  const legacyApiKey = normalizeApiKeyInput((provider as PiGlobalProvider & { apiKey?: string }).apiKey);
  const nextApiKey = normalizeApiKeyInput(apiKey) ?? legacyApiKey;
  if (nextApiKey) {
    setPiGlobalApiKey(key, nextApiKey);
  }
  const nextProvider = sanitizePiGlobalProvider(provider);
  const normalizedBaseUrl = normalizePiCustomEndpointBaseUrl(nextProvider.baseUrl, nextProvider.api);
  if (normalizedBaseUrl) {
    nextProvider.baseUrl = normalizedBaseUrl;
  } else {
    delete nextProvider.baseUrl;
  }
  savePiHostGlobalProvider({
    key,
    provider: nextProvider as HostGlobalProvider,
    apiKey: nextApiKey,
  });
}

export async function deletePiGlobalProvider(key: string): Promise<void> {
  await deletePiHostGlobalProvider(key);
}

export async function setPiGlobalDefault(
  provider: string,
  model: string,
  thinkingLevel?: string,
): Promise<void> {
  await setPiHostGlobalDefault({
    provider,
    model,
    thinkingLevel,
  });
}

/**
 * Set only the top-level `defaultThinkingLevel` in ~/.pi/agent/settings.json
 * without touching defaultProvider/defaultModel. This is the authoritative
 * SoT read by the pi subprocess; mortise's setDefaultThinkingLevel() mirrors
 * its value here so the subprocess picks it up immediately.
 */
export async function setPiGlobalDefaultThinkingLevel(level: string): Promise<void> {
  await setPiHostDefaultThinkingLevel(level);
}

// ===== Mortise agent runtime namespace (mortise.agent.*) =====
//
// Mortise-only UI/window preferences stay in ~/.mortise/config.json. Runtime
// toggles that affect agent behavior live in ~/.pi/agent/settings.json under
// mortise.agent.* so Pi/Mortise subprocesses read the same source of truth.

export type PiMortiseSettings = Record<string, unknown>;

export function readPiMortiseSettings(): PiMortiseSettings {
  return readPiHostMortiseSettings();
}

export function readPiMortiseSetting(key: string, fallback: unknown): unknown {
  const value = readPiMortiseSettings()[key];
  return value != null ? value : fallback;
}

export function readPiMortiseBoolean(key: string, fallback = false): boolean {
  const value = readPiMortiseSetting(key, fallback);
  return typeof value === 'boolean' ? value : fallback;
}

export function writePiMortiseSettingsBulk(updates: Record<string, unknown>): void {
  writePiHostMortiseSettingsBulk(updates);
}

export function writePiMortiseSetting(key: string, value: unknown): void {
  writePiMortiseSettingsBulk({ [key]: value });
}

export function writePiMortiseBoolean(key: string, value: boolean): void {
  writePiMortiseSetting(key, value);
}

// ===== 扩展命名空间（extensionConfig.<name>.*）=====
//
// 扩展级 model/enabled/concurrency 统一存放在 ~/.pi/agent/settings.json 的
// `extensionConfig.<id>.*` 命名空间；不再读取旧 `extensions.<name>.*` 对象。

/**
 * settings.json 中扩展配置命名空间的松散结构。
 * 键为扩展 id（如 'repo-memory'、'trace-audit'），值为该扩展的配置对象。
 */
export type PiExtensionNamespaceSettings = Record<string, Record<string, unknown>>;

/**
 * 读取 settings.json 的扩展配置命名空间整体。
 * 文件缺失或字段缺失时返回空对象。
 */
export function readPiExtensionNamespace(): PiExtensionNamespaceSettings {
  return readPiHostExtensionNamespace() as PiExtensionNamespaceSettings;
}

/**
 * 读取某个扩展在 settings.json 的 `extensionConfig.<name>` 配置对象。
 */
function readPiExtensionConfig(name: string): Record<string, unknown> {
  return readPiHostExtensionConfig(name) as Record<string, unknown>;
}

/**
 * 写入某个扩展在 settings.json 的 `extensionConfig.<name>` 配置对象（整体覆盖）。
 */
async function writePiExtensionConfig(name: string, config: Record<string, unknown>): Promise<void> {
  await setPiHostExtensionConfig(name, config);
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

/**
 * 读取 Pi 扩展 catalog。扩展发现、metadata、enabled/config 均来自 Pi host facade；
 * Mortise 只把结果作为设置 UI 的展示 DTO。
 */
export async function getPiExtensionCatalog(options: { cwd?: string; agentDir?: string } = {}): Promise<PiExtensionCatalogResult> {
  const cwd = options.cwd ?? process.cwd();
  const agentDir = options.agentDir ?? PI_AGENT_DIR;
  try {
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const packageManager = new DefaultPackageManager({
      cwd,
      agentDir,
      settingsManager,
      extensionTarget: 'mortise',
    });
    const result = await packageManager.resolve();
    return {
      // PackageManager deliberately retains disabled resources. Loading the
      // runtime (and the host facade catalog built on it) filters them out.
      extensions: result.extensions
        .filter((resource) => resource.metadata.extensionId)
        .map((resource): PiExtensionCatalogEntry => {
          const id = resource.metadata.extensionId!;
          const metadata = resource.metadata as typeof resource.metadata & {
            extensionManifest?: PiExtensionCatalogEntry['manifest'];
            extensionManifestStatus?: PiExtensionCatalogEntry['manifestStatus'];
            extensionManifestDiagnostics?: PiExtensionCatalogEntry['manifestDiagnostics'];
            extensionHostVersion?: string;
            extensionLoadable?: boolean;
          };
          const ui = metadata.extensionUI as PiExtensionCatalogEntry['ui'];
          const manifest = metadata.extensionManifest;
          const config = settingsManager.getExtensionConfig(id) as Record<string, unknown> | undefined;
          return {
            id,
            target: 'mortise',
            loaded: false,
            title: ui?.title ?? manifest?.name ?? id,
            description: ui?.description ?? manifest?.description ?? '',
            category: ui?.category ?? 'other',
            configurable: (ui?.settings?.fields.length ?? 0) > 0,
            manifest,
            manifestStatus: metadata.extensionManifestStatus ?? 'legacy',
            manifestDiagnostics: metadata.extensionManifestDiagnostics ?? [],
            hostVersion: metadata.extensionHostVersion ?? '0.0.0',
            loadable: metadata.extensionLoadable ?? resource.enabled,
            ui,
            enabled: config?.enabled === undefined ? true : config.enabled !== false,
            path: resource.path,
            resolvedPath: resource.path,
            commands: [],
            tools: [],
            flags: [],
            shortcuts: [],
            config,
          };
        }),
      errors: [],
    };
  } catch (error) {
    return {
      extensions: [],
      errors: [{ path: '', error: error instanceof Error ? error.message : String(error), target: 'mortise' }],
    };
  }
}

function validateSettingValue(field: PiExtensionSettingField, value: PiExtensionSettingScalar): string | null {
  if (field.type === 'boolean') return typeof value === 'boolean' ? null : `${field.key} must be boolean`;
  if (field.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return `${field.key} must be a finite number`;
    if (field.min !== undefined && value < field.min) return `${field.key} must be at least ${field.min}`;
    if (field.max !== undefined && value > field.max) return `${field.key} must be at most ${field.max}`;
    return null;
  }
  if (typeof value !== 'string') return `${field.key} must be a string`;
  if ((field.type === 'string' || field.type === 'textarea') && field.minLength !== undefined && value.length < field.minLength) return `${field.key} is too short`;
  if ((field.type === 'string' || field.type === 'textarea') && field.maxLength !== undefined && value.length > field.maxLength) return `${field.key} is too long`;
  if (field.type === 'select' && !field.options.some((option) => option.value === value)) return `${field.key} must use a declared option`;
  return null;
}

export function validatePiExtensionConfigPatch(entry: PiExtensionCatalogEntry, patch: PiExtensionConfigPatch): { requiresReload: boolean } {
  if (patch.schemaVersion !== 1 || patch.extensionId !== entry.id) throw new Error('Extension config patch identity is invalid');
  const fields = new Map((entry.ui?.settings?.fields ?? []).map((field) => [field.key, field]));
  const touched = [...Object.keys(patch.set ?? {}), ...(patch.unset ?? [])];
  if (new Set(touched).size !== touched.length) throw new Error('Extension config patch contains duplicate keys');
  let requiresReload = false;
  for (const key of touched) {
    const field = fields.get(key);
    if (!field) throw new Error(`Unknown extension setting: ${key}`);
    requiresReload ||= field.requiresReload === true;
    if (patch.set && key in patch.set) {
      const error = validateSettingValue(field, patch.set[key]!);
      if (error) throw new Error(error);
    }
  }
  return { requiresReload };
}

export async function patchPiExtensionConfig(
  entry: PiExtensionCatalogEntry,
  patch: PiExtensionConfigPatch,
  options: { cwd?: string; agentDir?: string } = {},
): Promise<{ config: Record<string, unknown>; requiresReload: boolean }> {
  const { requiresReload } = validatePiExtensionConfigPatch(entry, patch);
  const settingsManager = SettingsManager.create(options.cwd ?? process.cwd(), options.agentDir ?? PI_AGENT_DIR);
  const config = { ...(settingsManager.getExtensionConfig(patch.extensionId) as Record<string, unknown> | undefined) };
  for (const [key, value] of Object.entries(patch.set ?? {})) config[key] = value;
  for (const key of patch.unset ?? []) delete config[key];

  // The host facade patch helper currently returns before its SettingsManager
  // flushes, which hides asynchronous write errors. Flush and drain explicitly
  // so the RPC rejects when persistence failed.
  settingsManager.replaceExtensionConfig(patch.extensionId, config);
  await settingsManager.flush();
  const errors = settingsManager.drainErrors();
  if (errors.length > 0) {
    throw new Error(errors.map((item) => item.error.message).join('; '));
  }
  return { config, requiresReload };
}

// ===== Shell GUI 命名空间（shellGui.<name>.*）=====
//
// mortise shell 的 GUI 开关与 agent 行为字段（showStatusBadge/widgetVisible/
// mortise 全局开关等）回归 ~/.pi/agent/settings.json 的 `shellGui.<name>.*`
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
  return readPiHostShellGuiNamespace() as Record<string, PiShellGuiNamespaceSettings>;
}

/**
 * 读取某个 shell 在 settings.json 的 `shellGui.<name>` 配置对象。
 */
function readPiShellGuiConfig(name: string): PiShellGuiNamespaceSettings {
  return readPiHostShellGuiEntry(name) as PiShellGuiNamespaceSettings;
}

/**
 * 写入某个 shell 在 settings.json 的 `shellGui.<name>` 配置对象（整体覆盖）。
 */
async function writePiShellGuiConfig(name: string, config: PiShellGuiNamespaceSettings): Promise<void> {
  await setPiHostShellGuiEntry(name, config);
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
  const config = readPiShellGuiConfig(name);
  config[key] = value;
  await writePiShellGuiConfig(name, config);
}

/**
 * 批量写入多个 `shellGui.<name>.<key>` 字段，仅执行一次 read-modify-write。
 *
 * F2 修复：替代多次独立调用 writePiShellGuiSetting/writePiShellGuiBoolean，
 * 避免每次都读全文件→改一字段→写全文件造成的竞态窗口与性能开销。
 *
 * @param updates 形如 `{ 'mortise': { enabled: true, ... }, 'subagent': { reviewEnabled: false } }` 的对象
 */
export async function writePiShellGuiSettingsBulk(
  updates: Record<string, Record<string, unknown>>,
): Promise<void> {
  await Promise.all(Object.entries(updates).map(async ([name, fields]) => {
    const current = readPiShellGuiConfig(name);
    await writePiShellGuiConfig(name, {
      ...current,
      ...fields,
    });
  }));
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
  await deletePiHostShellGuiEntry(name);
}

// ===== Fetch models from custom endpoint (/v1/models) =====

export interface FetchedEndpointModel {
  id: string;
  name?: string;
  ownedBy?: string;
}

type FetchModelsForEndpointOptions = {
  api?: PiCustomApi;
  authHeader?: boolean;
  timeoutMs?: number;
};

export interface FetchModelsForEndpointResult {
  models: FetchedEndpointModel[];
  resolvedBaseUrl: string;
  requestUrl: string;
  attemptedUrls: string[];
}

type ModelEndpointErrorKind = 'http' | 'html' | 'empty' | 'invalid-json';

class ModelEndpointResponseError extends Error {
  constructor(
    message: string,
    readonly kind: ModelEndpointErrorKind,
    readonly requestUrl: string,
  ) {
    super(message);
    this.name = 'ModelEndpointResponseError';
  }
}

interface ModelEndpointCandidate {
  baseUrl: string;
  modelsUrl: string;
}

function normalizeUrlWithoutTrailingSlash(url: URL): string {
  const next = new URL(url.toString());
  next.hash = '';
  next.search = '';
  if (next.pathname.length > 1) {
    next.pathname = next.pathname.replace(/\/+$/, '');
  }
  return next.toString().replace(/\/$/, '');
}

function appendPath(baseUrl: string, suffix: string): string {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${suffix.replace(/^\/+/, '')}`;
  return normalizeUrlWithoutTrailingSlash(url);
}

function modelsUrlForBase(baseUrl: string, api: PiCustomApi): string {
  const normalized = baseUrl.replace(/\/+$/, '');
  return api === 'anthropic-messages'
    ? `${normalized}/v1/models`
    : `${normalized}/models`;
}

function addCandidate(
  candidates: ModelEndpointCandidate[],
  seen: Set<string>,
  baseUrl: string,
  api: PiCustomApi,
  modelsUrl = modelsUrlForBase(baseUrl, api),
): void {
  const key = modelsUrl;
  if (seen.has(key)) return;
  seen.add(key);
  candidates.push({ baseUrl, modelsUrl });
}

function buildModelEndpointCandidates(baseUrl: string, api: PiCustomApi): ModelEndpointCandidate[] {
  const trimmed = baseUrl.trim();
  if (!trimmed) throw new Error('baseUrl is required');

  const input = new URL(trimmed);
  const base = normalizeUrlWithoutTrailingSlash(input);
  const path = input.pathname.replace(/\/+$/, '');
  const lowerPath = path.toLowerCase();
  const candidates: ModelEndpointCandidate[] = [];
  const seen = new Set<string>();

  if (/\/models$/i.test(path)) {
    const resolved = new URL(input.toString());
    resolved.hash = '';
    resolved.search = '';
    resolved.pathname = path.replace(/\/models$/i, '') || '/';
    const resolvedBaseUrl = normalizePiCustomEndpointBaseUrl(normalizeUrlWithoutTrailingSlash(resolved), api)
      ?? normalizeUrlWithoutTrailingSlash(resolved);
    addCandidate(candidates, seen, resolvedBaseUrl, api, input.toString());
    return candidates;
  }

  const firstBase = api === 'anthropic-messages'
    ? normalizePiCustomEndpointBaseUrl(base, api) ?? base
    : base;
  addCandidate(candidates, seen, firstBase, api);

  const normalizedBase = normalizePiCustomEndpointBaseUrl(base, api);
  if (normalizedBase && normalizedBase !== firstBase) {
    addCandidate(candidates, seen, normalizedBase, api);
  }

  const isRootPath = lowerPath === '' || lowerPath === '/';
  const hasVersionPath = /(^|\/)(v\d+(?:beta)?|api\/v\d+)(\/|$)/i.test(lowerPath);
  const versionSuffixes = api === 'google-generative-ai'
    ? ['v1beta', 'v1']
    : ['v1'];
  for (const suffix of versionSuffixes) {
    if (!hasVersionPath && !lowerPath.endsWith(`/${suffix}`) && lowerPath !== `/${suffix}`) {
      const candidateBase = appendPath(base, suffix);
      const resolvedBase = normalizePiCustomEndpointBaseUrl(candidateBase, api) ?? candidateBase;
      addCandidate(candidates, seen, resolvedBase, api);
    }
  }

  const host = input.hostname.toLowerCase();
  const apiV1First = host === 'openrouter.ai' || host.endsWith('.openrouter.ai');
  const apiV1 = appendPath(base, 'api/v1');
  if (isRootPath && apiV1First) {
    const resolvedBase = normalizePiCustomEndpointBaseUrl(apiV1, api) ?? apiV1;
    const candidate = { baseUrl: resolvedBase, modelsUrl: modelsUrlForBase(resolvedBase, api) };
    if (!seen.has(candidate.modelsUrl)) {
      seen.add(candidate.modelsUrl);
      candidates.splice(1, 0, candidate);
    }
  } else if (isRootPath) {
    const resolvedBase = normalizePiCustomEndpointBaseUrl(apiV1, api) ?? apiV1;
    addCandidate(candidates, seen, resolvedBase, api);
  }

  return candidates.filter((candidate, index, all) =>
    all.findIndex(item => item.modelsUrl === candidate.modelsUrl) === index,
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function mapOpenAiModels(data: unknown): FetchedEndpointModel[] {
  const root = asRecord(data);
  return asArray(root.data ?? root.models)
    .map(item => asRecord(item))
    .filter(item => typeof item.id === 'string' && item.id.trim())
    .map(item => ({
      id: String(item.id),
      name: typeof item.name === 'string' ? item.name : String(item.id),
      ownedBy: typeof item.owned_by === 'string' ? item.owned_by : undefined,
    }));
}

function mapAnthropicModels(data: unknown): FetchedEndpointModel[] {
  const root = asRecord(data);
  return asArray(root.data ?? root.models)
    .map(item => asRecord(item))
    .filter(item => typeof item.id === 'string' && item.id.trim())
    .map(item => ({
      id: String(item.id),
      name: typeof item.display_name === 'string'
        ? item.display_name
        : typeof item.name === 'string'
          ? item.name
          : String(item.id),
      ownedBy: 'Anthropic',
    }));
}

function mapGoogleModels(data: unknown): FetchedEndpointModel[] {
  const root = asRecord(data);
  return asArray(root.models ?? root.data)
    .map(item => asRecord(item))
    .map((item): FetchedEndpointModel | null => {
      const rawName = typeof item.name === 'string' ? item.name : '';
      const id = rawName.startsWith('models/') ? rawName.slice('models/'.length) : rawName;
      if (!id) return null;
      return {
        id,
        name: typeof item.displayName === 'string' ? item.displayName : id,
        ownedBy: 'Google',
      } satisfies FetchedEndpointModel;
    })
    .filter((item): item is FetchedEndpointModel => item !== null);
}

function redactUrlForError(requestUrl: string): string {
  try {
    const url = new URL(requestUrl);
    for (const key of ['key', 'api_key', 'apikey', 'token', 'access_token']) {
      if (url.searchParams.has(key)) url.searchParams.set(key, 'REDACTED');
    }
    return url.toString();
  } catch {
    return requestUrl;
  }
}

function summarizeResponseBody(body: string): string {
  return body
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

function isHtmlResponse(contentType: string, body: string): boolean {
  const trimmed = body.trimStart().toLowerCase();
  return contentType.toLowerCase().includes('text/html')
    || trimmed.startsWith('<!doctype')
    || trimmed.startsWith('<html')
    || trimmed.startsWith('<head')
    || trimmed.startsWith('<body');
}

async function readEndpointJson(resp: Response, requestUrl: string): Promise<unknown> {
  const contentType = resp.headers.get('content-type') ?? '';
  const body = await resp.text().catch(() => '');
  const safeUrl = redactUrlForError(requestUrl);
  const snippet = summarizeResponseBody(body);

  if (!resp.ok) {
    throw new Error(
      `Model list request failed with HTTP ${resp.status} at ${safeUrl}${snippet ? `: ${snippet}` : ''}`,
    );
  }

  if (!body.trim()) {
    throw new Error(`Model list endpoint returned an empty response at ${safeUrl}. Check the API endpoint URL.`);
  }

  if (isHtmlResponse(contentType, body)) {
    throw new Error(
      `Model list endpoint returned HTML instead of JSON at ${safeUrl}. Check that the endpoint is the provider API base URL, not a website or dashboard URL.`,
    );
  }

  try {
    return JSON.parse(body);
  } catch {
    throw new Error(
      `Model list endpoint returned invalid JSON at ${safeUrl}${contentType ? ` (${contentType})` : ''}${snippet ? `: ${snippet}` : ''}`,
    );
  }
}

function appendAttemptedUrls(error: unknown, attemptedUrls: string[]): Error {
  const message = error instanceof Error ? error.message : String(error);
  const attempted = attemptedUrls.map(redactUrlForError).join(', ');
  return new Error(`${message}${attempted ? ` Tried model endpoints: ${attempted}` : ''}`);
}

function buildModelEndpointRequest(
  candidate: ModelEndpointCandidate,
  api: PiCustomApi,
  apiKey: string,
  authHeader: boolean,
): { requestUrl: string; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  let requestUrl = candidate.modelsUrl;

  switch (api) {
    case 'anthropic-messages':
      if (apiKey.trim()) headers['x-api-key'] = apiKey.trim();
      headers['anthropic-version'] = '2023-06-01';
      break;
    case 'google-generative-ai': {
      const withKey = new URL(candidate.modelsUrl);
      if (apiKey.trim()) withKey.searchParams.set('key', apiKey.trim());
      requestUrl = withKey.toString();
      if (apiKey.trim()) headers['x-goog-api-key'] = apiKey.trim();
      break;
    }
    case 'openai-completions':
    case 'openai-responses':
    default:
      if (authHeader && apiKey.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`;
      break;
  }

  return {
    requestUrl,
    headers: {
      Accept: 'application/json',
      ...headers,
    },
  };
}

/**
 * Fetch model list from a custom endpoint.
 * OpenAI-compatible protocols use `${baseUrl}/models` with optional Bearer auth.
 * Anthropic-compatible endpoints use `x-api-key`; Google Generative AI uses
 * the `key` query parameter and strips the returned `models/` prefix.
 */
export async function fetchModelsForEndpoint(
  baseUrl: string,
  apiKey: string,
  options?: FetchModelsForEndpointOptions,
): Promise<FetchedEndpointModel[]> {
  return (await fetchModelsForEndpointWithResolution(baseUrl, apiKey, options)).models;
}

export async function fetchModelsForEndpointWithResolution(
  baseUrl: string,
  apiKey: string,
  options?: FetchModelsForEndpointOptions,
): Promise<FetchModelsForEndpointResult> {
  const timeoutMs = options?.timeoutMs ?? 15_000;
  const api = options?.api ?? 'openai-completions';
  const authHeader = options?.authHeader ?? true;
  const candidates = buildModelEndpointCandidates(baseUrl, api);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const attemptedUrls: string[] = [];
  let lastError: unknown;
  try {
    for (const candidate of candidates) {
      const { requestUrl, headers } = buildModelEndpointRequest(candidate, api, apiKey, authHeader);
      attemptedUrls.push(requestUrl);
      try {
        const resp = await fetch(requestUrl, {
          headers,
          signal: controller.signal,
        });
        const data = await readEndpointJson(resp, requestUrl);
        const models = api === 'anthropic-messages'
          ? mapAnthropicModels(data)
          : api === 'google-generative-ai'
            ? mapGoogleModels(data)
            : mapOpenAiModels(data);
        return {
          models,
          resolvedBaseUrl: candidate.baseUrl,
          requestUrl,
          attemptedUrls,
        };
      } catch (error) {
        lastError = error;
      }
    }
    throw appendAttemptedUrls(lastError ?? new Error('Failed to fetch models'), attemptedUrls);
  } finally {
    clearTimeout(timer);
  }
}
