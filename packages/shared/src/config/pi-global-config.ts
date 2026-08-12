/**
 * Pi CLI Global Config facade.
 *
 * This is the single source of truth for "pure Pi + custom provider" mode.
 * Mortise settings handlers use this module as the canonical typed boundary;
 * storage reads/writes go through Pi's host facade.
 */

import { existsSync, statSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { unzipSync } from 'fflate';
import { ResourceResolver, SettingsManager } from '@mortise/pi-coding-agent';
import {
  deleteGlobalApiKey as deletePiHostGlobalApiKey,
  deleteGlobalProvider as deletePiHostGlobalProvider,
  deleteShellGuiEntry as deletePiHostShellGuiEntry,
  getHostAgentDir as getPiHostAgentDir,
  hasGlobalProviderAuth as hasPiHostGlobalProviderAuth,
  maskApiKey as maskPiHostApiKey,
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
  readGlobalWebSearchMode as readPiHostGlobalWebSearchMode,
  readGlobalModelDefaultSlots as readPiHostGlobalModelDefaultSlots,
  removeGlobalModelDefaultSlot as removePiHostGlobalModelDefaultSlot,
  readShellGuiEntry as readPiHostShellGuiEntry,
  readShellGuiNamespace as readPiHostShellGuiNamespace,
  saveGlobalProvider as savePiHostGlobalProvider,
  setDefaultThinkingLevel as setPiHostDefaultThinkingLevel,
  setExtensionConfig as setPiHostExtensionConfig,
  setGlobalApiKey as setPiHostGlobalApiKey,
  setGlobalDefault as setPiHostGlobalDefault,
  setGlobalModelDefaultSlot as setPiHostGlobalModelDefaultSlot,
  setGlobalWebSearchMode as setPiHostGlobalWebSearchMode,
  setShellGuiEntry as setPiHostShellGuiEntry,
  subscribeGlobalConfig as subscribePiHostGlobalConfig,
  writeMortiseSettingsBulk as writePiHostMortiseSettingsBulk,
  type HostGlobalConfigSubscription,
  type HostGlobalProvider,
} from '@mortise/pi-coding-agent/host-facade';
import { PI_MODEL_REFERENCE_CURRENT_SESSION, type PiExtensionCatalogEntry, type PiExtensionCatalogResult, type PiExtensionConfigPatch, type PiExtensionImportResult, type PiExtensionSettingField, type PiExtensionSettingScalar, type PiExtensionUninstallResult } from './pi-extension-settings.ts';
import type { PiCustomApi, PiGlobalModel, PiGlobalProvider } from './pi-provider-models.ts';
import { MORTISE_PROJECT_DIR } from './paths';
import { DEFAULT_THINKING_LEVEL, type ThinkingLevel } from '../agent/thinking-levels.ts';

export {
  piProviderModelSupportsImages,
  piProviderModelSupportsReasoning,
  setPiProviderModelSupportsImages,
  setPiProviderModelSupportsReasoning,
} from './pi-provider-models.ts';
export type { PiCustomApi, PiGlobalModel, PiGlobalProvider } from './pi-provider-models.ts';

/** Resolve the Pi-owned Agent root through its typed host facade. */
export function getPiAgentDir(): string {
  return getPiHostAgentDir();
}

export type WebSearchMode = 'auto' | 'native' | 'extension' | 'disabled';

export function readPiWebSearchMode(): WebSearchMode {
  return readPiHostGlobalWebSearchMode();
}

export async function writePiWebSearchMode(mode: WebSearchMode): Promise<void> {
  await setPiHostGlobalWebSearchMode(mode);
}

const MANAGED_EXTENSION_SUBDIR = join('extensions', 'imported');
const MAX_EXTENSION_ARCHIVE_FILES = 5_000;
const MAX_EXTENSION_ARCHIVE_BYTES = 100 * 1024 * 1024;

function isPathInside(parent: string, candidate: string): boolean {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function managedExtensionRoot(agentDir = getPiHostAgentDir()): string {
  return join(agentDir, MANAGED_EXTENSION_SUBDIR);
}

function safePackageSlug(value: string, fallback: string): string {
  const slug = value
    .replace(/^@/, '')
    .replace(/[\\/]+/g, '-')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '');
  return slug || fallback;
}

type ImportManifest = {
  name?: string;
  pi?: {
    extensions?: Array<{ id?: string; path?: string }>;
  };
};

async function readImportManifest(directory: string): Promise<{ packageName: string; extensionIds: string[] }> {
  const manifestPath = join(directory, 'package.json');
  let manifest: ImportManifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as ImportManifest;
  } catch (error) {
    throw new Error(`Extension source must contain a readable package.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  const entries = manifest.pi?.extensions;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('Extension package.json must declare at least one pi.extensions entry');
  }
  const extensionIds: string[] = [];
  for (const entry of entries) {
    const id = entry?.id?.trim();
    const entryPath = entry?.path?.trim();
    if (!id || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(id)) {
      throw new Error('Every imported extension must declare a lowercase stable id');
    }
    if (!entryPath || isAbsolute(entryPath)) {
      throw new Error(`Extension ${id} must declare a relative path`);
    }
    const resolvedEntry = resolve(directory, entryPath);
    if (!isPathInside(directory, resolvedEntry) || !existsSync(resolvedEntry)) {
      throw new Error(`Extension ${id} points outside the package or to a missing file`);
    }
    extensionIds.push(id);
  }
  if (new Set(extensionIds).size !== extensionIds.length) {
    throw new Error('Extension package contains duplicate ids');
  }
  return {
    packageName: typeof manifest.name === 'string' && manifest.name.trim() ? manifest.name.trim() : extensionIds[0]!,
    extensionIds,
  };
}

async function locateImportRoot(directory: string): Promise<string> {
  if (existsSync(join(directory, 'package.json'))) return directory;
  const candidates: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && existsSync(join(directory, entry.name, 'package.json'))) {
      candidates.push(join(directory, entry.name));
    }
  }
  if (candidates.length !== 1) {
    throw new Error('Select a folder or ZIP containing one extension package.json at its root');
  }
  return candidates[0]!;
}

async function extractExtensionArchive(archivePath: string, destination: string): Promise<void> {
  const files = unzipSync(new Uint8Array(await readFile(archivePath)));
  const names = Object.keys(files);
  if (names.length > MAX_EXTENSION_ARCHIVE_FILES) throw new Error('Extension ZIP contains too many files');
  let totalBytes = 0;
  for (const [rawName, data] of Object.entries(files)) {
    const normalized = rawName.replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);
    if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized) || parts.includes('..')) {
      throw new Error(`Extension ZIP contains an unsafe path: ${rawName}`);
    }
    if (parts.length === 0 || normalized.endsWith('/')) continue;
    totalBytes += data.byteLength;
    if (totalBytes > MAX_EXTENSION_ARCHIVE_BYTES) throw new Error('Extension ZIP is too large after extraction');
    const target = join(destination, ...parts);
    if (!isPathInside(destination, target)) throw new Error(`Extension ZIP contains an unsafe path: ${rawName}`);
    await mkdir(resolve(target, '..'), { recursive: true });
    await writeFile(target, data);
  }
}

async function persistGlobalExtensionPaths(settingsManager: SettingsManager, paths: ReturnType<SettingsManager['getExtensionPaths']>): Promise<void> {
  settingsManager.setExtensionPaths(paths);
  await settingsManager.flush();
  const errors = settingsManager.drainErrors();
  if (errors.length > 0) throw new Error(errors.map((item) => item.error.message).join('; '));
}

export interface PiGlobalModelsFile {
  providers?: Record<string, PiGlobalProvider>;
  [key: string]: unknown;
}

export interface PiGlobalSettings {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: string;
  /** Normalized ordered model defaults. Slot 1 mirrors Pi's top-level fields. */
  defaultSlots?: PiGlobalDefaultSlot[];
  mortise?: {
    agent?: Record<string, unknown>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface PiGlobalDefaultSlot {
  slot: number;
  provider: string;
  model: string;
  thinkingLevel: ThinkingLevel;
}

export { PI_MODEL_REFERENCE_CURRENT_SESSION } from './pi-extension-settings.ts';
export function piModelReferenceForDefault(slot: number): string {
  return `default:${slot}`;
}

export function isPiModelReference(value: string): boolean {
  return value === PI_MODEL_REFERENCE_CURRENT_SESSION || /^default:[1-9]\d*$/.test(value) || /^model:[^/]+\/.+$/.test(value);
}

export function resolvePiModelReference(
  reference: string | undefined,
  options: { current?: { provider?: string; model?: string; thinkingLevel?: ThinkingLevel }; settings?: PiGlobalSettings } = {},
): { provider: string; model: string; thinkingLevel?: ThinkingLevel } | undefined {
  if (!reference || reference === PI_MODEL_REFERENCE_CURRENT_SESSION) {
    return options.current?.provider && options.current.model
      ? {
          provider: options.current.provider,
          model: options.current.model,
          ...(options.current.thinkingLevel ? { thinkingLevel: options.current.thinkingLevel } : {}),
        }
      : undefined;
  }
  const defaultMatch = /^default:([1-9]\d*)$/.exec(reference);
  if (defaultMatch) {
    const slot = getPiGlobalDefaultSlots(options.settings ?? readPiGlobalSettings())
      .find((candidate) => candidate.slot === Number(defaultMatch[1]));
    return slot ? { provider: slot.provider, model: slot.model, thinkingLevel: slot.thinkingLevel } : undefined;
  }
  if (reference.startsWith('model:')) {
    const canonical = reference.slice('model:'.length);
    const separator = canonical.indexOf('/');
    if (separator > 0 && separator < canonical.length - 1) {
      return { provider: canonical.slice(0, separator), model: canonical.slice(separator + 1) };
    }
  }
  return undefined;
}

export function getPiGlobalDefaultSlots(settings: PiGlobalSettings): PiGlobalDefaultSlot[] {
  const slots: PiGlobalDefaultSlot[] = [];
  if (settings.defaultProvider?.trim() && settings.defaultModel?.trim()) {
    slots.push({
      slot: 1,
      provider: settings.defaultProvider.trim(),
      model: settings.defaultModel.trim(),
      thinkingLevel: (settings.defaultThinkingLevel as ThinkingLevel | undefined) ?? DEFAULT_THINKING_LEVEL,
    });
  }
  for (const configured of settings.defaultSlots ?? []) {
    if (configured.slot > 1 && Number.isInteger(configured.slot) && configured.provider && configured.model) {
      slots.push({ ...configured, thinkingLevel: configured.thinkingLevel ?? DEFAULT_THINKING_LEVEL });
    }
  }
  slots.sort((a, b) => a.slot - b.slot);
  return slots;
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
    const settings = readPiHostGlobalSettings() as PiGlobalSettings;
    const configured = readPiHostGlobalModelDefaultSlots();
    const defaultSlots = configured.flatMap((value) => {
      const slot = value.slot;
      const provider = value?.provider?.trim();
      const model = value?.model?.trim();
      return provider && model
        ? [{ slot, provider, model, thinkingLevel: value.thinkingLevel ?? DEFAULT_THINKING_LEVEL }]
        : [];
    });
    return { ...settings, defaultSlots };
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

/** Subscribe to Pi-owned provider/default/auth changes through its typed facade. */
export function subscribePiGlobalConfig(
  onChanged: () => void,
  onError?: (error: Error) => void,
): HostGlobalConfigSubscription {
  return subscribePiHostGlobalConfig(() => onChanged(), onError);
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
  if (!rest.models?.some(model => model.reasoning === true)) return rest;
  return {
    ...rest,
    models: rest.models.map(model => {
      if (model.reasoning !== true) return model;
      const next = { ...model };
      delete next.reasoning;
      return next;
    }),
  };
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

export function savePiGlobalProvider(key: string, provider: PiGlobalProvider, apiKey?: string): void {
  assertValidProviderKey(key);
  const nextApiKey = normalizeApiKeyInput(apiKey);
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

function assertPiGlobalModelSupportsConfiguredThinking(
  providerKey: string,
  modelId: string,
  thinkingLevel: string | undefined,
): void {
  if (!thinkingLevel || thinkingLevel === 'off') return;

  const provider = readPiGlobalProviders()[providerKey];
  if (!provider) throw new Error(`Unknown provider: ${providerKey}`);
  const model = provider.models?.find(candidate => candidate.id === modelId);
  if (!model) throw new Error(`Unknown model: ${providerKey}/${modelId}`);
  if (model.reasoning === false) {
    throw new Error(`Model ${providerKey}/${modelId} explicitly disables reasoning; thinking level must be off`);
  }
}

export async function deletePiGlobalProvider(key: string): Promise<void> {
  await deletePiHostGlobalProvider(key);
}

export async function setPiGlobalDefault(
  provider: string,
  model: string,
  thinkingLevel?: string,
): Promise<void> {
  assertPiGlobalModelSupportsConfiguredThinking(provider, model, thinkingLevel);
  await setPiHostGlobalDefault({
    provider,
    model,
    thinkingLevel,
  });
}

/** Persist one of the ordered defaults. Slot 1 remains Pi's native default. */
export async function setPiGlobalDefaultSlot(
  slot: number,
  provider: string,
  model: string,
  thinkingLevel: string,
): Promise<void> {
  assertPiGlobalModelSupportsConfiguredThinking(provider, model, thinkingLevel);
  await setPiHostGlobalModelDefaultSlot({
    slot,
    provider,
    model,
    thinkingLevel,
  });
}

export async function removePiGlobalDefaultSlot(slot: number): Promise<void> {
  await removePiHostGlobalModelDefaultSlot(slot);
}

/**
 * Set only the top-level `defaultThinkingLevel` in the Mortise Agent settings.
 * without touching defaultProvider/defaultModel. This is the authoritative
 * SoT read by the pi subprocess; mortise's setDefaultThinkingLevel() mirrors
 * its value here so the subprocess picks it up immediately.
 */
export async function setPiGlobalDefaultThinkingLevel(level: string): Promise<void> {
  await setPiHostDefaultThinkingLevel(level);
}

// ===== Mortise agent runtime namespace (mortise.agent.*) =====
//
// Mortise-only UI/window preferences stay in ~/.mortise/state.sqlite. Runtime
// toggles that affect agent behavior live in the Mortise Agent settings under
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
// 扩展级 model/enabled/concurrency 统一存放在 Mortise Agent settings.json 的
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

export async function importPiExtension(
  sourcePath: string,
  options: { agentDir?: string; cwd?: string } = {},
): Promise<PiExtensionImportResult> {
  const source = resolve(sourcePath);
  const sourceStats = await stat(source).catch(() => null);
  if (!sourceStats) throw new Error('Selected extension source does not exist');
  if (!sourceStats.isDirectory() && (!sourceStats.isFile() || extname(source).toLowerCase() !== '.zip')) {
    throw new Error('Select an extension folder or a .zip package');
  }

  const agentDir = options.agentDir ?? getPiHostAgentDir();
  const managedRoot = managedExtensionRoot(agentDir);
  if (sourceStats.isDirectory() && (resolve(source) === resolve(managedRoot) || isPathInside(source, managedRoot))) {
    throw new Error('Select one extension package, not the Mortise Agent or managed extensions directory');
  }
  if (sourceStats.isFile() && sourceStats.size > MAX_EXTENSION_ARCHIVE_BYTES) {
    throw new Error('Extension ZIP is too large');
  }
  await mkdir(managedRoot, { recursive: true });
  const stagingRoot = join(managedRoot, `.install-${randomUUID()}`);
  await mkdir(stagingRoot, { recursive: true });

  try {
    if (sourceStats.isDirectory()) await cp(source, stagingRoot, { recursive: true });
    else await extractExtensionArchive(source, stagingRoot);

    const packageRoot = await locateImportRoot(stagingRoot);
    const metadata = await readImportManifest(packageRoot);
    const catalog = await getPiExtensionCatalog({ agentDir, cwd: options.cwd });
    const existingIds = new Set(catalog.extensions.map((entry) => entry.id));
    const duplicateId = metadata.extensionIds.find((id) => existingIds.has(id));
    if (duplicateId) throw new Error(`Extension ${duplicateId} is already installed`);

    const packageSlug = safePackageSlug(metadata.packageName, basename(source, extname(source)));
    const destination = join(managedRoot, packageSlug);
    if (existsSync(destination)) throw new Error(`Extension package ${packageSlug} is already installed`);

    if (resolve(packageRoot) === resolve(stagingRoot)) {
      await rename(stagingRoot, destination);
    } else {
      await cp(packageRoot, destination, { recursive: true });
      await rm(stagingRoot, { recursive: true, force: true });
    }

    const settingsManager = SettingsManager.create(options.cwd ?? process.cwd(), agentDir, MORTISE_PROJECT_DIR);
    const previousPaths = settingsManager.getExtensionPaths();
    const relativePackagePath = `./${relative(agentDir, destination).split(sep).join('/')}`;
    try {
      await persistGlobalExtensionPaths(settingsManager, [
        ...previousPaths,
        { id: `managed-${safePackageSlug(metadata.extensionIds[0]!, 'extension')}`, path: relativePackagePath },
      ]);
    } catch (error) {
      await rm(destination, { recursive: true, force: true });
      throw error;
    }

    return { ...metadata, installedPath: destination };
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function uninstallPiExtension(
  extensionId: string,
  options: { agentDir?: string; cwd?: string } = {},
): Promise<PiExtensionUninstallResult> {
  const agentDir = options.agentDir ?? getPiHostAgentDir();
  const managedRoot = managedExtensionRoot(agentDir);
  const catalog = await getPiExtensionCatalog({ agentDir, cwd: options.cwd });
  const extension = catalog.extensions.find((entry) => entry.id === extensionId);
  if (!extension) throw new Error(`Unknown extension: ${extensionId}`);
  if (!extension.uninstallable) throw new Error('Only extensions imported into Mortise can be uninstalled here');

  const rel = relative(managedRoot, resolve(extension.resolvedPath));
  const packageSegment = rel.split(sep)[0];
  if (!packageSegment || packageSegment === '..') throw new Error('Managed extension package could not be resolved');
  const packageRoot = join(managedRoot, packageSegment);
  if (!isPathInside(managedRoot, packageRoot)) throw new Error('Managed extension package path is invalid');
  const metadata = await readImportManifest(packageRoot);

  const settingsManager = SettingsManager.create(options.cwd ?? process.cwd(), agentDir, MORTISE_PROJECT_DIR);
  const previousPaths = settingsManager.getExtensionPaths();
  const nextPaths = previousPaths.filter((entry) => {
    if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string') return true;
    return resolve(agentDir, entry.path) !== resolve(packageRoot);
  });
  if (nextPaths.length === previousPaths.length) throw new Error('Managed extension declaration is missing');

  await persistGlobalExtensionPaths(settingsManager, nextPaths);
  try {
    await rm(packageRoot, { recursive: true });
  } catch (error) {
    await persistGlobalExtensionPaths(settingsManager, previousPaths).catch(() => undefined);
    throw error;
  }
  return metadata;
}

const frontendAssetRevisions = new Map<string, { fingerprint: string; revision: number }>();

function frontendAssetRevision(extensionId: string, frontendId: string, root: string, assets: string[]): number {
  const fingerprint = assets.map((asset) => {
    try {
      const info = statSync(resolve(root, asset));
      return `${asset}:${info.mtimeMs}:${info.size}`;
    } catch {
      return `${asset}:missing`;
    }
  }).join('|');
  const key = `${extensionId}\0${frontendId}\0${root}`;
  const previous = frontendAssetRevisions.get(key);
  if (previous?.fingerprint === fingerprint) return previous.revision;
  const revision = (previous?.revision ?? 0) + 1;
  frontendAssetRevisions.set(key, { fingerprint, revision });
  return revision;
}

function extensionFrontendDevServer(extensionId: string): URL | undefined {
  const raw = process.env.MORTISE_EXTENSION_UI_DEV_SERVERS;
  if (!raw) return undefined;
  try {
    const value = (JSON.parse(raw) as Record<string, unknown>)[extensionId];
    if (typeof value !== 'string') return undefined;
    const url = new URL(value.endsWith('/') ? value : `${value}/`);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

/**
 * 读取 Pi 扩展 catalog。扩展发现、metadata、enabled/config 均来自 Pi host facade；
 * Mortise 只把结果作为设置 UI 的展示 DTO。
 */
export async function getPiExtensionCatalog(options: { cwd?: string; agentDir?: string; bundledExtensionPaths?: string[] } = {}): Promise<PiExtensionCatalogResult> {
  const cwd = options.cwd ?? process.cwd();
  const agentDir = options.agentDir ?? getPiHostAgentDir();
  try {
    const settingsManager = SettingsManager.create(cwd, agentDir, MORTISE_PROJECT_DIR);
    const resourceResolver = new ResourceResolver({
      cwd,
      agentDir,
      projectConfigDir: MORTISE_PROJECT_DIR,
      settingsManager,
    });
    const result = await resourceResolver.resolveRaw();
    const bundledExtensionPaths = options.bundledExtensionPaths
      ?? [process.env.MORTISE_BUNDLED_PI_EXTENSIONS_PATH].filter(
        (value): value is string => Boolean(value && existsSync(value)),
      );
    const bundled = bundledExtensionPaths.length > 0
      ? await resourceResolver.resolveExtensionSources(bundledExtensionPaths, { resolveGraph: false })
      : { extensions: [] };
    const mergedExtensions = resourceResolver.resolveExtensionManifestGraph([
      ...bundled.extensions,
      ...result.extensions,
    ]);
    const seenExtensionIds = new Set<string>();
    const extensions = mergedExtensions.filter((resource) => {
      const id = resource.metadata.extensionId;
      if (!id || seenExtensionIds.has(id)) return false;
      seenExtensionIds.add(id);
      return true;
    });
    const catalogResult: PiExtensionCatalogResult = {
      // PackageManager deliberately retains disabled resources. Loading the
      // runtime (and the host facade catalog built on it) filters them out.
      extensions: extensions
        .filter((resource) => resource.metadata.extensionId)
        .map((resource): PiExtensionCatalogEntry => {
          const id = resource.metadata.extensionId!;
          const metadata = resource.metadata as typeof resource.metadata & {
            extensionManifest?: PiExtensionCatalogEntry['manifest'];
            extensionManifestStatus?: PiExtensionCatalogEntry['manifestStatus'];
            extensionManifestDiagnostics?: PiExtensionCatalogEntry['manifestDiagnostics'];
            extensionLoadable?: boolean;
            extensionFrontendLoadable?: PiExtensionCatalogEntry['frontendLoadable'];
            extensionFrontendDiagnostics?: PiExtensionCatalogEntry['frontendDiagnostics'];
          };
          const ui = metadata.extensionUI as PiExtensionCatalogEntry['ui'];
          const manifest = metadata.extensionManifest;
          const config = settingsManager.getExtensionConfig(id) as Record<string, unknown> | undefined;
          const resolvedPath = resolve(resource.path);
          const extensionRoot = dirname(resolvedPath);
          const devServer = extensionFrontendDevServer(id);
          const frontendDescriptors = ui?.schemaVersion === 2
            ? (ui.frontends ?? [])
              .filter((frontend) => !metadata.extensionFrontendDiagnostics?.some((diagnostic) =>
                diagnostic.severity === 'error' && (diagnostic.frontendId === undefined || diagnostic.frontendId === frontend.id)))
              .map((frontend) => ({
                schemaVersion: 2 as const,
                extensionId: id,
                frontendId: frontend.id,
                entryUrl: devServer
                  ? new URL(frontend.entry.slice(2), devServer).toString()
                  : `mortise-extension://frontend/${encodeURIComponent(id)}/${encodeURIComponent(frontend.id)}/entry`,
                styleUrls: (frontend.styles ?? []).map((style, index) => devServer
                  ? new URL(style.slice(2), devServer).toString()
                  : `mortise-extension://frontend/${encodeURIComponent(id)}/${encodeURIComponent(frontend.id)}/style/${index}`),
                surface: frontend.surface,
                mode: frontend.mode,
                scope: frontend.scope,
                revision: frontendAssetRevision(id, frontend.id, extensionRoot, [frontend.entry, ...(frontend.styles ?? [])]),
                title: ui.title,
                page: frontend.page,
              }))
            : undefined;
          const moduleDescriptors = ui?.schemaVersion === 2
            ? (ui.modules ?? []).map((module) => ({
              schemaVersion: 2 as const,
              extensionId: id,
              moduleId: module.id,
              entryUrl: devServer
                ? new URL(module.entry.slice(2), devServer).toString()
                : `mortise-extension://module/${encodeURIComponent(id)}/${encodeURIComponent(module.id)}/entry`,
              styleUrls: (module.styles ?? []).map((style, index) => devServer
                ? new URL(style.slice(2), devServer).toString()
                : `mortise-extension://module/${encodeURIComponent(id)}/${encodeURIComponent(module.id)}/style/${index}`),
              apiVersion: module.apiVersion,
              revision: frontendAssetRevision(id, `module:${module.id}`, extensionRoot, [module.entry, ...(module.styles ?? [])]),
            }))
            : undefined;
          const overrideDescriptors = ui?.schemaVersion === 2
            ? (ui.overrides ?? []).map((override) => ({
              schemaVersion: 2 as const,
              extensionId: id,
              overrideId: override.id,
              target: override.target,
              mode: override.mode,
              entryUrl: devServer
                ? new URL(override.entry.slice(2), devServer).toString()
                : `mortise-extension://override/${encodeURIComponent(id)}/${encodeURIComponent(override.id)}/entry`,
              styleUrls: (override.styles ?? []).map((style, index) => devServer
                ? new URL(style.slice(2), devServer).toString()
                : `mortise-extension://override/${encodeURIComponent(id)}/${encodeURIComponent(override.id)}/style/${index}`),
              revision: frontendAssetRevision(id, `override:${override.id}`, extensionRoot, [override.entry, ...(override.styles ?? [])]),
            }))
            : undefined;
          return {
            id,
            loaded: false,
            title: ui?.title ?? manifest?.name ?? id,
            description: ui?.description ?? manifest?.description ?? '',
            category: ui?.category ?? 'other',
            configurable: ui?.schemaVersion === 1
              && (Boolean(ui.settings?.page) || (ui.settings?.fields.length ?? 0) > 0),
            manifest,
            manifestStatus: metadata.extensionManifestStatus ?? 'legacy',
            manifestDiagnostics: metadata.extensionManifestDiagnostics ?? [],
            capabilityBindings: metadata.extensionCapabilityBindings ?? [],
            loadable: metadata.extensionLoadable ?? resource.enabled,
            ui,
            frontendLoadable: metadata.extensionFrontendLoadable,
            frontendDiagnostics: metadata.extensionFrontendDiagnostics,
            frontendDescriptors,
            moduleDescriptors,
            overrideDescriptors,
            enabled: config?.enabled === undefined ? true : config.enabled !== false,
            path: resource.path,
            resolvedPath,
            commands: [],
            tools: [],
            config,
            uninstallable: isPathInside(managedExtensionRoot(agentDir), resolvedPath),
          };
        }),
      errors: [],
    };
    return catalogResult;
  } catch (error) {
    return {
      extensions: [],
      errors: [{ path: '', error: error instanceof Error ? error.message : String(error) }],
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
  if (field.type === 'model-reference' && !/^current-session$|^default:[1-9]\d*$|^model:[^/]+\/.+$/.test(value)) return `${field.key} must be a valid model reference`;
  if ((field.type === 'string' || field.type === 'textarea') && field.minLength !== undefined && value.length < field.minLength) return `${field.key} is too short`;
  if ((field.type === 'string' || field.type === 'textarea') && field.maxLength !== undefined && value.length > field.maxLength) return `${field.key} is too long`;
  if (field.type === 'select' && !field.options.some((option) => option.value === value)) return `${field.key} must use a declared option`;
  return null;
}

export function validatePiExtensionConfigPatch(entry: PiExtensionCatalogEntry, patch: PiExtensionConfigPatch): { requiresReload: boolean } {
  if (patch.schemaVersion !== 1 || patch.extensionId !== entry.id) throw new Error('Extension config patch identity is invalid');
  const fields = new Map((entry.ui?.schemaVersion === 1 ? entry.ui.settings?.fields ?? [] : []).map((field) => [field.key, field]));
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
  const settingsManager = SettingsManager.create(
    options.cwd ?? process.cwd(),
    options.agentDir ?? getPiHostAgentDir(),
    MORTISE_PROJECT_DIR,
  );
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
// mortise 全局开关等）存放在 Mortise Agent settings.json 的 `shellGui.<name>.*`
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
