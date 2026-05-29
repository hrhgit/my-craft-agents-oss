export type TransportErrorCode =
	| "aborted"
	| "timeout"
	| "header_timeout"
	| "idle_timeout"
	| "rate_limit"
	| "terminal_rate_limit"
	| "server_error"
	| "auth_error"
	| "client_error"
	| "network_error"
	| "websocket_closed"
	| "websocket_error"
	| "protocol_error"
	| "unknown";

export type TransportPhase =
	| "request"
	| "response_headers"
	| "response_body"
	| "stream"
	| "websocket_connect"
	| "websocket_stream"
	| "sdk"
	| "unknown";

export interface TransportErrorOptions {
	code: TransportErrorCode;
	message: string;
	status?: number;
	retryable?: boolean;
	phase?: TransportPhase;
	retryAfterMs?: number;
	cause?: unknown;
}

export interface TransportErrorClassificationContext {
	status?: number;
	phase?: TransportPhase;
	retryAfterMs?: number;
	terminalRateLimit?: boolean;
	messageTooBig?: boolean;
	forcePhase?: boolean;
}

export class TransportError extends Error {
	readonly code: TransportErrorCode;
	readonly status?: number;
	readonly retryable: boolean;
	readonly phase?: TransportPhase;
	readonly retryAfterMs?: number;

	constructor(options: TransportErrorOptions) {
		super(options.message);
		this.name = "TransportError";
		this.code = options.code;
		this.status = options.status;
		this.retryable = options.retryable ?? isRetryableTransportErrorCode(options.code);
		this.phase = options.phase;
		this.retryAfterMs = options.retryAfterMs;
		this.cause = options.cause;
	}
}

export function isRetryableTransportErrorCode(code: TransportErrorCode): boolean {
	switch (code) {
		case "timeout":
		case "header_timeout":
		case "idle_timeout":
		case "rate_limit":
		case "server_error":
		case "network_error":
		case "websocket_closed":
		case "websocket_error":
			return true;
		default:
			return false;
	}
}

export function isRetryableTransportError(error: unknown): boolean {
	return error instanceof TransportError ? error.retryable : classifyTransportError(error).retryable;
}

export function isAbortLikeError(error: unknown): boolean {
	if (error instanceof TransportError) return error.code === "aborted";
	if (!(error instanceof Error)) return false;
	const name = error.name.toLowerCase();
	const message = error.message.toLowerCase();
	return name === "aborterror" || message === "request was aborted" || message === "request aborted";
}

