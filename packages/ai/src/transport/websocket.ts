import { headersToRecord } from "../utils/headers.ts";
import { classifyTransportError, formatUnknownError, TransportError } from "./errors.ts";

export const WEBSOCKET_MESSAGE_TOO_BIG_CLOSE_CODE = 1009;

export type WebSocketEventType = "open" | "message" | "error" | "close";
export type WebSocketListener = (event: unknown) => void;

export interface WebSocketLike {
	close(code?: number, reason?: string): void;
	send(data: string): void;
	addEventListener(type: WebSocketEventType, listener: WebSocketListener): void;
	removeEventListener(type: WebSocketEventType, listener: WebSocketListener): void;
}

export type WebSocketConstructor = new (
	url: string,
	protocols?: string | string[] | { headers?: Record<string, string> },
) => WebSocketLike;

export interface CachedWebSocketConnection<TState = unknown> {
	socket: WebSocketLike;
	busy: boolean;
	idleTimer?: ReturnType<typeof setTimeout>;
	state?: TState;
}

export interface AcquiredWebSocket<TState = unknown> {
	socket: WebSocketLike;
	entry?: CachedWebSocketConnection<TState>;
	reused: boolean;
	release: (options?: { keep?: boolean }) => void;
}

export interface ConnectWebSocketOptions {
	url: string;
	headers?: Headers | Record<string, string>;
	signal?: AbortSignal;
	connectTimeoutMs?: number;
	getConstructor?: () => Promise<WebSocketConstructor | null> | WebSocketConstructor | null;
	prepareHeaders?: (headers: Record<string, string>) => Record<string, string>;
	unavailableMessage?: string;
}

export interface IterateWebSocketJsonMessagesOptions<T> {
	signal?: AbortSignal;
	idleTimeoutMs?: number;
	isTerminalEvent: (message: T) => boolean;
	terminalMissingMessage?: string;
	parseErrorMessage?: (error: unknown, data: string | null) => string;
}

export class WebSocketCloseError extends Error {
	readonly code?: number;
	readonly reason?: string;
	readonly wasClean?: boolean;

	constructor(message: string, options?: { code?: number; reason?: string; wasClean?: boolean; cause?: unknown }) {
		super(message);
		this.name = "WebSocketCloseError";
		this.code = options?.code;
		this.reason = options?.reason;
		this.wasClean = options?.wasClean;
		this.cause = options?.cause;
	}
}

export function getWebSocketReadyState(socket: WebSocketLike): number | undefined {
	const readyState = (socket as { readyState?: unknown }).readyState;
	return typeof readyState === "number" ? readyState : undefined;
}

export function isWebSocketReusable(socket: WebSocketLike): boolean {
	const readyState = getWebSocketReadyState(socket);
	return readyState === undefined || readyState === 1;
}

export function closeWebSocketSilently(socket: WebSocketLike, code = 1000, reason = "done"): void {
	try {
		socket.close(code, reason);
	} catch {}
}

export async function connectWebSocket(options: ConnectWebSocketOptions): Promise<WebSocketLike> {
	const getConstructor = options.getConstructor ?? getGlobalWebSocketConstructor;
	const WebSocketCtor = await getConstructor();
	if (!WebSocketCtor) {
		throw new TransportError({
			code: "websocket_error",
			message: options.unavailableMessage ?? "WebSocket transport is not available in this runtime",
			phase: "websocket_connect",
		});
	}

	const headers =
		options.headers instanceof Headers ? headersToRecord(options.headers) : { ...(options.headers ?? {}) };
	const wsHeaders = options.prepareHeaders?.(headers) ?? headers;

	return new Promise<WebSocketLike>((resolve, reject) => {
		let settled = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let socket: WebSocketLike;

		try {
			socket = new WebSocketCtor(options.url, { headers: wsHeaders });
		} catch (error) {
			reject(classifyTransportError(error, { phase: "websocket_connect" }));
			return;
		}

		const cleanup = () => {
			if (timeout) {
				clearTimeout(timeout);
				timeout = undefined;
			}
			socket.removeEventListener("open", onOpen);
			socket.removeEventListener("error", onError);
			socket.removeEventListener("close", onClose);
			options.signal?.removeEventListener("abort", onAbort);
		};
		const fail = (error: unknown, closeReason?: string) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (closeReason) {
				closeWebSocketSilently(socket, 1000, closeReason);
			}
			reject(classifyTransportError(error, { phase: "websocket_connect" }));
		};
		const onOpen: WebSocketListener = () => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(socket);
		};
		const onError: WebSocketListener = (event) => {
			fail(extractWebSocketError(event));
		};
		const onClose: WebSocketListener = (event) => {
			fail(extractWebSocketCloseError(event));
		};
		const onAbort = () => {
			fail(
				new TransportError({
					code: "aborted",
					message: "Request was aborted",
					phase: "websocket_connect",
					retryable: false,
					cause: options.signal?.reason,
				}),
				"aborted",
			);
		};

		socket.addEventListener("open", onOpen);
		socket.addEventListener("error", onError);
		socket.addEventListener("close", onClose);
		options.signal?.addEventListener("abort", onAbort);

		const connectTimeoutMs = options.connectTimeoutMs;
		if (connectTimeoutMs !== undefined && connectTimeoutMs > 0) {
			timeout = setTimeout(() => {
				fail(
					new TransportError({
						code: "timeout",
						message: `WebSocket connect timeout after ${connectTimeoutMs}ms`,
						phase: "websocket_connect",
					}),
					"connect_timeout",
				);
			}, connectTimeoutMs);
		}
		if (options.signal?.aborted) {
			onAbort();
		}
	});
}

