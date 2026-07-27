import type { Api, Model } from "@mortise/pi-ai";
import { ENV_SESSION_DIR, expandTildePath, getAgentDir, getProjectConfigDir } from "./config.ts";
import { type CreateAgentSessionRuntimeFactory, createAgentSessionRuntime } from "./core/agent-session-runtime.ts";
import { createAgentSessionFromServices, createAgentSessionServices } from "./core/agent-session-services.ts";
import { AuthStorage } from "./core/auth-storage.ts";
import type { ExtensionFactory } from "./core/extensions/types.ts";
import { restoreStdout, takeOverStdout } from "./core/output-guard.ts";
import type { CreateAgentSessionOptions } from "./core/sdk.ts";
import { SessionManager } from "./core/session-manager.ts";
import { parseRpcHostUICapabilities, runRpcMode } from "./modes/rpc/rpc-mode.ts";
import { PI_HOST_HOOKS_MODULE_ENV, PI_RPC_UI_CAPABILITIES_ENV } from "./modes/rpc/rpc-types.ts";
import { resolvePath } from "./utils/paths.ts";

type UnknownFunction = (...args: unknown[]) => unknown;

export interface HeadlessMainOptions {
	extensionFactories?: ExtensionFactory[];
	fetchInterceptor?: CreateAgentSessionOptions["fetchInterceptor"];
	toolMetadataResolver?: CreateAgentSessionOptions["toolMetadataResolver"];
	hostHooksModule?: string;
}

interface HeadlessArgs {
	provider?: string;
	model?: string;
}

function parseHeadlessArgs(args: string[]): HeadlessArgs {
	const parsed: HeadlessArgs = {};
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg !== "--provider" && arg !== "--model") {
			throw new Error(`Unsupported Mortise headless runtime argument: ${arg}`);
		}
		const value = args[++index]?.trim();
		if (!value) throw new Error(`${arg} requires a non-empty value`);
		if (arg === "--provider") parsed.provider = value;
		else parsed.model = value;
	}
	return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function functionExport(moduleValue: Record<string, unknown>, names: string[]): UnknownFunction | undefined {
	for (const name of names) {
		if (typeof moduleValue[name] === "function") return moduleValue[name] as UnknownFunction;
	}
	const defaultExport = moduleValue.default;
	if (!isRecord(defaultExport)) return undefined;
	for (const name of names) {
		if (typeof defaultExport[name] === "function") return defaultExport[name] as UnknownFunction;
	}
	return undefined;
}

function hookFactory(factory: UnknownFunction | undefined, label: string): UnknownFunction | undefined {
	if (!factory) return undefined;
	const hook = factory();
	if (typeof hook !== "function") throw new Error(`Host hook factory ${label} did not return a function`);
	return hook as UnknownFunction;
}

export async function loadHostHooks(modulePath: string | undefined, cwd: string) {
	if (!modulePath) return {};
	const { createJiti } = await import("jiti/static");
	const resolvedPath = resolvePath(modulePath, cwd);
	const loaded = await createJiti(import.meta.url, { moduleCache: false }).import(resolvedPath);
	const moduleValue = isRecord(loaded) ? loaded : { default: loaded };
	const defaultExport = moduleValue.default;
	const fetchInterceptor =
		functionExport(moduleValue, ["fetchInterceptor"]) ??
		hookFactory(functionExport(moduleValue, ["createFetchInterceptor"]), `${resolvedPath}:createFetchInterceptor`) ??
		(typeof defaultExport === "function" ? defaultExport : undefined);
	const toolMetadataResolver =
		hookFactory(
			functionExport(moduleValue, ["createToolMetadataResolver"]),
			`${resolvedPath}:createToolMetadataResolver`,
		) ?? functionExport(moduleValue, ["toolMetadataResolver", "resolveToolMetadata"]);
	if (!fetchInterceptor && !toolMetadataResolver) {
		throw new Error(`Host hooks module ${resolvedPath} has no supported hooks`);
	}
	return { fetchInterceptor, toolMetadataResolver };
}

export async function runHeadlessMain(args: string[], options: HeadlessMainOptions = {}): Promise<void> {
	const parsed = parseHeadlessArgs(args);
	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const projectConfigDir = getProjectConfigDir();
	const sessionDirValue = process.env[ENV_SESSION_DIR];
	const sessionDir = sessionDirValue ? expandTildePath(sessionDirValue) : undefined;
	const authStorage = AuthStorage.create();
	const moduleHooks = await loadHostHooks(options.hostHooksModule ?? process.env[PI_HOST_HOOKS_MODULE_ENV], cwd);
	const fetchInterceptor = options.fetchInterceptor ?? moduleHooks.fetchInterceptor;
	const toolMetadataResolver = options.toolMetadataResolver ?? moduleHooks.toolMetadataResolver;
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({
		cwd: runtimeCwd,
		agentDir: runtimeAgentDir,
		projectConfigDir: runtimeProjectConfigDir,
		sessionManager,
		sessionStartEvent,
		deferResourceLoad,
		persistInitialState,
		extensionTarget,
		extensionPaths,
	}) => {
		const services = await createAgentSessionServices({
			cwd: runtimeCwd,
			agentDir: runtimeAgentDir,
			projectConfigDir: runtimeProjectConfigDir,
			authStorage,
			deferResourceLoad,
			resourceLoaderOptions: {
				extensionTarget: extensionTarget ?? "mortise",
				additionalExtensionPaths: (extensionPaths ?? []).map((path, index) => ({
					id: `runtime-extension-${index}`,
					path,
					activation: "startup" as const,
					targets: ["mortise" as const],
				})),
				extensionFactories: options.extensionFactories,
			},
		});
		let model: Model<Api> | undefined;
		if (parsed.model) {
			const provider =
				parsed.provider ??
				(parsed.model.includes("/") ? parsed.model.slice(0, parsed.model.indexOf("/")) : undefined);
			const modelId =
				provider && parsed.model.startsWith(`${provider}/`)
					? parsed.model.slice(provider.length + 1)
					: parsed.model;
			if (!provider) throw new Error("--model requires --provider or a provider/model value");
			model = services.modelRegistry.find(provider, modelId);
			if (!model) throw new Error(`Configured model not found: ${provider}/${modelId}`);
		}
		const created = await createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
			model,
			fetchInterceptor: fetchInterceptor as CreateAgentSessionOptions["fetchInterceptor"],
			toolMetadataResolver: toolMetadataResolver as CreateAgentSessionOptions["toolMetadataResolver"],
			persistInitialState,
		});
		return { ...created, services, diagnostics: services.diagnostics };
	};

	const sessionManager = SessionManager.create(cwd, sessionDir);
	const uiCapabilities = parseRpcHostUICapabilities(process.env[PI_RPC_UI_CAPABILITIES_ENV]);
	takeOverStdout();
	try {
		if (process.env.PI_GLOBAL_HOST_PROCESS === "1") {
			await runRpcMode({
				kind: "global-host",
				agentDir,
				createRuntime,
				defaultRuntime: {
					cwd,
					sessionManager,
					extensionTarget: "mortise",
					deferResourceLoad: false,
					persistInitialState: true,
					uiCapabilities,
				},
			});
			return;
		}
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd,
			agentDir,
			projectConfigDir,
			sessionManager,
			extensionTarget: "mortise",
			persistInitialState: true,
		});
		await runRpcMode(runtime, { uiCapabilities });
	} finally {
		restoreStdout();
	}
}
