/**
 * Stable host facade for GUI shells and embedders.
 *
 * Pi owns runtime/config/credential/session/resource storage. Host apps such as
 * Craft should use this facade (or the matching RPC commands), not raw
 * ~/.pi/agent file IO or copied Pi internals.
 */

import { randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getModels, getProviders } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai/types";
import lockfile from "proper-lockfile";
import { CONFIG_DIR_NAME, getAgentDir, getModelsPath, getSettingsPath } from "../config.ts";
import { parseFrontmatter } from "../utils/frontmatter.ts";
import { stripJsonComments } from "../utils/json.ts";
import type { AuthCredential, AuthStatus } from "./auth-storage.ts";
import { AuthStorage } from "./auth-storage.ts";
import type { ResourceDiagnostic } from "./diagnostics.ts";
import type {
	Extension,
	ExtensionActivation,
	ExtensionManifestUIV1,
	ExtensionSettingScalar,
} from "./extensions/types.ts";
import { ModelRegistry } from "./model-registry.ts";
import { DefaultPackageManager } from "./package-manager.ts";
import { BUILT_IN_PROVIDER_DISPLAY_NAMES } from "./provider-display-names.ts";
import { DefaultResourceLoader } from "./resource-loader.ts";
import {
	type SessionContext,
	type SessionEntry,
	type SessionHeader,
	type SessionInfo,
	SessionManager,
	type SessionTreeNode,
} from "./session-manager.ts";
import {
	type ExtensionNamespaceSettings,
	type Settings,
	SettingsManager,
	type ShellGuiNamespaceSettings,
} from "./settings-manager.ts";
import { loadSkills, type Skill } from "./skills.ts";
import { createSourceInfo, type SourceInfo } from "./source-info.ts";

export { SessionManager };

export type HostThinkingLevel = ThinkingLevel;
export type HostErrorKind =
	| "invalid_input"
	| "config_parse"
	| "config_write"
	| "auth"
	| "session"
	| "resource"
	| "unknown";

export interface HostErrorPayload {
	errorKind: HostErrorKind;
	userMessage: string;
	recoverable: boolean;
	message: string;
}

export class HostFacadeError extends Error {
	readonly errorKind: HostErrorKind;
	readonly userMessage: string;
	readonly recoverable: boolean;

	constructor(kind: HostErrorKind, message: string, options: { userMessage?: string; recoverable?: boolean } = {}) {
		super(message);
		this.name = "HostFacadeError";
		this.errorKind = kind;
		this.userMessage = options.userMessage ?? message;
		this.recoverable = options.recoverable ?? kind !== "config_parse";
	}

	toPayload(): HostErrorPayload {
		return {
			errorKind: this.errorKind,
			userMessage: this.userMessage,
			recoverable: this.recoverable,
			message: this.message,
		};
	}
}

