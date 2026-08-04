/**
 * Extension loader - loads TypeScript extension modules using jiti.
 *
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as _bundledPiAgentCore from "@mortise/pi-agent-core";
import * as _bundledPiAi from "@mortise/pi-ai";
import * as _bundledPiAiOauth from "@mortise/pi-ai/oauth";
import { createJiti } from "jiti/static";
// Static imports of packages that extensions may use.
// These MUST be static so Bun bundles them into the compiled binary.
// The virtualModules option then makes them available to extensions.
import * as _bundledTypebox from "typebox";
import * as _bundledTypeboxCompile from "typebox/compile";
import * as _bundledTypeboxValue from "typebox/value";
import { getAgentDir, getPackageDir, isBunBinary } from "../../config.ts";
import * as _bundledPiCodingAgentExtensionApi from "../../extension-api.ts";
import { resolvePath } from "../../utils/paths.ts";
import { createEventBus, type EventBus } from "../event-bus.ts";
import type { ExecOptions } from "../exec.ts";
import { execCommand } from "../exec.ts";
import type {
	ExtensionManifestDiagnostic,
	ExtensionManifestStatus,
	ExtensionManifestV1,
} from "../extension-manifest.ts";
import { getProcessGlobalBackgroundTaskCoordinator } from "../global-background-tasks.ts";
import { createSyntheticSourceInfo } from "../source-info.ts";
import type {
	Extension,
	ExtensionActivation,
	ExtensionAPI,
	ExtensionFactory,
	ExtensionFactoryV2,
	ExtensionManifestUIV1,
	ExtensionRuntime,
	LoadExtensionsResult,
	ProviderConfig,
	RegisteredCommand,
	ToolDefinition,
} from "./types.ts";

export interface ExtensionLoadMetadata {
	id: string;
	agentDir: string;
	config?: Record<string, unknown>;
	manifest?: ExtensionManifestV1;
	manifestStatus?: ExtensionManifestStatus;
	manifestDiagnostics?: ExtensionManifestDiagnostic[];
	manifestUI?: ExtensionManifestUIV1;
}

const require = createRequire(import.meta.url);

const extensionV2FactoryCache = new Map<string, { mtimeMs: number; factory: ExtensionFactoryV2 }>();

let _virtualModules: Record<string, unknown> | undefined;

function getVirtualModules(): Record<string, unknown> {
	if (_virtualModules) return _virtualModules;
	_virtualModules = {
		typebox: _bundledTypebox,
		"typebox/compile": _bundledTypeboxCompile,
		"typebox/value": _bundledTypeboxValue,
		"@sinclair/typebox": _bundledTypebox,
		"@sinclair/typebox/compile": _bundledTypeboxCompile,
		"@sinclair/typebox/value": _bundledTypeboxValue,
		"@mortise/pi-agent-core": _bundledPiAgentCore,
		"@mortise/pi-ai": _bundledPiAi,
		"@mortise/pi-ai/oauth": _bundledPiAiOauth,
		"@mortise/pi-coding-agent": _bundledPiCodingAgentExtensionApi,
	};
	return _virtualModules;
}

/**
 * Get aliases for jiti (used in Node.js/development mode).
 * In Bun binary mode, virtualModules is used instead.
 */
let _aliases: Record<string, string> | null = null;

function getAliases(): Record<string, string> {
	if (_aliases) return _aliases;

	const packageDir = getPackageDir();
	const packageIndex = path.join(packageDir, "dist", "index.js");

	const typeboxEntry = require.resolve("typebox");
	const typeboxCompileEntry = require.resolve("typebox/compile");
	const typeboxValueEntry = require.resolve("typebox/value");

	const packagesRoot = path.resolve(packageDir, "..");
	const resolveWorkspaceOrImport = (workspaceRelativePath: string, specifier: string): string => {
		const workspacePath = path.join(packagesRoot, workspaceRelativePath);
		if (fs.existsSync(workspacePath)) {
			return workspacePath;
		}
		return fileURLToPath(import.meta.resolve(specifier));
	};

	const piCodingAgentEntry = packageIndex;
	const piAgentCoreEntry = resolveWorkspaceOrImport("agent/dist/index.js", "@mortise/pi-agent-core");
	const piAiEntry = resolveWorkspaceOrImport("ai/dist/index.js", "@mortise/pi-ai");
	const piAiOauthEntry = resolveWorkspaceOrImport("ai/dist/oauth.js", "@mortise/pi-ai/oauth");

	_aliases = {
		"@mortise/pi-coding-agent": piCodingAgentEntry,
		"@mortise/pi-agent-core": piAgentCoreEntry,
		"@mortise/pi-ai": piAiEntry,
		"@mortise/pi-ai/oauth": piAiOauthEntry,
		typebox: typeboxEntry,
		"typebox/compile": typeboxCompileEntry,
		"typebox/value": typeboxValueEntry,
		"@sinclair/typebox": typeboxEntry,
		"@sinclair/typebox/compile": typeboxCompileEntry,
		"@sinclair/typebox/value": typeboxValueEntry,
	};

	return _aliases;
}