export function classifyTransportError(
	error: unknown,
	context: TransportErrorClassificationContext = {},
): TransportError {
	if (error instanceof TransportError) {
		if (context.forcePhase && context.phase && error.phase !== context.phase) {
			return new TransportError({
				code: error.code,
				message: error.message,
				status: error.status,
				retryable: error.retryable,
				phase: context.phase,
				retryAfterMs: error.retryAfterMs,
				cause: error.cause,
			});
		}
		return error;
	}

	const status = context.status ?? extractStatus(error);
	const retryAfterMs = context.retryAfterMs ?? extractRetryAfterMs(error);
	const message = formatUnknownError(error);
	const phase = context.phase ?? "unknown";

	if (isAbortLikeError(error)) {
		return new TransportError({
			code: "aborted",
			message: normalizedAbortMessage(message),
			status,
			phase,
			retryAfterMs,
			retryable: false,
			cause: error,
		});
	}

	if (context.terminalRateLimit || isTerminalRateLimitMessage(message)) {
		return new TransportError({
			code: "terminal_rate_limit",
			message,
			status,
			phase,
			retryAfterMs,
			retryable: false,
			cause: error,
		});
	}

	if (status !== undefined) {
		return classifyStatusError(error, message, status, phase, retryAfterMs);
	}

	const lower = message.toLowerCase();
	if (/headers? timed out|headers? timeout|reset before headers/.test(lower)) {
		return new TransportError({
			code: "header_timeout",
			message,
			phase: context.phase ?? "response_headers",
			retryAfterMs,
			cause: error,
		});
	}

	if (/idle timeout/.test(lower)) {
		return new TransportError({
			code: "idle_timeout",
			message,
			phase: context.phase ?? "stream",
			retryAfterMs,
			cause: error,
		});
	}

	if (/timed? out|timeout/.test(lower)) {
		return new TransportError({
			code: "timeout",
			message,
			phase,
			retryAfterMs,
			cause: error,
		});
	}

	if (/websocket closed|other side closed|stream closed before|message too big/.test(lower)) {
		return new TransportError({
			code: "websocket_closed",
			message,
			phase: context.phase ?? "websocket_stream",
			retryAfterMs,
			cause: error,
		});
	}

	if (/websocket error|websocket transport is not available/.test(lower)) {
		return new TransportError({
			code: "websocket_error",
			message,
			phase: context.phase ?? "websocket_connect",
			retryAfterMs,
			cause: error,
		});
	}

	if (
		/fetch failed|network.?error|connection.?error|connection.?refused|connection.?lost|socket hang up|upstream.?connect|terminated|econnreset|enotfound|etimedout|http2 request did not get a response/i.test(
			message,
		)
	) {
		return new TransportError({
			code: "network_error",
			message,
			phase,
			retryAfterMs,
			cause: error,
		});
	}

	if (/stream ended before|ended without/i.test(message)) {
		return new TransportError({
			code: "network_error",
			message,
			phase,
			retryAfterMs,
			cause: error,
		});
	}

	if (/invalid .*json|could not parse|protocol/i.test(message)) {
		return new TransportError({
			code: "protocol_error",
			message,
			phase,
			retryAfterMs,
			retryable: false,
			cause: error,
		});
	}

	return new TransportError({
		code: "unknown",
		message,
		status,
		phase,
		retryAfterMs,
		retryable: false,
		cause: error,
	});
}

export function formatTransportError(error: unknown, prefix?: string): string {
	const transportError = classifyTransportError(error);
	const message = transportError.message || transportError.code;
	if (prefix && transportError.status !== undefined) {
		return `${prefix} (${transportError.status}): ${message}`;
	}
	return message;
}

export function formatUnknownError(error: unknown): string {
	if (error instanceof Error) return error.message || error.name;
	if (typeof error === "string") return error;
	try {
		const serialized = JSON.stringify(error);
		return serialized === undefined ? String(error) : serialized;
	} catch {
		return String(error);
	}
}

function classifyStatusError(
	error: unknown,
	message: string,
	status: number,
	phase: TransportPhase,
	retryAfterMs: number | undefined,
): TransportError {
	if (status === 401 || status === 403) {
		return new TransportError({
			code: "auth_error",
			message,
			status,
			phase,
			retryAfterMs,
			retryable: false,
			cause: error,
		});
	}

	if (status === 429) {
		return new TransportError({
			code: "rate_limit",
			message,
			status,
			phase,
			retryAfterMs,
			cause: error,
		});
	}

	if (status === 500 || status === 502 || status === 503 || status === 504) {
		return new TransportError({
			code: "server_error",
			message,
			status,
			phase,
			retryAfterMs,
			cause: error,
		});
	}

	if (status >= 400 && status < 500) {
		return new TransportError({
			code: "client_error",
			message,
			status,
			phase,
			retryAfterMs,
			retryable: false,
			cause: error,
		});
	}

	return new TransportError({
		code: "unknown",
		message,
		status,
		phase,
		retryAfterMs,
		retryable: false,
		cause: error,
	});
}

function extractStatus(error: unknown): number | undefined {
	if (!error || typeof error !== "object") return undefined;
	const candidates = [
		(error as { status?: unknown }).status,
		(error as { statusCode?: unknown }).statusCode,
		(error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode,
	];
	for (const candidate of candidates) {
		if (typeof candidate === "number" && Number.isInteger(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

function extractRetryAfterMs(error: unknown): number | undefined {
	if (!error || typeof error !== "object") return undefined;
	const value = (error as { retryAfterMs?: unknown }).retryAfterMs;
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizedAbortMessage(message: string): string {
	return message && message !== "The operation was aborted." ? message : "Request was aborted";
}

function isTerminalRateLimitMessage(message: string): boolean {
	return /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/i.test(
		message,
	);
}
