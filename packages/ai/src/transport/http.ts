import { combineAbortSignals } from "../utils/abort-signals.ts";
import { headersToRecord } from "../utils/headers.ts";
import { classifyTransportError, TransportError } from "./errors.ts";
import { getRetryDelayMs, sleepWithAbort } from "./retry.ts";

export interface FetchWithHeaderTimeoutOptions {
	signal?: AbortSignal;
	headerTimeoutMs?: number;
	headerTimeoutMessage?: string;
}

export interface FetchWithRetryOptions extends FetchWithHeaderTimeoutOptions {
	maxRetries?: number;
	maxRetryDelayMs?: number;
	baseDelayMs?: number;
	onResponse?: (response: Response, attempt: number) => void | Promise<void>;
	shouldRetryResponse?: (response: Response, bodyText: string) => boolean;
	createResponseError?: (response: Response, bodyText: string) => Error | Promise<Error>;
	shouldRetryError?: (error: unknown) => boolean;
}

export async function fetchWithHeaderTimeout(
	input: RequestInfo | URL,
	init: RequestInit,
	options: FetchWithHeaderTimeoutOptions = {},
): Promise<Response> {
	const headerTimeout = createHeaderTimeout(options.headerTimeoutMs, options.headerTimeoutMessage);
	const combinedSignal = combineAbortSignals([options.signal, headerTimeout.signal]);
	try {
		return await fetch(input, { ...init, signal: combinedSignal.signal });
	} catch (error) {
		const timeoutError = headerTimeout.error();
		if (timeoutError && !options.signal?.aborted) {
			throw timeoutError;
		}
		throw classifyTransportError(error, { phase: "response_headers" });
	} finally {
		combinedSignal.cleanup();
		headerTimeout.clear();
	}
}

export async function fetchWithRetry(
	input: RequestInfo | URL,
	init: RequestInit,
	options: FetchWithRetryOptions = {},
): Promise<Response> {
	const maxRetries = options.maxRetries ?? 0;
	let lastError: Error | undefined;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		if (options.signal?.aborted) {
			throw new TransportError({
				code: "aborted",
				message: "Request was aborted",
				phase: "request",
				retryable: false,
				cause: options.signal.reason,
			});
		}

		try {
			const response = await fetchWithHeaderTimeout(input, init, options);
			await options.onResponse?.(response, attempt);

			if (response.ok) {
				return response;
			}

			const bodyText = await response.text();
			if (attempt < maxRetries && options.shouldRetryResponse?.(response, bodyText)) {
				const delayMs = getRetryDelayMs({
					attempt,
					headers: response.headers,
					status: response.status,
					maxRetryDelayMs: options.maxRetryDelayMs,
					baseDelayMs: options.baseDelayMs,
				});
				await sleepWithAbort(delayMs, options.signal);
				continue;
			}

			if (options.createResponseError) {
				throw await options.createResponseError(response, bodyText);
			}
			throw new TransportError({
				code: classifyStatusCode(response.status, bodyText),
				message: bodyText || response.statusText || "Request failed",
				status: response.status,
				phase: "response_headers",
				retryAfterMs: getRetryDelayMs({ attempt: 0, headers: response.headers, status: response.status }),
			});
		} catch (error) {
			const transportError = classifyTransportError(error, { phase: "request" });
			lastError = transportError;
			if (attempt < maxRetries && (options.shouldRetryError?.(transportError) ?? transportError.retryable)) {
				const delayMs = getRetryDelayMs({
					attempt,
					maxRetryDelayMs: options.maxRetryDelayMs,
					baseDelayMs: options.baseDelayMs,
				});
				await sleepWithAbort(delayMs, options.signal);
				continue;
			}
			throw transportError;
		}
	}

	throw lastError ?? new TransportError({ code: "unknown", message: "Failed after retries", phase: "request" });
}

export function providerResponseFromFetchResponse(response: Response): {
	status: number;
	headers: Record<string, string>;
} {
	return { status: response.status, headers: headersToRecord(response.headers) };
}

function createHeaderTimeout(
	headerTimeoutMs: number | undefined,
	headerTimeoutMessage: string | undefined,
): { signal?: AbortSignal; clear: () => void; error: () => TransportError | undefined } {
	if (headerTimeoutMs === undefined || headerTimeoutMs <= 0) {
		return { clear: () => {}, error: () => undefined };
	}

	const controller = new AbortController();
	let error: TransportError | undefined;
	const timeout = setTimeout(() => {
		error = new TransportError({
			code: "header_timeout",
			message: headerTimeoutMessage ?? `Response headers timed out after ${headerTimeoutMs}ms`,
			phase: "response_headers",
		});
		controller.abort(error);
	}, headerTimeoutMs);
	return {
		signal: controller.signal,
		clear: () => clearTimeout(timeout),
		error: () => error,
	};
}

function classifyStatusCode(status: number, bodyText: string) {
	if (
		status === 429 &&
		/GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/i.test(
			bodyText,
		)
	) {
		return "terminal_rate_limit" as const;
	}
	if (status === 429) return "rate_limit" as const;
	if (status === 401 || status === 403) return "auth_error" as const;
	if (status === 500 || status === 502 || status === 503 || status === 504) return "server_error" as const;
	if (status >= 400 && status < 500) return "client_error" as const;
	return "unknown" as const;
}
