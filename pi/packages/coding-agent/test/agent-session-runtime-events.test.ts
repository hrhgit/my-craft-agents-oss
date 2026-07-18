import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionActivityRegistry } from "../src/core/session-activity-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type {
	ExtensionFactory,
	SessionBeforeForkEvent,
	SessionBeforeSwitchEvent,
	SessionShutdownEvent,
	SessionStartEvent,
} from "../src/index.ts";

type RecordedSessionEvent =
	| SessionBeforeSwitchEvent
	| SessionBeforeForkEvent
	| SessionShutdownEvent
	| SessionStartEvent;

describe("AgentSessionRuntime session lifecycle events", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	async function createRuntimeHost(extensionFactory: ExtensionFactory) {
		const tempDir = join(tmpdir(), `pi-runtime-events-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);

		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

		const runtimeOptions = {
			agentDir: tempDir,
			authStorage,
			model: faux.getModel(),
			resourceLoaderOptions: {
				extensionFactories: [extensionFactory],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				...runtimeOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: faux.getModel(),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtimeHost = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(tempDir),
		});
		await runtimeHost.session.bindExtensions({});

		cleanups.push(async () => {
			await runtimeHost.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		return { runtimeHost, faux };
	}

	it("emits session_before_switch and session_start for new and resume flows", async () => {
		const events: RecordedSessionEvent[] = [];
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_before_switch", (event) => {
				events.push(event);
			});
			pi.on("session_shutdown", (event) => {
				events.push(event);
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtimeHost.session.prompt("hello");
		const originalSessionFile = runtimeHost.session.sessionFile;
		expect(originalSessionFile).toBeTruthy();

		const newSessionResult = await runtimeHost.newSession();
		expect(newSessionResult.cancelled).toBe(false);
		await runtimeHost.session.bindExtensions({});
		const secondSessionFile = runtimeHost.session.sessionFile;
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "new", targetSessionFile: undefined },
			{ type: "session_shutdown", reason: "new", targetSessionFile: secondSessionFile },
			{ type: "session_start", reason: "new", previousSessionFile: originalSessionFile },
		]);

		events.length = 0;
		expect(secondSessionFile).toBeTruthy();

		const switchResult = await runtimeHost.switchSession(originalSessionFile!);
		expect(switchResult.cancelled).toBe(false);
		await runtimeHost.session.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "resume", targetSessionFile: originalSessionFile },
			{ type: "session_shutdown", reason: "resume", targetSessionFile: originalSessionFile },
			{ type: "session_start", reason: "resume", previousSessionFile: secondSessionFile },
		]);
	});

	it("honors session_before_switch cancellation", async () => {
		const events: RecordedSessionEvent[] = [];
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_before_switch", (event) => {
				events.push(event);
				return { cancel: true };
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtimeHost.session.prompt("hello");
		const originalSessionFile = runtimeHost.session.sessionFile;

		const result = await runtimeHost.newSession();
		expect(result.cancelled).toBe(true);
		expect(runtimeHost.session.sessionFile).toBe(originalSessionFile);
		expect(events).toEqual([{ type: "session_before_switch", reason: "new", targetSessionFile: undefined }]);
	});

	it("gives extensions the runtime agentDir session activity registry", async () => {
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_start", async (_event, ctx) => {
				await ctx.sessionActivityRegistry.upsertActiveSession({
					id: "background-agent",
					ownerId: "background-agent",
					ownerKind: "agent",
					cwd: ctx.cwd,
					sessionId: "background-session",
					status: "running",
					leaseDurationMs: 60_000,
				});
			});
		});

		const activeSessions = await SessionActivityRegistry.create(runtimeHost.services.agentDir).listActiveSessions();

		expect(activeSessions).toMatchObject([
			{
				id: "background-agent",
				ownerId: "background-agent",
				ownerKind: "agent",
				cwd: runtimeHost.cwd,
				sessionId: "background-session",
				status: "running",
			},
		]);
	});

	it("prepares deferred request resources without persisting placeholder state", async () => {
		const tempDir = join(tmpdir(), `pi-runtime-deferred-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(sessionDir, { recursive: true });

		const faux = registerFauxProvider();
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
		const events: RecordedSessionEvent[] = [];

		const createRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			sessionManager,
			sessionStartEvent,
			deferResourceLoad,
			persistInitialState,
		}) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir: tempDir,
				authStorage,
				deferResourceLoad,
				resourceLoaderOptions: {
					extensionFactories: [
						(pi) => {
							pi.on("session_start", (event) => {
								events.push(event);
							});
						},
					],
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: faux.getModel(),
					persistInitialState,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};

		const sessionManager = SessionManager.create(tempDir, sessionDir);
		const runtimeHost = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager,
			deferResourceLoad: true,
			persistInitialState: false,
		});
		runtimeHost.setRebindSession(async (session) => {
			await session.bindExtensions({});
		});
		cleanups.push(async () => {
			await runtimeHost.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		expect(runtimeHost.isWorkspaceLoaded).toBe(true);
		expect(runtimeHost.session.resourceLoader.getExtensions().extensions).toEqual([]);
		expect(runtimeHost.session.sessionManager.getEntries()).toEqual([]);

		await runtimeHost.loadWorkspace();

		expect(runtimeHost.isWorkspaceLoaded).toBe(true);
		expect(runtimeHost.session.resourceLoader.getExtensions().extensions).toHaveLength(1);
		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		expect(runtimeHost.session.sessionManager.getEntries().map((entry) => entry.type)).toEqual([
			"model_change",
			"thinking_level_change",
		]);
	});

	it("keeps deferred resource loading for replacement sessions", async () => {
		const tempDir = join(tmpdir(), `pi-runtime-replacement-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(sessionDir, { recursive: true });

		const faux = registerFauxProvider();
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
		const seenOptions: Array<{ deferResourceLoad?: boolean; persistInitialState?: boolean }> = [];

		const createRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			sessionManager,
			sessionStartEvent,
			deferResourceLoad,
			persistInitialState,
		}) => {
			seenOptions.push({ deferResourceLoad, persistInitialState });
			const services = await createAgentSessionServices({
				cwd,
				agentDir: tempDir,
				authStorage,
				deferResourceLoad,
				resourceLoaderOptions: {
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: faux.getModel(),
					persistInitialState,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};

		const runtimeHost = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(tempDir, sessionDir),
			deferResourceLoad: true,
			persistInitialState: false,
		});
		cleanups.push(async () => {
			await runtimeHost.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		await runtimeHost.newSession();

		expect(seenOptions).toEqual([
			{ deferResourceLoad: true, persistInitialState: false },
			{ deferResourceLoad: true, persistInitialState: false },
		]);
	});

	it("registers startup extension providers before deferred request resources", async () => {
		const tempDir = join(
			tmpdir(),
			`pi-runtime-startup-provider-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		const extensionDir = join(tempDir, "extensions");
		mkdirSync(extensionDir, { recursive: true });
		writeFileSync(
			join(extensionDir, "startup-provider.ts"),
			`
export default function (pi) {
  pi.registerProvider("startup-provider", {
    baseUrl: "https://startup-provider.invalid/v1",
    apiKey: "$STARTUP_PROVIDER_API_KEY",
    api: "openai-completions",
    models: [{
      id: "startup-model",
      name: "Startup Model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096
    }]
  });
}
`,
			"utf-8",
		);

		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey("startup-provider", "startup-key");
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		settingsManager.setExtensionPaths([{ path: "extensions/startup-provider.ts", activation: "startup" }]);

		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			settingsManager,
			deferResourceLoad: true,
			resourceLoaderOptions: {
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});
		const runtime = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.create(tempDir),
			persistInitialState: false,
		});

		cleanups.push(async () => {
			runtime.session.dispose();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		expect(services.resourceLoader.getExtensions().extensions.map((extension) => extension.activation)).toEqual([
			"startup",
		]);
		expect(services.modelRegistry.find("startup-provider", "startup-model")?.id).toBe("startup-model");
		expect(runtime.session.model?.provider).toBe("startup-provider");
		expect(runtime.session.model?.id).toBe("startup-model");
	});

	it("can create a new session in a different cwd", async () => {
		const events: RecordedSessionEvent[] = [];
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_shutdown", (event) => {
				events.push(event);
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});
		const originalSessionFile = runtimeHost.session.sessionFile;
		const targetCwd = join(runtimeHost.services.agentDir, "other-workspace");
		mkdirSync(targetCwd, { recursive: true });

		const result = await runtimeHost.newSession({ cwd: targetCwd });
		await runtimeHost.session.bindExtensions({});

		expect(result.cancelled).toBe(false);
		expect(runtimeHost.cwd).toBe(targetCwd);
		expect(runtimeHost.session.sessionManager.getCwd()).toBe(targetCwd);
		expect(runtimeHost.session.sessionManager.getSessionFile()).toContain("other-workspace");
		expect(events).toEqual([
			{ type: "session_start", reason: "startup" },
			{ type: "session_shutdown", reason: "new", targetSessionFile: runtimeHost.session.sessionFile },
			{ type: "session_start", reason: "new", previousSessionFile: originalSessionFile },
		]);
	});

	it("runs beforeSessionInvalidate after session_shutdown and before rebindSession", async () => {
		const phases: string[] = [];
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_shutdown", () => {
				phases.push("session_shutdown");
			});
		});
		const oldSession = runtimeHost.session;
		runtimeHost.setBeforeSessionInvalidate(() => {
			phases.push("beforeSessionInvalidate");
			expect(oldSession.extensionRunner.createContext().cwd).toBe(oldSession.sessionManager.getCwd());
		});
		runtimeHost.setRebindSession(async () => {
			phases.push("rebindSession");
		});

		await runtimeHost.newSession();

		expect(phases).toEqual(["session_shutdown", "beforeSessionInvalidate", "rebindSession"]);
		expect(() => oldSession.extensionRunner.createContext().cwd).toThrow(
			"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
		);
		runtimeHost.setBeforeSessionInvalidate(undefined);
		runtimeHost.setRebindSession(undefined);
	});

	it("emits session_before_fork and session_start and honors cancellation", async () => {
		const events: RecordedSessionEvent[] = [];
		let cancelNextFork = false;
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_before_fork", (event) => {
				events.push(event);
				if (cancelNextFork) {
					cancelNextFork = false;
					return { cancel: true };
				}
			});
			pi.on("session_shutdown", (event) => {
				events.push(event);
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtimeHost.session.prompt("hello");
		const userMessage = runtimeHost.session.getUserMessagesForForking()[0];
		const previousSessionFile = runtimeHost.session.sessionFile;

		const successResult = await runtimeHost.fork(userMessage.entryId);
		expect(successResult.cancelled).toBe(false);
		expect(successResult.selectedText).toBe("hello");
		await runtimeHost.session.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_fork", entryId: userMessage.entryId, position: "before" },
			{ type: "session_shutdown", reason: "fork", targetSessionFile: runtimeHost.session.sessionFile },
			{ type: "session_start", reason: "fork", previousSessionFile },
		]);

		events.length = 0;
		cancelNextFork = true;
		const cancelResult = await runtimeHost.fork(userMessage.entryId);
		expect(cancelResult).toEqual({ cancelled: true });
		expect(events).toEqual([{ type: "session_before_fork", entryId: userMessage.entryId, position: "before" }]);

		events.length = 0;
		cancelNextFork = true;
		const cancelAtResult = await runtimeHost.fork("missing-entry", { position: "at" });
		expect(cancelAtResult).toEqual({ cancelled: true });
		expect(events).toEqual([{ type: "session_before_fork", entryId: "missing-entry", position: "at" }]);
	});
});
