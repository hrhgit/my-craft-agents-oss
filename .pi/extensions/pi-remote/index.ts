import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { RemoteAuth } from "./auth.ts";
import { RemoteServer } from "./server.ts";
import type { RemoteSettings } from "./state.ts";

const PLAN_MODE_PROMPT =
	"Remote plan mode is enabled. Before making file changes or running destructive commands, first present a concise plan and wait for explicit user approval. Prefer investigation and read-only commands until approved.";

export default function (pi: ExtensionAPI) {
	let currentContext: ExtensionContext | undefined;
	const settings: RemoteSettings = { webSearch: false, planMode: false };
	const extensionDir = dirname(fileURLToPath(import.meta.url));
	const loaded = RemoteAuth.load(extensionDir);
	const server = new RemoteServer({
		pi,
		auth: loaded.auth,
		settings,
		getContext: () => currentContext,
		getThinkingLevel: () => pi.getThinkingLevel(),
	});

	pi.registerCommand("remote", {
		description: "Manage the pi remote server",
		handler: async (args, ctx) => {
			const [command, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			if (!command || command === "status") {
				ctx.ui.notify(`pi-remote ${server.running ? "running" : "stopped"} at ${loaded.auth.host}:${loaded.auth.port}`, "info");
				return;
			}
			if (command === "start") {
				const host = rest[0] || loaded.auth.host;
				const portText = rest[1];
				const port = portText ? Number.parseInt(portText, 10) : loaded.auth.port;
				if (!Number.isInteger(port) || port <= 0 || port > 65535) {
					ctx.ui.notify("Usage: /remote start [host] [port]", "error");
					return;
				}
				await server.start(host, port);
				ctx.ui.notify(`pi-remote listening on ${host}:${port}`, "info");
				return;
			}
			if (command === "stop") {
				await server.stop();
				ctx.ui.notify("pi-remote stopped", "info");
				return;
			}
			if (command === "token") {
				if (rest[0] === "rotate") {
					const token = loaded.auth.rotate();
					ctx.ui.notify(`New pi-remote token: ${token}`, "info");
					return;
				}
				if (loaded.token) {
					ctx.ui.notify(`Initial pi-remote token: ${loaded.token}`, "info");
				} else {
					ctx.ui.notify("Token is already generated. Use /remote token rotate to create a new one.", "info");
				}
				return;
			}
			ctx.ui.notify("Usage: /remote status | start [host] [port] | stop | token [rotate]", "warning");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		currentContext = ctx;
		ctx.ui.setStatus("pi-remote", server.running ? `remote ${loaded.auth.host}:${loaded.auth.port}` : "remote stopped");
	});

	pi.on("session_shutdown", async () => {
		currentContext = undefined;
		await server.stop();
	});

	pi.on("before_agent_start", async (event) => {
		if (!settings.planMode) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${PLAN_MODE_PROMPT}` };
	});

	pi.on("agent_start", async () => {
		server.broadcast({ type: "agent_start" });
		server.broadcastState();
	});

	pi.on("agent_end", async () => {
		server.broadcast({ type: "agent_end" });
		server.broadcastState();
	});

	pi.on("message_update", async (event) => {
		const assistantEvent = event.assistantMessageEvent;
		if (assistantEvent.type === "text_delta") {
			server.broadcast({ type: "assistant_delta", text: assistantEvent.delta });
		} else if (assistantEvent.type === "thinking_delta") {
			server.broadcast({ type: "thinking_delta", text: assistantEvent.delta });
		}
	});

	pi.on("tool_execution_start", async (event) => {
		server.forwardToolStart(event.toolCallId, event.toolName, event.args);
	});

	pi.on("tool_execution_update", async (event) => {
		server.forwardToolUpdate(event.toolCallId, event.toolName, event.partialResult);
	});

	pi.on("tool_execution_end", async (event) => {
		server.forwardToolEnd(event.toolCallId, event.toolName, event.isError, event.result);
	});

	pi.on("model_select", async () => {
		server.broadcastState();
	});

	pi.on("thinking_level_select", async () => {
		server.broadcastState();
	});
}
