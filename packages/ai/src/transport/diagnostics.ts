import type { AssistantMessageDiagnostic } from "../utils/diagnostics.ts";
import { createAssistantMessageDiagnostic } from "../utils/diagnostics.ts";
import { classifyTransportError, type TransportError, type TransportPhase } from "./errors.ts";

export interface TransportDiagnosticDetails {
	provider?: string;
	transport?: string;
	configuredTransport?: string;
	fallbackTransport?: string;
	eventsEmitted?: boolean;
	phase?: TransportPhase | string;
	transportAttempt?: number;
	requestBytes?: number;
	[key: string]: unknown;
}

export function createTransportDiagnostic(
	error: unknown,
	details: TransportDiagnosticDetails = {},
	type = "provider_transport_failure",
): AssistantMessageDiagnostic {
	const transportError = classifyTransportError(error, {
		phase: typeof details.phase === "string" ? (details.phase as TransportPhase) : undefined,
	});
	return createAssistantMessageDiagnostic(type, transportError, {
		...details,
		transportErrorCode: transportError.code,
		transportRetryable: transportError.retryable,
		transportPhase: transportError.phase ?? details.phase,
		transportStatus: transportError.status,
		transportRetryAfterMs: transportError.retryAfterMs,
	});
}

export function transportErrorDetails(error: unknown): Record<string, unknown> {
	const transportError: TransportError = classifyTransportError(error);
	return {
		transportErrorCode: transportError.code,
		transportRetryable: transportError.retryable,
		transportPhase: transportError.phase,
		transportStatus: transportError.status,
		transportRetryAfterMs: transportError.retryAfterMs,
	};
}
