import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import chalk from "chalk";
import { getProjectConfigDir } from "../config.ts";
import type { ResourceDiagnostic } from "./diagnostics.ts";

export type { ResourceCollision, ResourceDiagnostic } from "./diagnostics.ts";

import { canonicalizePath, isLocalPath, resolvePath } from "../utils/paths.ts";
import { createEventBus, type EventBus } from "./event-bus.ts";
import {
	createExtensionRuntime,
	type ExtensionLoadMetadata,
	loadExtensionFromFactory,
	loadExtensions,
	loadExtensionsIntoRuntime,
} from "./extensions/loader.ts";
import type {
	Extension,
	ExtensionActivation,
	ExtensionFactory,
	ExtensionRuntime,
	LoadExtensionsResult,
} from "./extensions/types.ts";
import type { PromptTemplate } from "./prompt-templates.ts";
import { loadPromptTemplates } from "./prompt-templates.ts";
import {
	type PathMetadata,
	type ResolvedPaths,
	type ResolvedResource,
	type ResourcePathEntry,
	ResourceResolver,
} from "./resource-resolver.ts";
import { SettingsManager } from "./settings-manager.ts";
import type { Skill } from "./skills.ts";
import { loadSkills } from "./skills.ts";
import { createSourceInfo, type SourceInfo } from "./source-info.ts";

export interface ResourceExtensionPaths {
	skillPaths?: Array<{ path: string; metadata: PathMetadata }>;
	promptPaths?: Array<{ path: string; metadata: PathMetadata }>;
}

export interface ResourceLoader {
	getExtensions(): LoadExtensionsResult;
	getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] };
	getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] };
	getAgentsFiles(): { agentsFiles: Array<{ path: string; content: string }> };
	getSystemPrompt(): string | undefined;
	getAppendSystemPrompt(): string[];
	extendResources(paths: ResourceExtensionPaths): void;
	reload(options?: ResourceReloadOptions): Promise<void>;
	loadPhase?(phase: ResourceLoadPhase): Promise<boolean>;
}

export type ResourceLoadPhase = "startup" | "beforeFirstRequest" | "full";

export interface ResourceReloadOptions {
	phase?: ResourceLoadPhase;
}

interface ResourceResolutionSnapshot {
	resolvedPaths: ResolvedPaths;
	cliExtensionPaths: ResolvedPaths;
	metadataByPath: Map<string, PathMetadata>;
}

interface ResourceResolutionSnapshotCacheEntry {
	generation: string;
	snapshot: Promise<ResourceResolutionSnapshot>;
}

const MAX_RESOURCE_SNAPSHOT_CACHE_ENTRIES = 64;
const resourceResolutionSnapshotCache = new Map<string, ResourceResolutionSnapshotCacheEntry>();

function fileGeneration(path: string): string {
	try {
		const stats = statSync(path);
		return `${stats.mtimeMs}:${stats.size}`;
	} catch {
		return "missing";
	}
}

function cloneResolvedPaths(paths: ResolvedPaths): ResolvedPaths {
	return {
		extensions: paths.extensions.map((resource) => ({ ...resource, metadata: { ...resource.metadata } })),
		skills: paths.skills.map((resource) => ({ ...resource, metadata: { ...resource.metadata } })),
		prompts: paths.prompts.map((resource) => ({ ...resource, metadata: { ...resource.metadata } })),
	};
}

function cloneResourceResolutionSnapshot(snapshot: ResourceResolutionSnapshot): ResourceResolutionSnapshot {
	return {
		resolvedPaths: cloneResolvedPaths(snapshot.resolvedPaths),
		cliExtensionPaths: cloneResolvedPaths(snapshot.cliExtensionPaths),
		metadataByPath: new Map(
			Array.from(snapshot.metadataByPath, ([path, metadata]) => [path, { ...metadata }] as const),
		),
	};
}

type LocalExtensionSource = ResourcePathEntry;

interface StartupExtensionEntry {
	id: string;
	path: string;
}

function resolvePromptInput(input: string | undefined, description: string): string | undefined {
	if (!input) {
		return undefined;
	}

	if (existsSync(input)) {
		try {
			return readFileSync(input, "utf-8");
		} catch (error) {
			console.error(chalk.yellow(`Warning: Could not read ${description} file ${input}: ${error}`));
			return input;
		}
	}

	return input;
}

function loadContextFileFromDir(dir: string): { path: string; content: string } | null {
	const candidates = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
	for (const filename of candidates) {
		const filePath = join(dir, filename);
		if (existsSync(filePath)) {
			try {
				return {
					path: filePath,
					content: readFileSync(filePath, "utf-8"),
				};
			} catch (error) {
				console.error(chalk.yellow(`Warning: Could not read ${filePath}: ${error}`));
			}
		}
	}
	return null;
}

function getLocalExtensionPath(entry: LocalExtensionSource): string {
	return typeof entry === "string" ? entry : entry.path;
}

function getLocalExtensionActivation(entry: LocalExtensionSource): ExtensionActivation | undefined {
	return typeof entry === "string" ? undefined : entry.activation;
}

function getLocalExtensionId(entry: LocalExtensionSource): string | undefined {
	return typeof entry === "string" ? undefined : entry.id?.trim();
}

function withStartupExtensionMetadata(metadata: PathMetadata, extensionId?: string): PathMetadata {
	const next: PathMetadata = { ...metadata, activation: "startup", extensionId };
	return next;
}