type HandlerFn = (...args: unknown[]) => Promise<unknown>;

/**
 * Create a runtime with throwing stubs for action methods.
 * Runner.bindCore() replaces these with real implementations.
 */
export function createExtensionRuntime(): ExtensionRuntime {
	const notInitialized = () => {
		throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.");
	};
	const state: { staleMessage?: string } = {};
	const assertActive = () => {
		if (state.staleMessage) {
			throw new Error(state.staleMessage);
		}
	};

	const runtime: ExtensionRuntime = {
		sendMessage: notInitialized,
		sendUserMessage: notInitialized,
		appendEntry: notInitialized,
		setSessionName: notInitialized,
		getSessionName: notInitialized,
		setLabel: notInitialized,
		getActiveTools: notInitialized,
		getAllTools: notInitialized,
		setActiveTools: notInitialized,
		// registerTool() is valid during extension load; refresh is only needed post-bind.
		refreshTools: () => {},
		getCommands: notInitialized,
		setModel: () => Promise.reject(new Error("Extension runtime not initialized")),
		getThinkingLevel: notInitialized,
		setThinkingLevel: notInitialized,
		pendingProviderRegistrations: [],
		assertActive,
		invalidate: (message) => {
			state.staleMessage ??=
				message ??
				"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().";
		},
		// Pre-bind: queue registrations so bindCore() can flush them once the
		// model registry is available. bindCore() replaces both with direct calls.
		registerProvider: (name, config, extensionPath = "<unknown>") => {
			runtime.pendingProviderRegistrations.push({ name, config, extensionPath });
		},
		unregisterProvider: (name) => {
			runtime.pendingProviderRegistrations = runtime.pendingProviderRegistrations.filter((r) => r.name !== name);
		},
	};

	return runtime;
}

/**
 * Create the ExtensionAPI for an extension.
 * Registration methods write to the extension object.
 * Action methods delegate to the shared runtime.
 */