export function toHostErrorPayload(error: unknown): HostErrorPayload {
	if (error instanceof HostFacadeError) return error.toPayload();
	const message = error instanceof Error ? error.message : String(error);
	return {
		errorKind: "unknown",
		userMessage: message,
		recoverable: true,
		message,
	};
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export interface HostGlobalModel {
	id: string;
	name?: string;
	api?: Api;
	baseUrl?: string;
	reasoning?: boolean;
	thinkingLevelMap?: Record<string, string | null>;
	input?: Array<"text" | "image">;
	cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
	contextWindow?: number;
	maxTokens?: number;
	headers?: Record<string, string>;
	compat?: Model<Api>["compat"];
	[key: string]: unknown;
}

export interface HostGlobalProvider {
	name?: string;
	baseUrl?: string;
	api?: Api;
	authHeader?: boolean;
	headers?: Record<string, string>;
	compat?: Model<Api>["compat"];
	models?: HostGlobalModel[];
	modelOverrides?: Record<string, Record<string, unknown>>;
	[key: string]: unknown;
}

export interface HostGlobalModelsFile {
	providers?: Record<string, HostGlobalProvider>;
	/** Host-owned metadata; Pi ModelRegistry ignores unknown top-level fields. */
	craftConnections?: unknown[];
	[key: string]: unknown;
}

export interface HostGlobalProviderForDisplay {
	key: string;
	label: string;
	provider: HostGlobalProvider;
	apiKeyMasked: string;
	modelCount: number;
	authStatus: AuthStatus;
}

export interface HostModelCatalogModel {
	id: string;
	name: string;
	shortName: string;
	provider: string;
	baseUrl?: string;
	api?: Api;
	contextWindow: number;
	maxTokens?: number;
	reasoning: boolean;
	input?: Array<"text" | "image">;
	cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
	thinkingLevelMap?: Record<string, string | null>;
}

export interface HostModelCatalogProvider {
	key: string;
	label: string;
	placeholder: string;
	baseUrl?: string;
	models: HostModelCatalogModel[];
}

export interface HostModelCatalog {
	providers: HostModelCatalogProvider[];
	apiKeyProviders: Array<Pick<HostModelCatalogProvider, "key" | "label" | "placeholder">>;
}

export interface HostGlobalConfig {
	models: HostGlobalModelsFile;
	providers: Record<string, HostGlobalProvider>;
	settings: Settings;
	providersForDisplay: HostGlobalProviderForDisplay[];
	craftConnections: unknown[];
}

export interface HostApiKeyMigrationResult {
	migrated: number;
	removedFromModels: number;
	changed: boolean;
}

export interface HostSessionProjection {
	path?: string;
	sessionDir: string;
	id: string;
	cwd: string;
	name?: string;
	leafId: string | null;
	header: SessionHeader | null;
	entries: SessionEntry[];
	tree: SessionTreeNode[];
	context: SessionContext;
	messages: SessionContext["messages"];
}

export interface HostSkillSummary {
	slug: string;
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	sourceInfo: SourceInfo;
	disableModelInvocation: boolean;
	frontmatter: Record<string, unknown>;
	body: string;
	iconPath?: string;
}

export interface HostResolvedSkill extends HostSkillSummary {
	content: string;
}

export interface HostSkillsResult {
	skills: HostSkillSummary[];
	skillRoots: string[];
	diagnostics: ResourceDiagnostic[];
}

export type HostExtensionCategory =
	| "ui"
	| "automation"
	| "agent"
	| "shell"
	| "diagnostics"
	| "memory"
	| "search"
	| "other";

export interface HostExtensionSummary {
	id: string;
	target: "pi" | "craft";
	loaded: boolean;
	title: string;
	description: string;
	category: HostExtensionCategory;
	configurable: boolean;
	ui?: ExtensionManifestUIV1;
	path: string;
	resolvedPath: string;
	activation: ExtensionActivation;
	sourceInfo: SourceInfo;
	commands: string[];
	tools: string[];
	flags: string[];
	shortcuts: string[];
	config?: ExtensionNamespaceSettings;
	enabled: boolean;
}

export interface HostExtensionsResult {
	extensions: HostExtensionSummary[];
	errors: Array<{ path: string; error: string; target: "pi" | "craft" }>;
}

const VALID_THINKING_LEVELS: HostThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const MODELS_FILE_FALLBACK: HostGlobalModelsFile = { providers: {} };
const SETTINGS_FILE_FALLBACK: Settings = {};
const MODEL_ID_PREFIX = "pi/";
const EXCLUDED_MODEL_IDS = new Set([
	"gemini-1.5-flash",
	"gemini-1.5-flash-8b",
	"gemini-1.5-pro",
	"gemini-2.0-flash",
	"gemini-2.0-flash-lite",
	"codex-mini-latest",
]);
const EXCLUDED_MODEL_PREFIXES = ["gpt-4"];
const EXCLUDED_API_KEY_PROVIDERS = new Set(["github-copilot", "openai-codex", "google-vertex"]);
const PROVIDER_PLACEHOLDERS: Record<string, string> = {
	anthropic: "sk-ant-...",
	google: "AIza...",
	openai: "sk-...",
	openrouter: "sk-or-...",
	groq: "gsk_...",
	deepseek: "sk-...",
	xai: "xai-...",
	cerebras: "csk-...",
	"amazon-bedrock": "AKIA...",
	huggingface: "hf_...",
	"kimi-coding": "sk-kimi-...",
};

function clone<T>(value: T): T {
	return structuredClone(value);
}

function ensureParentDir(filePath: string): void {
	const dir = dirname(filePath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	}
}

function ensureJsonFile(filePath: string, fallback: unknown): void {
	ensureParentDir(filePath);
	if (!existsSync(filePath)) {
		writeFileSync(filePath, `${JSON.stringify(fallback, null, 2)}\n`, "utf-8");
		try {
			chmodSync(filePath, 0o600);
		} catch {
			// Best-effort on platforms/filesystems that do not support chmod.
		}
	}
}

function atomicWriteJsonFile(filePath: string, value: unknown): void {
	ensureParentDir(filePath);
	const tempPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}.tmp`;
	writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
	try {
		renameSync(tempPath, filePath);
		try {
			chmodSync(filePath, 0o600);
		} catch {
			// Best-effort.
		}
	} catch (error) {
		rmSync(tempPath, { force: true });
		throw error;
	}
}

function parseJsonFile<T>(
	filePath: string,
	fallback: T,
	normalize: (value: unknown) => T,
	options: { create?: boolean } = {},
): T {
	if (!existsSync(filePath)) {
		if (options.create) ensureJsonFile(filePath, fallback);
		return clone(fallback);
	}
	try {
		return normalize(JSON.parse(stripJsonComments(readFileSync(filePath, "utf-8"))));
	} catch (error) {
		throw new HostFacadeError(
			"config_parse",
			`Failed to parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
			{ recoverable: false },
		);
	}
}