export function loadProjectContextFiles(options: {
	cwd: string;
	agentDir: string;
}): Array<{ path: string; content: string }> {
	const resolvedCwd = resolvePath(options.cwd);
	const resolvedAgentDir = resolvePath(options.agentDir);

	const contextFiles: Array<{ path: string; content: string }> = [];
	const seenPaths = new Set<string>();

	const globalContext = loadContextFileFromDir(resolvedAgentDir);
	if (globalContext) {
		contextFiles.push(globalContext);
		seenPaths.add(globalContext.path);
	}

	const ancestorContextFiles: Array<{ path: string; content: string }> = [];

	let currentDir = resolvedCwd;
	const root = resolve("/");

	while (true) {
		const contextFile = loadContextFileFromDir(currentDir);
		if (contextFile && !seenPaths.has(contextFile.path)) {
			ancestorContextFiles.unshift(contextFile);
			seenPaths.add(contextFile.path);
		}

		if (currentDir === root) break;

		const parentDir = resolve(currentDir, "..");
		if (parentDir === currentDir) break;
		currentDir = parentDir;
	}

	contextFiles.push(...ancestorContextFiles);

	return contextFiles;
}

export interface DefaultResourceLoaderOptions {
	cwd: string;
	agentDir: string;
	/** Project-local config directory name. Defaults to the standalone Pi directory. */
	projectConfigDir?: string;
	settingsManager?: SettingsManager;
	eventBus?: EventBus;
	additionalExtensionPaths?: ResourcePathEntry[];
	additionalSkillPaths?: string[];
	additionalPromptTemplatePaths?: string[];
	extensionFactories?: ExtensionFactory[];
	noExtensions?: boolean;
	noSkills?: boolean;
	noPromptTemplates?: boolean;
	noContextFiles?: boolean;
	systemPrompt?: string;
	appendSystemPrompt?: string[];
	extensionsOverride?: (base: LoadExtensionsResult) => LoadExtensionsResult;
	skillsOverride?: (base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => {
		skills: Skill[];
		diagnostics: ResourceDiagnostic[];
	};
	promptsOverride?: (base: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] }) => {
		prompts: PromptTemplate[];
		diagnostics: ResourceDiagnostic[];
	};
	agentsFilesOverride?: (base: { agentsFiles: Array<{ path: string; content: string }> }) => {
		agentsFiles: Array<{ path: string; content: string }>;
	};
	systemPromptOverride?: (base: string | undefined) => string | undefined;
	appendSystemPromptOverride?: (base: string[]) => string[];
}