function createExtensionAPI(
	extension: Extension,
	runtime: ExtensionRuntime,
	cwd: string,
	eventBus: EventBus,
	environment: ExtensionLoadMetadata,
): ExtensionAPI {
	const backgroundTasks = getProcessGlobalBackgroundTaskCoordinator();
	const dataDir = path.join(environment.agentDir, "extension-data", environment.id);
	fs.mkdirSync(dataDir, { recursive: true });
	const api = {
		environment: Object.freeze({
			id: environment.id,
			sourcePath: extension.resolvedPath,
			dataDir,
			config: Object.freeze({ ...(environment.config ?? {}) }),
		}),
		host: {
			registerBackgroundTask: (type, handler) => {
				try {
					return backgroundTasks.register(type, handler);
				} catch (error) {
					if (error instanceof Error && error.message.includes("already registered")) return () => {};
					throw error;
				}
			},
			enqueueBackgroundTask: (request) => backgroundTasks.enqueue(request),
			cancelBackgroundTask: (id) => backgroundTasks.cancel(id),
			listBackgroundTasks: () => backgroundTasks.list(),
			subscribeBackgroundTasks: (listener) => backgroundTasks.subscribe(listener),
		},
		declareCapabilities(declarations: readonly import("./types.ts").HostCapabilityDeclaration[]): void {
			runtime.assertActive();
			const normalized = declarations.map((declaration) => {
				const capability = declaration.capability.trim();
				const operations = [
					...new Set(declaration.operations.map((operation) => operation.trim()).filter(Boolean)),
				];
				if (!capability || operations.length === 0) {
					throw new Error("Host capability declarations require a capability and at least one operation");
				}
				return { capability, operations };
			});
			extension.hostCapabilities = normalized;
		},
		// Registration methods - write to extension
		on(event: string, handler: HandlerFn): void {
			runtime.assertActive();
			const list = extension.handlers.get(event) ?? [];
			list.push(handler);
			extension.handlers.set(event, list);
		},

		registerTool(tool: ToolDefinition): void {
			runtime.assertActive();
			extension.tools.set(tool.name, {
				definition: tool,
				sourceInfo: extension.sourceInfo,
				extensionId: extension.id,
			});
			runtime.refreshTools();
		},

		registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo" | "extensionId">): void {
			runtime.assertActive();
			extension.commands.set(name, {
				name,
				extensionId: extension.id,
				sourceInfo: extension.sourceInfo,
				...options,
			});
		},

		// Action methods - delegate to shared runtime
		sendMessage(message, options): void {
			runtime.assertActive();
			runtime.sendMessage(message, options);
		},

		sendUserMessage(content, options): void {
			runtime.assertActive();
			runtime.sendUserMessage(content, options);
		},

		appendEntry(customType: string, data?: unknown): void {
			runtime.assertActive();
			runtime.appendEntry(customType, data);
		},

		setSessionName(name: string): void {
			runtime.assertActive();
			runtime.setSessionName(name);
		},

		getSessionName(): string | undefined {
			runtime.assertActive();
			return runtime.getSessionName();
		},

		setLabel(entryId: string, label: string | undefined): void {
			runtime.assertActive();
			runtime.setLabel(entryId, label);
		},

		exec(command: string, args: string[], options?: ExecOptions) {
			runtime.assertActive();
			return execCommand(command, args, options?.cwd ?? cwd, options);
		},

		getActiveTools(): string[] {
			runtime.assertActive();
			return runtime.getActiveTools();
		},

		getAllTools() {
			runtime.assertActive();
			return runtime.getAllTools();
		},

		setActiveTools(toolNames: string[]): void {
			runtime.assertActive();
			runtime.setActiveTools(toolNames);
		},

		getCommands() {
			runtime.assertActive();
			return runtime.getCommands();
		},

		setModel(model) {
			runtime.assertActive();
			return runtime.setModel(model);
		},

		getThinkingLevel() {
			runtime.assertActive();
			return runtime.getThinkingLevel();
		},

		setThinkingLevel(level) {
			runtime.assertActive();
			runtime.setThinkingLevel(level);
		},

		registerProvider(name: string, config: ProviderConfig) {
			runtime.assertActive();
			runtime.registerProvider(name, config, extension.path);
		},

		unregisterProvider(name: string) {
			runtime.assertActive();
			runtime.unregisterProvider(name, extension.path);
		},

		events: eventBus,
	} as ExtensionAPI;

	return api;
}

async function loadExtensionModule(extensionPath: string) {
	const mtimeMs = fs.statSync(extensionPath).mtimeMs;
	const cached = extensionV2FactoryCache.get(extensionPath);
	if (cached?.mtimeMs === mtimeMs) return cached.factory;
	const jiti = createJiti(import.meta.url, {
		moduleCache: false,
		fsCache: path.join(getAgentDir(), ".cache", "jiti"),
		// In Bun binary: use virtualModules for bundled packages (no filesystem resolution)
		// Also disable tryNative so jiti handles ALL imports (not just the entry point)
		// In Node.js/dev: use aliases to resolve to node_modules paths
		...(isBunBinary ? { virtualModules: getVirtualModules(), tryNative: false } : { alias: getAliases() }),
	});

	const module = await jiti.import(extensionPath, { default: true });
	const factory = module as ExtensionFactory;
	if (typeof factory !== "function") return undefined;
	const v2Factory = factory as ExtensionFactoryV2;
	if (v2Factory.definitionV2 && v2Factory.definitionV2.isolation !== "process") {
		extensionV2FactoryCache.set(extensionPath, { mtimeMs, factory: v2Factory });
	}
	return factory;
}

/**
 * Create an Extension object with empty collections.
 */
