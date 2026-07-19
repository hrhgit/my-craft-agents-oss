import { join } from "node:path";
import type { ThinkingLevel } from "@mortise/pi-agent-core";
import type { Model } from "@mortise/pi-ai/types";
import { getAgentDir } from "../config.ts";
import { resolvePath } from "../utils/paths.ts";
import { AuthStorage } from "./auth-storage.ts";
import { applyExtensionFlagValues } from "./extension-flags.ts";
import type { SessionStartEvent, ToolDefinition } from "./extensions/index.ts";
import { ModelRegistry } from "./model-registry.ts";
import { NetworkManager } from "./network-manager.ts";
import { DefaultResourceLoader, type DefaultResourceLoaderOptions, type ResourceLoader } from "./resource-loader.ts";
import { type CreateAgentSessionOptions, type CreateAgentSessionResult, createAgentSession } from "./sdk.ts";
import type { SessionManager } from "./session-manager.ts";
import { SettingsManager } from "./settings-manager.ts";

/**
 * Non-fatal issues collected while creating services or sessions.
 *
 * Runtime creation returns diagnostics to the caller instead of printing or
 * exiting. The app layer decides whether warnings should be shown and whether
 * errors should abort startup.
 */
export interface AgentSessionRuntimeDiagnostic {
	type: "info" | "warning" | "error";
	message: string;
}

/**
 * Inputs for creating cwd-bound runtime services.
 *
 * These services are recreated whenever the effective session cwd changes.
 * CLI-provided resource paths should be resolved to absolute paths before they
 * reach this function, so later cwd switches do not reinterpret them.
 */
export interface CreateAgentSessionServicesOptions {
	cwd: string;
	agentDir?: string;
	authStorage?: AuthStorage;
	settingsManager?: SettingsManager;
	modelRegistry?: ModelRegistry;
	extensionFlagValues?: Map<string, boolean | string>;
	resourceLoaderOptions?: Omit<DefaultResourceLoaderOptions, "cwd" | "agentDir" | "settingsManager">;
	deferResourceLoad?: boolean;
}

/**
 * Inputs for creating an AgentSession from already-created services.
 *
 * Use this after services exist and any cwd-bound model/tool/session options
 * have been resolved against those services.
 */
export interface CreateAgentSessionFromServicesOptions {
	services: AgentSessionServices;
	sessionManager: SessionManager;
	sessionStartEvent?: SessionStartEvent;
	model?: Model<any>;
	thinkingLevel?: ThinkingLevel;
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	tools?: string[];
	excludeTools?: CreateAgentSessionOptions["excludeTools"];
	noTools?: CreateAgentSessionOptions["noTools"];
	customTools?: ToolDefinition[];
	fetchInterceptor?: CreateAgentSessionOptions["fetchInterceptor"];
	toolMetadataResolver?: CreateAgentSessionOptions["toolMetadataResolver"];
	persistInitialState?: boolean;
	onRuntimeDiagnostics?: (diagnostics: AgentSessionRuntimeDiagnostic[]) => void;
}

/**
 * Coherent cwd-bound runtime services for one effective session cwd.
 *
 * This is infrastructure only. The AgentSession itself is created separately so
 * session options can be resolved against these services first.
 */
export interface AgentSessionServices {
	cwd: string;
	agentDir: string;
	authStorage: AuthStorage;
	settingsManager: SettingsManager;
	modelRegistry: ModelRegistry;
	networkManager: NetworkManager;
	resourceLoader: ResourceLoader;
	extensionFlagValues?: Map<string, boolean | string>;
	diagnostics: AgentSessionRuntimeDiagnostic[];
}

function registerPendingExtensionProviders(
	resourceLoader: ResourceLoader,
	modelRegistry: ModelRegistry,
	diagnostics: AgentSessionRuntimeDiagnostic[],
): void {
	const extensionsResult = resourceLoader.getExtensions();
	for (const { name, config, extensionPath } of extensionsResult.runtime.pendingProviderRegistrations) {
		try {
			modelRegistry.registerProvider(name, config);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			diagnostics.push({
				type: "error",
				message: `Extension "${extensionPath}" error: ${message}`,
			});
		}
	}
	extensionsResult.runtime.pendingProviderRegistrations = [];
}

