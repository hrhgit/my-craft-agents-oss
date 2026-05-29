import type { AssistantMessage } from "../types.ts";
import { appendAssistantMessageDiagnostic } from "../utils/diagnostics.ts";
import { createTransportDiagnostic, type TransportDiagnosticDetails } from "./diagnostics.ts";
import { classifyTransportError, formatTransportError } from "./errors.ts";

export interface SdkRequestInput {
	signal?: AbortSignal;
	timeoutMs?: number;
	maxRetries?: number;
}

export interface SdkRequestOptions {
	signal?: AbortSignal;
	timeout?: number;
	maxRetries: number;
}

export function createSdkRequestOptions(options?: SdkRequestInput): SdkRequestOptions {
	return {
		...(options?.signal ? { signal: options.signal } : {}),
		...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
		maxRetries: options?.maxRetries ?? 0,
	};
}

export function formatSdkTransportError(error: unknown, prefix?: string): string {
	if (!prefix) {
		return formatTransportError(error);
	}
	return formatTransportError(error, prefix);
}

export function appendSdkTransportDiagnostic(
	message: AssistantMessage,
	error: unknown,
	details: TransportDiagnosticDetails = {},
): void {
	const classified = classifyTransportError(error, { phase: "sdk", forcePhase: true });
	if (classified.code === "unknown") {
		return;
	}
	appendAssistantMessageDiagnostic(message, createTransportDiagnostic(classified, { phase: "sdk", ...details }));
}
