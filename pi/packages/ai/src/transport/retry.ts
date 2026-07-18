import { TransportError } from "./errors.ts";

export const DEFAULT_BASE_RETRY_DELAY_MS = 1000;
export const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;

export interface RetryDelayOptions {
	attempt: number;
	headers?: Headers;
	status?: number;
	maxRetryDelayMs?: number;
	baseDelayMs?: number;
	jitterRatio?: number;
}

export function parseRetryAfterMs(headers: Headers): number | undefined {
	const retryAfterMs = headers.get("retry-after-ms");
	if (retryAfterMs !== null) {
		const millis = Number(retryAfterMs);
		if (Number.isFinite(millis)) {
			return Math.max(0, millis);
		}
	}

	const retryAfter = headers.get("retry-after");
	if (!retryAfter) {
		return undefined;
	}

	const seconds = Number(retryAfter);
	if (Number.isFinite(seconds)) {
		return Math.max(0, seconds * 1000);
	}

	const date = Date.parse(retryAfter);
	if (!Number.isNaN(date)) {
		return Math.max(0, date - Date.now());
	}

	return undefined;
}

export function capRetryDelayMs(delayMs: number, maxRetryDelayMs?: number): number {
	const cap = maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
	return cap > 0 ? Math.min(delayMs, cap) : delayMs;
}

export function getRetryDelayMs(options: RetryDelayOptions): number {
	const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_RETRY_DELAY_MS;
	const serverDelayMs = options.headers ? parseRetryAfterMs(options.headers) : undefined;
	const rawDelayMs = serverDelayMs ?? baseDelayMs * 2 ** options.attempt;
	const shouldCapServerDelay = serverDelayMs !== undefined && options.status === 429;
	const delayMs =
		serverDelayMs === undefined || shouldCapServerDelay
			? capRetryDelayMs(rawDelayMs, options.maxRetryDelayMs)
			: rawDelayMs;
	if (!options.jitterRatio || options.jitterRatio <= 0) {
		return delayMs;
	}
	const jitterRange = delayMs * options.jitterRatio;
	return Math.max(0, Math.round(delayMs - jitterRange + Math.random() * jitterRange * 2));
}

export function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(createAbortError(signal.reason));
			return;
		}
		let timeout: ReturnType<typeof setTimeout>;
		const onAbort = () => {
			clearTimeout(timeout);
			reject(createAbortError(signal?.reason));
		};
		timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function createAbortError(cause?: unknown): TransportError {
	return new TransportError({
		code: "aborted",
		message: "Request was aborted",
		retryable: false,
		cause,
	});
}
