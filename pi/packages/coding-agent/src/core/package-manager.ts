import type { ChildProcess, ChildProcessByStdio } from "node:child_process";
import { createHash } from "node:crypto";
import {
	type Dirent,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";

function getEnv(): NodeJS.ProcessEnv {
	if (process.platform !== "linux" || Object.keys(process.env).length > 0) {
		return process.env;
	}
	try {
		const data = readFileSync("/proc/self/environ", "utf-8");
		const env: NodeJS.ProcessEnv = {};
		for (const entry of data.split("\0")) {
			const idx = entry.indexOf("=");
			if (idx > 0) {
				env[entry.slice(0, idx)] = entry.slice(idx + 1);
			}
		}
		return env;
	} catch {
		return process.env;
	}
}

import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import ignore from "ignore";
import { minimatch } from "minimatch";
import { satisfies } from "semver";
import { CONFIG_DIR_NAME, VERSION } from "../config.ts";
import { spawnProcess, spawnProcessSync } from "../utils/child-process.ts";
import { type GitSource, parseGitUrl } from "../utils/git.ts";
import { canonicalizePath, isLocalPath, markPathIgnoredByCloudSync, resolvePath } from "../utils/paths.ts";
import {
	assertValidExtensionManifest,
	type ExtensionManifestDiagnostic,
	type ExtensionManifestStatus,
	type ExtensionManifestV1,
	isExtensionManifestId,
} from "./extension-manifest.ts";
import { parseExtensionTargets } from "./extension-targets.ts";
import type { ExtensionActivation, ExtensionManifestUIV1, ExtensionTarget } from "./extensions/types.ts";
import { isStdoutTakenOver } from "./output-guard.ts";
import type { PackageSource, SettingsManager } from "./settings-manager.ts";

const NETWORK_TIMEOUT_MS = 10000;
const UPDATE_CHECK_CONCURRENCY = 4;
const GIT_UPDATE_CONCURRENCY = 4;

function isOfflineModeEnabled(): boolean {
	const value = process.env.PI_OFFLINE;
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

export interface PathMetadata {
	source: string;
	scope: SourceScope;
	origin: "package" | "top-level";
	baseDir?: string;
	activation?: ExtensionActivation;
	targets?: ExtensionTarget[];
	extensionId?: string;
	extensionUI?: ExtensionManifestUIV1;
	extensionManifest?: ExtensionManifestV1;
	extensionManifestStatus?: ExtensionManifestStatus;
	extensionManifestDiagnostics?: ExtensionManifestDiagnostic[];
	extensionHostVersion?: string;
	extensionLoadable?: boolean;
}

export interface ResolvedResource {
	path: string;
	enabled: boolean;
	metadata: PathMetadata;
}

export interface ResolvedPaths {
	extensions: ResolvedResource[];
	skills: ResolvedResource[];
	prompts: ResolvedResource[];
	themes: ResolvedResource[];
}

export type MissingSourceAction = "install" | "skip" | "error";

export interface ProgressEvent {
	type: "start" | "progress" | "complete" | "error";
	action: "install" | "remove" | "update" | "clone" | "pull";
	source: string;
	message?: string;
}

export type ProgressCallback = (event: ProgressEvent) => void;

export interface PackageUpdate {
	source: string;
	displayName: string;
	type: "npm" | "git";
	scope: Exclude<SourceScope, "temporary">;
}

export interface ConfiguredPackage {
	source: string;
	scope: "user" | "project";
	filtered: boolean;
	installedPath?: string;
}

export interface PackageManager {
	resolve(onMissing?: (source: string) => Promise<MissingSourceAction>): Promise<ResolvedPaths>;
	install(source: string, options?: { local?: boolean }): Promise<void>;
	installAndPersist(source: string, options?: { local?: boolean }): Promise<void>;
	remove(source: string, options?: { local?: boolean }): Promise<void>;
	removeAndPersist(source: string, options?: { local?: boolean }): Promise<boolean>;
	update(source?: string): Promise<void>;
	listConfiguredPackages(): ConfiguredPackage[];
	resolveExtensionSources(
		sources: ResourcePathEntry[],
		options?: { local?: boolean; temporary?: boolean },
	): Promise<ResolvedPaths>;
	addSourceToSettings(source: string, options?: { local?: boolean }): boolean;
	removeSourceFromSettings(source: string, options?: { local?: boolean }): boolean;
	setProgressCallback(callback: ProgressCallback | undefined): void;
	getInstalledPath(source: string, scope: "user" | "project"): string | undefined;
}

interface PackageManagerOptions {
	cwd: string;
	agentDir: string;
	settingsManager: SettingsManager;
	extensionTarget?: ExtensionTarget;
	hostVersions?: Partial<Record<ExtensionTarget, string>>;
}

type SourceScope = "user" | "project" | "temporary";

type NpmSource = {
	type: "npm";
	spec: string;
	name: string;
	pinned: boolean;
};

type LocalSource = {
	type: "local";
	path: string;
};

type ParsedSource = NpmSource | GitSource | LocalSource;

type InstalledSourceScope = Exclude<SourceScope, "temporary">;

interface ConfiguredUpdateSource {
	source: string;
	scope: InstalledSourceScope;
}

interface NpmUpdateTarget extends ConfiguredUpdateSource {
	parsed: NpmSource;
}

interface GitUpdateTarget extends ConfiguredUpdateSource {
	parsed: GitSource;
}

export interface ExtensionManifestEntry {
	id: string;
	path: string;
	activation?: ExtensionActivation;
	targets: ExtensionTarget[];
	manifest?: ExtensionManifestV1;
	ui?: ExtensionManifestUIV1;
}

type ManifestResourceEntry = ExtensionManifestEntry;

interface PiManifest {
	extensions?: ManifestResourceEntry[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
}

interface ResourceAccumulator {
	extensions: Map<string, { metadata: PathMetadata; enabled: boolean }>;
	skills: Map<string, { metadata: PathMetadata; enabled: boolean }>;
	prompts: Map<string, { metadata: PathMetadata; enabled: boolean }>;
	themes: Map<string, { metadata: PathMetadata; enabled: boolean }>;
}

/**
 * Compute a numeric precedence rank for a resource based on its metadata.
 * Lower rank = higher precedence. Used to sort resolved resources so that
 * name-collision resolution ("first wins") produces the correct outcome.
 *
 * Precedence (highest to lowest):
 *   0  project + settings entry (source: "local", scope: "project")
 *   1  project + auto-discovered (source: "auto", scope: "project")
 *   2  user + settings entry (source: "local", scope: "user")
 *   3  user + auto-discovered (source: "auto", scope: "user")
 *   4  package resource (origin: "package")
 */
function resourcePrecedenceRank(m: PathMetadata): number {
	if (m.origin === "package") return 4;
	const scopeBase = m.scope === "project" ? 0 : 2;
	return scopeBase + (m.source === "local" ? 0 : 1);
}

interface PackageFilter {
	extensions?: ResourcePathEntry[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
}

type ResourceType = "extensions" | "skills" | "prompts" | "themes";

const RESOURCE_TYPES: ResourceType[] = ["extensions", "skills", "prompts", "themes"];

const FILE_PATTERNS: Record<ResourceType, RegExp> = {
	extensions: /\.(ts|js)$/,
	skills: /\.md$/,
	prompts: /\.md$/,
	themes: /\.json$/,
};

const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

type IgnoreMatcher = ReturnType<typeof ignore>;

export type ResourcePathEntry =
	| string
	| {
			id?: string;
			path: string;
			activation?: ExtensionActivation;
			targets?: ExtensionTarget[];
			manifest?: ExtensionManifestV1;
			ui?: ExtensionManifestUIV1;
	  };

interface ResolvedResourcePathEntry {
	id?: string;
	path: string;
	activation?: ExtensionActivation;
	targets?: ExtensionTarget[];
	manifest?: ExtensionManifestV1;
	ui?: ExtensionManifestUIV1;
}

interface ExtensionDiscoveryEntry extends ResolvedResourcePathEntry {
	id: string;
	targets: ExtensionTarget[];
	manifest?: ExtensionManifestV1;
	ui?: ExtensionManifestUIV1;
}

const EXTENSION_ACTIVATIONS: ExtensionActivation[] = ["startup", "beforeFirstRequest", "lazy"];
const DEFAULT_EXTENSION_TARGET: ExtensionTarget = "pi";

function parseExtensionActivation(value: unknown): ExtensionActivation | undefined {
	if (typeof value !== "string") return undefined;
	return EXTENSION_ACTIVATIONS.includes(value as ExtensionActivation) ? (value as ExtensionActivation) : undefined;
}

function getResourceEntryPath(entry: ResourcePathEntry): string {
	return typeof entry === "string" ? entry : entry.path;
}

function getResourceEntryActivation(entry: ResourcePathEntry): ExtensionActivation | undefined {
	return typeof entry === "string" ? undefined : parseExtensionActivation(entry.activation);
}

function getResourceEntryTargets(entry: ResourcePathEntry): ExtensionTarget[] | undefined {
	return typeof entry === "string" ? undefined : parseExtensionTargets(entry.targets);
}

function getResourceEntryUI(entry: ResourcePathEntry): ExtensionManifestUIV1 | undefined {
	return typeof entry === "string" ? undefined : entry.ui;
}

function getResourceEntryManifest(entry: ResourcePathEntry): ExtensionManifestV1 | undefined {
	return typeof entry === "string" ? undefined : entry.manifest;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}

function assertValidExtensionUI(value: unknown, context: string): asserts value is ExtensionManifestUIV1 {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(`${context}: extension ui must be an object`);
	const ui = value as Record<string, unknown>;
	if (!hasOnlyKeys(ui, ["schemaVersion", "title", "description", "category", "settings"]))
		throw new Error(`${context}: extension ui contains unknown fields`);
	if (ui.schemaVersion !== 1) throw new Error(`${context}: extension ui schemaVersion must be 1`);
	if (ui.title !== undefined && (typeof ui.title !== "string" || ui.title.length > 256))
		throw new Error(`${context}: extension ui title is invalid`);
	if (ui.description !== undefined && (typeof ui.description !== "string" || ui.description.length > 2000))
		throw new Error(`${context}: extension ui description is invalid`);
	if (
		ui.category !== undefined &&
		!["ui", "automation", "agent", "shell", "diagnostics", "memory", "search", "other"].includes(String(ui.category))
	)
		throw new Error(`${context}: extension ui category is invalid`);
	if (ui.settings === undefined) return;
	if (!ui.settings || typeof ui.settings !== "object" || Array.isArray(ui.settings))
		throw new Error(`${context}: extension settings must be an object`);
	const settings = ui.settings as Record<string, unknown>;
	if (!hasOnlyKeys(settings, ["schemaVersion", "groups", "fields"]))
		throw new Error(`${context}: extension settings contains unknown fields`);
	if (settings.schemaVersion !== 1 || !Array.isArray(settings.fields) || settings.fields.length > 128)
		throw new Error(`${context}: extension settings schema is invalid`);
	const groups = new Set<string>();
	if (settings.groups !== undefined) {
		if (!Array.isArray(settings.groups) || settings.groups.length > 32)
			throw new Error(`${context}: extension setting groups are invalid`);
		for (const candidate of settings.groups) {
			if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
				throw new Error(`${context}: extension setting group is invalid`);
			const group = candidate as Record<string, unknown>;
			if (
				!hasOnlyKeys(group, ["id", "title", "description"]) ||
				typeof group.id !== "string" ||
				typeof group.title !== "string" ||
				groups.has(group.id)
			)
				throw new Error(`${context}: extension setting groups require unique ids and titles`);
			groups.add(group.id);
		}
	}
	const keys = new Set<string>();
	for (const candidate of settings.fields) {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
			throw new Error(`${context}: extension setting field is invalid`);
		const field = candidate as Record<string, unknown>;
		const commonKeys = ["key", "type", "label", "description", "group", "requiresReload", "visibleWhen", "default"];
		const typeKeys =
			field.type === "number"
				? ["min", "max", "step"]
				: field.type === "string" || field.type === "textarea"
					? ["minLength", "maxLength"]
					: field.type === "select"
						? ["options"]
						: field.type === "model-reference"
							? []
						: [];
		if (!hasOnlyKeys(field, [...commonKeys, ...typeKeys]))
			throw new Error(`${context}: extension setting field contains unknown fields`);
		if (typeof field.key !== "string" || !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(field.key) || keys.has(field.key))
			throw new Error(`${context}: extension setting keys must be unique stable identifiers`);
		keys.add(field.key);
		if (typeof field.label !== "string" || field.label.length === 0 || field.label.length > 256)
			throw new Error(`${context}: extension setting label is invalid`);
		if (!["boolean", "string", "textarea", "number", "select", "model", "model-reference"].includes(String(field.type)))
			throw new Error(`${context}: extension setting type is invalid`);
		if (field.type === "boolean" && typeof field.default !== "boolean")
			throw new Error(`${context}: boolean settings require a default`);
		if (
			field.type === "model-reference" &&
			field.default !== undefined &&
			(typeof field.default !== "string" || !/^current-session$|^default:[1-9]\d*$|^model:[^/]+\/.+$/.test(field.default))
		)
			throw new Error(`${context}: model-reference default is invalid`);
		if (
			field.type === "select" &&
			(!Array.isArray(field.options) || field.options.length === 0 || field.options.length > 128)
		)
			throw new Error(`${context}: select settings require options`);
		if (field.group !== undefined && (typeof field.group !== "string" || !groups.has(field.group)))
			throw new Error(`${context}: extension setting references an unknown group`);
		if (field.requiresReload !== undefined && typeof field.requiresReload !== "boolean")
			throw new Error(`${context}: requiresReload must be boolean`);
		if (field.type === "number") {
			for (const key of ["default", "min", "max", "step"] as const) {
				if (field[key] !== undefined && (typeof field[key] !== "number" || !Number.isFinite(field[key])))
					throw new Error(`${context}: numeric setting bounds are invalid`);
			}
			if (typeof field.min === "number" && typeof field.max === "number" && field.min > field.max)
				throw new Error(`${context}: numeric setting bounds are inconsistent`);
		}
		if (field.type === "select") {
			const optionValues = new Set<string>();
			for (const option of field.options as Array<Record<string, unknown>>) {
				if (
					!option ||
					typeof option !== "object" ||
					!hasOnlyKeys(option, ["value", "label", "description"]) ||
					typeof option.value !== "string" ||
					typeof option.label !== "string" ||
					optionValues.has(option.value)
				)
					throw new Error(`${context}: select options are invalid`);
				optionValues.add(option.value);
			}
			if (field.default !== undefined && (typeof field.default !== "string" || !optionValues.has(field.default)))
				throw new Error(`${context}: select default must use a declared option`);
		}
		if (field.visibleWhen !== undefined) {
			const condition = field.visibleWhen as Record<string, unknown>;
			if (
				!condition ||
				typeof condition !== "object" ||
				typeof condition.key !== "string" ||
				!["string", "number", "boolean"].includes(typeof condition.equals)
			)
				throw new Error(`${context}: setting visibility condition is invalid`);
		}
	}
	for (const candidate of settings.fields) {
		const condition = (candidate as Record<string, unknown>).visibleWhen as Record<string, unknown> | undefined;
		if (condition && !keys.has(String(condition.key)))
			throw new Error(`${context}: visibility condition references an unknown setting`);
	}
}

function getResourceEntryId(entry: ResourcePathEntry): string | undefined {
	if (typeof entry === "string") return undefined;
	const id = entry.id?.trim();
	return id && isExtensionManifestId(id) ? id : undefined;
}

function assertStrictExtensionEntry(
	entry: ResourcePathEntry,
	context: string,
): asserts entry is ExtensionManifestEntry {
	if (typeof entry === "string") {
		throw new Error(`${context}: extension entries must be objects with id, path, and targets`);
	}
	const extensionId = getResourceEntryId(entry);
	if (!extensionId) {
		throw new Error(`${context}: extension id must be a lowercase stable identifier`);
	}
	if (!hasOnlyKeys(entry as Record<string, unknown>, ["id", "path", "activation", "targets", "manifest", "ui"])) {
		throw new Error(`${context}: extension entry contains unknown fields`);
	}
	if (typeof entry.path !== "string" || !entry.path.trim()) {
		throw new Error(`${context}: extension path must be a non-empty string`);
	}
	if (entry.activation !== undefined && parseExtensionActivation(entry.activation) === undefined) {
		throw new Error(`${context}: extension activation is invalid`);
	}
	const targets = parseExtensionTargets(entry.targets);
	if (!targets || targets.length === 0) {
		throw new Error(`${context}: extension targets must explicitly contain pi, mortise, or both`);
	}
	if (entry.manifest !== undefined) assertValidExtensionManifest(entry.manifest, extensionId, targets, context);
	if (entry.ui !== undefined) assertValidExtensionUI(entry.ui, context);
}

function getResourceEntryPaths(entries: readonly ResourcePathEntry[]): string[] {
	return entries.map((entry) => getResourceEntryPath(entry));
}

function getSettingsResourceEntries(
	settings: ReturnType<SettingsManager["getGlobalSettings"]>,
	resourceType: ResourceType,
): ResourcePathEntry[] {
	const entries = settings[resourceType];
	return Array.isArray(entries) ? (entries as ResourcePathEntry[]) : [];
}

function getSettingsStringEntries(
	settings: ReturnType<SettingsManager["getGlobalSettings"]>,
	resourceType: Exclude<ResourceType, "extensions">,
): string[] {
	const entries = settings[resourceType];
	return Array.isArray(entries) ? (entries as string[]) : [];
}

function withExtensionMetadata(
	metadata: PathMetadata,
	activation: ExtensionActivation | undefined,
	targets: ExtensionTarget[] | undefined,
	extensionId?: string,
	extensionUI?: ExtensionManifestUIV1,
	extensionManifest?: ExtensionManifestV1,
): PathMetadata {
	const next: PathMetadata = { ...metadata };
	if (activation) {
		next.activation = activation;
	}
	if (targets !== undefined) {
		next.targets = targets;
	}
	if (extensionId) {
		next.extensionId = extensionId;
	}
	if (extensionUI) next.extensionUI = extensionUI;
	if (extensionManifest) next.extensionManifest = extensionManifest;
	return next;
}

function extensionTargetsMatch(metadata: PathMetadata, target: ExtensionTarget): boolean {
	return (metadata.targets ?? [DEFAULT_EXTENSION_TARGET]).includes(target);
}

function entryMatchesPath(filePath: string, entryPath: string, baseDir: string): boolean {
	if (hasGlobPattern(entryPath)) {
		return matchesAnyPattern(filePath, [entryPath], baseDir);
	}
	const resolved = resolve(baseDir, entryPath);
	const normalizedFilePath = resolve(filePath);
	if (normalizedFilePath === resolved) {
		return true;
	}
	const prefix = resolved.endsWith(sep) ? resolved : `${resolved}${sep}`;
	return normalizedFilePath.startsWith(prefix);
}

function toPosixPath(p: string): string {
	return p.split(sep).join("/");
}

function getHomeDir(): string {
	return process.env.HOME || homedir();
}

function prefixIgnorePattern(line: string, prefix: string): string | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) return null;

	let pattern = line;
	let negated = false;

	if (pattern.startsWith("!")) {
		negated = true;
		pattern = pattern.slice(1);
	} else if (pattern.startsWith("\\!")) {
		pattern = pattern.slice(1);
	}

	if (pattern.startsWith("/")) {
		pattern = pattern.slice(1);
	}

	const prefixed = prefix ? `${prefix}${pattern}` : pattern;
	return negated ? `!${prefixed}` : prefixed;
}

function addIgnoreRules(ig: IgnoreMatcher, dir: string, rootDir: string): void {
	const relativeDir = relative(rootDir, dir);
	const prefix = relativeDir ? `${toPosixPath(relativeDir)}/` : "";

	for (const filename of IGNORE_FILE_NAMES) {
		const ignorePath = join(dir, filename);
		if (!existsSync(ignorePath)) continue;
		try {
			const content = readFileSync(ignorePath, "utf-8");
			const patterns = content
				.split(/\r?\n/)
				.map((line) => prefixIgnorePattern(line, prefix))
				.filter((line): line is string => Boolean(line));
			if (patterns.length > 0) {
				ig.add(patterns);
			}
		} catch {}
	}
}

function isPattern(s: string): boolean {
	return s.startsWith("!") || s.startsWith("+") || s.startsWith("-") || s.includes("*") || s.includes("?");
}

function isOverridePattern(s: string): boolean {
	return s.startsWith("!") || s.startsWith("+") || s.startsWith("-");
}

function hasGlobPattern(s: string): boolean {
	return s.includes("*") || s.includes("?");
}

function splitPatterns(entries: ResourcePathEntry[]): { plain: ResourcePathEntry[]; patterns: string[] } {
	const plain: ResourcePathEntry[] = [];
	const patterns: string[] = [];
	for (const entry of entries) {
		const path = getResourceEntryPath(entry);
		if (isPattern(path)) {
			patterns.push(path);
		} else {
			plain.push(entry);
		}
	}
	return { plain, patterns };
}

function collectFiles(
	dir: string,
	filePattern: RegExp,
	skipNodeModules = true,
	ignoreMatcher?: IgnoreMatcher,
	rootDir?: string,
): string[] {
	const files: string[] = [];
	if (!existsSync(dir)) return files;

	const root = rootDir ?? dir;
	const ig = ignoreMatcher ?? ignore();
	addIgnoreRules(ig, dir, root);

	try {
		const entries = readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			if (skipNodeModules && entry.name === "node_modules") continue;

			const fullPath = join(dir, entry.name);
			let isDir = entry.isDirectory();
			let isFile = entry.isFile();

			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isDir = stats.isDirectory();
					isFile = stats.isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(root, fullPath));
			const ignorePath = isDir ? `${relPath}/` : relPath;
			if (ig.ignores(ignorePath)) continue;

			if (isDir) {
				files.push(...collectFiles(fullPath, filePattern, skipNodeModules, ig, root));
			} else if (isFile && filePattern.test(entry.name)) {
				files.push(fullPath);
			}
		}
	} catch {
		// Ignore errors
	}

	return files;
}