/**
 * Create cwd-bound runtime services.
 *
 * Returns services plus diagnostics. It does not create an AgentSession.
 */
export async function createAgentSessionServices(
	options: CreateAgentSessionServicesOptions,
): Promise<AgentSessionServices> {
	const servicesStartedAt = performance.now();
	const cwd = resolvePath(options.cwd);
	const agentDir = options.agentDir ? resolvePath(options.agentDir) : getAgentDir();
	const authStorage = options.authStorage ?? AuthStorage.create(join(agentDir, "auth.json"));
	const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
	const modelRegistry = options.modelRegistry ?? ModelRegistry.create(authStorage, join(agentDir, "models.json"));
	const networkManager = new NetworkManager(settingsManager);
	const resourceLoader = new DefaultResourceLoader({
		...(options.resourceLoaderOptions ?? {}),
		cwd,
		agentDir,
		settingsManager,
	});
	const objectsReadyAt = performance.now();

	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	if (options.deferResourceLoad) {
		await resourceLoader.loadPhase?.("startup");
		const resourcesReadyAt = performance.now();
		registerPendingExtensionProviders(resourceLoader, modelRegistry, diagnostics);
		diagnostics.push(
			...applyExtensionFlagValues(resourceLoader, options.extensionFlagValues, { ignoreUnknown: true }),
		);
		if (process.env.PI_RUNTIME_PROFILE === "1") {
			console.error(
				JSON.stringify({
					scope: "pi-host",
					event: "services.profile",
					cwd,
					objectsMs: Math.round((objectsReadyAt - servicesStartedAt) * 100) / 100,
					resourcesMs: Math.round((resourcesReadyAt - objectsReadyAt) * 100) / 100,
					networkMs: 0,
				}),
			);
		}
	} else {
		await resourceLoader.reload();
		const resourcesReadyAt = performance.now();
		registerPendingExtensionProviders(resourceLoader, modelRegistry, diagnostics);
		diagnostics.push(...applyExtensionFlagValues(resourceLoader, options.extensionFlagValues));
		await networkManager.initialize();
		if (process.env.PI_RUNTIME_PROFILE === "1") {
			console.error(
				JSON.stringify({
					scope: "pi-host",
					event: "services.profile",
					cwd,
					objectsMs: Math.round((objectsReadyAt - servicesStartedAt) * 100) / 100,
					resourcesMs: Math.round((resourcesReadyAt - objectsReadyAt) * 100) / 100,
					networkMs: Math.round((performance.now() - resourcesReadyAt) * 100) / 100,
				}),
			);
		}
	}

	return {
		cwd,
		agentDir,
		authStorage,
		settingsManager,
		modelRegistry,
		networkManager,
		resourceLoader,
		extensionFlagValues: options.extensionFlagValues,
		diagnostics,
	};
}

/**
 * Create an AgentSession from previously created services.
 *
 * This keeps session creation separate from service creation so callers can
 * resolve model, thinking, tools, and other session inputs against the target
 * cwd before constructing the session.
 */
export async function createAgentSessionFromServices(
	options: CreateAgentSessionFromServicesOptions,
): Promise<CreateAgentSessionResult> {
	return createAgentSession({
		cwd: options.services.cwd,
		agentDir: options.services.agentDir,
		authStorage: options.services.authStorage,
		settingsManager: options.services.settingsManager,
		modelRegistry: options.services.modelRegistry,
		networkManager: options.services.networkManager,
		resourceLoader: options.services.resourceLoader,
		sessionManager: options.sessionManager,
		model: options.model,
		thinkingLevel: options.thinkingLevel,
		scopedModels: options.scopedModels,
		tools: options.tools,
		excludeTools: options.excludeTools,
		noTools: options.noTools,
		customTools: options.customTools,
		fetchInterceptor: options.fetchInterceptor,
		toolMetadataResolver: options.toolMetadataResolver,
		sessionStartEvent: options.sessionStartEvent,
		persistInitialState: options.persistInitialState,
		extensionFlagValues: options.services.extensionFlagValues,
		onRuntimeDiagnostics: options.onRuntimeDiagnostics,
	});
}