function withJsonFileLock<TFile, TResult>(
	filePath: string,
	fallback: TFile,
	normalize: (value: unknown) => TFile,
	fn: (file: TFile) => TResult | { result: TResult; next?: TFile } | false | undefined,
): TResult {
	ensureJsonFile(filePath, fallback);
	let release: (() => void) | undefined;
	try {
		release = lockfile.lockSync(filePath, { realpath: false, stale: 30_000 });
		const file = parseJsonFile(filePath, fallback, normalize);
		const output = fn(file);
		if (output === false) return undefined as TResult;
		if (output && typeof output === "object" && "result" in output) {
			const next = (output as { next?: TFile }).next;
			atomicWriteJsonFile(filePath, next ?? file);
			return (output as { result: TResult }).result;
		}
		if (output !== undefined) return output as TResult;
		atomicWriteJsonFile(filePath, file);
		return undefined as TResult;
	} catch (error) {
		if (error instanceof HostFacadeError) throw error;
		throw new HostFacadeError(
			"config_write",
			`Failed to update ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	} finally {
		release?.();
	}
}

function normalizeModelsFile(value: unknown): HostGlobalModelsFile {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("models.json root must be an object");
	}
	const file = value as HostGlobalModelsFile;
	if (!file.providers || typeof file.providers !== "object" || Array.isArray(file.providers)) {
		file.providers = {};
	}
	return file;
}

function normalizeSettingsFile(value: unknown): Settings {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("settings.json root must be an object");
	}
	return value as Settings;
}

function modelsPath(): string {
	return getModelsPath();
}

function settingsPath(): string {
	return getSettingsPath();
}

function createSettingsManager(cwd = process.cwd()): SettingsManager {
	return SettingsManager.create(cwd, getAgentDir());
}

function createAuthStorage(): AuthStorage {
	return AuthStorage.create();
}

function createModelRegistry(): ModelRegistry {
	return ModelRegistry.create(createAuthStorage());
}

function isValidProviderKey(key: string): boolean {
	return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key);
}

function assertProviderKey(key: string): void {
	if (!isValidProviderKey(key)) {
		throw new HostFacadeError("invalid_input", `Invalid provider key: ${key} (must be lowercase slug a-z0-9-)`);
	}
}

function normalizeApiKeyInput(apiKey: string | undefined): string | undefined {
	const trimmed = apiKey?.trim();
	if (!trimmed || trimmed.includes("••")) return undefined;
	return trimmed;
}

function sanitizeProvider(provider: HostGlobalProvider): HostGlobalProvider {
	const { apiKey: _apiKey, ...rest } = provider as HostGlobalProvider & { apiKey?: unknown };
	return rest;
}

export function isDeprecatedClaudeOpus46Model(modelId: string): boolean {
	const lower = modelId.toLowerCase().replace(/^pi\//, "");
	return (
		lower === "claude-opus-4-6" ||
		lower === "claude-opus-4.6" ||
		lower === "anthropic/claude-opus-4-6" ||
		lower === "anthropic/claude-opus-4.6" ||
		lower.endsWith(".anthropic.claude-opus-4-6-v1") ||
		lower === "anthropic.claude-opus-4-6-v1"
	);
}

function isExcludedCatalogModel(provider: string, modelId: string): boolean {
	if (EXCLUDED_MODEL_IDS.has(modelId)) return true;
	if (isDeprecatedClaudeOpus46Model(modelId)) return true;
	if (EXCLUDED_MODEL_PREFIXES.some((prefix) => modelId.startsWith(prefix))) return true;
	return provider === "amazon-bedrock" && modelId.startsWith("anthropic.claude-");
}

function formatProviderName(key: string): string {
	return key
		.split("-")
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ");
}

function getProviderPlaceholder(key: string): string {
	return PROVIDER_PLACEHOLDERS[key] ?? "Paste your key here...";
}

function toCatalogModel(model: Model<Api>): HostModelCatalogModel {
	const lastPart = model.name.split(/[\s-]/).pop() ?? model.name;
	return {
		id: model.id.startsWith(MODEL_ID_PREFIX) ? model.id : `${MODEL_ID_PREFIX}${model.id}`,
		name: model.name,
		shortName: model.name.length > 20 ? lastPart : model.name,
		provider: model.provider,
		baseUrl: model.baseUrl,
		api: model.api,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		reasoning: model.reasoning,
		input: model.input,
		cost: model.cost,
		thinkingLevelMap: model.thinkingLevelMap,
	};
}

function getProviderLabel(key: string): string {
	return BUILT_IN_PROVIDER_DISPLAY_NAMES[key] ?? formatProviderName(key);
}

export function getModelCatalog(args: { provider?: string } = {}): HostModelCatalog {
	const providerKeys = args.provider ? [args.provider] : getProviders();
	const providers = providerKeys
		.map((key): HostModelCatalogProvider | null => {
			const models = getModels(key as Parameters<typeof getModels>[0])
				.filter((model) => !isExcludedCatalogModel(key, model.id))
				.map(toCatalogModel);
			if (models.length === 0) return null;
			return {
				key,
				label: getProviderLabel(key),
				placeholder: getProviderPlaceholder(key),
				baseUrl: models[0]?.baseUrl,
				models,
			};
		})
		.filter((provider): provider is HostModelCatalogProvider => provider !== null)
		.sort((a, b) => {
			const priority = ["anthropic", "google", "openai"];
			const ai = priority.indexOf(a.key);
			const bi = priority.indexOf(b.key);
			if (ai !== -1 && bi !== -1) return ai - bi;
			if (ai !== -1) return -1;
			if (bi !== -1) return 1;
			return a.label.localeCompare(b.label);
		});

	return {
		providers,
		apiKeyProviders: providers
			.filter((provider) => !EXCLUDED_API_KEY_PROVIDERS.has(provider.key))
			.map(({ key, label, placeholder }) => ({ key, label, placeholder })),
	};
}

export function normalizeHostThinkingLevel(level: string | undefined): HostThinkingLevel | undefined {
	if (level === undefined) return undefined;
	const normalized = level === "max" ? "xhigh" : level;
	if (!VALID_THINKING_LEVELS.includes(normalized as HostThinkingLevel)) {
		throw new HostFacadeError(
			"invalid_input",
			`Invalid thinking level: ${level}. Expected one of ${VALID_THINKING_LEVELS.join(", ")}.`,
		);
	}
	return normalized as HostThinkingLevel;
}

export function maskApiKey(key: string | undefined): string {
	if (!key) return "";
	if (key.length <= 15) return "••••••••";
	return `${key.slice(0, 7)}...${key.slice(-4)}`;
}

export function readGlobalModelsFile(): HostGlobalModelsFile {
	return parseJsonFile(modelsPath(), MODELS_FILE_FALLBACK, normalizeModelsFile);
}

export function readGlobalProviders(): Record<string, HostGlobalProvider> {
	return readGlobalModelsFile().providers ?? {};
}

export function readCraftLlmConnections<T = unknown>(): T[] {
	const connections = readGlobalModelsFile().craftConnections;
	return Array.isArray(connections) ? (connections as T[]) : [];
}

export function writeCraftLlmConnections(connections: unknown[]): void {
	withJsonFileLock(modelsPath(), MODELS_FILE_FALLBACK, normalizeModelsFile, (file) => {
		file.providers ??= {};
		file.craftConnections = connections;
	});
}

export function upsertCraftLlmConnection(connection: { slug: string; [key: string]: unknown }): void {
	withJsonFileLock(modelsPath(), MODELS_FILE_FALLBACK, normalizeModelsFile, (file) => {
		const connections = Array.isArray(file.craftConnections) ? file.craftConnections : [];
		const index = connections.findIndex((item) => {
			return !!item && typeof item === "object" && (item as { slug?: unknown }).slug === connection.slug;
		});
		file.craftConnections =
			index === -1
				? [...connections, connection]
				: connections.map((existing, existingIndex) => (existingIndex === index ? connection : existing));
	});
}

export function deleteCraftLlmConnection(slug: string): boolean {
	return withJsonFileLock(modelsPath(), MODELS_FILE_FALLBACK, normalizeModelsFile, (file) => {
		const connections = Array.isArray(file.craftConnections) ? file.craftConnections : [];
		const next = connections.filter((item) => {
			return !item || typeof item !== "object" || (item as { slug?: unknown }).slug !== slug;
		});
		if (next.length === connections.length) return false;
		file.craftConnections = next;
		return { result: true };
	});
}

export function readGlobalSettings(): Settings {
	return parseJsonFile(settingsPath(), SETTINGS_FILE_FALLBACK, normalizeSettingsFile);
}

export function readGlobalCredential(provider: string): AuthCredential | undefined {
	return createAuthStorage().get(provider);
}

export function readGlobalAuthFile(): Record<string, AuthCredential> {
	return createAuthStorage().getAll();
}

export function readGlobalApiKey(provider: string): string | undefined {
	const credential = readGlobalCredential(provider);
	if (credential?.type === "api_key" && typeof credential.key === "string" && credential.key.trim()) {
		return credential.key;
	}
	return undefined;
}

export function hasGlobalProviderAuth(provider: string | undefined): boolean {
	if (!provider) return false;
	const authStorage = createAuthStorage();
	if (authStorage.hasAuth(provider)) return true;
	return createModelRegistry().getProviderAuthStatus(provider).configured;
}

export function readGlobalProvidersForDisplay(): HostGlobalProviderForDisplay[] {
	const providers = readGlobalProviders();
	const registry = createModelRegistry();
	return Object.entries(providers)
		.map(([key, provider]) => ({
			key,
			label:
				typeof provider.name === "string" && provider.name.trim()
					? provider.name.trim()
					: registry.getProviderDisplayName(key),
			provider: sanitizeProvider(provider),
			apiKeyMasked: maskApiKey(readGlobalApiKey(key)),
			modelCount: provider.models?.length ?? 0,
			authStatus: registry.getProviderAuthStatus(key),
		}))
		.sort((a, b) => a.key.localeCompare(b.key));
}

export function getGlobalConfig(): HostGlobalConfig {
	const models = readGlobalModelsFile();
	const settings = readGlobalSettings();
	return {
		models,
		providers: models.providers ?? {},
		settings,
		providersForDisplay: readGlobalProvidersForDisplay(),
		craftConnections: Array.isArray(models.craftConnections) ? models.craftConnections : [],
	};
}

export function setGlobalApiKey(provider: string, apiKey: string): void {
	assertProviderKey(provider);
	createAuthStorage().set(provider, { type: "api_key", key: apiKey });
}

export function deleteGlobalApiKey(provider: string): void {
	assertProviderKey(provider);
	createAuthStorage().remove(provider);
}

function shouldPreserveExistingAuthCredential(value: AuthCredential | undefined): boolean {
	if (!value) return false;
	if (value.type !== "api_key") return true;
	return typeof value.key === "string" && value.key.trim().length > 0;
}

export function migrateGlobalProviderApiKeysToAuth(): HostApiKeyMigrationResult {
	const legacyApiKeys = new Map<string, string>();
	withJsonFileLock(modelsPath(), MODELS_FILE_FALLBACK, normalizeModelsFile, (file) => {
		for (const [key, provider] of Object.entries(file.providers ?? {})) {
			const apiKey = normalizeApiKeyInput((provider as HostGlobalProvider & { apiKey?: string }).apiKey);
			if (apiKey) legacyApiKeys.set(key, apiKey);
		}
		return false;
	});

	if (legacyApiKeys.size === 0) {
		return { migrated: 0, removedFromModels: 0, changed: false };
	}

	const authStorage = createAuthStorage();
	let migrated = 0;
	for (const [key, apiKey] of legacyApiKeys) {
		if (shouldPreserveExistingAuthCredential(authStorage.get(key))) continue;
		authStorage.set(key, { type: "api_key", key: apiKey });
		migrated++;
	}

	let removedFromModels = 0;
	withJsonFileLock(modelsPath(), MODELS_FILE_FALLBACK, normalizeModelsFile, (file) => {
		for (const provider of Object.values(file.providers ?? {})) {
			if (!Object.hasOwn(provider, "apiKey")) continue;
			delete (provider as HostGlobalProvider & { apiKey?: unknown }).apiKey;
			removedFromModels++;
		}
	});

	return {
		migrated,
		removedFromModels,
		changed: migrated > 0 || removedFromModels > 0,
	};
}

export function saveGlobalProvider(args: { key: string; provider: HostGlobalProvider; apiKey?: string }): void {
	assertProviderKey(args.key);
	const legacyApiKey = normalizeApiKeyInput((args.provider as HostGlobalProvider & { apiKey?: string }).apiKey);
	const nextApiKey = normalizeApiKeyInput(args.apiKey) ?? legacyApiKey;
	if (nextApiKey) {
		setGlobalApiKey(args.key, nextApiKey);
	}

	withJsonFileLock(modelsPath(), MODELS_FILE_FALLBACK, normalizeModelsFile, (file) => {
		file.providers ??= {};
		file.providers[args.key] = sanitizeProvider(args.provider);
	});
}

export async function deleteGlobalProvider(key: string): Promise<void> {
	assertProviderKey(key);
	withJsonFileLock(modelsPath(), MODELS_FILE_FALLBACK, normalizeModelsFile, (file) => {
		if (!file.providers?.[key]) return false;
		delete file.providers[key];
	});
	deleteGlobalApiKey(key);

	withJsonFileLock(settingsPath(), SETTINGS_FILE_FALLBACK, normalizeSettingsFile, (settings) => {
		if (settings.defaultProvider !== key) return false;
		delete settings.defaultProvider;
		delete settings.defaultModel;
	});
}

export async function setGlobalDefault(args: {
	provider: string;
	model: string;
	thinkingLevel?: string;
	cwd?: string;
}): Promise<void> {
	if (args.provider === "custom-endpoint") {
		throw new HostFacadeError(
			"invalid_input",
			"Refusing to set 'custom-endpoint' as default provider; use a real provider key from models.json.",
		);
	}
	const thinkingLevel = normalizeHostThinkingLevel(args.thinkingLevel);
	const settings = createSettingsManager(args.cwd);
	settings.setDefaultModelAndProvider(args.provider, args.model);
	if (thinkingLevel !== undefined) {
		settings.setDefaultThinkingLevel(thinkingLevel);
	}
	await settings.flush();
	const errors = settings.drainErrors();
	if (errors.length > 0) {
		throw new HostFacadeError("config_write", errors.map((item) => item.error.message).join("; "));
	}
}

export async function setDefaultThinkingLevel(level: string, cwd?: string): Promise<void> {
	const thinkingLevel = normalizeHostThinkingLevel(level);
	if (thinkingLevel === undefined) {
		throw new HostFacadeError("invalid_input", "Thinking level is required.");
	}
	const settings = createSettingsManager(cwd);
	settings.setDefaultThinkingLevel(thinkingLevel);
	await settings.flush();
	const errors = settings.drainErrors();
	if (errors.length > 0) {
		throw new HostFacadeError("config_write", errors.map((item) => item.error.message).join("; "));
	}
}

export function readCraftAgentSettings(): Record<string, unknown> {
	const settings = readGlobalSettings() as Settings & { craft?: { agent?: Record<string, unknown> } };
	const agent = settings.craft?.agent;
	return agent && typeof agent === "object" ? { ...agent } : {};
}

export function writeCraftAgentSettingsBulk(updates: Record<string, unknown>): void {
	withJsonFileLock(settingsPath(), SETTINGS_FILE_FALLBACK, normalizeSettingsFile, (settings) => {
		const current = settings as Settings & { craft?: { agent?: Record<string, unknown> } };
		const craft = current.craft && typeof current.craft === "object" ? current.craft : {};
		const agent = craft.agent && typeof craft.agent === "object" ? craft.agent : {};
		current.craft = {
			...craft,
			agent: {
				...agent,
				...updates,
			},
		};
	});
}

export function readExtensionNamespace(): Record<string, ExtensionNamespaceSettings> {
	const settings = readGlobalSettings();
	return { ...(settings.extensionConfig ?? {}) };
}

export function readExtensionConfig(name: string): ExtensionNamespaceSettings {
	return readExtensionNamespace()[name] ?? {};
}

export async function setExtensionConfig(name: string, config: Record<string, unknown>): Promise<void> {
	const settings = createSettingsManager();
	settings.setExtensionConfig(name, config as Partial<ExtensionNamespaceSettings>);
	await settings.flush();
	const errors = settings.drainErrors();
	if (errors.length > 0) {
		throw new HostFacadeError("config_write", errors.map((item) => item.error.message).join("; "));
	}
}

export interface HostExtensionConfigPatchV1 {
	schemaVersion: 1;
	extensionId: string;
	set?: Record<string, ExtensionSettingScalar>;
	unset?: string[];
}

export async function patchExtensionConfig(patch: HostExtensionConfigPatchV1): Promise<Record<string, unknown>> {
	const current = { ...(readExtensionConfig(patch.extensionId) as Record<string, unknown>) };
	for (const [key, value] of Object.entries(patch.set ?? {})) current[key] = value;
	for (const key of patch.unset ?? []) delete current[key];
	const settings = createSettingsManager();
	settings.replaceExtensionConfig(patch.extensionId, current as ExtensionNamespaceSettings);
	return current;
}

export function readShellGuiNamespace(): Record<string, ShellGuiNamespaceSettings> {
	const settings = readGlobalSettings();
	const shellGui = settings.shellGui;
	return shellGui && typeof shellGui === "object" ? { ...shellGui } : {};
}

export function readShellGuiEntry(name: string): ShellGuiNamespaceSettings {
	return readShellGuiNamespace()[name] ?? {};
}

export async function setShellGuiEntry(name: string, value: ShellGuiNamespaceSettings): Promise<void> {
	const settings = createSettingsManager();
	settings.setShellGuiEntry(name, value);
	await settings.flush();
	const errors = settings.drainErrors();
	if (errors.length > 0) {
		throw new HostFacadeError("config_write", errors.map((item) => item.error.message).join("; "));
	}
}

export async function deleteShellGuiEntry(name: string): Promise<void> {
	const settings = createSettingsManager();
	settings.deleteShellGuiEntry(name);
	await settings.flush();
	const errors = settings.drainErrors();
	if (errors.length > 0) {
		throw new HostFacadeError("config_write", errors.map((item) => item.error.message).join("; "));
	}
}

export function setCraftCredential(slug: string, credential: unknown): void {
	createAuthStorage().setCraftCredential(slug, credential as AuthCredential);
}

export function getCraftCredential(slug: string): unknown {
	return createAuthStorage().getCraftCredential(slug);
}

export function deleteCraftCredential(slug: string): void {
	createAuthStorage().deleteCraftCredential(slug);
}

export function listCraftCredentialSlugs(): string[] {
	return createAuthStorage().listCraftSlugs();
}

export function deleteAllCraftCredentials(): void {
	createAuthStorage().deleteAllCraftCredentials();
}

function toSessionProjection(manager: SessionManager): HostSessionProjection {
	const context = manager.buildSessionContext();
	return {
		path: manager.getSessionFile(),
		sessionDir: manager.getSessionDir(),
		id: manager.getSessionId(),
		cwd: manager.getCwd(),
		name: manager.getSessionName(),
		leafId: manager.getLeafId(),
		header: manager.getHeader(),
		entries: manager.getEntries(),
		tree: manager.getTree(),
		context,
		messages: context.messages,
	};
}

export function getSessionProjection(args: {
	sessionPath: string;
	sessionDir?: string;
	cwdOverride?: string;
}): HostSessionProjection {
	try {
		return toSessionProjection(SessionManager.open(args.sessionPath, args.sessionDir, args.cwdOverride));
	} catch (error) {
		throw new HostFacadeError("session", error instanceof Error ? error.message : String(error));
	}
}

export function createSessionProjection(args: {
	cwd: string;
	sessionDir?: string;
	id?: string;
	metadata?: unknown;
}): HostSessionProjection {
	try {
		const manager = SessionManager.create(args.cwd, args.sessionDir, { id: args.id });
		if (args.metadata !== undefined && !isPlainRecord(args.metadata)) {
			throw new HostFacadeError("invalid_input", "Craft session metadata must be an object.");
		}
		manager.setCraftMetadata(args.metadata ?? {});
		return toSessionProjection(manager);
	} catch (error) {
		if (error instanceof HostFacadeError) throw error;
		throw new HostFacadeError("session", error instanceof Error ? error.message : String(error));
	}
}

export function setCraftSessionMetadata(args: {
	sessionPath: string;
	sessionDir?: string;
	cwdOverride?: string;
	name?: string;
	metadata?: unknown;
	customType?: string;
}): HostSessionProjection {
	try {
		const manager = SessionManager.open(args.sessionPath, args.sessionDir, args.cwdOverride);
		if (args.name !== undefined) {
			manager.appendSessionInfo(args.name);
		}
		if (args.metadata !== undefined) {
			if (!isPlainRecord(args.metadata)) {
				throw new HostFacadeError("invalid_input", "Craft session metadata must be an object.");
			}
			manager.setCraftMetadata(args.metadata);
			if (args.customType) {
				manager.appendCustomEntry(args.customType, args.metadata);
			}
		}
		return toSessionProjection(manager);
	} catch (error) {
		throw new HostFacadeError("session", error instanceof Error ? error.message : String(error));
	}
}

export function forkSession(args: {
	sourcePath: string;
	targetCwd: string;
	sessionDir?: string;
	id?: string;
	parentSession?: string;
}): HostSessionProjection {
	try {
		const manager = SessionManager.forkFrom(args.sourcePath, args.targetCwd, args.sessionDir, {
			id: args.id,
			parentSession: args.parentSession,
		});
		return toSessionProjection(manager);
	} catch (error) {
		throw new HostFacadeError("session", error instanceof Error ? error.message : String(error));
	}
}

export async function listSessions(args: { cwd?: string; sessionDir?: string } = {}): Promise<SessionInfo[]> {
	return SessionManager.list(args.cwd ?? process.cwd(), args.sessionDir);
}

export async function findSessionProjectionById(args: {
	cwd: string;
	sessionId: string;
	sessionDir?: string;
}): Promise<HostSessionProjection | null> {
	try {
		const sessions = await SessionManager.list(args.cwd, args.sessionDir);
		const direct = sessions.find((session) => session.id === args.sessionId);
		if (direct) {
			return getSessionProjection({
				sessionPath: direct.path,
				sessionDir: args.sessionDir,
				cwdOverride: args.cwd,
			});
		}

		for (const session of sessions) {
			const projection = getSessionProjection({
				sessionPath: session.path,
				sessionDir: args.sessionDir,
				cwdOverride: args.cwd,
			});
			const craftId = projection.header?.craft?.id;
			if (craftId === args.sessionId) {
				return projection;
			}
		}
		return null;
	} catch (error) {
		throw new HostFacadeError("session", error instanceof Error ? error.message : String(error));
	}
}

interface HostSkillsArgs {
	cwd?: string;
	agentDir?: string;
	skillPaths?: string[];
}

function getDefaultSkillRoots(args: { cwd?: string; agentDir?: string } = {}): { user: string; project: string } {
	const cwd = args.cwd ?? process.cwd();
	const agentDir = args.agentDir ?? getAgentDir();
	return {
		user: join(agentDir, "skills"),
		project: join(cwd, CONFIG_DIR_NAME, "skills"),
	};
}

function getSkillRoots(args: HostSkillsArgs = {}): string[] {
	const roots = getDefaultSkillRoots(args);
	return [roots.user, roots.project, ...(args.skillPaths ?? [])];
}

function findSkillIcon(baseDir: string): string | undefined {
	try {
		const icon = readdirSync(baseDir, { withFileTypes: true }).find((entry) => {
			return entry.isFile() && /^icon\.(svg|png|jpg|jpeg|webp)$/i.test(entry.name);
		});
		return icon ? join(baseDir, icon.name) : undefined;
	} catch {
		return undefined;
	}
}

function readSkillParts(filePath: string): { frontmatter: Record<string, unknown>; body: string } {
	try {
		return parseFrontmatter(readFileSync(filePath, "utf-8"));
	} catch {
		return { frontmatter: {}, body: "" };
	}
}

function skillSlug(skill: Skill): string {
	return basename(skill.filePath).toLowerCase() === "skill.md"
		? basename(skill.baseDir)
		: basename(skill.filePath, ".md");
}

function summarizeSkill(skill: Skill): HostSkillSummary {
	const { frontmatter, body } = readSkillParts(skill.filePath);
	return {
		slug: skillSlug(skill),
		name: skill.name,
		description: skill.description,
		filePath: skill.filePath,
		baseDir: skill.baseDir,
		sourceInfo: skill.sourceInfo,
		disableModelInvocation: skill.disableModelInvocation,
		frontmatter,
		body,
		iconPath: findSkillIcon(skill.baseDir),
	};
}

function dedupeHostSkillsBySlug(skills: HostSkillSummary[]): HostSkillSummary[] {
	const seen = new Set<string>();
	const deduped: HostSkillSummary[] = [];
	for (const skill of skills) {
		if (seen.has(skill.slug)) continue;
		seen.add(skill.slug);
		deduped.push(skill);
	}
	return deduped;
}

async function createHostResourceLoader(
	args: { cwd?: string; agentDir?: string; extensionTarget?: "pi" | "craft" } = {},
) {
	const cwd = args.cwd ?? process.cwd();
	const agentDir = args.agentDir ?? getAgentDir();
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		extensionTarget: args.extensionTarget ?? "craft",
	});
	await loader.reload({ phase: "full" });
	return loader;
}

export function listSkillsSync(args: HostSkillsArgs = {}): HostSkillsResult {
	const cwd = args.cwd ?? process.cwd();
	const agentDir = args.agentDir ?? getAgentDir();
	const skillRoots = getSkillRoots({ cwd, agentDir, skillPaths: args.skillPaths });
	const defaultRoots = getDefaultSkillRoots({ cwd, agentDir });
	try {
		const result = loadSkills({
			cwd,
			agentDir,
			// Host shells need project-local skills to override global skills, and
			// Craft keeps old sync helpers keyed by directory slug rather than
			// frontmatter display name. Use explicit roots so Pi remains the parser
			// while the facade owns host-facing precedence.
			skillPaths: [defaultRoots.project, defaultRoots.user, ...(args.skillPaths ?? [])],
			includeDefaults: false,
		});
		return {
			skills: dedupeHostSkillsBySlug(result.skills.map(summarizeSkill)),
			skillRoots,
			diagnostics: result.diagnostics,
		};
	} catch (error) {
		return {
			skills: [],
			skillRoots,
			diagnostics: [
				{
					type: "error",
					message: error instanceof Error ? error.message : String(error),
				} satisfies ResourceDiagnostic,
			],
		};
	}
}

export async function listSkills(args: HostSkillsArgs = {}): Promise<HostSkillsResult> {
	return listSkillsSync(args);
}

export async function resolveSkill(args: {
	name: string;
	cwd?: string;
	agentDir?: string;
	skillPaths?: string[];
}): Promise<HostResolvedSkill | null> {
	const result = await listSkills(args);
	const skill = result.skills.find(
		(candidate) => candidate.slug === args.name || candidate.name === args.name || candidate.filePath === args.name,
	);
	if (!skill) return null;
	try {
		return {
			...skill,
			content: readFileSync(skill.filePath, "utf-8"),
		};
	} catch (error) {
		throw new HostFacadeError("resource", error instanceof Error ? error.message : String(error));
	}
}

function summarizeExtension(extension: Extension): HostExtensionSummary {
	const id = extension.id;
	const manifestUI = extension.manifestUI;
	const config = readExtensionConfig(id);
	const enabled = config?.enabled === undefined ? true : config.enabled !== false;
	return {
		id,
		target: extension.target,
		loaded: true,
		title: manifestUI?.title ?? id,
		description: manifestUI?.description ?? "",
		category: manifestUI?.category ?? "other",
		configurable: (manifestUI?.settings?.fields.length ?? 0) > 0,
		ui: manifestUI,
		path: extension.path,
		resolvedPath: extension.resolvedPath,
		activation: extension.activation,
		sourceInfo: extension.sourceInfo,
		commands: Array.from(extension.commands.keys()).sort(),
		tools: Array.from(extension.tools.keys()).sort(),
		flags: Array.from(extension.flags.keys()).sort(),
		shortcuts: Array.from(extension.shortcuts.keys()).map(String).sort(),
		config,
		enabled,
	};
}

export async function getExtensions(
	args: { cwd?: string; agentDir?: string; extensionTarget?: "pi" | "craft" } = {},
): Promise<HostExtensionsResult> {
	try {
		const loader = await createHostResourceLoader(args);
		const result = loader.getExtensions();
		return {
			extensions: result.extensions.map(summarizeExtension),
			errors: result.errors.map((item) => ({ ...item, target: args.extensionTarget ?? "craft" })),
		};
	} catch (error) {
		return {
			extensions: [],
			errors: [
				{
					path: "",
					error: error instanceof Error ? error.message : String(error),
					target: args.extensionTarget ?? "craft",
				},
			],
		};
	}
}

export async function getExtensionCatalog(
	args: { cwd?: string; agentDir?: string; extensionTarget?: "pi" | "craft" } = {},
): Promise<HostExtensionsResult> {
	const cwd = args.cwd ?? process.cwd();
	const agentDir = args.agentDir ?? getAgentDir();
	const target = args.extensionTarget ?? "craft";
	try {
		const packageManager = new DefaultPackageManager({
			cwd,
			agentDir,
			settingsManager: SettingsManager.create(cwd, agentDir),
			extensionTarget: target,
		});
		const resolved = await packageManager.resolve();
		return {
			extensions: resolved.extensions
				.filter((resource) => resource.enabled && resource.metadata.extensionId)
				.map((resource) => {
					const id = resource.metadata.extensionId!;
					const manifestUI = resource.metadata.extensionUI;
					const config = readExtensionConfig(id);
					return {
						id,
						target,
						loaded: false,
						title: manifestUI?.title ?? id,
						description: manifestUI?.description ?? "",
						category: manifestUI?.category ?? "other",
						configurable: (manifestUI?.settings?.fields.length ?? 0) > 0,
						ui: manifestUI,
						path: resource.path,
						resolvedPath: resource.path,
						activation: resource.metadata.activation ?? "beforeFirstRequest",
						sourceInfo: createSourceInfo(resource.path, resource.metadata),
						commands: [],
						tools: [],
						flags: [],
						shortcuts: [],
						config,
						enabled: config?.enabled === undefined ? true : config.enabled !== false,
					};
				}),
			errors: [],
		};
	} catch (error) {
		return {
			extensions: [],
			errors: [{ path: "", error: error instanceof Error ? error.message : String(error), target }],
		};
	}
}