type SkillDiscoveryMode = "pi" | "agents";

function collectSkillEntries(
	dir: string,
	mode: SkillDiscoveryMode,
	ignoreMatcher?: IgnoreMatcher,
	rootDir?: string,
): string[] {
	const entries: string[] = [];
	if (!existsSync(dir)) return entries;

	const root = rootDir ?? dir;
	const ig = ignoreMatcher ?? ignore();
	addIgnoreRules(ig, dir, root);

	try {
		const dirEntries = readdirSync(dir, { withFileTypes: true });

		for (const entry of dirEntries) {
			if (entry.name !== "SKILL.md") {
				continue;
			}

			const fullPath = join(dir, entry.name);
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					isFile = statSync(fullPath).isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(root, fullPath));
			if (isFile && !ig.ignores(relPath)) {
				entries.push(fullPath);
				return entries;
			}
		}

		for (const entry of dirEntries) {
			if (entry.name.startsWith(".")) continue;
			if (entry.name === "node_modules") continue;

			const fullPath = join(dir, entry.name);
			let isDir = entry.isDirectory();
			let isFile = entry.isFile();

			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isDir = stats.isDirectory();
					isFile = stats.isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(root, fullPath));
			if (mode === "pi" && dir === root && isFile && entry.name.endsWith(".md") && !ig.ignores(relPath)) {
				entries.push(fullPath);
				continue;
			}

			if (!isDir) continue;
			if (ig.ignores(`${relPath}/`)) continue;

			entries.push(...collectSkillEntries(fullPath, mode, ig, root));
		}
	} catch {
		// Ignore errors
	}

	return entries;
}

function collectAutoSkillEntries(dir: string, mode: SkillDiscoveryMode): string[] {
	return collectSkillEntries(dir, mode);
}

function findGitRepoRoot(startDir: string): string | null {
	let dir = resolve(startDir);
	while (true) {
		if (existsSync(join(dir, ".git"))) {
			return dir;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			return null;
		}
		dir = parent;
	}
}

function collectAncestorAgentsSkillDirs(startDir: string): string[] {
	const skillDirs: string[] = [];
	const resolvedStartDir = resolve(startDir);
	const gitRepoRoot = findGitRepoRoot(resolvedStartDir);

	let dir = resolvedStartDir;
	while (true) {
		skillDirs.push(join(dir, ".agents", "skills"));
		if (gitRepoRoot && dir === gitRepoRoot) {
			break;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			break;
		}
		dir = parent;
	}

	return skillDirs;
}

function collectAutoPromptEntries(dir: string): string[] {
	const entries: string[] = [];
	if (!existsSync(dir)) return entries;

	const ig = ignore();
	addIgnoreRules(ig, dir, dir);

	try {
		const dirEntries = readdirSync(dir, { withFileTypes: true });
		for (const entry of dirEntries) {
			if (entry.name.startsWith(".")) continue;
			if (entry.name === "node_modules") continue;

			const fullPath = join(dir, entry.name);
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					isFile = statSync(fullPath).isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(dir, fullPath));
			if (ig.ignores(relPath)) continue;

			if (isFile && entry.name.endsWith(".md")) {
				entries.push(fullPath);
			}
		}
	} catch {
		// Ignore errors
	}

	return entries;
}

function collectAutoThemeEntries(dir: string): string[] {
	const entries: string[] = [];
	if (!existsSync(dir)) return entries;

	const ig = ignore();
	addIgnoreRules(ig, dir, dir);

	try {
		const dirEntries = readdirSync(dir, { withFileTypes: true });
		for (const entry of dirEntries) {
			if (entry.name.startsWith(".")) continue;
			if (entry.name === "node_modules") continue;

			const fullPath = join(dir, entry.name);
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					isFile = statSync(fullPath).isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(dir, fullPath));
			if (ig.ignores(relPath)) continue;

			if (isFile && entry.name.endsWith(".json")) {
				entries.push(fullPath);
			}
		}
	} catch {
		// Ignore errors
	}

	return entries;
}

function readPiManifestFile(packageJsonPath: string): PiManifest | null {
	try {
		const content = readFileSync(packageJsonPath, "utf-8");
		const pkg = JSON.parse(content) as { pi?: PiManifest };
		return pkg.pi ?? null;
	} catch {
		return null;
	}
}

function resolveExtensionEntries(dir: string): ExtensionDiscoveryEntry[] | null {
	const packageJsonPath = join(dir, "package.json");
	if (existsSync(packageJsonPath)) {
		const manifest = readPiManifestFile(packageJsonPath);
		if (manifest?.extensions?.length) {
			const entries: ExtensionDiscoveryEntry[] = [];
			for (const entry of manifest.extensions) {
				assertStrictExtensionEntry(entry, packageJsonPath);
				const extPath = getResourceEntryPath(entry);
				const resolvedExtPath = resolve(dir, extPath);
				if (existsSync(resolvedExtPath)) {
					entries.push({
						id: entry.id,
						path: resolvedExtPath,
						activation: getResourceEntryActivation(entry),
						targets: getResourceEntryTargets(entry)!,
						manifest: getResourceEntryManifest(entry),
						ui: getResourceEntryUI(entry),
					});
				}
			}
			if (entries.length > 0) {
				return entries;
			}
		}
	}

	return null;
}

function collectAutoExtensionEntries(dir: string): ExtensionDiscoveryEntry[] {
	const entries: ExtensionDiscoveryEntry[] = [];
	if (!existsSync(dir)) return entries;

	// First check if this directory itself has explicit extension entries (package.json or index)
	const rootEntries = resolveExtensionEntries(dir);
	if (rootEntries) {
		return rootEntries;
	}

	// Otherwise, discover extensions from directory contents
	const ig = ignore();
	addIgnoreRules(ig, dir, dir);

	try {
		const dirEntries = readdirSync(dir, { withFileTypes: true });
		for (const entry of dirEntries) {
			if (entry.name.startsWith(".")) continue;
			if (entry.name === "node_modules") continue;

			const fullPath = join(dir, entry.name);
			let isDir = entry.isDirectory();

			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isDir = stats.isDirectory();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(dir, fullPath));
			const ignorePath = isDir ? `${relPath}/` : relPath;
			if (ig.ignores(ignorePath)) continue;

			if (isDir) {
				const resolvedEntries = resolveExtensionEntries(fullPath);
				if (resolvedEntries) {
					entries.push(...resolvedEntries);
				}
			}
		}
	} catch {
		// Ignore errors
	}

	return entries;
}

/**
 * Collect resource files from a directory based on resource type.
 * Extensions use smart discovery (index.ts in subdirs), others use recursive collection.
 */
function collectResourceFiles(dir: string, resourceType: ResourceType): string[] {
	if (resourceType === "skills") {
		return collectSkillEntries(dir, "pi");
	}
	if (resourceType === "extensions") {
		return collectAutoExtensionEntries(dir).map((entry) => entry.path);
	}
	return collectFiles(dir, FILE_PATTERNS[resourceType]);
}

function collectGlobMatches(root: string, pattern: string): string[] {
	const matches: string[] = [];
	if (!existsSync(root)) return matches;
	const normalizedPattern = normalizeExactPattern(pattern);

	const visit = (dir: string) => {
		let entries: Dirent<string>[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			if (entry.name === "node_modules") continue;

			const fullPath = join(dir, entry.name);
			let isDirectory = entry.isDirectory();
			let isFile = entry.isFile();

			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isDirectory = stats.isDirectory();
					isFile = stats.isFile();
				} catch {
					continue;
				}
			}

			if (!isDirectory && !isFile) continue;

			const relPath = toPosixPath(relative(root, fullPath));
			if (minimatch(relPath, normalizedPattern)) {
				matches.push(resolve(fullPath));
			}

			if (isDirectory) {
				visit(fullPath);
			}
		}
	};

	visit(root);
	return matches;
}

