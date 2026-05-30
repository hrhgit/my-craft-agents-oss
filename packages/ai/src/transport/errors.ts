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

export interface TransportErrorCauseEntry {
	name?: string;
	message: string;
	code?: string | number;
	status?: number;
	errno?: string | number;
	syscall?: string;
	hostname?: string;
	address?: string;
	port?: number;
	type?: string;
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
	const message = detailTransportErrorMessage(error, formatUnknownError(error));
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
	if (prefix) {
		return transportError.status !== undefined
			? `${prefix} (${transportError.status}): ${message}`
			: `${prefix}: ${message}`;
	}
	return message;
}

export function formatUnknownError(error: unknown): string {
	if (error instanceof Error) return error.message || error.name;
	if (typeof error === "string") return error;
	if (isObjectLike(error)) {
		const status = extractStatusValue(error);
		const statusText = getStringProperty(error, "statusText");
		if (status !== undefined || statusText) {
			return [status, statusText].filter((value) => value !== undefined && value !== "").join(" ") || "HTTP error";
		}
		const message = getStringProperty(error, "message");
		if (message) return message;
	}
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
	return findInErrorCauseChain(error, extractStatusValue);
}

function extractRetryAfterMs(error: unknown): number | undefined {
	return findInErrorCauseChain(error, extractRetryAfterMsValue);
}

function normalizedAbortMessage(message: string): string {
	return message && message !== "The operation was aborted." ? message : "Request was aborted";
}

function isTerminalRateLimitMessage(message: string): boolean {
	return /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/i.test(
		message,
	);
}

export function getTransportErrorCauseChain(error: unknown): TransportErrorCauseEntry[] {
	const chain: TransportErrorCauseEntry[] = [];
	const seen = new Set<unknown>();
	let current: unknown = error;

	while (current !== undefined && current !== null && chain.length < 10) {
		if (isObjectLike(current)) {
			if (seen.has(current)) break;
			seen.add(current);
		}

		chain.push({
			name: getErrorName(current),
			message: formatUnknownError(current),
			code: getCodeProperty(current),
			status: extractStatusValue(current),
			errno: getErrnoProperty(current),
			syscall: getStringProperty(current, "syscall"),
			hostname: getStringProperty(current, "hostname"),
			address: getStringProperty(current, "address"),
			port: getNumberProperty(current, "port"),
			type: getStringProperty(current, "type"),
		});

		current = getCause(current);
	}

	return chain;
}

export function getTransportSpecificCause(error: unknown): TransportErrorCauseEntry | undefined {
	const chain = getTransportErrorCauseChain(error);
	for (let index = 1; index < chain.length; index++) {
		const entry = chain[index];
		if (
			!isGenericTransportMessage(entry.message) ||
			entry.code !== undefined ||
			entry.status !== undefined ||
			entry.errno !== undefined ||
			entry.syscall !== undefined ||
			entry.hostname !== undefined ||
			entry.address !== undefined ||
			entry.port !== undefined
		) {
			return entry;
		}
	}
	return undefined;
}

export function formatTransportCauseEntry(entry: TransportErrorCauseEntry): string {
	const annotations: string[] = [];
	const message = entry.message.trim();
	const status = entry.status;
	const code = entry.code ?? entry.errno;

	if (status !== undefined && !message.includes(String(status))) {
		annotations.push(`status=${status}`);
	}
	if (code !== undefined && !message.toLowerCase().includes(String(code).toLowerCase())) {
		annotations.push(`code=${String(code)}`);
	}
	if (entry.syscall && !message.includes(entry.syscall)) {
		annotations.push(`syscall=${entry.syscall}`);
	}
	if (entry.hostname && !message.includes(entry.hostname)) {
		annotations.push(`hostname=${entry.hostname}`);
	}
	if (entry.address && !message.includes(entry.address)) {
		annotations.push(`address=${entry.address}`);
	}
	if (entry.port !== undefined && !message.includes(String(entry.port))) {
		annotations.push(`port=${entry.port}`);
	}
	if (annotations.length === 0) return message;
	return `${message} (${annotations.join(", ")})`;
}

