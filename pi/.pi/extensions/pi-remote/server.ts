import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { RemoteAuth } from "./auth.ts";
import { asRecord, isDeliveryMode, isThinkingLevel, type ClientEvent, type RemoteSessionInfo, type ServerEvent } from "./protocol.ts";
import { createRemoteState, toRemoteModel, type RemoteSettings } from "./state.ts";

interface RemoteServerOptions {
	pi: ExtensionAPI;
	auth: RemoteAuth;
	settings: RemoteSettings;
	getContext: () => ExtensionContext | undefined;
	getThinkingLevel: () => ReturnType<ExtensionAPI["getThinkingLevel"]>;
}

interface WebSocketClient {
	socket: import("node:net").Socket;
	authed: boolean;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	const text = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(text),
	});
	res.end(text);
}

function readBody(req: IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => {
			chunks.push(chunk);
			if (Buffer.concat(chunks).length > 1024 * 1024) {
				req.destroy(new Error("Request body too large"));
			}
		});
		req.on("end", () => {
			const text = Buffer.concat(chunks).toString("utf8");
			if (!text.trim()) {
				resolve({});
				return;
			}
			try {
				resolve(JSON.parse(text));
			} catch (error) {
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
		req.on("error", reject);
	});
}

function getBearerToken(req: IncomingMessage): string | undefined {
	const header = req.headers.authorization;
	if (!header) return undefined;
	const match = /^Bearer\s+(.+)$/i.exec(header);
	return match?.[1];
}

function encodeWsFrame(payload: string): Buffer {
	const data = Buffer.from(payload);
	if (data.length < 126) {
		return Buffer.concat([Buffer.from([0x81, data.length]), data]);
	}
	if (data.length <= 0xffff) {
		const header = Buffer.alloc(4);
		header[0] = 0x81;
		header[1] = 126;
		header.writeUInt16BE(data.length, 2);
		return Buffer.concat([header, data]);
	}
	const header = Buffer.alloc(10);
	header[0] = 0x81;
	header[1] = 127;
	header.writeBigUInt64BE(BigInt(data.length), 2);
	return Buffer.concat([header, data]);
}

function decodeWsFrames(buffer: Buffer): { messages: string[]; remaining: Buffer; close: boolean } {
	const messages: string[] = [];
	let offset = 0;
	let close = false;
	while (offset + 2 <= buffer.length) {
		const first = buffer[offset];
		const second = buffer[offset + 1];
		const opcode = first & 0x0f;
		const masked = (second & 0x80) !== 0;
		let length = second & 0x7f;
		let headerLength = 2;
		if (length === 126) {
			if (offset + 4 > buffer.length) break;
			length = buffer.readUInt16BE(offset + 2);
			headerLength = 4;
		} else if (length === 127) {
			if (offset + 10 > buffer.length) break;
			const bigLength = buffer.readBigUInt64BE(offset + 2);
			if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("WebSocket frame too large");
			length = Number(bigLength);
			headerLength = 10;
		}
		const maskLength = masked ? 4 : 0;
		const frameLength = headerLength + maskLength + length;
		if (offset + frameLength > buffer.length) break;
		if (opcode === 0x8) {
			close = true;
			offset += frameLength;
			continue;
		}
		if (opcode !== 0x1) {
			offset += frameLength;
			continue;
		}
		const mask = masked ? buffer.subarray(offset + headerLength, offset + headerLength + 4) : undefined;
		const payload = Buffer.from(buffer.subarray(offset + headerLength + maskLength, offset + frameLength));
		if (mask) {
			for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
		}
		messages.push(payload.toString("utf8"));
		offset += frameLength;
	}
	return { messages, remaining: buffer.subarray(offset), close };
}