function matchesAnyPattern(filePath: string, patterns: string[], baseDir: string): boolean {
	const rel = toPosixPath(relative(baseDir, filePath));
	const name = basename(filePath);
	const filePathPosix = toPosixPath(filePath);
	const isSkillFile = name === "SKILL.md";
	const parentDir = isSkillFile ? dirname(filePath) : undefined;
	const parentRel = isSkillFile ? toPosixPath(relative(baseDir, parentDir!)) : undefined;
	const parentName = isSkillFile ? basename(parentDir!) : undefined;
	const parentDirPosix = isSkillFile ? toPosixPath(parentDir!) : undefined;

	return patterns.some((pattern) => {
		const normalizedPattern = toPosixPath(pattern);
		if (
			minimatch(rel, normalizedPattern) ||
			minimatch(name, normalizedPattern) ||
			minimatch(filePathPosix, normalizedPattern)
		) {
			return true;
		}
		if (!isSkillFile) return false;
		return (
			minimatch(parentRel!, normalizedPattern) ||
			minimatch(parentName!, normalizedPattern) ||
			minimatch(parentDirPosix!, normalizedPattern)
		);
	});
}

function normalizeExactPattern(pattern: string): string {
	const normalized = pattern.startsWith("./") || pattern.startsWith(".\\") ? pattern.slice(2) : pattern;
	return toPosixPath(normalized);
}

function matchesAnyExactPattern(filePath: string, patterns: string[], baseDir: string): boolean {
	if (patterns.length === 0) return false;
	const rel = toPosixPath(relative(baseDir, filePath));
	const name = basename(filePath);
	const filePathPosix = toPosixPath(filePath);
	const isSkillFile = name === "SKILL.md";
	const parentDir = isSkillFile ? dirname(filePath) : undefined;
	const parentRel = isSkillFile ? toPosixPath(relative(baseDir, parentDir!)) : undefined;
	const parentDirPosix = isSkillFile ? toPosixPath(parentDir!) : undefined;

	return patterns.some((pattern) => {
		const normalized = normalizeExactPattern(pattern);
		if (normalized === rel || normalized === filePathPosix) {
			return true;
		}
		if (!isSkillFile) return false;
		return normalized === parentRel || normalized === parentDirPosix;
	});
}

function getOverridePatterns(entries: string[]): string[] {
	return entries.filter((pattern) => pattern.startsWith("!") || pattern.startsWith("+") || pattern.startsWith("-"));
}

function isEnabledByOverrides(filePath: string, patterns: string[], baseDir: string): boolean {
	const overrides = getOverridePatterns(patterns);
	const excludes = overrides.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1));
	const forceIncludes = overrides.filter((pattern) => pattern.startsWith("+")).map((pattern) => pattern.slice(1));
	const forceExcludes = overrides.filter((pattern) => pattern.startsWith("-")).map((pattern) => pattern.slice(1));

	let enabled = true;
	if (excludes.length > 0 && matchesAnyPattern(filePath, excludes, baseDir)) {
		enabled = false;
	}
	if (forceIncludes.length > 0 && matchesAnyExactPattern(filePath, forceIncludes, baseDir)) {
		enabled = true;
	}
	if (forceExcludes.length > 0 && matchesAnyExactPattern(filePath, forceExcludes, baseDir)) {
		enabled = false;
	}
	return enabled;
}

/**
 * Apply patterns to paths and return a Set of enabled paths.
 * Pattern types:
 * - Plain patterns: include matching paths
 * - `!pattern`: exclude matching paths
 * - `+path`: force-include exact path (overrides exclusions)
 * - `-path`: force-exclude exact path (overrides force-includes)
 */
function applyPatterns(allPaths: string[], patterns: string[], baseDir: string): Set<string> {
	const includes: string[] = [];
	const excludes: string[] = [];
	const forceIncludes: string[] = [];
	const forceExcludes: string[] = [];

	for (const p of patterns) {
		if (p.startsWith("+")) {
			forceIncludes.push(p.slice(1));
		} else if (p.startsWith("-")) {
			forceExcludes.push(p.slice(1));
		} else if (p.startsWith("!")) {
			excludes.push(p.slice(1));
		} else {
			includes.push(p);
		}
	}

	// Step 1: Apply includes (or all if no includes)
	let result: string[];
	if (includes.length === 0) {
		result = [...allPaths];
	} else {
		result = allPaths.filter((filePath) => matchesAnyPattern(filePath, includes, baseDir));
	}

	// Step 2: Apply excludes
	if (excludes.length > 0) {
		result = result.filter((filePath) => !matchesAnyPattern(filePath, excludes, baseDir));
	}

	// Step 3: Force-include (add back from allPaths, overriding exclusions)
	if (forceIncludes.length > 0) {
		for (const filePath of allPaths) {
			if (!result.includes(filePath) && matchesAnyExactPattern(filePath, forceIncludes, baseDir)) {
				result.push(filePath);
			}
		}
	}

	// Step 4: Force-exclude (remove even if included or force-included)
	if (forceExcludes.length > 0) {
		result = result.filter((filePath) => !matchesAnyExactPattern(filePath, forceExcludes, baseDir));
	}

	return new Set(result);
}

export class DefaultPackageManager implements PackageManager {
	private cwd: string;
	private agentDir: string;
	private settingsManager: SettingsManager;
	private extensionTarget: ExtensionTarget;
	private hostVersions: Record<ExtensionTarget, string>;
	private globalNpmRoot: string | undefined;
	private globalNpmRootCommandKey: string | undefined;
	private progressCallback: ProgressCallback | undefined;

	constructor(options: PackageManagerOptions) {
		this.cwd = resolvePath(options.cwd);
		this.agentDir = resolvePath(options.agentDir);
		this.settingsManager = options.settingsManager;
		this.extensionTarget = options.extensionTarget ?? DEFAULT_EXTENSION_TARGET;
		this.hostVersions = {
			pi: options.hostVersions?.pi ?? VERSION,
			mortise: options.hostVersions?.mortise ?? process.env.MORTISE_AGENT_VERSION ?? VERSION,
		};
	}

	setProgressCallback(callback: ProgressCallback | undefined): void {
		this.progressCallback = callback;
	}

	addSourceToSettings(source: string, options?: { local?: boolean }): boolean {
		const scope: SourceScope = options?.local ? "project" : "user";
		const currentSettings =
			scope === "project" ? this.settingsManager.getProjectSettings() : this.settingsManager.getGlobalSettings();
		const currentPackages = currentSettings.packages ?? [];
		const normalizedSource = this.normalizePackageSourceForSettings(source, scope);
		const matchIndex = currentPackages.findIndex((existing) => this.packageSourcesMatch(existing, source, scope));
		if (matchIndex !== -1) {
			const existing = currentPackages[matchIndex];
			if (this.getPackageSourceString(existing) === normalizedSource) {
				return false;
			}
			const nextPackages = [...currentPackages];
			nextPackages[matchIndex] =
				typeof existing === "string" ? normalizedSource : { ...existing, source: normalizedSource };
			if (scope === "project") {
				this.settingsManager.setProjectPackages(nextPackages);
			} else {
				this.settingsManager.setPackages(nextPackages);
			}
			return true;
		}
		const nextPackages = [...currentPackages, normalizedSource];
		if (scope === "project") {
			this.settingsManager.setProjectPackages(nextPackages);
		} else {
			this.settingsManager.setPackages(nextPackages);
		}
		return true;
	}

	removeSourceFromSettings(source: string, options?: { local?: boolean }): boolean {
		const scope: SourceScope = options?.local ? "project" : "user";
		const currentSettings =
			scope === "project" ? this.settingsManager.getProjectSettings() : this.settingsManager.getGlobalSettings();
		const currentPackages = currentSettings.packages ?? [];
		const nextPackages = currentPackages.filter((existing) => !this.packageSourcesMatch(existing, source, scope));
		const changed = nextPackages.length !== currentPackages.length;
		if (!changed) {
			return false;
		}
		if (scope === "project") {
			this.settingsManager.setProjectPackages(nextPackages);
		} else {
			this.settingsManager.setPackages(nextPackages);
		}
		return true;
	}

	getInstalledPath(source: string, scope: "user" | "project"): string | undefined {
		const parsed = this.parseSource(source);
		if (parsed.type === "npm") {
			const path = this.getNpmInstallPath(parsed, scope);
			return existsSync(path) ? path : undefined;
		}
		if (parsed.type === "git") {
			const path = this.getGitInstallPath(parsed, scope);
			return existsSync(path) ? path : undefined;
		}
		if (parsed.type === "local") {
			const baseDir = this.getBaseDirForScope(scope);
			const path = this.resolvePathFromBase(parsed.path, baseDir);
			return existsSync(path) ? path : undefined;
		}
		return undefined;
	}

	private emitProgress(event: ProgressEvent): void {
		this.progressCallback?.(event);
	}

	private async withProgress(
		action: ProgressEvent["action"],
		source: string,
		message: string,
		operation: () => Promise<void>,
	): Promise<void> {
		this.emitProgress({ type: "start", action, source, message });
		try {
			await operation();
			this.emitProgress({ type: "complete", action, source });
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.emitProgress({ type: "error", action, source, message: errorMessage });
			throw error;
		}
	}

	async resolve(onMissing?: (source: string) => Promise<MissingSourceAction>): Promise<ResolvedPaths> {
		const accumulator = this.createAccumulator();
		const globalSettings = this.settingsManager.getGlobalSettings();
		const projectSettings = this.settingsManager.getProjectSettings();

		// Collect all packages with scope (project first so cwd resources win collisions)
		const allPackages: Array<{ pkg: PackageSource; scope: SourceScope }> = [];
		for (const pkg of projectSettings.packages ?? []) {
			allPackages.push({ pkg, scope: "project" });
		}
		for (const pkg of globalSettings.packages ?? []) {
			allPackages.push({ pkg, scope: "user" });
		}

		// Dedupe: project scope wins over global for same package identity
		const packageSources = this.dedupePackages(allPackages);
		await this.resolvePackageSources(packageSources, accumulator, onMissing);

		const globalBaseDir = this.agentDir;
		const projectBaseDir = join(this.cwd, CONFIG_DIR_NAME);

		for (const resourceType of RESOURCE_TYPES) {
			const target = this.getTargetMap(accumulator, resourceType);
			const globalEntries = getSettingsResourceEntries(globalSettings, resourceType);
			const projectEntries = getSettingsResourceEntries(projectSettings, resourceType);
			this.resolveLocalEntries(
				projectEntries,
				resourceType,
				target,
				{
					source: "local",
					scope: "project",
					origin: "top-level",
				},
				projectBaseDir,
			);
			this.resolveLocalEntries(
				globalEntries,
				resourceType,
				target,
				{
					source: "local",
					scope: "user",
					origin: "top-level",
				},
				globalBaseDir,
			);
		}

		this.addAutoDiscoveredResources(accumulator, globalSettings, projectSettings, globalBaseDir, projectBaseDir);

		return this.toResolvedPaths(accumulator);
	}

	async resolveExtensionSources(
		sources: ResourcePathEntry[],
		options?: { local?: boolean; temporary?: boolean },
	): Promise<ResolvedPaths> {
		const accumulator = this.createAccumulator();
		const scope: SourceScope = options?.temporary ? "temporary" : options?.local ? "project" : "user";
		const sourceEntries: Array<{ pkg: PackageSource; scope: SourceScope }> = [];
		const localEntries: ResourcePathEntry[] = [];
		for (const source of sources) {
			if (typeof source === "string") {
				sourceEntries.push({ pkg: source, scope });
				continue;
			}
			if (isLocalPath(source.path)) {
				localEntries.push(source);
			} else {
				sourceEntries.push({ pkg: source.path, scope });
			}
		}
		await this.resolvePackageSources(sourceEntries, accumulator);
		this.resolveLocalEntries(
			localEntries,
			"extensions",
			accumulator.extensions,
			{
				source: "cli",
				scope,
				origin: "top-level",
			},
			this.getBaseDirForScope(scope),
		);
		return this.toResolvedPaths(accumulator);
	}

	listConfiguredPackages(): ConfiguredPackage[] {
		const globalSettings = this.settingsManager.getGlobalSettings();
		const projectSettings = this.settingsManager.getProjectSettings();
		const configuredPackages: ConfiguredPackage[] = [];

		for (const pkg of globalSettings.packages ?? []) {
			const source = typeof pkg === "string" ? pkg : pkg.source;
			configuredPackages.push({
				source,
				scope: "user",
				filtered: typeof pkg === "object",
				installedPath: this.getInstalledPath(source, "user"),
			});
		}

		for (const pkg of projectSettings.packages ?? []) {
			const source = typeof pkg === "string" ? pkg : pkg.source;
			configuredPackages.push({
				source,
				scope: "project",
				filtered: typeof pkg === "object",
				installedPath: this.getInstalledPath(source, "project"),
			});
		}

		return configuredPackages;
	}

	async install(source: string, options?: { local?: boolean }): Promise<void> {
		const parsed = this.parseSource(source);
		const scope: SourceScope = options?.local ? "project" : "user";
		await this.withProgress("install", source, `Installing ${source}...`, async () => {
			if (parsed.type === "npm") {
				await this.installNpm(parsed, scope, false);
				return;
			}
			if (parsed.type === "git") {
				await this.installGit(parsed, scope);
				return;
			}
			if (parsed.type === "local") {
				const resolved = this.resolvePath(parsed.path);
				if (!existsSync(resolved)) {
					throw new Error(`Path does not exist: ${resolved}`);
				}
				return;
			}
			throw new Error(`Unsupported install source: ${source}`);
		});
	}

	async installAndPersist(source: string, options?: { local?: boolean }): Promise<void> {
		await this.install(source, options);
		this.addSourceToSettings(source, options);
	}

	async remove(source: string, options?: { local?: boolean }): Promise<void> {
		const parsed = this.parseSource(source);
		const scope: SourceScope = options?.local ? "project" : "user";
		await this.withProgress("remove", source, `Removing ${source}...`, async () => {
			if (parsed.type === "npm") {
				await this.uninstallNpm(parsed, scope);
				return;
			}
			if (parsed.type === "git") {
				await this.removeGit(parsed, scope);
				return;
			}
			if (parsed.type === "local") {
				return;
			}
			throw new Error(`Unsupported remove source: ${source}`);
		});
	}

	async removeAndPersist(source: string, options?: { local?: boolean }): Promise<boolean> {
		await this.remove(source, options);
		return this.removeSourceFromSettings(source, options);
	}