export function createSessionWebSocketCache<TState>(ttlMs: number) {
	const entries = new Map<string, CachedWebSocketConnection<TState>>();

	const scheduleExpiry = (sessionId: string, entry: CachedWebSocketConnection<TState>) => {
		if (entry.idleTimer) {
			clearTimeout(entry.idleTimer);
		}
		entry.idleTimer = setTimeout(() => {
			if (entry.busy) return;
			closeWebSocketSilently(entry.socket, 1000, "idle_timeout");
			entries.delete(sessionId);
		}, ttlMs);
	};

	const closeEntry = (entry: CachedWebSocketConnection<TState>, reason = "debug_close") => {
		if (entry.idleTimer) clearTimeout(entry.idleTimer);
		closeWebSocketSilently(entry.socket, 1000, reason);
	};

	return {
		get(sessionId: string): CachedWebSocketConnection<TState> | undefined {
			return entries.get(sessionId);
		},
		clear(sessionId?: string): void {
			if (sessionId) {
				const entry = entries.get(sessionId);
				if (entry) closeEntry(entry);
				entries.delete(sessionId);
				return;
			}
			for (const entry of entries.values()) {
				closeEntry(entry);
			}
			entries.clear();
		},
		async acquire(options: ConnectWebSocketOptions & { sessionId?: string }): Promise<AcquiredWebSocket<TState>> {
			const sessionId = options.sessionId;
			if (!sessionId) {
				const socket = await connectWebSocket(options);
				return {
					socket,
					reused: false,
					release: () => closeWebSocketSilently(socket),
				};
			}

			const cached = entries.get(sessionId);
			if (cached) {
				if (cached.idleTimer) {
					clearTimeout(cached.idleTimer);
					cached.idleTimer = undefined;
				}
				if (!cached.busy && isWebSocketReusable(cached.socket)) {
					cached.busy = true;
					return {
						socket: cached.socket,
						entry: cached,
						reused: true,
						release: ({ keep } = {}) => {
							if (!keep || !isWebSocketReusable(cached.socket)) {
								closeEntry(cached, "done");
								entries.delete(sessionId);
								return;
							}
							cached.busy = false;
							scheduleExpiry(sessionId, cached);
						},
					};
				}
				if (cached.busy) {
					const socket = await connectWebSocket(options);
					return {
						socket,
						reused: false,
						release: () => closeWebSocketSilently(socket),
					};
				}
				if (!isWebSocketReusable(cached.socket)) {
					closeEntry(cached, "done");
					entries.delete(sessionId);
				}
			}

			const socket = await connectWebSocket(options);
			const entry: CachedWebSocketConnection<TState> = { socket, busy: true };
			entries.set(sessionId, entry);
			return {
				socket,
				entry,
				reused: false,
				release: ({ keep } = {}) => {
					if (!keep || !isWebSocketReusable(entry.socket)) {
						closeEntry(entry, "done");
						if (entries.get(sessionId) === entry) {
							entries.delete(sessionId);
						}
						return;
					}
					entry.busy = false;
					scheduleExpiry(sessionId, entry);
				},
			};
		},
	};
}

export function extractWebSocketError(event: unknown): Error {
	if (event && typeof event === "object") {
		const message = "message" in event ? (event as { message?: unknown }).message : undefined;
		if (typeof message === "string" && message.length > 0) {
			return new TransportError({ code: "websocket_error", message, phase: "websocket_stream" });
		}

		const nestedError = "error" in event ? (event as { error?: unknown }).error : undefined;
		if (nestedError instanceof Error && nestedError.message.length > 0) {
			return nestedError;
		}
		if (nestedError && typeof nestedError === "object" && "message" in nestedError) {
			const nestedMessage = (nestedError as { message?: unknown }).message;
			if (typeof nestedMessage === "string" && nestedMessage.length > 0) {
				return new TransportError({
					code: "websocket_error",
					message: nestedMessage,
					phase: "websocket_stream",
					cause: nestedError,
				});
			}
		}
	}
	return new TransportError({ code: "websocket_error", message: "WebSocket error", phase: "websocket_stream" });
}