function detailTransportErrorMessage(error: unknown, rawMessage: string): string {
	const specificCause = getTransportSpecificCause(error);
	if (!specificCause) return rawMessage;

	const specificMessage = formatTransportCauseEntry(specificCause);
	if (specificMessage.length === 0 || specificMessage === rawMessage) {
		return rawMessage;
	}

	if (isGenericTransportMessage(rawMessage)) {
		return `${rawMessage} Cause: ${specificMessage}`;
	}

	return rawMessage;
}

function isGenericTransportMessage(message: string): boolean {
	const trimmed = message.trim();
	if (trimmed.length === 0) return true;

	return [
		/^connection error\.?$/i,
		/^network error\.?$/i,
		/^fetch failed\.?$/i,
		/^request failed\.?$/i,
		/^request timed out\.?$/i,
		/^websocket error\.?$/i,
		/^websocket closed\.?$/i,
		/^an unknown error occurred\.?$/i,
		/^failed after retries\.?$/i,
		/^\d{3} status code \(no body\)$/i,
	].some((pattern) => pattern.test(trimmed));
}

function findInErrorCauseChain<T>(error: unknown, extractor: (value: unknown) => T | undefined): T | undefined {
	const seen = new Set<unknown>();
	let current: unknown = error;

	while (current !== undefined && current !== null) {
		const value = extractor(current);
		if (value !== undefined) {
			return value;
		}

		if (isObjectLike(current)) {
			if (seen.has(current)) break;
			seen.add(current);
		}

		current = getCause(current);
	}

	return undefined;
}

function getCause(value: unknown): unknown {
	if (!isObjectLike(value)) return undefined;
	return value.cause;
}

function extractStatusValue(error: unknown): number | undefined {
	if (!isObjectLike(error)) return undefined;
	const candidates = [
		error.status,
		error.statusCode,
		(error.$metadata as { httpStatusCode?: unknown } | undefined)?.httpStatusCode,
		(error.response as { status?: unknown } | undefined)?.status,
	];
	for (const candidate of candidates) {
		if (typeof candidate === "number" && Number.isInteger(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

function extractRetryAfterMsValue(error: unknown): number | undefined {
	if (!isObjectLike(error)) return undefined;
	const candidates = [error.retryAfterMs, (error.response as { retryAfterMs?: unknown } | undefined)?.retryAfterMs];
	for (const candidate of candidates) {
		if (typeof candidate === "number" && Number.isFinite(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

function getErrorName(value: unknown): string | undefined {
	if (value instanceof Error) {
		return value.name || undefined;
	}
	if (!isObjectLike(value)) return undefined;

	const explicitName = getStringProperty(value, "name");
	if (explicitName) return explicitName;

	const ctorName = value.constructor?.name;
	return typeof ctorName === "string" && ctorName !== "Object" ? ctorName : undefined;
}

function getCodeProperty(value: unknown): string | number | undefined {
	if (!isObjectLike(value)) return undefined;
	const code = value.code;
	return typeof code === "string" || typeof code === "number" ? code : undefined;
}

function getErrnoProperty(value: unknown): string | number | undefined {
	if (!isObjectLike(value)) return undefined;
	const errno = value.errno;
	return typeof errno === "string" || typeof errno === "number" ? errno : undefined;
}

function getStringProperty(value: unknown, key: string): string | undefined {
	if (!isObjectLike(value)) return undefined;
	const candidate = value[key];
	return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function getNumberProperty(value: unknown, key: string): number | undefined {
	if (!isObjectLike(value)) return undefined;
	const candidate = value[key];
	return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}

function isObjectLike(value: unknown): value is Record<string, any> {
	return typeof value === "object" && value !== null;
}