function createExtension(
	extensionPath: string,
	resolvedPath: string,
	identity: Pick<ExtensionLoadMetadata, "id" | "manifest" | "manifestStatus" | "manifestDiagnostics" | "manifestUI">,
	activation: ExtensionActivation = "beforeFirstRequest",
): Extension {
	const source =
		extensionPath.startsWith("<") && extensionPath.endsWith(">")
			? extensionPath.slice(1, -1).split(":")[0] || "temporary"
			: "local";
	const baseDir = extensionPath.startsWith("<") ? undefined : path.dirname(resolvedPath);

	return {
		id: identity.id,
		path: extensionPath,
		resolvedPath,
		sourceInfo: createSyntheticSourceInfo(extensionPath, { source, baseDir }),
		activation,
		manifest: identity.manifest,
		manifestStatus: identity.manifestStatus ?? "legacy",
		manifestDiagnostics: [...(identity.manifestDiagnostics ?? [])],
		manifestUI: identity.manifestUI,
		hostCapabilities: [],
		handlers: new Map(),
		tools: new Map(),
		commands: new Map(),
	};
}

async function loadExtension(
	extensionPath: string,
	cwd: string,
	eventBus: EventBus,
	runtime: ExtensionRuntime,
	metadata: ExtensionLoadMetadata,
	activation?: ExtensionActivation,
): Promise<{ extension: Extension | null; error: string | null }> {
	const resolvedPath = resolvePath(extensionPath, cwd, { normalizeUnicodeSpaces: true });

	try {
		const factory = await loadExtensionModule(resolvedPath);
		if (!factory) {
			return { extension: null, error: `Extension does not export a valid factory function: ${extensionPath}` };
		}

		const extension = createExtension(extensionPath, resolvedPath, metadata, activation);
		const api = createExtensionAPI(extension, runtime, cwd, eventBus, metadata);
		await factory(api);

		return { extension, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { extension: null, error: `Failed to load extension: ${message}` };
	}
}

/**
 * Create an Extension from an inline factory function.
 */
export async function loadExtensionFromFactory(
	factory: ExtensionFactory,
	cwd: string,
	eventBus: EventBus,
	runtime: ExtensionRuntime,
	extensionPath = "<inline>",
	activation: ExtensionActivation = "beforeFirstRequest",
	metadata: ExtensionLoadMetadata = { id: "inline", agentDir: getAgentDir() },
): Promise<Extension> {
	const extension = createExtension(extensionPath, extensionPath, metadata, activation);
	const resolvedCwd = resolvePath(cwd);
	const api = createExtensionAPI(extension, runtime, resolvedCwd, eventBus, metadata);
	await factory(api);
	return extension;
}

export async function loadExtensionsIntoRuntime(
	paths: string[],
	cwd: string,
	eventBus: EventBus,
	runtime: ExtensionRuntime,
	activationByPath?: Map<string, ExtensionActivation>,
	metadataByPath?: Map<string, ExtensionLoadMetadata>,
): Promise<Pick<LoadExtensionsResult, "extensions" | "errors">> {
	const extensions: Extension[] = [];
	const errors: Array<{ path: string; error: string }> = [];
	const resolvedCwd = resolvePath(cwd);

	for (const extPath of paths) {
		const resolvedPath = resolvePath(extPath, resolvedCwd, { normalizeUnicodeSpaces: true });
		const activation = activationByPath?.get(extPath) ?? activationByPath?.get(resolvedPath);
		const metadata = metadataByPath?.get(extPath) ?? metadataByPath?.get(resolvedPath);
		if (!metadata) {
			errors.push({ path: extPath, error: "Missing strict extension metadata (id, agentDir)" });
			continue;
		}
		const { extension, error } = await loadExtension(extPath, resolvedCwd, eventBus, runtime, metadata, activation);

		if (error) {
			errors.push({ path: extPath, error });
			continue;
		}

		if (extension) {
			extensions.push(extension);
		}
	}

	return { extensions, errors };
}

/**
 * Load extensions from paths.
 */
export async function loadExtensions(
	paths: string[],
	cwd: string,
	eventBus?: EventBus,
	activationByPath?: Map<string, ExtensionActivation>,
	metadataByPath?: Map<string, ExtensionLoadMetadata>,
): Promise<LoadExtensionsResult> {
	const extensions: Extension[] = [];
	const errors: Array<{ path: string; error: string }> = [];
	const resolvedCwd = resolvePath(cwd);
	const resolvedEventBus = eventBus ?? createEventBus();
	const runtime = createExtensionRuntime();

	const loaded = await loadExtensionsIntoRuntime(
		paths,
		resolvedCwd,
		resolvedEventBus,
		runtime,
		activationByPath,
		metadataByPath,
	);
	extensions.push(...loaded.extensions);
	errors.push(...loaded.errors);

	return {
		extensions,
		errors,
		runtime,
	};
}