	async update(source?: string): Promise<void> {
		const globalSettings = this.settingsManager.getGlobalSettings();
		const projectSettings = this.settingsManager.getProjectSettings();
		const identity = source ? this.getPackageIdentity(source) : undefined;
		let matched = false;
		const updateSources: ConfiguredUpdateSource[] = [];

		for (const pkg of globalSettings.packages ?? []) {
			const sourceStr = typeof pkg === "string" ? pkg : pkg.source;
			if (identity && this.getPackageIdentity(sourceStr, "user") !== identity) continue;
			matched = true;
			updateSources.push({ source: sourceStr, scope: "user" });
		}
		for (const pkg of projectSettings.packages ?? []) {
			const sourceStr = typeof pkg === "string" ? pkg : pkg.source;
			if (identity && this.getPackageIdentity(sourceStr, "project") !== identity) continue;
			matched = true;
			updateSources.push({ source: sourceStr, scope: "project" });
		}

		if (source && !matched) {
			throw new Error(
				this.buildNoMatchingPackageMessage(source, [
					...(globalSettings.packages ?? []),
					...(projectSettings.packages ?? []),
				]),
			);
		}

		await this.updateConfiguredSources(updateSources);
	}

	private async updateConfiguredSources(sources: ConfiguredUpdateSource[]): Promise<void> {
		if (isOfflineModeEnabled() || sources.length === 0) {
			return;
		}

		const npmCandidates: NpmUpdateTarget[] = [];
		const gitCandidates: GitUpdateTarget[] = [];

		for (const entry of sources) {
			const parsed = this.parseSource(entry.source);
			// Pinned npm versions are fixed. Pinned git refs are configured checkout targets,
			// so include them to reconcile an existing clone when the configured ref changes.
			if (parsed.type === "npm") {
				if (!parsed.pinned) {
					npmCandidates.push({ ...entry, parsed });
				}
			} else if (parsed.type === "git") {
				gitCandidates.push({ ...entry, parsed });
			}
		}

		const npmCheckTasks = npmCandidates.map((entry) => async () => ({
			entry,
			shouldUpdate: await this.shouldUpdateNpmSource(entry.parsed, entry.scope),
		}));
		const npmCheckResults = await this.runWithConcurrency(npmCheckTasks, UPDATE_CHECK_CONCURRENCY);
		const userNpmUpdates: NpmUpdateTarget[] = [];
		const projectNpmUpdates: NpmUpdateTarget[] = [];
		for (const result of npmCheckResults) {
			if (!result.shouldUpdate) {
				continue;
			}
			if (result.entry.scope === "user") {
				userNpmUpdates.push(result.entry);
			} else {
				projectNpmUpdates.push(result.entry);
			}
		}

		const tasks: Promise<void>[] = [];
		if (userNpmUpdates.length > 0) {
			tasks.push(this.updateNpmBatch(userNpmUpdates, "user"));
		}
		if (projectNpmUpdates.length > 0) {
			tasks.push(this.updateNpmBatch(projectNpmUpdates, "project"));
		}
		if (gitCandidates.length > 0) {
			const gitTasks = gitCandidates.map(
				(entry) => async () =>
					this.withProgress("update", entry.source, `Updating ${entry.source}...`, async () => {
						await this.updateGit(entry.parsed, entry.scope);
					}),
			);
			tasks.push(this.runWithConcurrency(gitTasks, GIT_UPDATE_CONCURRENCY).then(() => {}));
		}

		await Promise.all(tasks);
	}

	private async shouldUpdateNpmSource(source: NpmSource, scope: InstalledSourceScope): Promise<boolean> {
		const installedPath = this.getManagedNpmInstallPath(source, scope);
		const installedVersion = existsSync(installedPath) ? this.getInstalledNpmVersion(installedPath) : undefined;
		if (!installedVersion) {
			return true;
		}

		try {
			const latestVersion = await this.getLatestNpmVersion(source.name);
			return latestVersion !== installedVersion;
		} catch {
			// Preserve existing update behavior when version lookup fails.
			return true;
		}
	}

	private async updateNpmBatch(sources: NpmUpdateTarget[], scope: InstalledSourceScope): Promise<void> {
		if (sources.length === 0) {
			return;
		}

		const sourceLabel = sources.length === 1 ? sources[0].source : `${scope} npm packages`;
		const message = sources.length === 1 ? `Updating ${sources[0].source}...` : `Updating ${scope} npm packages...`;
		const specs = sources.map((entry) => `${entry.parsed.name}@latest`);

		await this.withProgress("update", sourceLabel, message, async () => {
			await this.installNpmBatch(specs, scope);
		});
	}

	private async installNpmBatch(specs: string[], scope: InstalledSourceScope): Promise<void> {
		const installRoot = this.getNpmInstallRoot(scope, false);
		this.ensureNpmProject(installRoot);
		await this.runNpmCommand(this.getNpmInstallArgs(specs, installRoot));
	}

	async checkForAvailableUpdates(): Promise<PackageUpdate[]> {
		if (isOfflineModeEnabled()) {
			return [];
		}

		const globalSettings = this.settingsManager.getGlobalSettings();
		const projectSettings = this.settingsManager.getProjectSettings();
		const allPackages: Array<{ pkg: PackageSource; scope: SourceScope }> = [];
		for (const pkg of projectSettings.packages ?? []) {
			allPackages.push({ pkg, scope: "project" });
		}
		for (const pkg of globalSettings.packages ?? []) {
			allPackages.push({ pkg, scope: "user" });
		}

		const packageSources = this.dedupePackages(allPackages);
		const checks = packageSources
			.filter(
				(entry): entry is { pkg: PackageSource; scope: Exclude<SourceScope, "temporary"> } =>
					entry.scope !== "temporary",
			)
			.map((entry) => async (): Promise<PackageUpdate | undefined> => {
				const source = typeof entry.pkg === "string" ? entry.pkg : entry.pkg.source;
				const parsed = this.parseSource(source);
				if (parsed.type === "local" || parsed.pinned) {
					return undefined;
				}

				if (parsed.type === "npm") {
					const installedPath = this.getNpmInstallPath(parsed, entry.scope);
					if (!existsSync(installedPath)) {
						return undefined;
					}
					const hasUpdate = await this.npmHasAvailableUpdate(parsed, installedPath);
					if (!hasUpdate) {
						return undefined;
					}
					return {
						source,
						displayName: parsed.name,
						type: "npm",
						scope: entry.scope,
					};
				}

				const installedPath = this.getGitInstallPath(parsed, entry.scope);
				if (!existsSync(installedPath)) {
					return undefined;
				}
				const hasUpdate = await this.gitHasAvailableUpdate(installedPath);
				if (!hasUpdate) {
					return undefined;
				}
				return {
					source,
					displayName: `${parsed.host}/${parsed.path}`,
					type: "git",
					scope: entry.scope,
				};
			});

		const results = await this.runWithConcurrency(checks, UPDATE_CHECK_CONCURRENCY);
		return results.filter((result): result is PackageUpdate => result !== undefined);
	}

	private async resolvePackageSources(
		sources: Array<{ pkg: PackageSource; scope: SourceScope }>,
		accumulator: ResourceAccumulator,
		onMissing?: (source: string) => Promise<MissingSourceAction>,
	): Promise<void> {
		for (const { pkg, scope } of sources) {
			const sourceStr = typeof pkg === "string" ? pkg : pkg.source;
			const filter = typeof pkg === "object" ? pkg : undefined;
			const parsed = this.parseSource(sourceStr);
			const metadata: PathMetadata = { source: sourceStr, scope, origin: "package" };

			if (parsed.type === "local") {
				const baseDir = this.getBaseDirForScope(scope);
				this.resolveLocalExtensionSource(parsed, accumulator, filter, metadata, baseDir);
				continue;
			}

			const installMissing = async (): Promise<boolean> => {
				if (isOfflineModeEnabled()) {
					return false;
				}
				if (!onMissing) {
					await this.installParsedSource(parsed, scope);
					return true;
				}
				const action = await onMissing(sourceStr);
				if (action === "skip") return false;
				if (action === "error") throw new Error(`Missing source: ${sourceStr}`);
				await this.installParsedSource(parsed, scope);
				return true;
			};

			if (parsed.type === "npm") {
				let installedPath = this.getNpmInstallPath(parsed, scope);
				const needsInstall =
					!existsSync(installedPath) ||
					(parsed.pinned && !(await this.installedNpmMatchesPinnedVersion(parsed, installedPath)));
				if (needsInstall) {
					const installed = await installMissing();
					if (!installed) continue;
					installedPath = this.getNpmInstallPath(parsed, scope);
				}
				metadata.baseDir = installedPath;
				this.collectPackageResources(installedPath, accumulator, filter, metadata);
				continue;
			}

			if (parsed.type === "git") {
				const installedPath = this.getGitInstallPath(parsed, scope);
				if (!existsSync(installedPath)) {
					const installed = await installMissing();
					if (!installed) continue;
				} else if (scope === "temporary" && !parsed.pinned && !isOfflineModeEnabled()) {
					await this.refreshTemporaryGitSource(parsed, sourceStr);
				}
				metadata.baseDir = installedPath;
				this.collectPackageResources(installedPath, accumulator, filter, metadata);
			}
		}
	}

	private resolveLocalExtensionSource(
		source: LocalSource,
		accumulator: ResourceAccumulator,
		filter: PackageFilter | undefined,
		metadata: PathMetadata,
		baseDir: string,
	): void {
		const resolved = this.resolvePathFromBase(source.path, baseDir);
		if (!existsSync(resolved)) {
			return;
		}

		try {
			const stats = statSync(resolved);
			if (stats.isFile()) {
				metadata.baseDir = dirname(resolved);
				this.addResource(accumulator.extensions, resolved, metadata, true);
				return;
			}
			if (stats.isDirectory()) {
				metadata.baseDir = resolved;
				const resources = this.collectPackageResources(resolved, accumulator, filter, metadata);
				if (!resources) {
					this.addResource(accumulator.extensions, resolved, metadata, true);
				}
			}
		} catch {
			return;
		}
	}

	private async installParsedSource(parsed: ParsedSource, scope: SourceScope): Promise<void> {
		if (parsed.type === "npm") {
			await this.installNpm(parsed, scope, scope === "temporary");
			return;
		}
		if (parsed.type === "git") {
			await this.installGit(parsed, scope);
			return;
		}
	}

	private getPackageSourceString(pkg: PackageSource): string {
		return typeof pkg === "string" ? pkg : pkg.source;
	}

	private getSourceMatchKeyForInput(source: string): string {
		const parsed = this.parseSource(source);
		if (parsed.type === "npm") {
			return `npm:${parsed.name}`;
		}
		if (parsed.type === "git") {
			return `git:${parsed.host}/${parsed.path}`;
		}
		return `local:${this.resolvePath(parsed.path)}`;
	}

	private getSourceMatchKeyForSettings(source: string, scope: SourceScope): string {
		const parsed = this.parseSource(source);
		if (parsed.type === "npm") {
			return `npm:${parsed.name}`;
		}
		if (parsed.type === "git") {
			return `git:${parsed.host}/${parsed.path}`;
		}
		const baseDir = this.getBaseDirForScope(scope);
		return `local:${this.resolvePathFromBase(parsed.path, baseDir)}`;
	}

	private buildNoMatchingPackageMessage(source: string, configuredPackages: PackageSource[]): string {
		const suggestion = this.findSuggestedConfiguredSource(source, configuredPackages);
		if (!suggestion) {
			return `No matching package found for ${source}`;
		}
		return `No matching package found for ${source}. Did you mean ${suggestion}?`;
	}

	private findSuggestedConfiguredSource(source: string, configuredPackages: PackageSource[]): string | undefined {
		const trimmedSource = source.trim();
		const suggestions = new Set<string>();

		for (const pkg of configuredPackages) {
			const sourceStr = this.getPackageSourceString(pkg);
			const parsed = this.parseSource(sourceStr);
			if (parsed.type === "npm") {
				if (trimmedSource === parsed.name || trimmedSource === parsed.spec) {
					suggestions.add(sourceStr);
				}
				continue;
			}
			if (parsed.type === "git") {
				const shorthand = `${parsed.host}/${parsed.path}`;
				const shorthandWithRef = parsed.ref ? `${shorthand}@${parsed.ref}` : undefined;
				if (trimmedSource === shorthand || (shorthandWithRef && trimmedSource === shorthandWithRef)) {
					suggestions.add(sourceStr);
				}
			}
		}

		return suggestions.values().next().value;
	}

	private packageSourcesMatch(existing: PackageSource, inputSource: string, scope: SourceScope): boolean {
		const left = this.getSourceMatchKeyForSettings(this.getPackageSourceString(existing), scope);
		const right = this.getSourceMatchKeyForInput(inputSource);
		return left === right;
	}

	private normalizePackageSourceForSettings(source: string, scope: SourceScope): string {
		const parsed = this.parseSource(source);
		if (parsed.type !== "local") {
			return source;
		}
		const baseDir = this.getBaseDirForScope(scope);
		const resolved = this.resolvePath(parsed.path);
		const rel = relative(baseDir, resolved);
		return rel || ".";
	}

	private parseSource(source: string): ParsedSource {
		if (source.startsWith("npm:")) {
			const spec = source.slice("npm:".length).trim();
			const { name, version } = this.parseNpmSpec(spec);
			return {
				type: "npm",
				spec,
				name,
				pinned: Boolean(version),
			};
		}

		if (isLocalPath(source)) {
			return { type: "local", path: source };
		}

		// Try parsing as git URL
		const gitParsed = parseGitUrl(source);
		if (gitParsed) {
			return gitParsed;
		}

		return { type: "local", path: source };
	}

	private async installedNpmMatchesPinnedVersion(source: NpmSource, installedPath: string): Promise<boolean> {
		const installedVersion = this.getInstalledNpmVersion(installedPath);
		if (!installedVersion) {
			return false;
		}

		const { version: pinnedVersion } = this.parseNpmSpec(source.spec);
		if (!pinnedVersion) {
			return true;
		}

		return installedVersion === pinnedVersion;
	}

	private async npmHasAvailableUpdate(source: NpmSource, installedPath: string): Promise<boolean> {
		if (isOfflineModeEnabled()) {
			return false;
		}

		const installedVersion = this.getInstalledNpmVersion(installedPath);
		if (!installedVersion) {
			return false;
		}

		try {
			const latestVersion = await this.getLatestNpmVersion(source.name);
			return latestVersion !== installedVersion;
		} catch {
			return false;
		}
	}

	private getInstalledNpmVersion(installedPath: string): string | undefined {
		const packageJsonPath = join(installedPath, "package.json");
		if (!existsSync(packageJsonPath)) return undefined;
		try {
			const content = readFileSync(packageJsonPath, "utf-8");
			const pkg = JSON.parse(content) as { version?: string };
			return pkg.version;
		} catch {
			return undefined;
		}
	}

	private async getLatestNpmVersion(packageName: string): Promise<string> {
		const npmCommand = this.getNpmCommand();
		const stdout = await this.runCommandCapture(
			npmCommand.command,
			[...npmCommand.args, "view", packageName, "version", "--json"],
			{ cwd: this.cwd, timeoutMs: NETWORK_TIMEOUT_MS },
		);
		const raw = stdout.trim();
		if (!raw) throw new Error("Empty response from npm view");
		return JSON.parse(raw);
	}