export class DefaultResourceLoader implements ResourceLoader {
	private cwd: string;
	private agentDir: string;
	private projectConfigDir: string;
	private settingsManager: SettingsManager;
	private eventBus: EventBus;
	private resourceResolver: ResourceResolver | undefined;
	private additionalExtensionPaths: LocalExtensionSource[];
	private additionalSkillPaths: string[];
	private additionalPromptTemplatePaths: string[];
	private extensionFactories: ExtensionFactory[];
	private noExtensions: boolean;
	private noSkills: boolean;
	private noPromptTemplates: boolean;
	private noContextFiles: boolean;
	private systemPromptSource?: string;
	private appendSystemPromptSource?: string[];
	private extensionsOverride?: (base: LoadExtensionsResult) => LoadExtensionsResult;
	private skillsOverride?: (base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => {
		skills: Skill[];
		diagnostics: ResourceDiagnostic[];
	};
	private promptsOverride?: (base: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] }) => {
		prompts: PromptTemplate[];
		diagnostics: ResourceDiagnostic[];
	};
	private agentsFilesOverride?: (base: { agentsFiles: Array<{ path: string; content: string }> }) => {
		agentsFiles: Array<{ path: string; content: string }>;
	};
	private systemPromptOverride?: (base: string | undefined) => string | undefined;
	private appendSystemPromptOverride?: (base: string[]) => string[];

	private extensionsResult: LoadExtensionsResult;
	private skills: Skill[];
	private skillDiagnostics: ResourceDiagnostic[];
	private prompts: PromptTemplate[];
	private promptDiagnostics: ResourceDiagnostic[];
	private agentsFiles: Array<{ path: string; content: string }>;
	private systemPrompt?: string;
	private appendSystemPrompt: string[];
	private lastSkillPaths: string[];
	private extensionSkillSourceInfos: Map<string, SourceInfo>;
	private extensionPromptSourceInfos: Map<string, SourceInfo>;
	private lastPromptPaths: string[];
	private loadedResourcePhase: ResourceLoadPhase | undefined;

	constructor(options: DefaultResourceLoaderOptions) {
		this.cwd = resolvePath(options.cwd);
		this.agentDir = resolvePath(options.agentDir);
		this.projectConfigDir = options.projectConfigDir ?? getProjectConfigDir();
		this.settingsManager =
			options.settingsManager ?? SettingsManager.create(this.cwd, this.agentDir, this.projectConfigDir);
		this.eventBus = options.eventBus ?? createEventBus();
		this.additionalExtensionPaths = options.additionalExtensionPaths ?? [];
		this.additionalSkillPaths = options.additionalSkillPaths ?? [];
		this.additionalPromptTemplatePaths = options.additionalPromptTemplatePaths ?? [];
		this.extensionFactories = options.extensionFactories ?? [];
		this.noExtensions = options.noExtensions ?? false;
		this.noSkills = options.noSkills ?? false;
		this.noPromptTemplates = options.noPromptTemplates ?? false;
		this.noContextFiles = options.noContextFiles ?? false;
		this.systemPromptSource = options.systemPrompt;
		this.appendSystemPromptSource = options.appendSystemPrompt;
		this.extensionsOverride = options.extensionsOverride;
		this.skillsOverride = options.skillsOverride;
		this.promptsOverride = options.promptsOverride;
		this.agentsFilesOverride = options.agentsFilesOverride;
		this.systemPromptOverride = options.systemPromptOverride;
		this.appendSystemPromptOverride = options.appendSystemPromptOverride;

		this.extensionsResult = { extensions: [], errors: [], runtime: createExtensionRuntime() };
		this.skills = [];
		this.skillDiagnostics = [];
		this.prompts = [];
		this.promptDiagnostics = [];
		this.agentsFiles = [];
		this.appendSystemPrompt = [];
		this.lastSkillPaths = [];
		this.extensionSkillSourceInfos = new Map();
		this.extensionPromptSourceInfos = new Map();
		this.lastPromptPaths = [];
		this.loadedResourcePhase = undefined;
	}

	getExtensions(): LoadExtensionsResult {
		return this.extensionsResult;
	}

	getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] } {
		return { skills: this.skills, diagnostics: this.skillDiagnostics };
	}

	getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] } {
		return { prompts: this.prompts, diagnostics: this.promptDiagnostics };
	}

	getAgentsFiles(): { agentsFiles: Array<{ path: string; content: string }> } {
		return { agentsFiles: this.agentsFiles };
	}

	getSystemPrompt(): string | undefined {
		return this.systemPrompt;
	}

	getAppendSystemPrompt(): string[] {
		return this.appendSystemPrompt;
	}

	extendResources(paths: ResourceExtensionPaths): void {
		const skillPaths = this.normalizeExtensionPaths(paths.skillPaths ?? []);
		const promptPaths = this.normalizeExtensionPaths(paths.promptPaths ?? []);

		for (const entry of skillPaths) {
			this.extensionSkillSourceInfos.set(entry.path, createSourceInfo(entry.path, entry.metadata));
		}
		for (const entry of promptPaths) {
			this.extensionPromptSourceInfos.set(entry.path, createSourceInfo(entry.path, entry.metadata));
		}

		if (skillPaths.length > 0) {
			this.lastSkillPaths = this.mergePaths(
				this.lastSkillPaths,
				skillPaths.map((entry) => entry.path),
			);
			this.updateSkillsFromPaths(this.lastSkillPaths);
		}

		if (promptPaths.length > 0) {
			this.lastPromptPaths = this.mergePaths(
				this.lastPromptPaths,
				promptPaths.map((entry) => entry.path),
			);
			this.updatePromptsFromPaths(this.lastPromptPaths);
		}
	}

	async reload(options: ResourceReloadOptions = {}): Promise<void> {
		const reloadStartedAt = performance.now();
		const phase = options.phase ?? "full";
		await this.settingsManager.reload();
		const settingsReadyAt = performance.now();
		const snapshot = await this.resolveResourceSnapshot(phase);
		const snapshotReadyAt = performance.now();
		const metadataByPath = snapshot.metadataByPath;

		this.extensionSkillSourceInfos = new Map();
		this.extensionPromptSourceInfos = new Map();

		// Keep disabled extensions discoverable through the catalog, but exclude
		// them before module evaluation so reload really unloads their runtime.
		const enabledExtensions = this.getEnabledResources(snapshot.resolvedPaths.extensions)
			.filter((resource) => !resource.metadata.extensionId || this.settingsManager.isExtensionEnabled(resource.metadata.extensionId, true))
			.map((resource) => resource.path);
		const enabledSkillResources = this.getEnabledResources(snapshot.resolvedPaths.skills);
		const enabledPrompts = this.getEnabledPaths(snapshot.resolvedPaths.prompts);

		const mapSkillPath = (resource: { path: string; metadata: PathMetadata }): string => {
			if (resource.metadata.source !== "auto" && resource.metadata.origin !== "package") {
				return resource.path;
			}
			try {
				const stats = statSync(resource.path);
				if (!stats.isDirectory()) {
					return resource.path;
				}
			} catch {
				return resource.path;
			}
			const skillFile = join(resource.path, "SKILL.md");
			if (existsSync(skillFile)) {
				if (!metadataByPath.has(skillFile)) {
					metadataByPath.set(skillFile, resource.metadata);
				}
				return skillFile;
			}
			return resource.path;
		};

		const enabledSkills = enabledSkillResources.map(mapSkillPath);

		// Add CLI paths metadata
		for (const r of snapshot.cliExtensionPaths.extensions) {
			if (!metadataByPath.has(r.path)) {
				metadataByPath.set(r.path, { source: "cli", scope: "temporary", origin: "top-level" });
			}
		}
		for (const r of snapshot.cliExtensionPaths.skills) {
			if (!metadataByPath.has(r.path)) {
				metadataByPath.set(r.path, { source: "cli", scope: "temporary", origin: "top-level" });
			}
		}

		const cliEnabledExtensions = this.getEnabledResources(snapshot.cliExtensionPaths.extensions)
			.filter((resource) => !resource.metadata.extensionId || this.settingsManager.isExtensionEnabled(resource.metadata.extensionId, true))
			.map((resource) => resource.path);
		const cliEnabledSkills = this.getEnabledPaths(snapshot.cliExtensionPaths.skills);
		const cliEnabledPrompts = this.getEnabledPaths(snapshot.cliExtensionPaths.prompts);

		const extensionActivationByPath = this.buildExtensionActivationMap([
			...snapshot.resolvedPaths.extensions,
			...snapshot.cliExtensionPaths.extensions,
		]);
		const extensionLoadMetadataByPath = this.buildExtensionLoadMetadataMap([
			...snapshot.resolvedPaths.extensions,
			...snapshot.cliExtensionPaths.extensions,
		]);
		const allExtensionPaths = this.noExtensions
			? cliEnabledExtensions
			: this.mergePaths(cliEnabledExtensions, enabledExtensions);
		const extensionPaths = this.filterExtensionPathsForPhase(allExtensionPaths, extensionActivationByPath, phase);
		const extensionsResult = await this.loadExtensionsForPhase(
			extensionPaths,
			extensionActivationByPath,
			extensionLoadMetadataByPath,
			phase,
		);
		for (const resource of [...snapshot.resolvedPaths.extensions, ...snapshot.cliExtensionPaths.extensions]) {
			for (const diagnostic of resource.metadata.extensionManifestDiagnostics ?? []) {
				if (diagnostic.severity !== "error") continue;
				if (
					!extensionsResult.errors.some(
						(existing) => existing.path === resource.path && existing.error === diagnostic.message,
					)
				) {
					extensionsResult.errors.push({ path: resource.path, error: diagnostic.message });
				}
			}
		}

		// Keep all extensions loaded. Conflicts are diagnostics; load order owns precedence.
		// Keep all extensions loaded. Conflicts are reported as diagnostics, and precedence is handled by load order.
		const conflicts = this.detectExtensionConflicts(extensionsResult.extensions);
		for (const conflict of conflicts) {
			extensionsResult.errors.push({ path: conflict.path, error: conflict.message });
		}

		for (const entry of this.additionalExtensionPaths) {
			const entryPath = getLocalExtensionPath(entry);
			if (isLocalPath(entryPath)) {
				const resolved = this.resolveResourcePath(entryPath);
				if (!existsSync(resolved)) {
					extensionsResult.errors.push({ path: resolved, error: `Extension path does not exist: ${resolved}` });
				}
			}
		}
		this.extensionsResult = this.extensionsOverride ? this.extensionsOverride(extensionsResult) : extensionsResult;

		// Filter out extensions disabled via settings.json (extensionConfig.<name>.enabled = false
		// or extensions.<name>.enabled = false for mortise compatibility)
		const filteredExtensions = this.extensionsResult.extensions.filter((ext) => {
			const extName = this.extractExtensionName(ext, metadataByPath);
			if (!extName) return true; // keep extensions whose name can't be determined
			return this.settingsManager.isExtensionEnabled(extName, true);
		});
		this.extensionsResult = { ...this.extensionsResult, extensions: filteredExtensions };

		this.applyExtensionSourceInfo(this.extensionsResult.extensions, metadataByPath);
		const extensionsReadyAt = performance.now();

		const shouldLoadRequestResources = phase !== "startup";
		const skillPaths = shouldLoadRequestResources
			? this.noSkills
				? this.mergePaths(cliEnabledSkills, this.additionalSkillPaths)
				: this.mergePaths([...cliEnabledSkills, ...enabledSkills], this.additionalSkillPaths)
			: [];
		this.lastSkillPaths = skillPaths;
		this.updateSkillsFromPaths(skillPaths, metadataByPath);
		if (shouldLoadRequestResources) {
			for (const p of this.additionalSkillPaths) {
				if (isLocalPath(p)) {
					const resolved = this.resolveResourcePath(p);
					if (!existsSync(resolved) && !this.skillDiagnostics.some((d) => d.path === resolved)) {
						this.skillDiagnostics.push({ type: "error", message: "Skill path does not exist", path: resolved });
					}
				}
			}
		}

		const promptPaths = shouldLoadRequestResources
			? this.noPromptTemplates
				? this.mergePaths(cliEnabledPrompts, this.additionalPromptTemplatePaths)
				: this.mergePaths([...cliEnabledPrompts, ...enabledPrompts], this.additionalPromptTemplatePaths)
			: [];

		this.lastPromptPaths = promptPaths;
		this.updatePromptsFromPaths(promptPaths, metadataByPath);
		if (shouldLoadRequestResources) {
			for (const p of this.additionalPromptTemplatePaths) {
				if (isLocalPath(p)) {
					const resolved = this.resolveResourcePath(p);
					if (!existsSync(resolved) && !this.promptDiagnostics.some((d) => d.path === resolved)) {
						this.promptDiagnostics.push({
							type: "error",
							message: "Prompt template path does not exist",
							path: resolved,
						});
					}
				}
			}
		}

		const agentsFiles = {
			agentsFiles:
				this.noContextFiles || !shouldLoadRequestResources
					? []
					: loadProjectContextFiles({ cwd: this.cwd, agentDir: this.agentDir }),
		};
		const resolvedAgentsFiles = this.agentsFilesOverride ? this.agentsFilesOverride(agentsFiles) : agentsFiles;
		this.agentsFiles = resolvedAgentsFiles.agentsFiles;

		const baseSystemPrompt = resolvePromptInput(
			this.systemPromptSource ?? this.discoverSystemPromptFile(),
			"system prompt",
		);
		this.systemPrompt = this.systemPromptOverride ? this.systemPromptOverride(baseSystemPrompt) : baseSystemPrompt;

		const appendSources =
			this.appendSystemPromptSource ??
			(this.discoverAppendSystemPromptFile() ? [this.discoverAppendSystemPromptFile()!] : []);
		const baseAppend = appendSources
			.map((s) => resolvePromptInput(s, "append system prompt"))
			.filter((s): s is string => s !== undefined);
		this.appendSystemPrompt = this.appendSystemPromptOverride
			? this.appendSystemPromptOverride(baseAppend)
			: baseAppend;
		if (process.env.PI_RUNTIME_PROFILE === "1") {
			console.error(
				JSON.stringify({
					scope: "pi-host",
					event: "resources.profile",
					cwd: this.cwd,
					phase,
					settingsMs: Math.round((settingsReadyAt - reloadStartedAt) * 100) / 100,
					snapshotMs: Math.round((snapshotReadyAt - settingsReadyAt) * 100) / 100,
					extensionsMs: Math.round((extensionsReadyAt - snapshotReadyAt) * 100) / 100,
					staticResourcesMs: Math.round((performance.now() - extensionsReadyAt) * 100) / 100,
				}),
			);
		}
		this.loadedResourcePhase = phase;
	}

	async loadPhase(phase: ResourceLoadPhase): Promise<boolean> {
		if (phase === "startup") {
			if (this.loadedResourcePhase) {
				return false;
			}
			await this.reload({ phase: "startup" });
			return true;
		}
		if (phase === "beforeFirstRequest") {
			if (this.loadedResourcePhase === "beforeFirstRequest" || this.loadedResourcePhase === "full") {
				return false;
			}
			await this.reload({ phase: "beforeFirstRequest" });
			return true;
		}
		await this.reload({ phase: "full" });
		return true;
	}

	private getResourceResolver(): ResourceResolver {
		if (!this.resourceResolver) {
			this.resourceResolver = new ResourceResolver({
				cwd: this.cwd,
				agentDir: this.agentDir,
				projectConfigDir: this.projectConfigDir,
				settingsManager: this.settingsManager,
			});
		}
		return this.resourceResolver;
	}

	private getResourceCacheKey(phase: ResourceLoadPhase): string {
		return JSON.stringify({
			cwd: this.cwd,
			agentDir: this.agentDir,
			additionalExtensionPaths: this.additionalExtensionPaths,
			additionalSkillPaths: this.additionalSkillPaths,
			additionalPromptTemplatePaths: this.additionalPromptTemplatePaths,
			noSkills: this.noSkills,
			noPromptTemplates: this.noPromptTemplates,
			noContextFiles: this.noContextFiles,
			systemPromptSource: this.systemPromptSource,
			appendSystemPromptSource: this.appendSystemPromptSource,
			phase,
		});
	}

	private getResourceCacheGeneration(): string {
		return [
			fileGeneration(join(this.agentDir, "settings.json")),
			fileGeneration(join(this.cwd, this.projectConfigDir, "settings.json")),
			fileGeneration(join(this.agentDir, "package.json")),
			fileGeneration(join(this.cwd, this.projectConfigDir, "package.json")),
		].join("|");
	}

	private async resolveResourceSnapshot(phase: ResourceLoadPhase): Promise<ResourceResolutionSnapshot> {
		if (phase === "startup") {
			return this.resolveStartupResourceSnapshot();
		}
		const cacheKey = this.getResourceCacheKey(phase);
		const generation = this.getResourceCacheGeneration();
		const cached = resourceResolutionSnapshotCache.get(cacheKey);
		if (cached?.generation === generation) {
			return cloneResourceResolutionSnapshot(await cached.snapshot);
		}

		const snapshot = this.resolveResourceSnapshotUncached();
		resourceResolutionSnapshotCache.set(cacheKey, { generation, snapshot });
		if (resourceResolutionSnapshotCache.size > MAX_RESOURCE_SNAPSHOT_CACHE_ENTRIES) {
			const oldestKey = resourceResolutionSnapshotCache.keys().next().value;
			if (oldestKey !== undefined) resourceResolutionSnapshotCache.delete(oldestKey);
		}
		try {
			return cloneResourceResolutionSnapshot(await snapshot);
		} catch (error) {
			if (resourceResolutionSnapshotCache.get(cacheKey)?.snapshot === snapshot) {
				resourceResolutionSnapshotCache.delete(cacheKey);
			}
			throw error;
		}
	}

	private async resolveResourceSnapshotUncached(): Promise<ResourceResolutionSnapshot> {
		const resourceResolver = this.getResourceResolver();
		const resolvedPaths = await resourceResolver.resolve();
		const cliExtensionPaths = await resourceResolver.resolveExtensionSources(this.additionalExtensionPaths);
		const metadataByPath = new Map<string, PathMetadata>();
		for (const resources of [
			resolvedPaths.extensions,
			resolvedPaths.skills,
			resolvedPaths.prompts,
			cliExtensionPaths.extensions,
			cliExtensionPaths.skills,
			cliExtensionPaths.prompts,
		]) {
			for (const resource of resources) {
				if (!metadataByPath.has(resource.path)) {
					metadataByPath.set(resource.path, resource.metadata);
				}
			}
		}
		return { resolvedPaths, cliExtensionPaths, metadataByPath };
	}

	private resolveStartupResourceSnapshot(): ResourceResolutionSnapshot {
		const emptyPaths = (): ResolvedPaths => ({ extensions: [], skills: [], prompts: [] });
		const resolvedPaths = emptyPaths();
		const cliExtensionPaths = emptyPaths();
		const metadataByPath = new Map<string, PathMetadata>();
		const globalSettings = this.settingsManager.getGlobalSettings();
		const projectSettings = this.settingsManager.getProjectSettings();
		const globalExtensionEntries = Array.isArray(globalSettings.extensions)
			? (globalSettings.extensions as LocalExtensionSource[])
			: [];
		const projectExtensionEntries = Array.isArray(projectSettings.extensions)
			? (projectSettings.extensions as LocalExtensionSource[])
			: [];

		const addStartupExtensions = (
			entries: LocalExtensionSource[],
			baseDir: string,
			scope: PathMetadata["scope"],
			source: PathMetadata["source"],
			target: ResolvedPaths,
		) => {
			for (const entry of entries) {
				const entryId = getLocalExtensionId(entry);
				if (!entryId) continue;
				if (getLocalExtensionActivation(entry) !== "startup") {
					continue;
				}
				const entryPath = getLocalExtensionPath(entry);
				if (!isLocalPath(entryPath)) {
					continue;
				}
				const resolvedEntryPath = resolvePath(entryPath, baseDir, { homeDir: this.agentDir, trim: true });
				const resolvedEntries = this.resolveStartupExtensionEntries(
					resolvedEntryPath,
					getLocalExtensionActivation(entry),
					entryId,
				);
				const metadata: PathMetadata = { source, scope, origin: "top-level", baseDir };
				for (const extensionEntry of resolvedEntries) {
					const extensionPath = extensionEntry.path;
					const extensionMetadata = withStartupExtensionMetadata(metadata, extensionEntry.id);
					if (!metadataByPath.has(extensionPath)) {
						metadataByPath.set(extensionPath, extensionMetadata);
					}
					target.extensions.push({
						path: extensionPath,
						enabled: true,
						metadata: extensionMetadata,
					});
				}
			}
		};

		addStartupExtensions(
			projectExtensionEntries,
			join(this.cwd, this.projectConfigDir),
			"project",
			"local",
			resolvedPaths,
		);
		addStartupExtensions(globalExtensionEntries, this.agentDir, "user", "local", resolvedPaths);
		addStartupExtensions(this.additionalExtensionPaths, this.cwd, "temporary", "cli", cliExtensionPaths);

		return { resolvedPaths, cliExtensionPaths, metadataByPath };
	}

	private resolveStartupExtensionEntries(
		entryPath: string,
		inheritedActivation: ExtensionActivation | undefined,
		inheritedId?: string,
	): StartupExtensionEntry[] {
		if (!existsSync(entryPath)) {
			return [];
		}
		try {
			const stats = statSync(entryPath);
			if (stats.isFile() && (entryPath.endsWith(".ts") || entryPath.endsWith(".js"))) {
				if (!inheritedId || !inheritedActivation) return [];
				return [{ id: inheritedId, path: entryPath }];
			}
			if (!stats.isDirectory()) {
				return [];
			}
		} catch {
			return [];
		}

		const packageJsonPath = join(entryPath, "package.json");
		if (existsSync(packageJsonPath)) {
			try {
				const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
					pi?: { extensions?: LocalExtensionSource[] };
				};
				const extensions = pkg.pi?.extensions ?? [];
				const startupEntries: StartupExtensionEntry[] = [];
				for (const extension of extensions) {
					const id = getLocalExtensionId(extension);
					if (!id) continue;
					const activation = inheritedActivation ?? getLocalExtensionActivation(extension);
					if (activation !== "startup") {
						continue;
					}
					const extensionPath = resolvePath(getLocalExtensionPath(extension), entryPath, {
						homeDir: this.agentDir,
						trim: true,
					});
					if (existsSync(extensionPath)) {
						startupEntries.push({
							id,
							path: extensionPath,
						});
					}
				}
				if (startupEntries.length > 0) {
					return startupEntries;
				}
			} catch {
				return [];
			}
		}

		return [];
	}

	private getEnabledResources(resources: ResolvedResource[]): ResolvedResource[] {
		return resources.filter((resource) => resource.enabled);
	}

	private getEnabledPaths(resources: ResolvedResource[]): string[] {
		return this.getEnabledResources(resources).map((resource) => resource.path);
	}

	private buildExtensionActivationMap(resources: ResolvedResource[]): Map<string, ExtensionActivation> {
		const activationByPath = new Map<string, ExtensionActivation>();
		for (const resource of resources) {
			const activation = resource.metadata.activation ?? "beforeFirstRequest";
			const resolvedPath = this.resolveResourcePath(resource.path);
			activationByPath.set(resource.path, activation);
			activationByPath.set(resolvedPath, activation);
		}
		return activationByPath;
	}

	private buildExtensionLoadMetadataMap(resources: ResolvedResource[]): Map<string, ExtensionLoadMetadata> {
		const result = new Map<string, ExtensionLoadMetadata>();
		for (const resource of resources) {
			if (!resource.enabled || !resource.metadata.extensionId) continue;
			const metadata: ExtensionLoadMetadata = {
				id: resource.metadata.extensionId,
				agentDir: this.agentDir,
				config: { ...(this.settingsManager.getExtensionConfig(resource.metadata.extensionId) ?? {}) },
				manifest: resource.metadata.extensionManifest,
				manifestStatus: resource.metadata.extensionManifestStatus,
				manifestDiagnostics: resource.metadata.extensionManifestDiagnostics,
				manifestUI: resource.metadata.extensionUI,
			};
			const resolvedPath = this.resolveResourcePath(resource.path);
			result.set(resource.path, metadata);
			result.set(resolvedPath, metadata);
		}
		return result;
	}

	private filterExtensionPathsForPhase(
		extensionPaths: string[],
		activationByPath: Map<string, ExtensionActivation>,
		phase: ResourceLoadPhase,
	): string[] {
		if (phase === "full") {
			return extensionPaths;
		}
		const allowedActivations: ExtensionActivation[] =
			phase === "startup" ? ["startup"] : ["startup", "beforeFirstRequest"];
		return extensionPaths.filter((extensionPath) => {
			const resolvedPath = this.resolveResourcePath(extensionPath);
			const activation =
				activationByPath.get(extensionPath) ?? activationByPath.get(resolvedPath) ?? "beforeFirstRequest";
			return allowedActivations.includes(activation);
		});
	}

	private async loadExtensionsForPhase(
		extensionPaths: string[],
		activationByPath: Map<string, ExtensionActivation>,
		metadataByPath: Map<string, ExtensionLoadMetadata>,
		phase: ResourceLoadPhase,
	): Promise<LoadExtensionsResult> {
		if (phase === "beforeFirstRequest" && this.loadedResourcePhase === "startup") {
			const retainedExtensions = this.extensionsResult.extensions.filter((extension) =>
				extensionPaths.some(
					(extensionPath) =>
						canonicalizePath(this.resolveResourcePath(extensionPath)) ===
						canonicalizePath(extension.resolvedPath),
				),
			);
			const retainedPaths = new Set(retainedExtensions.map((extension) => canonicalizePath(extension.resolvedPath)));
			const newExtensionPaths = extensionPaths.filter(
				(extensionPath) => !retainedPaths.has(canonicalizePath(this.resolveResourcePath(extensionPath))),
			);
			const loaded = await loadExtensionsIntoRuntime(
				newExtensionPaths,
				this.cwd,
				this.eventBus,
				this.extensionsResult.runtime,
				activationByPath,
				metadataByPath,
			);
			const inlineExtensions = await this.loadExtensionFactories(this.extensionsResult.runtime, phase);
			return {
				extensions: [...retainedExtensions, ...loaded.extensions, ...inlineExtensions.extensions],
				errors: [...loaded.errors, ...inlineExtensions.errors],
				runtime: this.extensionsResult.runtime,
			};
		}

		const extensionsResult = await loadExtensions(
			extensionPaths,
			this.cwd,
			this.eventBus,
			activationByPath,
			metadataByPath,
		);
		const inlineExtensions = await this.loadExtensionFactories(extensionsResult.runtime, phase);
		extensionsResult.extensions.push(...inlineExtensions.extensions);
		extensionsResult.errors.push(...inlineExtensions.errors);
		return extensionsResult;
	}

	private normalizeExtensionPaths(
		entries: Array<{ path: string; metadata: PathMetadata }>,
	): Array<{ path: string; metadata: PathMetadata }> {
		return entries.map((entry) => {
			const metadata = entry.metadata.baseDir
				? { ...entry.metadata, baseDir: this.resolveResourcePath(entry.metadata.baseDir) }
				: entry.metadata;
			return {
				path: this.resolveResourcePath(entry.path),
				metadata,
			};
		});
	}

	private updateSkillsFromPaths(skillPaths: string[], metadataByPath?: Map<string, PathMetadata>): void {
		let skillsResult: { skills: Skill[]; diagnostics: ResourceDiagnostic[] };
		if (this.noSkills && skillPaths.length === 0) {
			skillsResult = { skills: [], diagnostics: [] };
		} else {
			skillsResult = loadSkills({
				cwd: this.cwd,
				agentDir: this.agentDir,
				projectConfigDir: this.projectConfigDir,
				skillPaths,
				includeDefaults: false,
			});
		}
		const resolvedSkills = this.skillsOverride ? this.skillsOverride(skillsResult) : skillsResult;
		this.skills = resolvedSkills.skills.map((skill) => ({
			...skill,
			sourceInfo:
				this.findSourceInfoForPath(skill.filePath, this.extensionSkillSourceInfos, metadataByPath) ??
				skill.sourceInfo ??
				this.getDefaultSourceInfoForPath(skill.filePath),
		}));
		this.skillDiagnostics = resolvedSkills.diagnostics;
	}

	private updatePromptsFromPaths(promptPaths: string[], metadataByPath?: Map<string, PathMetadata>): void {
		let promptsResult: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] };
		if (this.noPromptTemplates && promptPaths.length === 0) {
			promptsResult = { prompts: [], diagnostics: [] };
		} else {
			const allPrompts = loadPromptTemplates({
				cwd: this.cwd,
				agentDir: this.agentDir,
				projectConfigDir: this.projectConfigDir,
				promptPaths,
				includeDefaults: false,
			});
			promptsResult = this.dedupePrompts(allPrompts);
		}
		const resolvedPrompts = this.promptsOverride ? this.promptsOverride(promptsResult) : promptsResult;
		this.prompts = resolvedPrompts.prompts.map((prompt) => ({
			...prompt,
			sourceInfo:
				this.findSourceInfoForPath(prompt.filePath, this.extensionPromptSourceInfos, metadataByPath) ??
				prompt.sourceInfo ??
				this.getDefaultSourceInfoForPath(prompt.filePath),
		}));
		this.promptDiagnostics = resolvedPrompts.diagnostics;
	}

	/**
	 * Derive an extension's name for settings lookup.
	 *
	 * Priority: metadataByPath source (real package name) > sourceInfo.source
	 * (if meaningful) > path basename without extension.
	 */
	private extractExtensionName(ext: Extension, metadataByPath?: Map<string, PathMetadata>): string | undefined {
		// 1. If metadata is available, look up the real source (package name)
		if (metadataByPath) {
			const meta = metadataByPath.get(ext.path);
			if (meta?.source && meta.source !== "local" && meta.source !== "cli" && meta.source !== "auto") {
				return meta.source;
			}
		}
		// 2. Use sourceInfo.source if it's a meaningful name
		const source = ext.sourceInfo?.source;
		if (source && source !== "local" && source !== "cli" && source !== "auto" && source !== "temporary") {
			return source;
		}
		// 3. Fall back to deriving from path basename (without extension)
		const p = ext.path || ext.resolvedPath;
		if (!p) return undefined;
		const base = basename(p);
		const withoutExt = base.replace(/\.(ts|js|mjs|cjs)$/, "");
		return withoutExt || undefined;
	}

	private applyExtensionSourceInfo(extensions: Extension[], metadataByPath: Map<string, PathMetadata>): void {
		for (const extension of extensions) {
			extension.sourceInfo =
				this.findSourceInfoForPath(extension.path, undefined, metadataByPath) ??
				this.getDefaultSourceInfoForPath(extension.path);
			for (const command of extension.commands.values()) {
				command.sourceInfo = extension.sourceInfo;
			}
			for (const tool of extension.tools.values()) {
				tool.sourceInfo = extension.sourceInfo;
			}
		}
	}

	private findSourceInfoForPath(
		resourcePath: string,
		extraSourceInfos?: Map<string, SourceInfo>,
		metadataByPath?: Map<string, PathMetadata>,
	): SourceInfo | undefined {
		if (!resourcePath) {
			return undefined;
		}

		if (resourcePath.startsWith("<")) {
			return this.getDefaultSourceInfoForPath(resourcePath);
		}

		const normalizedResourcePath = resolve(resourcePath);
		if (extraSourceInfos) {
			for (const [sourcePath, sourceInfo] of extraSourceInfos.entries()) {
				const normalizedSourcePath = resolve(sourcePath);
				if (
					normalizedResourcePath === normalizedSourcePath ||
					normalizedResourcePath.startsWith(`${normalizedSourcePath}${sep}`)
				) {
					return { ...sourceInfo, path: resourcePath };
				}
			}
		}

		if (metadataByPath) {
			const exact = metadataByPath.get(normalizedResourcePath) ?? metadataByPath.get(resourcePath);
			if (exact) {
				return createSourceInfo(resourcePath, exact);
			}

			for (const [sourcePath, metadata] of metadataByPath.entries()) {
				const normalizedSourcePath = resolve(sourcePath);
				if (
					normalizedResourcePath === normalizedSourcePath ||
					normalizedResourcePath.startsWith(`${normalizedSourcePath}${sep}`)
				) {
					return createSourceInfo(resourcePath, metadata);
				}
			}
		}

		return undefined;
	}

	private getDefaultSourceInfoForPath(filePath: string): SourceInfo {
		if (filePath.startsWith("<") && filePath.endsWith(">")) {
			return {
				path: filePath,
				source: filePath.slice(1, -1).split(":")[0] || "temporary",
				scope: "temporary",
				origin: "top-level",
			};
		}

		const normalizedPath = resolve(filePath);
		const agentRoots = [
			join(this.agentDir, "skills"),
			join(this.agentDir, "prompts"),
			join(this.agentDir, "extensions"),
		];
		const projectRoots = [
			join(this.cwd, this.projectConfigDir, "skills"),
			join(this.cwd, this.projectConfigDir, "prompts"),
			join(this.cwd, this.projectConfigDir, "extensions"),
		];

		for (const root of agentRoots) {
			if (this.isUnderPath(normalizedPath, root)) {
				return { path: filePath, source: "local", scope: "user", origin: "top-level", baseDir: root };
			}
		}

		for (const root of projectRoots) {
			if (this.isUnderPath(normalizedPath, root)) {
				return { path: filePath, source: "local", scope: "project", origin: "top-level", baseDir: root };
			}
		}

		return {
			path: filePath,
			source: "local",
			scope: "temporary",
			origin: "top-level",
			baseDir: statSync(normalizedPath).isDirectory() ? normalizedPath : resolve(normalizedPath, ".."),
		};
	}

	private mergePaths(primary: string[], additional: string[]): string[] {
		const merged: string[] = [];
		const seen = new Set<string>();

		for (const p of [...primary, ...additional]) {
			const resolved = this.resolveResourcePath(p);
			const canonicalPath = canonicalizePath(resolved);
			if (seen.has(canonicalPath)) continue;
			seen.add(canonicalPath);
			merged.push(resolved);
		}

		return merged;
	}

	private resolveResourcePath(p: string): string {
		return resolvePath(p, this.cwd, { trim: true });
	}

	private async loadExtensionFactories(
		runtime: ExtensionRuntime,
		phase: ResourceLoadPhase,
	): Promise<{
		extensions: Extension[];
		errors: Array<{ path: string; error: string }>;
	}> {
		if (phase === "startup") {
			return { extensions: [], errors: [] };
		}
		const extensions: Extension[] = [];
		const errors: Array<{ path: string; error: string }> = [];

		for (const [index, factory] of this.extensionFactories.entries()) {
			const extensionPath = `<inline:${index + 1}>`;
			try {
				const extension = await loadExtensionFromFactory(
					factory,
					this.cwd,
					this.eventBus,
					runtime,
					extensionPath,
					"beforeFirstRequest",
				);
				extensions.push(extension);
			} catch (error) {
				const message = error instanceof Error ? error.message : "failed to load extension";
				errors.push({ path: extensionPath, error: message });
			}
		}

		return { extensions, errors };
	}

	private dedupePrompts(prompts: PromptTemplate[]): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] } {
		const seen = new Map<string, PromptTemplate>();
		const diagnostics: ResourceDiagnostic[] = [];

		for (const prompt of prompts) {
			const existing = seen.get(prompt.name);
			if (existing) {
				diagnostics.push({
					type: "collision",
					message: `name "/${prompt.name}" collision`,
					path: prompt.filePath,
					collision: {
						resourceType: "prompt",
						name: prompt.name,
						winnerPath: existing.filePath,
						loserPath: prompt.filePath,
					},
				});
			} else {
				seen.set(prompt.name, prompt);
			}
		}

		return { prompts: Array.from(seen.values()), diagnostics };
	}

	private discoverSystemPromptFile(): string | undefined {
		const projectPath = join(this.cwd, this.projectConfigDir, "SYSTEM.md");
		if (existsSync(projectPath)) {
			return projectPath;
		}

		const globalPath = join(this.agentDir, "SYSTEM.md");
		if (existsSync(globalPath)) {
			return globalPath;
		}

		return undefined;
	}

	private discoverAppendSystemPromptFile(): string | undefined {
		const projectPath = join(this.cwd, this.projectConfigDir, "APPEND_SYSTEM.md");
		if (existsSync(projectPath)) {
			return projectPath;
		}

		const globalPath = join(this.agentDir, "APPEND_SYSTEM.md");
		if (existsSync(globalPath)) {
			return globalPath;
		}

		return undefined;
	}

	private isUnderPath(target: string, root: string): boolean {
		const normalizedRoot = resolve(root);
		if (target === normalizedRoot) {
			return true;
		}
		const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
		return target.startsWith(prefix);
	}

	private detectExtensionConflicts(extensions: Extension[]): Array<{ path: string; message: string }> {
		const conflicts: Array<{ path: string; message: string }> = [];

		// Track extension identities and tool names owned by each extension.
		const toolOwners = new Map<string, string>();
		const idOwners = new Map<string, string>();

		for (const ext of extensions) {
			const existingIdOwner = idOwners.get(ext.id);
			if (existingIdOwner && existingIdOwner !== ext.path) {
				conflicts.push({
					path: ext.path,
					message: `Extension id "${ext.id}" conflicts with ${existingIdOwner}`,
				});
			} else {
				idOwners.set(ext.id, ext.path);
			}

			// Check tools
			for (const toolName of ext.tools.keys()) {
				const existingOwner = toolOwners.get(toolName);
				if (existingOwner && existingOwner !== ext.path) {
					conflicts.push({
						path: ext.path,
						message: `Tool "${toolName}" conflicts with ${existingOwner}`,
					});
				} else {
					toolOwners.set(toolName, ext.path);
				}
			}
		}

		return conflicts;
	}
}