export function extractWebSocketCloseError(event: unknown): WebSocketCloseError {
	if (event && typeof event === "object") {
		const code = "code" in event ? (event as { code?: unknown }).code : undefined;
		const reason = "reason" in event ? (event as { reason?: unknown }).reason : undefined;
		const wasClean = "wasClean" in event ? (event as { wasClean?: unknown }).wasClean : undefined;
		const codeText = typeof code === "number" ? ` ${code}` : "";
		let reasonText = typeof reason === "string" && reason.length > 0 ? ` ${reason}` : "";
		if (!reasonText && code === WEBSOCKET_MESSAGE_TOO_BIG_CLOSE_CODE) {
			reasonText = " message too big";
		}
		return new WebSocketCloseError(`WebSocket closed${codeText}${reasonText}`.trim(), {
			code: typeof code === "number" ? code : undefined,
			reason: typeof reason === "string" && reason.length > 0 ? reason : undefined,
			wasClean: typeof wasClean === "boolean" ? wasClean : undefined,
		});
	}
	return new WebSocketCloseError("WebSocket closed");
}

export async function decodeWebSocketData(data: unknown): Promise<string | null> {
	if (typeof data === "string") return data;
	if (data instanceof ArrayBuffer) {
		return new TextDecoder().decode(new Uint8Array(data));
	}
	if (ArrayBuffer.isView(data)) {
		const view = data as ArrayBufferView;
		return new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
	}
	if (data && typeof data === "object" && "arrayBuffer" in data) {
		const blobLike = data as { arrayBuffer: () => Promise<ArrayBuffer> };
		const arrayBuffer = await blobLike.arrayBuffer();
		return new TextDecoder().decode(new Uint8Array(arrayBuffer));
	}
	return null;
}

export async function* iterateWebSocketJsonMessages<T extends Record<string, unknown>>(
	socket: WebSocketLike,
	options: IterateWebSocketJsonMessagesOptions<T>,
): AsyncGenerator<T> {
	const queue: T[] = [];
	let pending: (() => void) | null = null;
	let done = false;
	let failed: Error | null = null;
	let sawCompletion = false;

	const wake = () => {
		if (!pending) return;
		const resolve = pending;
		pending = null;
		resolve();
	};

	const onMessage: WebSocketListener = (event) => {
		void (async () => {
			let text: string | null = null;
			try {
				if (!event || typeof event !== "object" || !("data" in event)) return;
				text = await decodeWebSocketData((event as { data?: unknown }).data);
				if (!text) return;
				const parsed = JSON.parse(text) as T;
				if (options.isTerminalEvent(parsed)) {
					sawCompletion = true;
					done = true;
				}
				queue.push(parsed);
				wake();
			} catch (cause) {
				failed = new TransportError({
					code: "protocol_error",
					message:
						options.parseErrorMessage?.(cause, text) ?? `Invalid WebSocket JSON: ${formatUnknownError(cause)}`,
					phase: "websocket_stream",
					retryable: false,
					cause,
				});
				done = true;
				wake();
			}
		})();
	};

	const onError: WebSocketListener = (event) => {
		failed = extractWebSocketError(event);
		done = true;
		wake();
	};

	const onClose: WebSocketListener = (event) => {
		if (sawCompletion) {
			done = true;
			wake();
			return;
		}
		if (!failed) {
			failed = extractWebSocketCloseError(event);
		}
		done = true;
		wake();
	};

	const onAbort = () => {
		failed = new TransportError({
			code: "aborted",
			message: "Request was aborted",
			phase: "websocket_stream",
			retryable: false,
			cause: options.signal?.reason,
		});
		done = true;
		wake();
	};

	socket.addEventListener("message", onMessage);
	socket.addEventListener("error", onError);
	socket.addEventListener("close", onClose);
	options.signal?.addEventListener("abort", onAbort);

	try {
		while (true) {
			if (options.signal?.aborted) {
				throw new TransportError({
					code: "aborted",
					message: "Request was aborted",
					phase: "websocket_stream",
					retryable: false,
					cause: options.signal.reason,
				});
			}
			if (queue.length > 0) {
				yield queue.shift()!;
				continue;
			}
			if (done) break;
			let timeout: ReturnType<typeof setTimeout> | undefined;
			await new Promise<void>((resolve, reject) => {
				pending = resolve;
				if (options.idleTimeoutMs !== undefined && options.idleTimeoutMs > 0) {
					timeout = setTimeout(() => {
						const error = new TransportError({
							code: "idle_timeout",
							message: `WebSocket idle timeout after ${options.idleTimeoutMs}ms`,
							phase: "websocket_stream",
						});
						failed = error;
						done = true;
						pending = null;
						closeWebSocketSilently(socket, 1000, "idle_timeout");
						reject(error);
					}, options.idleTimeoutMs);
				}
			}).finally(() => {
				if (timeout) {
					clearTimeout(timeout);
				}
			});
		}

		if (failed) {
			throw failed;
		}
		if (!sawCompletion) {
			throw new TransportError({
				code: "websocket_closed",
				message: options.terminalMissingMessage ?? "WebSocket stream closed before terminal event",
				phase: "websocket_stream",
			});
		}
	} finally {
		socket.removeEventListener("message", onMessage);
		socket.removeEventListener("error", onError);
		socket.removeEventListener("close", onClose);
		options.signal?.removeEventListener("abort", onAbort);
	}
}

function getGlobalWebSocketConstructor(): WebSocketConstructor | null {
	const ctor = (globalThis as { WebSocket?: unknown }).WebSocket;
	if (typeof ctor !== "function") return null;
	return ctor as unknown as WebSocketConstructor;
}