	private async gitHasAvailableUpdate(installedPath: string): Promise<boolean> {
		if (isOfflineModeEnabled()) {
			return false;
		}

		try {
			const localHead = await this.runCommandCapture("git", ["rev-parse", "HEAD"], {
				cwd: installedPath,
				timeoutMs: NETWORK_TIMEOUT_MS,
			});
			const remoteHead = await this.getRemoteGitHead(installedPath);
			return localHead.trim() !== remoteHead.trim();
		} catch {
			return false;
		}
	}

	private async getRemoteGitHead(installedPath: string): Promise<string> {
		const upstreamRef = await this.getGitUpstreamRef(installedPath);
		if (upstreamRef) {
			const remoteHead = await this.runGitRemoteCommand(installedPath, ["ls-remote", "origin", upstreamRef]);
			const match = remoteHead.match(/^([0-9a-f]{40})\s+/m);
			if (match?.[1]) {
				return match[1];
			}
		}

		const remoteHead = await this.runGitRemoteCommand(installedPath, ["ls-remote", "origin", "HEAD"]);
		const match = remoteHead.match(/^([0-9a-f]{40})\s+HEAD$/m);
		if (!match?.[1]) {
			throw new Error("Failed to determine remote HEAD");
		}
		return match[1];
	}

	private async getLocalGitUpdateTarget(
		installedPath: string,
	): Promise<{ ref: string; head: string; fetchArgs: string[] }> {
		try {
			const upstream = await this.runCommandCapture("git", ["rev-parse", "--abbrev-ref", "@{upstream}"], {
				cwd: installedPath,
				timeoutMs: NETWORK_TIMEOUT_MS,
			});
			const trimmedUpstream = upstream.trim();
			if (!trimmedUpstream.startsWith("origin/")) {
				throw new Error(`Unsupported upstream remote: ${trimmedUpstream}`);
			}
			const branch = trimmedUpstream.slice("origin/".length);
			if (!branch) {
				throw new Error("Missing upstream branch name");
			}
			const head = await this.runCommandCapture("git", ["rev-parse", "@{upstream}"], {
				cwd: installedPath,
				timeoutMs: NETWORK_TIMEOUT_MS,
			});
			return {
				ref: "@{upstream}",
				head,
				fetchArgs: [
					"fetch",
					"--prune",
					"--no-tags",
					"origin",
					`+refs/heads/${branch}:refs/remotes/origin/${branch}`,
				],
			};
		} catch {
			await this.runCommand("git", ["remote", "set-head", "origin", "-a"], { cwd: installedPath }).catch(() => {});
			const head = await this.runCommandCapture("git", ["rev-parse", "origin/HEAD"], {
				cwd: installedPath,
				timeoutMs: NETWORK_TIMEOUT_MS,
			});
			const originHeadRef = await this.runCommandCapture("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
				cwd: installedPath,
				timeoutMs: NETWORK_TIMEOUT_MS,
			}).catch(() => "");
			const branch = originHeadRef.trim().replace(/^refs\/remotes\/origin\//, "");
			if (branch) {
				return {
					ref: "origin/HEAD",
					head,
					fetchArgs: [
						"fetch",
						"--prune",
						"--no-tags",
						"origin",
						`+refs/heads/${branch}:refs/remotes/origin/${branch}`,
					],
				};
			}
			return {
				ref: "origin/HEAD",
				head,
				fetchArgs: ["fetch", "--prune", "--no-tags", "origin", "+HEAD:refs/remotes/origin/HEAD"],
			};
		}
	}

	private async getGitUpstreamRef(installedPath: string): Promise<string | undefined> {
		try {
			const upstream = await this.runCommandCapture("git", ["rev-parse", "--abbrev-ref", "@{upstream}"], {
				cwd: installedPath,
				timeoutMs: NETWORK_TIMEOUT_MS,
			});
			const trimmed = upstream.trim();
			if (!trimmed.startsWith("origin/")) {
				return undefined;
			}
			const branch = trimmed.slice("origin/".length);
			return branch ? `refs/heads/${branch}` : undefined;
		} catch {
			return undefined;
		}
	}

	private runGitRemoteCommand(installedPath: string, args: string[]): Promise<string> {
		return this.runCommandCapture("git", args, {
			cwd: installedPath,
			timeoutMs: NETWORK_TIMEOUT_MS,
			env: {
				GIT_TERMINAL_PROMPT: "0",
			},
		});
	}

	private async runWithConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
		if (tasks.length === 0) {
			return [];
		}

		const results: T[] = new Array(tasks.length);
		let nextIndex = 0;
		const workerCount = Math.max(1, Math.min(limit, tasks.length));

		const worker = async () => {
			while (true) {
				const index = nextIndex;
				nextIndex += 1;
				if (index >= tasks.length) {
					return;
				}
				results[index] = await tasks[index]();
			}
		};

