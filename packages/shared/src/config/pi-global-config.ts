/**
 * Pi CLI Global Config (~/.pi/agent/)
 *
 * Reads/writes the Pi CLI's global configuration files:
 * - models.json:   provider definitions (baseUrl, apiKey, api, models)
 * - settings.json: defaultProvider, defaultModel, defaultThinkingLevel
 * - auth.json:     OAuth credentials (usually empty for custom-endpoint providers)
 *
 * This is the single source of truth for "pure Pi + custom provider" mode.
 * Craft Agent syncs these files into its own ~/.craft-agent/config.json +
 * credentials.enc so the subprocess (which uses in-memory registries) stays
 * isolated while users edit ~/.pi/agent/ directly (interop with Pi CLI / cc-switch).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { PI_MODELS_FILE, PI_SETTINGS_FILE, PI_AUTH_FILE, PI_AGENT_DIR } from './paths';

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
  [key: string]: unknown;
}

export interface PiGlobalSettings {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: string;
  [key: string]: unknown;
}

// ===== Reads =====

export function readPiGlobalModelsFile(): PiGlobalModelsFile {
  try {
    if (!existsSync(PI_MODELS_FILE)) return { providers: {} };
    const raw = readFileSync(PI_MODELS_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as PiGlobalModelsFile;
    if (!parsed || typeof parsed !== 'object') return { providers: {} };
    if (!parsed.providers || typeof parsed.providers !== 'object') {
      parsed.providers = {};
    }
    return parsed;
  } catch {
    return { providers: {} };
  }
}

export function readPiGlobalProviders(): Record<string, PiGlobalProvider> {
  return readPiGlobalModelsFile().providers ?? {};
}

export function readPiGlobalSettings(): PiGlobalSettings {
  try {
    if (!existsSync(PI_SETTINGS_FILE)) return {};
    const raw = readFileSync(PI_SETTINGS_FILE, 'utf-8');
    return JSON.parse(raw) as PiGlobalSettings;
  } catch {
    return {};
  }
}

// ===== auth.json (OAuth / IAM credentials) =====

/**
 * Pi auth.json credential for a single provider.
 * Mirrors the PiCredential union used by pi-agent-server (api_key | oauth | iam).
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
 * cannot be parsed. Used by pi-global-sync to mirror OAuth/IAM credentials
 * into Craft's credentials.enc so getPiAuth() can resolve them by slug.
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

function writePiGlobalModelsFile(file: PiGlobalModelsFile): void {
  ensurePiAgentDir();
  writeFileSync(PI_MODELS_FILE, JSON.stringify(file, null, 2), 'utf-8');
}

function writePiGlobalSettings(settings: PiGlobalSettings): void {
  ensurePiAgentDir();
  writeFileSync(PI_SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
}

/** Provider key must be a lowercase slug (a-z0-9 plus hyphens). */
export function isValidProviderKey(key: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(key);
}

export function savePiGlobalProvider(key: string, provider: PiGlobalProvider): void {
  if (!isValidProviderKey(key)) {
    throw new Error(`Invalid provider key: ${key} (must be lowercase slug a-z0-9-)`);
  }
  const file = readPiGlobalModelsFile();
  file.providers = file.providers ?? {};
  file.providers[key] = provider;
  writePiGlobalModelsFile(file);
}

export function deletePiGlobalProvider(key: string): void {
  const file = readPiGlobalModelsFile();
  if (file.providers && file.providers[key]) {
    delete file.providers[key];
    writePiGlobalModelsFile(file);
  }
  // If deleted provider was default, clear default
  const settings = readPiGlobalSettings();
  if (settings.defaultProvider === key) {
    settings.defaultProvider = undefined;
    settings.defaultModel = undefined;
    writePiGlobalSettings(settings);
  }
}