function stringifyUnknown(value: unknown): string | undefined {
	if (value == null) return undefined;
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

export class RemoteServer {
	private server: Server | undefined;
	private clients = new Set<WebSocketClient>();

	constructor(private readonly options: RemoteServerOptions) {}

	get running(): boolean {
		return this.server !== undefined;
	}

	async start(host = this.options.auth.host, port = this.options.auth.port): Promise<void> {
		if (this.server) return;
		this.server = createServer((req, res) => {
			void this.handleRequest(req, res).catch((error: unknown) => {
				sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
			});
		});
		this.server.on("upgrade", (req, socket) => {
			this.handleUpgrade(req, socket);
		});
		await new Promise<void>((resolve, reject) => {
			this.server?.once("error", reject);
			this.server?.listen(port, host, () => {
				this.server?.off("error", reject);
				this.options.auth.setEndpoint(host, port);
				resolve();
			});
		});
	}

	async stop(): Promise<void> {
		for (const client of this.clients) client.socket.destroy();
		this.clients.clear();
		const server = this.server;
		this.server = undefined;
		if (!server) return;
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	broadcast(event: ServerEvent): void {
		const frame = encodeWsFrame(JSON.stringify(event));
		for (const client of this.clients) {
			if (client.authed) client.socket.write(frame);
		}
	}

	broadcastState(): void {
		const state = this.getState();
		if (state) this.broadcast({ type: "state", state });
	}

	private getState() {
		const ctx = this.options.getContext();
		if (!ctx) return undefined;
		return createRemoteState(ctx, this.options.settings, this.options.getThinkingLevel());
	}

	private isAuthed(req: IncomingMessage): boolean {
		const token = getBearerToken(req);
		return typeof token === "string" && this.options.auth.verify(token);
	}

	private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
		if (req.method === "GET" && url.pathname === "/api/health") {
			sendJson(res, 200, { ok: true, serverVersion: "0.1.0", requiresAuth: true });
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/auth/verify") {
			sendJson(res, this.isAuthed(req) ? 200 : 401, { ok: this.isAuthed(req) });
			return;
		}
		if (!this.isAuthed(req)) {
			sendJson(res, 401, { error: "Unauthorized" });
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/state") {
			const state = this.getState();
			if (!state) sendJson(res, 503, { error: "No active pi session" });
			else sendJson(res, 200, state);
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/models") {
			const ctx = this.options.getContext();
			if (!ctx) {
				sendJson(res, 503, { error: "No active pi session" });
				return;
			}
			sendJson(res, 200, { models: ctx.modelRegistry.getAvailable().map(toRemoteModel) });
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/model") {
			await this.setModel(await readBody(req));
			sendJson(res, 200, { ok: true });
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/thinking-level") {
			this.setThinkingLevel(await readBody(req));
			sendJson(res, 200, { ok: true });
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/settings") {
			this.setSettings(await readBody(req));
			sendJson(res, 200, { ok: true });
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/prompt") {
			await this.prompt(await readBody(req));
			sendJson(res, 200, { ok: true });
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/abort") {
			const ctx = this.options.getContext();
			ctx?.abort();
			sendJson(res, 200, { ok: true });
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/sessions") {
			const ctx = this.options.getContext();
			if (!ctx) {
				sendJson(res, 503, { error: "No active pi session" });
				return;
			}
			const sessions = await SessionManager.list(ctx.cwd);
			const result: RemoteSessionInfo[] = sessions.map((session) => ({
				file: session.path,
				id: session.id,
				name: session.name,
				cwd: session.cwd,
				createdAt: session.created.getTime(),
				updatedAt: session.modified.getTime(),
				messageCount: session.messageCount,
				firstMessage: session.firstMessage,
			}));
			sendJson(res, 200, { sessions: result });
			return;
		}
		sendJson(res, 404, { error: "Not found" });
	}

	private handleUpgrade(req: IncomingMessage, socket: import("node:net").Socket): void {
		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
		if (url.pathname !== "/ws") {
			socket.destroy();
			return;
		}
		const key = req.headers["sec-websocket-key"];
		if (typeof key !== "string") {
			socket.destroy();
			return;
		}
		const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
		socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${accept}`, "", ""].join("\r\n"));
		const client: WebSocketClient = { socket, authed: false };
		this.clients.add(client);
		let buffer = Buffer.alloc(0);
		socket.on("data", (chunk: Buffer) => {
			try {
				buffer = Buffer.concat([buffer, chunk]);
				const result = decodeWsFrames(buffer);
				buffer = result.remaining;
				if (result.close) socket.destroy();
				for (const message of result.messages) this.handleWsMessage(client, message);
			} catch (error) {
				this.sendToClient(client, { type: "error", message: error instanceof Error ? error.message : String(error) });
				socket.destroy();
			}
		});
		socket.on("close", () => this.clients.delete(client));
		socket.on("error", () => this.clients.delete(client));
	}

	private sendToClient(client: WebSocketClient, event: ServerEvent): void {
		client.socket.write(encodeWsFrame(JSON.stringify(event)));
	}

	private handleWsMessage(client: WebSocketClient, message: string): void {
		const event = JSON.parse(message) as ClientEvent;
		if (!client.authed) {
			if (event.type !== "auth" || !this.options.auth.verify(event.token)) {
				this.sendToClient(client, { type: "error", message: "Unauthorized" });
				client.socket.destroy();
				return;
			}
			client.authed = true;
			const state = this.getState();
			if (state) this.sendToClient(client, { type: "ready", state });
			return;
		}
		void this.handleClientEvent(event).catch((error: unknown) => {
			this.sendToClient(client, { type: "error", message: error instanceof Error ? error.message : String(error) });
		});
	}

	private async handleClientEvent(event: ClientEvent): Promise<void> {
		if (event.type === "ping") {
			this.broadcast({ type: "pong" });
			return;
		}
		if (event.type === "prompt") {
			await this.prompt(event);
			return;
		}
		if (event.type === "abort") {
			this.options.getContext()?.abort();
			return;
		}
		if (event.type === "set_model") {
			await this.setModel(event);
			return;
		}
		if (event.type === "set_thinking_level") {
			this.setThinkingLevel(event);
			return;
		}
		if (event.type === "set_settings") {
			this.setSettings(event);
		}
	}

	private async prompt(value: unknown): Promise<void> {
		const body = asRecord(value);
		const text = body?.text;
		if (typeof text !== "string" || !text.trim()) throw new Error("Missing prompt text");
		const ctx = this.options.getContext();
		if (!ctx) throw new Error("No active pi session");
		const delivery = isDeliveryMode(body.delivery) ? body.delivery : undefined;
		if (ctx.isIdle()) this.options.pi.sendUserMessage(text);
		else if (delivery) this.options.pi.sendUserMessage(text, { deliverAs: delivery });
		else throw new Error("Agent is busy; specify delivery as steer or followUp");
	}

	private async setModel(value: unknown): Promise<void> {
		const body = asRecord(value);
		const provider = body?.provider;
		const id = body?.id;
		if (typeof provider !== "string" || typeof id !== "string") throw new Error("Missing provider or id");
		const ctx = this.options.getContext();
		if (!ctx) throw new Error("No active pi session");
		const model = ctx.modelRegistry.find(provider, id);
		if (!model) throw new Error(`Model not found: ${provider}/${id}`);
		const ok = await this.options.pi.setModel(model);
		if (!ok) throw new Error(`No API key available for model: ${provider}/${id}`);
		this.broadcastState();
	}

	private setThinkingLevel(value: unknown): void {
		const body = asRecord(value);
		if (!isThinkingLevel(body?.level)) throw new Error("Invalid thinking level");
		this.options.pi.setThinkingLevel(body.level);
		this.broadcastState();
	}

	private setSettings(value: unknown): void {
		const body = asRecord(value);
		if (typeof body?.webSearch === "boolean") this.options.settings.webSearch = body.webSearch;
		if (typeof body?.planMode === "boolean") this.options.settings.planMode = body.planMode;
		this.broadcastState();
	}

	forwardToolStart(toolCallId: string, toolName: string, input: unknown): void {
		this.broadcast({ type: "tool_start", toolCallId, toolName, input });
	}

	forwardToolUpdate(toolCallId: string, toolName: string, partialResult: unknown): void {
		this.broadcast({ type: "tool_update", toolCallId, toolName, text: stringifyUnknown(partialResult) ?? "" });
	}

	forwardToolEnd(toolCallId: string, toolName: string, isError: boolean, result: unknown): void {
		this.broadcast({ type: "tool_end", toolCallId, toolName, isError, output: stringifyUnknown(result) });
	}
}