		await Promise.all(Array.from({ length: workerCount }, () => worker()));
		return results;
	}

	/**
	 * Get a unique identity for a package, ignoring version/ref.
	 * Used to detect when the same package is in both global and project settings.
	 * For git packages, uses normalized host/path to ensure SSH and HTTPS URLs
	 * for the same repository are treated as identical.
	 */
	private getPackageIdentity(source: string, scope?: SourceScope): string {
		const parsed = this.parseSource(source);
		if (parsed.type === "npm") {
			return `npm:${parsed.name}`;
		}
		if (parsed.type === "git") {
			// Use host/path for identity to normalize SSH and HTTPS
			return `git:${parsed.host}/${parsed.path}`;
		}
		if (scope) {
			const baseDir = this.getBaseDirForScope(scope);
			return `local:${this.resolvePathFromBase(parsed.path, baseDir)}`;
		}
		return `local:${this.resolvePath(parsed.path)}`;
	}

	/**
	 * Dedupe packages: if same package identity appears in both global and project,
	 * keep only the project one (project wins).
	 */
	private dedupePackages(
		packages: Array<{ pkg: PackageSource; scope: SourceScope }>,
	): Array<{ pkg: PackageSource; scope: SourceScope }> {
		const seen = new Map<string, { pkg: PackageSource; scope: SourceScope }>();

		for (const entry of packages) {
			const sourceStr = typeof entry.pkg === "string" ? entry.pkg : entry.pkg.source;
			const identity = this.getPackageIdentity(sourceStr, entry.scope);

			const existing = seen.get(identity);
			if (!existing) {
				seen.set(identity, entry);
			} else if (entry.scope === "project" && existing.scope === "user") {
				// Project wins over user
				seen.set(identity, entry);
			}
			// If existing is project and new is global, keep existing (project)
			// If both are same scope, keep first one
		}

		return Array.from(seen.values());
	}

	private parseNpmSpec(spec: string): { name: string; version?: string } {
		const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/);
		if (!match) {
			return { name: spec };
		}
		const name = match[1] ?? spec;
		const version = match[2];
		return { name, version };
	}

	private getNpmCommand(): { command: string; args: string[] } {
		const configuredCommand = this.settingsManager.getNpmCommand();
		if (!configuredCommand || configuredCommand.length === 0) {
			return { command: "npm", args: [] };
		}
		const [command, ...args] = configuredCommand;
		if (!command) {
			throw new Error("Invalid npmCommand: first array entry must be a non-empty command");
		}
		return { command, args };
	}

	private getPackageManagerName(): string {
		const npmCommand = this.getNpmCommand();
		const commandParts = [npmCommand.command, ...npmCommand.args];
		const separatorIndex = commandParts.lastIndexOf("--");
		const packageManagerCommand = separatorIndex >= 0 ? commandParts[separatorIndex + 1] : npmCommand.command;
		return packageManagerCommand ? basename(packageManagerCommand).replace(/\.(cmd|exe)$/i, "") : "";
	}

	private async runNpmCommand(args: string[], options?: { cwd?: string }): Promise<void> {
		const npmCommand = this.getNpmCommand();
		await this.runCommand(npmCommand.command, [...npmCommand.args, ...args], options);
	}

	private getGitDependencyInstallArgs(): string[] {
		const configuredCommand = this.settingsManager.getNpmCommand();
		if (configuredCommand && configuredCommand.length > 0) {
			return ["install"];
		}
		return ["install", "--omit=dev"];
	}

	private runNpmCommandSync(args: string[]): string {
		const npmCommand = this.getNpmCommand();
		return this.runCommandSync(npmCommand.command, [...npmCommand.args, ...args]);
	}

	private getNpmInstallArgs(specs: string[], installRoot: string): string[] {
		const packageManagerName = this.getPackageManagerName();
		// Extension packages run inside pi and resolve pi APIs through loader aliases/virtual modules.
		// Disable peer dependency resolution for managed installs (npm's --legacy-peer-deps, and
		// equivalent bun/pnpm settings) so package managers do not install or solve host-provided
		// @mortise/pi-* peers. Stale auto-installed pi peers can otherwise block updates.
		if (packageManagerName === "bun") {
			return ["install", ...specs, "--cwd", installRoot, "--omit=peer"];
		}
		if (packageManagerName === "pnpm") {
			return [
				"install",
				...specs,
				"--prefix",
				installRoot,
				"--config.auto-install-peers=false",
				"--config.strict-peer-dependencies=false",
				"--config.strict-dep-builds=false",
			];
		}
		return ["install", ...specs, "--prefix", installRoot, "--legacy-peer-deps"];
	}

	private async installNpm(source: NpmSource, scope: SourceScope, temporary: boolean): Promise<void> {
		const installRoot = this.getNpmInstallRoot(scope, temporary);
		this.ensureNpmProject(installRoot);
		await this.runNpmCommand(this.getNpmInstallArgs([source.spec], installRoot));
	}

	private async uninstallNpm(source: NpmSource, scope: SourceScope): Promise<void> {
		const installRoot = this.getNpmInstallRoot(scope, false);
		if (!existsSync(installRoot)) {
			return;
		}
		if (this.getPackageManagerName() === "bun") {
			await this.runNpmCommand(["uninstall", source.name, "--cwd", installRoot]);
			return;
		}
		await this.runNpmCommand(["uninstall", source.name, "--prefix", installRoot]);
	}

	private async installGit(source: GitSource, scope: SourceScope): Promise<void> {
		const targetDir = this.getGitInstallPath(source, scope);
		if (existsSync(targetDir)) {
			if (source.ref) {
				await this.ensureGitRef(targetDir, ["fetch", "origin", source.ref], "FETCH_HEAD");
				return;
			}
			const target = await this.getLocalGitUpdateTarget(targetDir);
			await this.ensureGitRef(targetDir, target.fetchArgs, target.ref);
			return;
		}
		const gitRoot = this.getGitInstallRoot(scope);
		if (gitRoot) {
			this.ensureGitIgnore(gitRoot);
		}
		mkdirSync(dirname(targetDir), { recursive: true });

		await this.runCommand("git", ["clone", source.repo, targetDir]);
		if (source.ref) {
			await this.runCommand("git", ["checkout", source.ref], { cwd: targetDir });
		}
		const packageJsonPath = join(targetDir, "package.json");
		if (existsSync(packageJsonPath)) {
			await this.runNpmCommand(this.getGitDependencyInstallArgs(), { cwd: targetDir });
		}
	}

	private async updateGit(source: GitSource, scope: SourceScope): Promise<void> {
		const targetDir = this.getGitInstallPath(source, scope);
		if (!existsSync(targetDir)) {
			await this.installGit(source, scope);
			return;
		}

		if (source.ref) {
			await this.ensureGitRef(targetDir, ["fetch", "origin", source.ref], "FETCH_HEAD");
			return;
		}

		const target = await this.getLocalGitUpdateTarget(targetDir);
		await this.ensureGitRef(targetDir, target.fetchArgs, target.ref);
	}

	private async ensureGitRef(targetDir: string, fetchArgs: string[], ref: string): Promise<void> {
		// Fetch only the ref we will reset to, avoiding unrelated branch/tag noise.
		await this.runCommand("git", fetchArgs, { cwd: targetDir });

		const localHead = await this.runCommandCapture("git", ["rev-parse", "HEAD"], {
			cwd: targetDir,
			timeoutMs: NETWORK_TIMEOUT_MS,
		});
		const commitRef = `${ref}^{commit}`;
		const targetHead = await this.runCommandCapture("git", ["rev-parse", commitRef], {
			cwd: targetDir,
			timeoutMs: NETWORK_TIMEOUT_MS,
		});
		if (localHead.trim() === targetHead.trim()) {
			return;
		}

		await this.runCommand("git", ["reset", "--hard", commitRef], { cwd: targetDir });

		// Clean untracked files (extensions should be pristine)
		await this.runCommand("git", ["clean", "-fdx"], { cwd: targetDir });

		const packageJsonPath = join(targetDir, "package.json");
		if (existsSync(packageJsonPath)) {
			await this.runNpmCommand(this.getGitDependencyInstallArgs(), { cwd: targetDir });
		}
	}

	private async refreshTemporaryGitSource(source: GitSource, sourceStr: string): Promise<void> {
		if (isOfflineModeEnabled()) {
			return;
		}
		try {
			await this.withProgress("pull", sourceStr, `Refreshing ${sourceStr}...`, async () => {
				await this.updateGit(source, "temporary");
			});
		} catch {
			// Keep cached temporary checkout if refresh fails.
		}
	}

	private async removeGit(source: GitSource, scope: SourceScope): Promise<void> {
		const targetDir = this.getGitInstallPath(source, scope);
		if (!existsSync(targetDir)) return;
		rmSync(targetDir, { recursive: true, force: true });
		this.pruneEmptyGitParents(targetDir, this.getGitInstallRoot(scope));
	}

	private pruneEmptyGitParents(targetDir: string, installRoot: string | undefined): void {
		if (!installRoot) return;
		const resolvedRoot = resolve(installRoot);
		let current = dirname(targetDir);
		while (current.startsWith(resolvedRoot) && current !== resolvedRoot) {
			if (!existsSync(current)) {
				current = dirname(current);
				continue;
			}
			const entries = readdirSync(current);
			if (entries.length > 0) {
				break;
			}
			try {
				rmSync(current, { recursive: true, force: true });
			} catch {
				break;
			}
			current = dirname(current);
		}
	}

	private ensureNpmProject(installRoot: string): void {
		if (!existsSync(installRoot)) {
			mkdirSync(installRoot, { recursive: true });
		}
		markPathIgnoredByCloudSync(installRoot);
		this.ensureGitIgnore(installRoot);
		const packageJsonPath = join(installRoot, "package.json");
		if (!existsSync(packageJsonPath)) {
			const pkgJson = { name: "pi-extensions", private: true };
			writeFileSync(packageJsonPath, JSON.stringify(pkgJson, null, 2), "utf-8");
		}
	}

	private ensureGitIgnore(dir: string): void {
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		const ignorePath = join(dir, ".gitignore");
		if (!existsSync(ignorePath)) {
			writeFileSync(ignorePath, "*\n!.gitignore\n", "utf-8");
		}
	}

	private getNpmInstallRoot(scope: SourceScope, temporary: boolean): string {
		if (temporary) {
			return this.getTemporaryDir("npm");
		}
		if (scope === "project") {
			return join(this.cwd, CONFIG_DIR_NAME, "npm");
		}
		return join(this.agentDir, "npm");
	}

	private getGlobalNpmRoot(): string {
		const npmCommand = this.getNpmCommand();
		const commandKey = [npmCommand.command, ...npmCommand.args].join("\0");
		if (this.globalNpmRoot && this.globalNpmRootCommandKey === commandKey) {
			return this.globalNpmRoot;
		}
		if (this.getPackageManagerName() === "bun") {
			const binDir = this.runNpmCommandSync(["pm", "bin", "-g"]).trim();
			this.globalNpmRoot = join(dirname(binDir), "install", "global", "node_modules");
		} else {
			this.globalNpmRoot = this.runNpmCommandSync(["root", "-g"]).trim();
		}
		this.globalNpmRootCommandKey = commandKey;
		return this.globalNpmRoot;
	}

	private getPnpmGlobalPackagePath(packageName: string): string | undefined {
		if (this.getPackageManagerName() !== "pnpm") {
			return undefined;
		}

		const output = this.runNpmCommandSync(["list", "-g", "--depth", "0", "--json"]);
		const entries = JSON.parse(output) as Array<{ dependencies?: Record<string, { path?: string }> }>;
		for (const entry of entries) {
			const path = entry.dependencies?.[packageName]?.path;
			if (path) return path;
		}
		return undefined;
	}

	private getManagedNpmInstallPath(source: NpmSource, scope: SourceScope): string {
		if (scope === "temporary") {
			return join(this.getTemporaryDir("npm"), "node_modules", source.name);
		}
		if (scope === "project") {
			return join(this.cwd, CONFIG_DIR_NAME, "npm", "node_modules", source.name);
		}
		return join(this.agentDir, "npm", "node_modules", source.name);
	}

	private getLegacyGlobalNpmInstallPath(source: NpmSource): string | undefined {
		try {
			return this.getPnpmGlobalPackagePath(source.name) ?? join(this.getGlobalNpmRoot(), source.name);
		} catch {
			return undefined;
		}
	}

	private getNpmInstallPath(source: NpmSource, scope: SourceScope): string {
		const managedPath = this.getManagedNpmInstallPath(source, scope);
		if (scope !== "user" || existsSync(managedPath)) {
			return managedPath;
		}
		const legacyPath = this.getLegacyGlobalNpmInstallPath(source);
		return legacyPath && existsSync(legacyPath) ? legacyPath : managedPath;
	}

	private getGitInstallPath(source: GitSource, scope: SourceScope): string {
		if (scope === "temporary") {
			return this.getTemporaryDir(`git-${source.host}`, source.path);
		}
		if (scope === "project") {
			return join(this.cwd, CONFIG_DIR_NAME, "git", source.host, source.path);
		}
		return join(this.agentDir, "git", source.host, source.path);
	}

	private getGitInstallRoot(scope: SourceScope): string | undefined {
		if (scope === "temporary") {
			return undefined;
		}
		if (scope === "project") {
			return join(this.cwd, CONFIG_DIR_NAME, "git");
		}
		return join(this.agentDir, "git");
	}

	private getTemporaryDir(prefix: string, suffix?: string): string {
		const hash = createHash("sha256")
			.update(`${prefix}-${suffix ?? ""}`)
			.digest("hex")
			.slice(0, 8);
		return join(tmpdir(), "pi-extensions", prefix, hash, suffix ?? "");
	}

	private getBaseDirForScope(scope: SourceScope): string {
		if (scope === "project") {
			return join(this.cwd, CONFIG_DIR_NAME);
		}
		if (scope === "user") {
			return this.agentDir;
		}
		return this.cwd;
	}

	private resolvePath(input: string): string {
		return resolvePath(input, this.cwd, { homeDir: getHomeDir(), trim: true });
	}

	private resolvePathFromBase(input: string, baseDir: string): string {
		return resolvePath(input, baseDir, { homeDir: getHomeDir(), trim: true });
	}

	private collectPackageResources(
		packageRoot: string,
		accumulator: ResourceAccumulator,
		filter: PackageFilter | undefined,
		metadata: PathMetadata,
	): boolean {
		if (filter) {
			for (const resourceType of RESOURCE_TYPES) {
				const patterns = filter[resourceType as keyof PackageFilter];
				const target = this.getTargetMap(accumulator, resourceType);
				if (patterns !== undefined) {
					this.applyPackageFilter(packageRoot, patterns, resourceType, target, metadata);
				} else {
					this.collectDefaultResources(packageRoot, resourceType, target, metadata);
				}
			}
			return true;
		}

		const manifest = this.readPiManifest(packageRoot);
		if (manifest) {
			for (const resourceType of RESOURCE_TYPES) {
				const entries = manifest[resourceType as keyof PiManifest];
				this.addManifestEntries(
					entries,
					packageRoot,
					resourceType,
					this.getTargetMap(accumulator, resourceType),
					metadata,
				);
			}
			return true;
		}

		let hasAnyDir = false;
		for (const resourceType of RESOURCE_TYPES) {
			const dir = join(packageRoot, resourceType);
			if (existsSync(dir)) {
				this.addDefaultResourcesFromDir(dir, resourceType, this.getTargetMap(accumulator, resourceType), metadata);
				hasAnyDir = true;
			}
		}
		return hasAnyDir;
	}

	private collectDefaultResources(
		packageRoot: string,
		resourceType: ResourceType,
		target: Map<string, { metadata: PathMetadata; enabled: boolean }>,
		metadata: PathMetadata,
	): void {
		const manifest = this.readPiManifest(packageRoot);
		const entries = manifest?.[resourceType as keyof PiManifest];
		if (entries) {
			this.addManifestEntries(entries, packageRoot, resourceType, target, metadata);
			return;
		}
		const dir = join(packageRoot, resourceType);
		if (existsSync(dir)) {
			this.addDefaultResourcesFromDir(dir, resourceType, target, metadata);
		}
	}

	private addDefaultResourcesFromDir(
		dir: string,
		resourceType: ResourceType,
		target: Map<string, { metadata: PathMetadata; enabled: boolean }>,
		metadata: PathMetadata,
	): void {
		if (resourceType === "extensions") {
			for (const entry of collectAutoExtensionEntries(dir)) {
				this.addResource(
					target,
					entry.path,
					withExtensionMetadata(metadata, entry.activation, entry.targets, entry.id, entry.ui, entry.manifest),
					true,
				);
			}
			return;
		}

		for (const f of collectResourceFiles(dir, resourceType)) {
			this.addResource(target, f, metadata, true);
		}
	}

	private applyPackageFilter(
		packageRoot: string,
		userPatterns: ResourcePathEntry[],
		resourceType: ResourceType,
		target: Map<string, { metadata: PathMetadata; enabled: boolean }>,
		metadata: PathMetadata,
	): void {
		const { allFiles } = this.collectManifestFiles(packageRoot, resourceType);
		const manifestEntries = resourceType === "extensions" ? this.readPiManifest(packageRoot)?.extensions : undefined;
		const conventionExtensionEntries =
			resourceType === "extensions" && !manifestEntries
				? collectAutoExtensionEntries(join(packageRoot, "extensions"))
				: undefined;

		if (userPatterns.length === 0) {
			// Empty array explicitly disables all resources of this type
			for (const f of allFiles) {
				const activation = conventionExtensionEntries
					? this.findActivationForResolvedPath(f, conventionExtensionEntries)
					: undefined;
				const targets = conventionExtensionEntries
					? this.findTargetsForResolvedPath(f, conventionExtensionEntries)
					: undefined;
				const extensionId = manifestEntries
					? this.findIdForPath(f, manifestEntries, packageRoot)
					: conventionExtensionEntries
						? this.findIdForResolvedPath(f, conventionExtensionEntries)
						: undefined;
				const extensionUI = manifestEntries
					? this.findUIForPath(f, manifestEntries, packageRoot)
					: conventionExtensionEntries
						? this.findUIForResolvedPath(f, conventionExtensionEntries)
						: undefined;
				const extensionManifest = manifestEntries
					? this.findManifestForPath(f, manifestEntries, packageRoot)
					: conventionExtensionEntries
						? this.findManifestForResolvedPath(f, conventionExtensionEntries)
						: undefined;
				this.addResource(
					target,
					f,
					withExtensionMetadata(metadata, activation, targets, extensionId, extensionUI, extensionManifest),
					false,
				);
			}
			return;
		}

		// Apply user patterns
		const enabledByUser = applyPatterns(allFiles, getResourceEntryPaths(userPatterns), packageRoot);

		for (const f of allFiles) {
			const enabled = enabledByUser.has(f);
			const activation =
				resourceType === "extensions"
					? (this.findActivationForPath(f, userPatterns, packageRoot) ??
						(manifestEntries ? this.findActivationForPath(f, manifestEntries, packageRoot) : undefined) ??
						(conventionExtensionEntries
							? this.findActivationForResolvedPath(f, conventionExtensionEntries)
							: undefined))
					: undefined;
			const targets =
				resourceType === "extensions"
					? (this.findTargetsForPath(f, userPatterns, packageRoot) ??
						(manifestEntries ? this.findTargetsForPath(f, manifestEntries, packageRoot) : undefined) ??
						(conventionExtensionEntries
							? this.findTargetsForResolvedPath(f, conventionExtensionEntries)
							: undefined))
					: undefined;
			const extensionId =
				resourceType === "extensions"
					? (this.findIdForPath(f, userPatterns, packageRoot) ??
						(manifestEntries ? this.findIdForPath(f, manifestEntries, packageRoot) : undefined) ??
						(conventionExtensionEntries ? this.findIdForResolvedPath(f, conventionExtensionEntries) : undefined))
					: undefined;
			const extensionUI =
				resourceType === "extensions"
					? (this.findUIForPath(f, userPatterns, packageRoot) ??
						(manifestEntries ? this.findUIForPath(f, manifestEntries, packageRoot) : undefined) ??
						(conventionExtensionEntries ? this.findUIForResolvedPath(f, conventionExtensionEntries) : undefined))
					: undefined;
			const extensionManifest =
				resourceType === "extensions"
					? (this.findManifestForPath(f, userPatterns, packageRoot) ??
						(manifestEntries ? this.findManifestForPath(f, manifestEntries, packageRoot) : undefined) ??
						(conventionExtensionEntries
							? this.findManifestForResolvedPath(f, conventionExtensionEntries)
							: undefined))
					: undefined;
			this.addResource(
				target,
				f,
				withExtensionMetadata(metadata, activation, targets, extensionId, extensionUI, extensionManifest),
				enabled,
			);
		}
	}

	/**
	 * Collect all files from a package for a resource type, applying manifest patterns.
	 * Returns { allFiles, enabledByManifest } where enabledByManifest is the set of files
	 * that pass the manifest's own patterns.
	 */
	private collectManifestFiles(
		packageRoot: string,
		resourceType: ResourceType,
	): { allFiles: string[]; enabledByManifest: Set<string> } {
		const manifest = this.readPiManifest(packageRoot);
		const entries = manifest?.[resourceType as keyof PiManifest];
		if (entries && entries.length > 0) {
			const allFiles = this.collectFilesFromManifestEntries(entries, packageRoot, resourceType);
			const manifestPatterns = getResourceEntryPaths(entries).filter(isOverridePattern);
			const enabledByManifest =
				manifestPatterns.length > 0 ? applyPatterns(allFiles, manifestPatterns, packageRoot) : new Set(allFiles);
			return { allFiles: Array.from(enabledByManifest), enabledByManifest };
		}

		const conventionDir = join(packageRoot, resourceType);
		if (!existsSync(conventionDir)) {
			return { allFiles: [], enabledByManifest: new Set() };
		}
		const allFiles = collectResourceFiles(conventionDir, resourceType);
		return { allFiles, enabledByManifest: new Set(allFiles) };
	}

	private readPiManifest(packageRoot: string): PiManifest | null {
		const packageJsonPath = join(packageRoot, "package.json");
		if (!existsSync(packageJsonPath)) {
			return null;
		}

		try {
			const content = readFileSync(packageJsonPath, "utf-8");
			const pkg = JSON.parse(content) as { pi?: PiManifest };
			return pkg.pi ?? null;
		} catch {
			return null;
		}
	}

	private addManifestEntries(
		entries: ResourcePathEntry[] | undefined,
		root: string,
		resourceType: ResourceType,
		target: Map<string, { metadata: PathMetadata; enabled: boolean }>,
		metadata: PathMetadata,
	): void {
		if (!entries) return;
		if (resourceType === "extensions") {
			for (const entry of entries) assertStrictExtensionEntry(entry, `${root}/package.json`);
		}

		const allFiles = this.collectFilesFromManifestEntries(entries, root, resourceType);
		const paths = getResourceEntryPaths(entries);
		const patterns = paths.filter(isOverridePattern);
		const enabledPaths = applyPatterns(allFiles, patterns, root);

		for (const f of allFiles) {
			if (enabledPaths.has(f)) {
				const activation = resourceType === "extensions" ? this.findActivationForPath(f, entries, root) : undefined;
				const targets = resourceType === "extensions" ? this.findTargetsForPath(f, entries, root) : undefined;
				const extensionId = resourceType === "extensions" ? this.findIdForPath(f, entries, root) : undefined;
				const extensionUI = resourceType === "extensions" ? this.findUIForPath(f, entries, root) : undefined;
				const extensionManifest =
					resourceType === "extensions" ? this.findManifestForPath(f, entries, root) : undefined;
				this.addResource(
					target,
					f,
					withExtensionMetadata(metadata, activation, targets, extensionId, extensionUI, extensionManifest),
					true,
				);
			}
		}
	}

	private collectFilesFromManifestEntries(
		entries: ResourcePathEntry[],
		root: string,
		resourceType: ResourceType,
	): string[] {
		const sourceEntries = entries.filter((entry) => !isOverridePattern(getResourceEntryPath(entry)));
		const resolved = sourceEntries.flatMap((entry) => {
			const pathEntry = getResourceEntryPath(entry);
			if (!hasGlobPattern(pathEntry)) {
				return [resolve(root, pathEntry)];
			}

			return collectGlobMatches(root, pathEntry);
		});
		return this.collectFilesFromPaths(resolved, resourceType);
	}

	private findActivationForPath(
		filePath: string,
		entries: ResourcePathEntry[],
		baseDir: string,
	): ExtensionActivation | undefined {
		for (const entry of entries) {
			const activation = getResourceEntryActivation(entry);
			if (!activation) {
				continue;
			}
			if (entryMatchesPath(filePath, getResourceEntryPath(entry), baseDir)) {
				return activation;
			}
		}
		return undefined;
	}

	private findTargetsForPath(
		filePath: string,
		entries: ResourcePathEntry[],
		baseDir: string,
	): ExtensionTarget[] | undefined {
		for (const entry of entries) {
			const targets = getResourceEntryTargets(entry);
			if (targets === undefined) {
				continue;
			}
			if (entryMatchesPath(filePath, getResourceEntryPath(entry), baseDir)) {
				return targets;
			}
		}
		return undefined;
	}

	private findIdForPath(filePath: string, entries: ResourcePathEntry[], baseDir: string): string | undefined {
		for (const entry of entries) {
			const id = getResourceEntryId(entry);
			if (id && entryMatchesPath(filePath, getResourceEntryPath(entry), baseDir)) return id;
		}
		return undefined;
	}

	private findUIForPath(
		filePath: string,
		entries: ResourcePathEntry[],
		baseDir: string,
	): ExtensionManifestUIV1 | undefined {
		for (const entry of entries) {
			if (typeof entry !== "string" && entry.ui && entryMatchesPath(filePath, entry.path, baseDir)) return entry.ui;
		}
		return undefined;
	}

	private findManifestForPath(
		filePath: string,
		entries: ResourcePathEntry[],
		baseDir: string,
	): ExtensionManifestV1 | undefined {
		for (const entry of entries) {
			if (typeof entry !== "string" && entry.manifest && entryMatchesPath(filePath, entry.path, baseDir)) {
				return entry.manifest;
			}
		}
		return undefined;
	}

	private resolveLocalEntries(
		entries: ResourcePathEntry[],
		resourceType: ResourceType,
		target: Map<string, { metadata: PathMetadata; enabled: boolean }>,
		metadata: PathMetadata,
		baseDir: string,
	): void {
		if (entries.length === 0) return;
		if (resourceType === "extensions") {
			for (const entry of entries) assertStrictExtensionEntry(entry, baseDir);
		}

		// Collect all files from plain entries (non-pattern entries)
		const { plain, patterns } = splitPatterns(entries);
		const resolvedPlain = plain.map((entry): ResolvedResourcePathEntry => {
			const entryPath = getResourceEntryPath(entry);
			return {
				id: resourceType === "extensions" ? getResourceEntryId(entry)! : "resource",
				path: this.resolvePathFromBase(entryPath, baseDir),
				activation: getResourceEntryActivation(entry),
				targets: resourceType === "extensions" ? getResourceEntryTargets(entry)! : [],
				manifest: resourceType === "extensions" ? getResourceEntryManifest(entry) : undefined,
				ui: resourceType === "extensions" ? getResourceEntryUI(entry) : undefined,
			};
		});
		const extensionEntries =
			resourceType === "extensions" ? this.collectExtensionEntriesFromPathEntries(resolvedPlain) : [];
		const allFiles =
			resourceType === "extensions"
				? extensionEntries.map((entry) => entry.path)
				: this.collectFilesFromPathEntries(resolvedPlain, resourceType);

		// Determine which files are enabled based on patterns
		const enabledPaths = applyPatterns(allFiles, patterns, baseDir);

		// Add all files with their enabled state
		for (const f of allFiles) {
			const activation =
				resourceType === "extensions" ? this.findActivationForResolvedPath(f, extensionEntries) : undefined;
			const targets =
				resourceType === "extensions" ? this.findTargetsForResolvedPath(f, extensionEntries) : undefined;
			const extensionId =
				resourceType === "extensions" ? this.findIdForResolvedPath(f, extensionEntries) : undefined;
			const extensionUI =
				resourceType === "extensions" ? this.findUIForResolvedPath(f, extensionEntries) : undefined;
			const extensionManifest =
				resourceType === "extensions" ? this.findManifestForResolvedPath(f, extensionEntries) : undefined;
			this.addResource(
				target,
				f,
				withExtensionMetadata(metadata, activation, targets, extensionId, extensionUI, extensionManifest),
				enabledPaths.has(f),
			);
		}
	}

	private collectFilesFromPathEntries(entries: ResolvedResourcePathEntry[], resourceType: ResourceType): string[] {
		return this.collectFilesFromPaths(
			entries.map((entry) => entry.path),
			resourceType,
		);
	}

	private collectExtensionEntriesFromPathEntries(entries: ResolvedResourcePathEntry[]): ResolvedResourcePathEntry[] {
		const discovered: ResolvedResourcePathEntry[] = [];
		for (const entry of entries) {
			if (!existsSync(entry.path)) {
				continue;
			}

			try {
				const stats = statSync(entry.path);
				if (stats.isFile()) {
					discovered.push(entry);
					continue;
				}
				if (!stats.isDirectory()) {
					continue;
				}
			} catch {
				continue;
			}

			for (const extensionEntry of collectAutoExtensionEntries(entry.path)) {
				discovered.push({
					id: entry.id || extensionEntry.id,
					path: extensionEntry.path,
					activation: entry.activation ?? extensionEntry.activation,
					targets: entry.targets ?? extensionEntry.targets,
					manifest: entry.manifest ?? extensionEntry.manifest,
					ui: entry.ui ?? extensionEntry.ui,
				});
			}
		}
		return discovered;
	}

	private findActivationForResolvedPath(
		filePath: string,
		entries: ResolvedResourcePathEntry[],
	): ExtensionActivation | undefined {
		const normalizedFilePath = resolve(filePath);
		for (const entry of entries) {
			if (!entry.activation) {
				continue;
			}
			const normalizedEntryPath = resolve(entry.path);
			if (normalizedFilePath === normalizedEntryPath) {
				return entry.activation;
			}
			const prefix = normalizedEntryPath.endsWith(sep) ? normalizedEntryPath : `${normalizedEntryPath}${sep}`;
			if (normalizedFilePath.startsWith(prefix)) {
				return entry.activation;
			}
		}
		return undefined;
	}

	private findTargetsForResolvedPath(
		filePath: string,
		entries: ResolvedResourcePathEntry[],
	): ExtensionTarget[] | undefined {
		const normalizedFilePath = resolve(filePath);
		for (const entry of entries) {
			if (entry.targets === undefined) {
				continue;
			}
			const normalizedEntryPath = resolve(entry.path);
			if (normalizedFilePath === normalizedEntryPath) {
				return entry.targets;
			}
			const prefix = normalizedEntryPath.endsWith(sep) ? normalizedEntryPath : `${normalizedEntryPath}${sep}`;
			if (normalizedFilePath.startsWith(prefix)) {
				return entry.targets;
			}
		}
		return undefined;
	}

	private findIdForResolvedPath(filePath: string, entries: ResolvedResourcePathEntry[]): string | undefined {
		const normalizedFilePath = resolve(filePath);
		for (const entry of entries) {
			const normalizedEntryPath = resolve(entry.path);
			if (normalizedFilePath === normalizedEntryPath) return entry.id;
			const prefix = normalizedEntryPath.endsWith(sep) ? normalizedEntryPath : `${normalizedEntryPath}${sep}`;
			if (normalizedFilePath.startsWith(prefix)) return entry.id;
		}
		return undefined;
	}

	private findUIForResolvedPath(
		filePath: string,
		entries: ResolvedResourcePathEntry[],
	): ExtensionManifestUIV1 | undefined {
		const normalizedFilePath = resolve(filePath);
		for (const entry of entries) {
			if (!entry.ui) continue;
			const normalizedEntryPath = resolve(entry.path);
			if (
				normalizedFilePath === normalizedEntryPath ||
				normalizedFilePath.startsWith(`${normalizedEntryPath}${sep}`)
			)
				return entry.ui;
		}
		return undefined;
	}

	private findManifestForResolvedPath(
		filePath: string,
		entries: ResolvedResourcePathEntry[],
	): ExtensionManifestV1 | undefined {
		const normalizedFilePath = resolve(filePath);
		for (const entry of entries) {
			if (!entry.manifest) continue;
			const normalizedEntryPath = resolve(entry.path);
			if (
				normalizedFilePath === normalizedEntryPath ||
				normalizedFilePath.startsWith(`${normalizedEntryPath}${sep}`)
			) {
				return entry.manifest;
			}
		}
		return undefined;
	}

	private addAutoDiscoveredResources(
		accumulator: ResourceAccumulator,
		globalSettings: ReturnType<SettingsManager["getGlobalSettings"]>,
		projectSettings: ReturnType<SettingsManager["getProjectSettings"]>,
		globalBaseDir: string,
		projectBaseDir: string,
	): void {
		const userMetadata: PathMetadata = {
			source: "auto",
			scope: "user",
			origin: "top-level",
			baseDir: globalBaseDir,
		};
		const projectMetadata: PathMetadata = {
			source: "auto",
			scope: "project",
			origin: "top-level",
			baseDir: projectBaseDir,
		};

		const userOverrides = {
			extensions: getResourceEntryPaths(getSettingsResourceEntries(globalSettings, "extensions")),
			skills: getSettingsStringEntries(globalSettings, "skills"),
			prompts: getSettingsStringEntries(globalSettings, "prompts"),
			themes: getSettingsStringEntries(globalSettings, "themes"),
		};
		const projectOverrides = {
			extensions: getResourceEntryPaths(getSettingsResourceEntries(projectSettings, "extensions")),
			skills: getSettingsStringEntries(projectSettings, "skills"),
			prompts: getSettingsStringEntries(projectSettings, "prompts"),
			themes: getSettingsStringEntries(projectSettings, "themes"),
		};
		const userExtensionEntries = getSettingsResourceEntries(globalSettings, "extensions");
		const projectExtensionEntries = getSettingsResourceEntries(projectSettings, "extensions");

		const userDirs = {
			extensions: join(globalBaseDir, "extensions"),
			skills: join(globalBaseDir, "skills"),
			prompts: join(globalBaseDir, "prompts"),
			themes: join(globalBaseDir, "themes"),
		};
		const projectDirs = {
			extensions: join(projectBaseDir, "extensions"),
			skills: join(projectBaseDir, "skills"),
			prompts: join(projectBaseDir, "prompts"),
			themes: join(projectBaseDir, "themes"),
		};
		const userAgentsSkillsDir = join(getHomeDir(), ".agents", "skills");
		const projectAgentsSkillDirs = collectAncestorAgentsSkillDirs(this.cwd).filter(
			(dir) => resolve(dir) !== resolve(userAgentsSkillsDir),
		);

		const addResources = (
			resourceType: ResourceType,
			paths: string[],
			metadata: PathMetadata,
			overrides: string[],
			baseDir: string,
			activationEntries?: ResourcePathEntry[],
		) => {
			const target = this.getTargetMap(accumulator, resourceType);
			for (const path of paths) {
				const enabled = isEnabledByOverrides(path, overrides, baseDir);
				const activation =
					resourceType === "extensions" && activationEntries
						? this.findActivationForPath(path, activationEntries, baseDir)
						: undefined;
				this.addResource(target, path, withExtensionMetadata(metadata, activation, undefined), enabled);
			}
		};

		const addExtensionResources = (
			entries: ExtensionDiscoveryEntry[],
			metadata: PathMetadata,
			overrides: string[],
			baseDir: string,
			activationEntries: ResourcePathEntry[],
		) => {
			const target = this.getTargetMap(accumulator, "extensions");
			for (const entry of entries) {
				const enabled = isEnabledByOverrides(entry.path, overrides, baseDir);
				const activation = this.findActivationForPath(entry.path, activationEntries, baseDir) ?? entry.activation;
				const targets = this.findTargetsForPath(entry.path, activationEntries, baseDir) ?? entry.targets;
				const extensionId = this.findIdForPath(entry.path, activationEntries, baseDir) ?? entry.id;
				const extensionUI = this.findUIForPath(entry.path, activationEntries, baseDir) ?? entry.ui;
				const extensionManifest =
					this.findManifestForPath(entry.path, activationEntries, baseDir) ?? entry.manifest;
				this.addResource(
					target,
					entry.path,
					withExtensionMetadata(metadata, activation, targets, extensionId, extensionUI, extensionManifest),
					enabled,
				);
			}
		};

		// Project extensions from .pi/
		addExtensionResources(
			collectAutoExtensionEntries(projectDirs.extensions),
			projectMetadata,
			projectOverrides.extensions,
			projectBaseDir,
			projectExtensionEntries,
		);

		// Project skills from .pi/
		addResources(
			"skills",
			collectAutoSkillEntries(projectDirs.skills, "pi"),
			projectMetadata,
			projectOverrides.skills,
			projectBaseDir,
		);

		// Project skills from .agents/ (each with its own baseDir)
		for (const agentsSkillsDir of projectAgentsSkillDirs) {
			const agentsBaseDir = dirname(agentsSkillsDir); // the .agents directory
			const agentsMetadata: PathMetadata = {
				...projectMetadata,
				baseDir: agentsBaseDir,
			};
			addResources(
				"skills",
				collectAutoSkillEntries(agentsSkillsDir, "agents"),
				agentsMetadata,
				projectOverrides.skills,
				agentsBaseDir,
			);
		}

		addResources(
			"prompts",
			collectAutoPromptEntries(projectDirs.prompts),
			projectMetadata,
			projectOverrides.prompts,
			projectBaseDir,
		);
		addResources(
			"themes",
			collectAutoThemeEntries(projectDirs.themes),
			projectMetadata,
			projectOverrides.themes,
			projectBaseDir,
		);

		// User extensions from ~/.pi/agent/
		addExtensionResources(
			collectAutoExtensionEntries(userDirs.extensions),
			userMetadata,
			userOverrides.extensions,
			globalBaseDir,
			userExtensionEntries,
		);

		// User skills from ~/.pi/agent/
		addResources(
			"skills",
			collectAutoSkillEntries(userDirs.skills, "pi"),
			userMetadata,
			userOverrides.skills,
			globalBaseDir,
		);

		// User skills from ~/.agents/ (with its own baseDir)
		const userAgentsBaseDir = dirname(userAgentsSkillsDir);
		const userAgentsMetadata: PathMetadata = {
			...userMetadata,
			baseDir: userAgentsBaseDir,
		};
		addResources(
			"skills",
			collectAutoSkillEntries(userAgentsSkillsDir, "agents"),
			userAgentsMetadata,
			userOverrides.skills,
			userAgentsBaseDir,
		);

		addResources(
			"prompts",
			collectAutoPromptEntries(userDirs.prompts),
			userMetadata,
			userOverrides.prompts,
			globalBaseDir,
		);
		addResources(
			"themes",
			collectAutoThemeEntries(userDirs.themes),
			userMetadata,
			userOverrides.themes,
			globalBaseDir,
		);
	}

	private collectFilesFromPaths(paths: string[], resourceType: ResourceType): string[] {
		const files: string[] = [];
		for (const p of paths) {
			if (!existsSync(p)) continue;

			try {
				const stats = statSync(p);
				if (stats.isFile()) {
					files.push(p);
				} else if (stats.isDirectory()) {
					files.push(...collectResourceFiles(p, resourceType));
				}
			} catch {
				// Ignore errors
			}
		}
		return files;
	}

	private getTargetMap(
		accumulator: ResourceAccumulator,
		resourceType: ResourceType,
	): Map<string, { metadata: PathMetadata; enabled: boolean }> {
		switch (resourceType) {
			case "extensions":
				return accumulator.extensions;
			case "skills":
				return accumulator.skills;
			case "prompts":
				return accumulator.prompts;
			case "themes":
				return accumulator.themes;
			default:
				throw new Error(`Unknown resource type: ${resourceType}`);
		}
	}

	private addResource(
		map: Map<string, { metadata: PathMetadata; enabled: boolean }>,
		path: string,
		metadata: PathMetadata,
		enabled: boolean,
	): void {
		if (!path) return;
		if (!map.has(path)) {
			map.set(path, { metadata, enabled });
		}
	}

	private createAccumulator(): ResourceAccumulator {
		return {
			extensions: new Map(),
			skills: new Map(),
			prompts: new Map(),
			themes: new Map(),
		};
	}

	private resolveExtensionManifestGraph(entries: ResolvedResource[]): ResolvedResource[] {
		const hostVersion = this.hostVersions[this.extensionTarget];
		const originalIndex = new Map(entries.map((entry, index) => [entry, index]));
		const byId = new Map<string, ResolvedResource>();

		const addDiagnostic = (entry: ResolvedResource, diagnostic: ExtensionManifestDiagnostic): void => {
			const diagnostics = entry.metadata.extensionManifestDiagnostics ?? [];
			if (
				diagnostics.some(
					(existing) =>
						existing.code === diagnostic.code && existing.relatedExtensionId === diagnostic.relatedExtensionId,
				)
			) {
				return;
			}
			diagnostics.push(diagnostic);
			entry.metadata.extensionManifestDiagnostics = diagnostics;
		};

		const block = (entry: ResolvedResource, diagnostic: ExtensionManifestDiagnostic): void => {
			addDiagnostic(entry, diagnostic);
			entry.enabled = false;
		};

		for (const entry of entries) {
			entry.metadata.extensionHostVersion = hostVersion;
			entry.metadata.extensionManifestDiagnostics = [];
			const id = entry.metadata.extensionId;
			if (!id) continue;
			const winner = byId.get(id);
			if (winner) {
				block(entry, {
					code: "duplicate-id",
					severity: "error",
					message: `Extension id "${id}" conflicts with ${winner.path}`,
					relatedExtensionId: id,
				});
				continue;
			}
			byId.set(id, entry);
		}

		for (const entry of entries) {
			const id = entry.metadata.extensionId;
			const manifest = entry.metadata.extensionManifest;
			if (!id || !manifest) {
				if (id) {
					addDiagnostic(entry, {
						code: "legacy-manifest",
						severity: "warning",
						message:
							"Local extension has no versioned manifest; dependency and host compatibility cannot be verified",
					});
				}
				continue;
			}
			const engineRange = manifest.engines[this.extensionTarget]!;
			if (!satisfies(hostVersion, engineRange, { includePrerelease: true })) {
				block(entry, {
					code: "host-incompatible",
					severity: "error",
					message: `${manifest.name} ${manifest.version} requires ${this.extensionTarget} ${engineRange}, current version is ${hostVersion}`,
				});
			}
		}

		const checkDependency = (
			entry: ResolvedResource,
			dependencyId: string,
			range: string,
			optional: boolean,
		): void => {
			const dependency = byId.get(dependencyId);
			if (!dependency || !dependency.enabled) {
				const diagnostic: ExtensionManifestDiagnostic = {
					code: optional ? "optional-dependency-missing" : "missing-dependency",
					severity: optional ? "warning" : "error",
					message: `${optional ? "Optional dependency" : "Required dependency"} ${dependencyId} ${range} is not available`,
					relatedExtensionId: dependencyId,
				};
				if (optional) addDiagnostic(entry, diagnostic);
				else block(entry, diagnostic);
				return;
			}
			const dependencyVersion = dependency.metadata.extensionManifest?.version;
			if (!dependencyVersion || !satisfies(dependencyVersion, range, { includePrerelease: true })) {
				const diagnostic: ExtensionManifestDiagnostic = {
					code: optional ? "optional-dependency-version-mismatch" : "dependency-version-mismatch",
					severity: optional ? "warning" : "error",
					message: `${optional ? "Optional dependency" : "Required dependency"} ${dependencyId} must satisfy ${range}; found ${dependencyVersion ?? "an unversioned extension"}`,
					relatedExtensionId: dependencyId,
				};
				if (optional) addDiagnostic(entry, diagnostic);
				else block(entry, diagnostic);
			}
		};

		for (const entry of entries) {
			const manifest = entry.metadata.extensionManifest;
			if (!manifest || !entry.enabled) continue;
			for (const [dependencyId, range] of Object.entries(manifest.dependencies ?? {})) {
				checkDependency(entry, dependencyId, range, false);
			}
			for (const [dependencyId, range] of Object.entries(manifest.optionalDependencies ?? {})) {
				checkDependency(entry, dependencyId, range, true);
			}
		}

		const conflictCandidates = new Set(entries.filter((entry) => entry.enabled));
		for (const entry of entries) {
			const manifest = entry.metadata.extensionManifest;
			if (!manifest || !entry.enabled) continue;
			for (const [conflictId, range] of Object.entries(manifest.conflicts ?? {})) {
				const conflict = byId.get(conflictId);
				if (!conflict || !conflictCandidates.has(conflict)) continue;
				const conflictVersion = conflict.metadata.extensionManifest?.version;
				if (conflictVersion && !satisfies(conflictVersion, range, { includePrerelease: true })) continue;
				block(entry, {
					code: "conflict",
					severity: "error",
					message: `Conflicts with ${conflictId} ${conflictVersion ?? "(unversioned)"} in range ${range}`,
					relatedExtensionId: conflictId,
				});
			}
		}

		const visitState = new Map<string, "visiting" | "visited">();
		const stack: string[] = [];
		const cycleIds = new Set<string>();
		const visitDependencies = (id: string): void => {
			const state = visitState.get(id);
			if (state === "visited") return;
			if (state === "visiting") {
				const cycleStart = stack.lastIndexOf(id);
				for (const cycleId of stack.slice(Math.max(0, cycleStart))) cycleIds.add(cycleId);
				return;
			}
			visitState.set(id, "visiting");
			stack.push(id);
			const entry = byId.get(id);
			if (entry?.enabled) {
				for (const dependencyId of Object.keys(entry.metadata.extensionManifest?.dependencies ?? {})) {
					if (byId.get(dependencyId)?.enabled) visitDependencies(dependencyId);
				}
			}
			stack.pop();
			visitState.set(id, "visited");
		};
		for (const [id, entry] of byId) {
			if (entry.enabled) visitDependencies(id);
		}
		for (const id of cycleIds) {
			const entry = byId.get(id);
			if (!entry) continue;
			block(entry, {
				code: "dependency-cycle",
				severity: "error",
				message: `Required dependency cycle includes ${Array.from(cycleIds).sort().join(", ")}`,
			});
		}

		let propagated = true;
		while (propagated) {
			propagated = false;
			for (const entry of entries) {
				if (!entry.enabled) continue;
				for (const [dependencyId, range] of Object.entries(entry.metadata.extensionManifest?.dependencies ?? {})) {
					if (byId.get(dependencyId)?.enabled) continue;
					block(entry, {
						code: "missing-dependency",
						severity: "error",
						message: `Required dependency ${dependencyId} ${range} is blocked`,
						relatedExtensionId: dependencyId,
					});
					propagated = true;
					break;
				}
			}
		}

		const activeEntries = entries.filter((entry) => entry.enabled && entry.metadata.extensionId);
		const activeIds = new Set(activeEntries.map((entry) => entry.metadata.extensionId!));
		const outgoing = new Map<string, Set<string>>();
		const indegree = new Map<string, number>(Array.from(activeIds, (id) => [id, 0]));
		const addEdge = (from: string, to: string): void => {
			if (from === to || !activeIds.has(from) || !activeIds.has(to)) return;
			const targets = outgoing.get(from) ?? new Set<string>();
			if (targets.has(to)) return;
			targets.add(to);
			outgoing.set(from, targets);
			indegree.set(to, (indegree.get(to) ?? 0) + 1);
		};
		for (const entry of activeEntries) {
			const id = entry.metadata.extensionId!;
			const manifest = entry.metadata.extensionManifest;
			for (const dependencyId of Object.keys(manifest?.dependencies ?? {})) addEdge(dependencyId, id);
			for (const afterId of manifest?.loadOrder?.after ?? []) addEdge(afterId, id);
			for (const beforeId of manifest?.loadOrder?.before ?? []) addEdge(id, beforeId);
		}
		const compareEntries = (a: ResolvedResource, b: ResolvedResource): number => {
			const priorityA = a.metadata.extensionManifest?.loadOrder?.priority ?? 0;
			const priorityB = b.metadata.extensionManifest?.loadOrder?.priority ?? 0;
			return (
				priorityB - priorityA ||
				resourcePrecedenceRank(a.metadata) - resourcePrecedenceRank(b.metadata) ||
				(a.metadata.extensionId ?? a.path).localeCompare(b.metadata.extensionId ?? b.path)
			);
		};
		const ready = activeEntries
			.filter((entry) => indegree.get(entry.metadata.extensionId!) === 0)
			.sort(compareEntries);
		const ordered: ResolvedResource[] = [];
		const orderedIds = new Set<string>();
		while (ready.length > 0) {
			const entry = ready.shift()!;
			const id = entry.metadata.extensionId!;
			if (orderedIds.has(id)) continue;
			ordered.push(entry);
			orderedIds.add(id);
			for (const targetId of outgoing.get(id) ?? []) {
				const nextDegree = (indegree.get(targetId) ?? 0) - 1;
				indegree.set(targetId, nextDegree);
				if (nextDegree === 0) {
					const target = byId.get(targetId);
					if (target) {
						ready.push(target);
						ready.sort(compareEntries);
					}
				}
			}
		}
		const orderCycleEntries = activeEntries.filter((entry) => !orderedIds.has(entry.metadata.extensionId!));
		for (const entry of orderCycleEntries) {
			addDiagnostic(entry, {
				code: "load-order-cycle",
				severity: "warning",
				message: "Load-order hints form a cycle; deterministic priority and id ordering is used",
			});
		}
		ordered.push(...orderCycleEntries.sort(compareEntries));

		for (const entry of entries) {
			const diagnostics = entry.metadata.extensionManifestDiagnostics ?? [];
			const status: ExtensionManifestStatus = diagnostics.some((diagnostic) => diagnostic.severity === "error")
				? "blocked"
				: !entry.metadata.extensionManifest
					? "legacy"
					: diagnostics.length > 0
						? "warning"
						: "compatible";
			entry.metadata.extensionManifestStatus = status;
			entry.metadata.extensionLoadable = entry.enabled && status !== "blocked";
		}

		const inactive = entries
			.filter((entry) => !ordered.includes(entry))
			.sort((a, b) => (originalIndex.get(a) ?? 0) - (originalIndex.get(b) ?? 0));
		return [...ordered, ...inactive];
	}

	private toResolvedPaths(accumulator: ResourceAccumulator): ResolvedPaths {
		const mapToResolved = (
			entries: Map<string, { metadata: PathMetadata; enabled: boolean }>,
			resourceType: ResourceType,
		): ResolvedResource[] => {
			let resolved = Array.from(entries.entries()).map(([path, { metadata, enabled }]) => ({
				path,
				enabled,
				metadata,
			}));
			if (resourceType === "extensions") {
				resolved = resolved.filter((entry) => extensionTargetsMatch(entry.metadata, this.extensionTarget));
			}
			resolved.sort((a, b) => resourcePrecedenceRank(a.metadata) - resourcePrecedenceRank(b.metadata));

			const seen = new Set<string>();
			const deduplicated = resolved.filter((entry) => {
				const canonicalPath = canonicalizePath(entry.path);
				if (seen.has(canonicalPath)) return false;
				seen.add(canonicalPath);
				return true;
			});
			return resourceType === "extensions" ? this.resolveExtensionManifestGraph(deduplicated) : deduplicated;
		};

		return {
			extensions: mapToResolved(accumulator.extensions, "extensions"),
			skills: mapToResolved(accumulator.skills, "skills"),
			prompts: mapToResolved(accumulator.prompts, "prompts"),
			themes: mapToResolved(accumulator.themes, "themes"),
		};
	}

	private spawnCommand(command: string, args: string[], options?: { cwd?: string }): ChildProcess {
		const env = getEnv();
		return spawnProcess(command, args, {
			cwd: options?.cwd,
			stdio: isStdoutTakenOver() ? ["ignore", 2, 2] : "inherit",
			env,
		});
	}

	private spawnCaptureCommand(
		command: string,
		args: string[],
		options?: { cwd?: string; env?: Record<string, string> },
	): ChildProcessByStdio<null, Readable, Readable> {
		const baseEnv = getEnv();
		const env = options?.env ? { ...baseEnv, ...options.env } : baseEnv;
		return spawnProcess(command, args, {
			cwd: options?.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env,
		});
	}

	private runCommandCapture(
		command: string,
		args: string[],
		options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> },
	): Promise<string> {
		return new Promise((resolvePromise, reject) => {
			const child = this.spawnCaptureCommand(command, args, options);
			let stdout = "";
			let stderr = "";
			let timedOut = false;
			const timeout =
				typeof options?.timeoutMs === "number"
					? setTimeout(() => {
							timedOut = true;
							child.kill();
						}, options.timeoutMs)
					: undefined;

			child.stdout?.on("data", (data) => {
				stdout += data.toString();
			});
			child.stderr?.on("data", (data) => {
				stderr += data.toString();
			});
			child.once("error", (error) => {
				if (timeout) clearTimeout(timeout);
				reject(error);
			});
			child.once("close", (code, signal) => {
				if (timeout) clearTimeout(timeout);
				if (timedOut) {
					reject(new Error(`${command} ${args.join(" ")} timed out after ${options?.timeoutMs}ms`));
					return;
				}
				if (code === 0) {
					resolvePromise(stdout.trim());
					return;
				}
				const exitStatus = code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`;
				reject(new Error(`${command} ${args.join(" ")} failed with ${exitStatus}: ${stderr || stdout}`));
			});
		});
	}

	private runCommand(command: string, args: string[], options?: { cwd?: string }): Promise<void> {
		return new Promise((resolvePromise, reject) => {
			const child = this.spawnCommand(command, args, options);
			child.on("error", reject);
			child.on("exit", (code) => {
				if (code === 0) {
					resolvePromise();
				} else {
					reject(new Error(`${command} ${args.join(" ")} failed with code ${code}`));
				}
			});
		});
	}

	private runCommandSync(command: string, args: string[]): string {
		const env = getEnv();
		const result = spawnProcessSync(command, args, {
			stdio: ["ignore", "pipe", "pipe"],
			encoding: "utf-8",
			env,
		});
		if (result.error || result.status !== 0) {
			throw new Error(
				`Failed to run ${command} ${args.join(" ")}: ${result.error?.message || result.stderr || result.stdout}`,
			);
		}
		return (result.stdout || result.stderr || "").trim();
	}
}