export function setPiGlobalDefault(
  provider: string,
  model: string,
  thinkingLevel?: string,
): void {
  // 'custom-endpoint' is a Pi SDK internal provider name registered by the
  // subprocess — it must never be persisted as the default in settings.json
  // (it doesn't exist in models.json, so pi-global-sync can't resolve it).
  if (provider === 'custom-endpoint') {
    throw new Error(
      "Refusing to set 'custom-endpoint' as default provider — it is an internal provider name. Use a real provider key from models.json instead.",
    );
  }
  const settings = readPiGlobalSettings();
  settings.defaultProvider = provider;
  settings.defaultModel = model;
  if (thinkingLevel !== undefined) {
    settings.defaultThinkingLevel = thinkingLevel;
  }
  writePiGlobalSettings(settings);
}

// ===== 扩展命名空间（extensions.<name>.*）=====
//
// Task 7：扩展级 model/enabled/concurrency 已回归 ~/.pi/agent/settings.json 的
// `extensions.<name>.*` 命名空间。以下函数提供同步读写能力，供未来 IPC handler
// 或 pi-global-sync 使用。craft 自身的 pi-extension-settings.ts 不再持有这些字段。

/**
 * settings.json 中 `extensions` 命名空间的松散结构。
 * 键为扩展 id（如 'repo-memory'、'trace-audit'），值为该扩展的配置对象。
 */
export type PiExtensionNamespaceSettings = Record<string, Record<string, unknown>>;

/**
 * 读取 settings.json 的 `extensions` 命名空间整体。
 * 文件缺失或字段缺失时返回空对象。
 */
export function readPiExtensionNamespace(): PiExtensionNamespaceSettings {
  const settings = readPiGlobalSettings();
  const extensions = (settings as { extensions?: unknown }).extensions;
  if (!extensions || typeof extensions !== 'object') return {};
  return extensions as PiExtensionNamespaceSettings;
}

/**
 * 读取某个扩展在 settings.json 的 `extensions.<name>` 配置对象。
 */
function readPiExtensionConfig(name: string): Record<string, unknown> {
  const ns = readPiExtensionNamespace();
  const entry = ns[name];
  if (!entry || typeof entry !== 'object') return {};
  return entry;
}

/**
 * 写入某个扩展在 settings.json 的 `extensions.<name>` 配置对象（整体覆盖）。
 */
function writePiExtensionConfig(name: string, config: Record<string, unknown>): void {
  const settings = readPiGlobalSettings() as PiGlobalSettings & { extensions?: PiExtensionNamespaceSettings };
  settings.extensions = settings.extensions ?? {};
  settings.extensions[name] = config;
  writePiGlobalSettings(settings);
}

/**
 * 读取 `extensions.<name>.enabled`。字段缺失时返回 fallback（默认 true，与 Pi SDK 行为一致）。
 */
export function readPiExtensionEnabled(name: string, fallback = true): boolean {
  const config = readPiExtensionConfig(name);
  const value = config.enabled;
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * 写入 `extensions.<name>.enabled`。保留该扩展已有的其他字段。
 */
export function writePiExtensionEnabled(name: string, enabled: boolean): void {
  const config = readPiExtensionConfig(name);
  config.enabled = enabled;
  writePiExtensionConfig(name, config);
}

/**
 * 读取 `extensions.<name>.model`。字段缺失时返回 fallback。
 */
export function readPiExtensionModel(name: string, fallback = ''): string {
  const config = readPiExtensionConfig(name);
  const value = config.model;
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

/**
 * 写入 `extensions.<name>.model`。保留该扩展已有的其他字段。
 */
export function writePiExtensionModel(name: string, model: string): void {
  const config = readPiExtensionConfig(name);
  config.model = model;
  writePiExtensionConfig(name, config);
}

/**
 * 读取 `extensions.<name>.concurrency`。字段缺失或非法时返回 fallback。
 */
export function readPiExtensionConcurrency(name: string, fallback: number): number {
  const config = readPiExtensionConfig(name);
  const value = config.concurrency;
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.round(value));
}

/**
 * 写入 `extensions.<name>.concurrency`。保留该扩展已有的其他字段。
 */
export function writePiExtensionConcurrency(name: string, concurrency: number): void {
  const config = readPiExtensionConfig(name);
  config.concurrency = Math.max(1, Math.round(concurrency));
  writePiExtensionConfig(name, config);
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
