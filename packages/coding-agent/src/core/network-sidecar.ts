import { Buffer } from "node:buffer";
import { type ChildProcessByStdio, spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { join } from "node:path";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { Readable } from "node:stream";
import { TransportError, type TransportErrorCode, type TransportPhase } from "@earendil-works/pi-ai/transport/errors";
import { getPackageDir } from "../config.ts";
import type {
	EffectiveNetworkSettings,
	NetworkRequestContext,
	SidecarFailureStage,
	SidecarFailureSummary,
	SidecarHealthSnapshot,
	SidecarHealthState,
	SidecarTimeoutKind,
	SidecarTransportOutcome,
} from "./network-types.ts";

const SIDECAR_OWNER_HEADER = "x-pi-transport-owner";
const SIDECAR_REQUEST_ID_HEADER = "x-pi-request-id";
const SIDECAR_TRACE_ID_HEADER = "x-pi-trace-id";
const SIDECAR_RESPONSE_STATUS_HEADER = "x-pi-response-status";
const SIDECAR_ATTEMPT_COUNT_HEADER = "x-pi-attempt-count";
const SIDECAR_RETRY_COUNT_HEADER = "x-pi-retry-count";
const SIDECAR_STREAMING_HEADER = "x-pi-streaming";
const SIDECAR_STREAMING_RESPONSE_HEADER = "x-pi-streaming-response";
const SIDECAR_STREAM_STARTED_HEADER = "x-pi-stream-started";
const SIDECAR_FINAL_STATUS_HEADER = "x-pi-final-status";
const SIDECAR_FAILURE_STAGE_HEADER = "x-pi-failure-stage";
const SIDECAR_TIMEOUT_KIND_HEADER = "x-pi-timeout-kind";
const SIDECAR_ERROR_HEADER = "x-pi-sidecar-error";

function headersToRecord(headers: Headers): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of headers.entries()) {
		result[key] = value;
	}
	return result;
}

function parseBooleanHeader(value: string | null): boolean | undefined {
	if (value === null) return undefined;
	if (value === "true") return true;
	if (value === "false") return false;
	return undefined;
}

function parseIntegerHeader(value: string | null): number | undefined {
	if (value === null || value.trim() === "") return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function asFailureStage(value: string | undefined): SidecarFailureStage | undefined {
	if (
		value === "dns" ||
		value === "connect" ||
		value === "tls" ||
		value === "upstream" ||
		value === "stream" ||
		value === "unknown"
	) {
		return value;
	}
	return undefined;
}

function asTimeoutKind(value: string | undefined): SidecarTimeoutKind | undefined {
	if (
		value === "connect" ||
		value === "tls" ||
		value === "response_headers" ||
		value === "idle_stream" ||
		value === "total" ||
		value === "unknown"
	) {
		return value;
	}
	return undefined;
}

function parseOutcomeFromHeaders(headers: Headers): SidecarTransportOutcome | undefined {
	const owner = headers.get(SIDECAR_OWNER_HEADER);
	const attemptCount = parseIntegerHeader(headers.get(SIDECAR_ATTEMPT_COUNT_HEADER));
	const retryCount = parseIntegerHeader(headers.get(SIDECAR_RETRY_COUNT_HEADER));
	const streamingResponse = parseBooleanHeader(headers.get(SIDECAR_STREAMING_RESPONSE_HEADER));
	const streamStarted = parseBooleanHeader(headers.get(SIDECAR_STREAM_STARTED_HEADER));
	const finalStatus = headers.get(SIDECAR_FINAL_STATUS_HEADER);
	if (
		owner !== "sidecar" &&
		attemptCount === undefined &&
		retryCount === undefined &&
		streamingResponse === undefined &&
		streamStarted === undefined &&
		!finalStatus
	) {
		return undefined;
	}
	return {
		owner: "sidecar",
		requestId: headers.get(SIDECAR_REQUEST_ID_HEADER) ?? undefined,
		traceId: headers.get(SIDECAR_TRACE_ID_HEADER) ?? undefined,
		responseStatus: parseIntegerHeader(headers.get(SIDECAR_RESPONSE_STATUS_HEADER)),
		attemptCount: attemptCount ?? 0,
		retryCount: retryCount ?? 0,
		streamingResponse: streamingResponse ?? false,
		streamStarted: streamStarted ?? false,
		finalStatus:
			finalStatus === "success" || finalStatus === "transport_error" || finalStatus === "stream_error"
				? finalStatus
				: "success",
		failureStage: asFailureStage(headers.get(SIDECAR_FAILURE_STAGE_HEADER) ?? undefined),
		timeoutKind: asTimeoutKind(headers.get(SIDECAR_TIMEOUT_KIND_HEADER) ?? undefined),
	};
}

function mergeOutcome(
	base: SidecarTransportOutcome | undefined,
	patch: Partial<SidecarTransportOutcome> | undefined,
): SidecarTransportOutcome | undefined {
	if (!base && !patch) {
		return undefined;
	}
	return {
		owner: "sidecar",
		requestId: patch?.requestId ?? base?.requestId,
		traceId: patch?.traceId ?? base?.traceId,
		responseStatus: patch?.responseStatus ?? base?.responseStatus,
		attemptCount: patch?.attemptCount ?? base?.attemptCount ?? 0,
		retryCount: patch?.retryCount ?? base?.retryCount ?? 0,
		streamingResponse: patch?.streamingResponse ?? base?.streamingResponse ?? false,
		streamStarted: patch?.streamStarted ?? base?.streamStarted ?? false,
		finalStatus: patch?.finalStatus ?? base?.finalStatus ?? "success",
		failureStage: patch?.failureStage ?? base?.failureStage,
		timeoutKind: patch?.timeoutKind ?? base?.timeoutKind,
		errorMessage: patch?.errorMessage ?? base?.errorMessage,
	};
}

function applyOutcome(
	requestContext: NetworkRequestContext | undefined,
	outcome: SidecarTransportOutcome | undefined,
): void {
	if (!requestContext || !outcome) {
		return;
	}
	requestContext.transportOutcome = { ...outcome };
	if (outcome.streamStarted) {
		requestContext.firstByteReceived = true;
	}
}

function stripSidecarHeaders(headers: Headers): void {
	headers.delete(SIDECAR_OWNER_HEADER);
	headers.delete(SIDECAR_REQUEST_ID_HEADER);
	headers.delete(SIDECAR_TRACE_ID_HEADER);
	headers.delete(SIDECAR_RESPONSE_STATUS_HEADER);
	headers.delete(SIDECAR_ATTEMPT_COUNT_HEADER);
	headers.delete(SIDECAR_RETRY_COUNT_HEADER);
	headers.delete(SIDECAR_STREAMING_HEADER);
	headers.delete(SIDECAR_STREAMING_RESPONSE_HEADER);
	headers.delete(SIDECAR_STREAM_STARTED_HEADER);
	headers.delete(SIDECAR_FINAL_STATUS_HEADER);
	headers.delete(SIDECAR_FAILURE_STAGE_HEADER);
	headers.delete(SIDECAR_TIMEOUT_KIND_HEADER);
	headers.delete(SIDECAR_ERROR_HEADER);
}

function transportErrorCodeFromOutcome(outcome: SidecarTransportOutcome): TransportErrorCode {
	if (outcome.timeoutKind === "response_headers") {
		return "header_timeout";
	}
	if (outcome.timeoutKind === "idle_stream") {
		return "idle_timeout";
	}
	if (outcome.timeoutKind) {
		return "timeout";
	}
	return "network_error";
}

function transportPhaseFromOutcome(outcome: SidecarTransportOutcome): TransportPhase {
	if (outcome.timeoutKind === "response_headers") {
		return "response_headers";
	}
	if (outcome.failureStage === "stream" || outcome.streamStarted) {
		return "stream";
	}
	return "request";
}

interface ParsedSidecarErrorBody {
	error?: string;
	outcome?: Partial<SidecarTransportOutcome>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseErrorBody(json: unknown): ParsedSidecarErrorBody {
	if (!isRecord(json)) {
		return {};
	}
	const outcomeRecord = isRecord(json.outcome) ? json.outcome : undefined;
	return {
		error: typeof json.error === "string" ? json.error : undefined,
		outcome: outcomeRecord
			? {
					requestId: typeof outcomeRecord.requestId === "string" ? outcomeRecord.requestId : undefined,
					traceId: typeof outcomeRecord.traceId === "string" ? outcomeRecord.traceId : undefined,
					responseStatus:
						typeof outcomeRecord.responseStatus === "number" ? outcomeRecord.responseStatus : undefined,
					attemptCount: typeof outcomeRecord.attemptCount === "number" ? outcomeRecord.attemptCount : undefined,
					retryCount: typeof outcomeRecord.retryCount === "number" ? outcomeRecord.retryCount : undefined,
					streamingResponse:
						typeof outcomeRecord.streamingResponse === "boolean" ? outcomeRecord.streamingResponse : undefined,
					streamStarted:
						typeof outcomeRecord.streamStarted === "boolean" ? outcomeRecord.streamStarted : undefined,
					finalStatus:
						outcomeRecord.finalStatus === "success" ||
						outcomeRecord.finalStatus === "transport_error" ||
						outcomeRecord.finalStatus === "stream_error"
							? outcomeRecord.finalStatus
							: undefined,
					failureStage:
						typeof outcomeRecord.failureStage === "string"
							? asFailureStage(outcomeRecord.failureStage)
							: undefined,
					timeoutKind:
						typeof outcomeRecord.timeoutKind === "string" ? asTimeoutKind(outcomeRecord.timeoutKind) : undefined,
					errorMessage: typeof outcomeRecord.errorMessage === "string" ? outcomeRecord.errorMessage : undefined,
				}
			: undefined,
	};
}

async function parseSidecarErrorResponse(response: Response): Promise<ParsedSidecarErrorBody> {
	const text = await response.text();
	if (!text) {
		return {};
	}
	try {
		return parseErrorBody(JSON.parse(text) as unknown);
	} catch {
		return { error: text };
	}
}

function createTransportError(outcome: SidecarTransportOutcome, message: string, status?: number): TransportError {
	return new TransportError({
		code: transportErrorCodeFromOutcome(outcome),
		message,
		status,
		retryable: outcome.finalStatus !== "stream_error",
		phase: transportPhaseFromOutcome(outcome),
	});
}

function closeReadline(rl: ReadlineInterface): void {
	try {
		rl.close();
	} catch {}
}

export interface SidecarState {
	enabled: boolean;
	ready: boolean;
	port?: number;
	baseUrl?: string;
	lastHealthAt?: number;
	lastError?: string;
	healthState?: SidecarHealthState;
	health?: SidecarHealthSnapshot;
}

interface SidecarFetchRequest {
	url: string;
	method: string;
	headers?: Record<string, string>;
	bodyBase64?: string;
	totalTimeoutMs?: number;
	connectTimeoutMs?: number;
	tlsTimeoutMs?: number;
	responseHeaderTimeoutMs?: number;
	idleStreamTimeoutMs?: number;
	maxAttempts?: number;
	retryBaseDelayMs?: number;
	retryMaxDelayMs?: number;
	proxyMode?: "preferred" | "required";
	proxyEnabled?: boolean;
	proxyCandidates?: string[];
	proxyProbeTimeoutMs?: number;
	proxyStatusCacheMs?: number;
	bypassHosts?: string[];
	bypassCidrs?: string[];
}

export class SidecarManager {
	private settings: EffectiveNetworkSettings;
	private child: ChildProcessByStdio<null, Readable, Readable> | undefined;
	private state: SidecarState = { enabled: false, ready: false };
	private restartTimer: NodeJS.Timeout | undefined;
	private healthTimer: NodeJS.Timeout | undefined;
	private startupPromise: Promise<SidecarState> | undefined;
	private cancelStartup: ((error: Error) => void) | undefined;
	private lifecycleGeneration = 0;

	constructor(settings: EffectiveNetworkSettings) {
		this.settings = settings;
		this.state.enabled = settings.sidecar.enabled;
	}

	getState(): SidecarState {
		return { ...this.state };
	}

	applySettings(settings: EffectiveNetworkSettings): void {
		this.settings = settings;
		this.state.enabled = settings.sidecar.enabled;
	}

	async ensureStarted(): Promise<SidecarState> {
		if (!this.settings.sidecar.enabled) {
			this.cancelCurrentStartup(new Error("Sidecar startup was superseded"));
			this.state = { enabled: false, ready: false };
			return this.getState();
		}
		if (this.child && this.state.ready) {
			return this.getState();
		}
		if (this.startupPromise) {
			return this.startupPromise;
		}

		const generation = ++this.lifecycleGeneration;
		this.state = { enabled: true, ready: false };
		this.startupPromise = this.startSidecar(generation);
		return this.startupPromise;
	}

	private async startSidecar(generation: number): Promise<SidecarState> {
		let child: ChildProcessByStdio<null, Readable, Readable> | undefined;
		try {
			const launch = await this.resolveLaunchSpec();
			if (!this.isCurrentLifecycle(generation)) {
				throw new Error("Sidecar startup was superseded");
			}
			child = spawn(launch.command, launch.args, {
				cwd: launch.cwd,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			this.child = child;
			return await this.waitForReady(child, generation);
		} catch (error) {
			if (child && this.child === child) {
				this.child = undefined;
			}
			if (this.isCurrentLifecycle(generation)) {
				this.state = {
					enabled: this.settings.sidecar.enabled,
					ready: false,
					lastError: error instanceof Error ? error.message : String(error),
					healthState: "down",
				};
				this.startupPromise = undefined;
				this.cancelStartup = undefined;
			}
			throw error;
		} finally {
			if (this.isCurrentLifecycle(generation) && this.startupPromise) {
				this.startupPromise = undefined;
				this.cancelStartup = undefined;
			}
		}
	}

	private waitForReady(
		child: ChildProcessByStdio<null, Readable, Readable>,
		generation: number,
	): Promise<SidecarState> {
		return new Promise<SidecarState>((resolve, reject) => {
			const rl = createInterface({ input: child.stdout });
			let settled = false;
			let timeout: ReturnType<typeof setTimeout> | undefined;

			const cleanup = () => {
				if (timeout) {
					clearTimeout(timeout);
					timeout = undefined;
				}
				rl.removeListener("line", onLine);
				child.stderr.removeListener("data", onStderr);
				closeReadline(rl);
			};
			const fail = (error: Error) => {
				if (settled) return;
				settled = true;
				cleanup();
				if (this.isCurrentChild(child, generation)) {
					this.child = undefined;
				}
				if (this.isCurrentLifecycle(generation) && this.cancelStartup === fail) {
					this.cancelStartup = undefined;
				}
				child.removeListener("exit", onExit);
				reject(error);
			};
			if (this.isCurrentLifecycle(generation)) {
				this.cancelStartup = fail;
			}
			const onLine = (line: string) => {
				if (!this.isCurrentChild(child, generation)) {
					fail(new Error("Sidecar startup was superseded"));
					return;
				}
				try {
					const parsed = JSON.parse(line) as { type?: string; port?: number };
					if (parsed.type !== "ready" || typeof parsed.port !== "number") {
						return;
					}
					if (settled) return;
					settled = true;
					cleanup();
					this.state = {
						enabled: true,
						ready: true,
						port: parsed.port,
						baseUrl: `http://127.0.0.1:${parsed.port}`,
						lastHealthAt: Date.now(),
						healthState: "ready",
					};
					this.startHealthPolling();
					resolve(this.getState());
				} catch {
					// ignore noisy line
				}
			};
			const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
				const message = `Sidecar exited (code=${code ?? "null"}, signal=${signal ?? "null"})`;
				if (!this.isCurrentChild(child, generation)) {
					return;
				}
				if (!this.state.ready) {
					fail(new Error(`Sidecar exited before ready (code=${code ?? "null"}, signal=${signal ?? "null"})`));
					return;
				}
				cleanup();
				this.child = undefined;
				this.state.ready = false;
				this.state.lastError = message;
				this.state.healthState = "down";
				this.scheduleRestart();
			};
			const onStderr = (chunk: Buffer | string) => {
				if (!this.isCurrentChild(child, generation)) {
					return;
				}
				this.state.lastError = chunk.toString().trim() || this.state.lastError;
			};

			timeout = setTimeout(() => {
				fail(new Error("Timed out waiting for sidecar startup"));
			}, 20_000);
			rl.on("line", onLine);
			child.once("exit", onExit);
			child.stderr.on("data", onStderr);
		});
	}

	async stop(): Promise<void> {
		const child = this.child;
		this.cancelCurrentStartup(new Error("Sidecar startup was superseded"));
		if (this.restartTimer) {
			clearTimeout(this.restartTimer);
			this.restartTimer = undefined;
		}
		if (this.healthTimer) {
			clearInterval(this.healthTimer);
			this.healthTimer = undefined;
		}
		this.child = undefined;
		if (!child) {
			this.state.ready = false;
			this.state.healthState = "down";
			return;
		}
		await new Promise<void>((resolve) => {
			if (child.exitCode !== null || child.killed) {
				resolve();
				return;
			}
			const timeout = setTimeout(() => resolve(), 2_000);
			child.once("exit", () => {
				clearTimeout(timeout);
				resolve();
			});
			try {
				child.kill();
			} catch {
				clearTimeout(timeout);
				resolve();
			}
		});
		this.state.ready = false;
		this.state.healthState = "down";
	}

	async reset(): Promise<void> {
		await this.stop();
		this.state = {
			enabled: this.settings.sidecar.enabled,
			ready: false,
		};
	}

	async refreshHealth(): Promise<SidecarHealthSnapshot | undefined> {
		if (!this.state.baseUrl) {
			return undefined;
		}
		try {
			const response = await fetch(`${this.state.baseUrl}/healthz`);
			if (!response.ok) {
				this.state.healthState = "down";
				this.state.lastError = `Health check failed with status ${response.status}`;
				return undefined;
			}
			const payload = (await response.json()) as {
				ready: boolean;
				state: SidecarHealthState;
				listenAddress?: string;
				lastSuccessAt?: number;
				lastFailureAt?: number;
				recentFailures?: Record<string, number>;
				lastError?: SidecarFailureSummary;
			};
			const health: SidecarHealthSnapshot = {
				ready: payload.ready,
				state: payload.state,
				listenAddress: payload.listenAddress,
				port: this.state.port,
				lastHealthAt: Date.now(),
				lastSuccessAt: payload.lastSuccessAt,
				lastFailureAt: payload.lastFailureAt,
				recentFailures: {
					dns: payload.recentFailures?.dns ?? 0,
					connect: payload.recentFailures?.connect ?? 0,
					tls: payload.recentFailures?.tls ?? 0,
					upstream: payload.recentFailures?.upstream ?? 0,
					stream: payload.recentFailures?.stream ?? 0,
					unknown: payload.recentFailures?.unknown ?? 0,
				},
				lastError: payload.lastError,
			};
			this.state.lastHealthAt = health.lastHealthAt;
			this.state.healthState = health.state;
			this.state.health = health;
			this.state.lastError = health.lastError?.message;
			return health;
		} catch (error) {
			this.state.healthState = "down";
			this.state.lastError = error instanceof Error ? error.message : String(error);
			return undefined;
		}
	}

	createFetch(
		requestContext?: NetworkRequestContext,
		options?: {
			totalTimeoutMs?: number;
			connectTimeoutMs?: number;
			tlsTimeoutMs?: number;
			responseHeaderTimeoutMs?: number;
			idleStreamTimeoutMs?: number;
			maxAttempts?: number;
			retryBaseDelayMs?: number;
			retryMaxDelayMs?: number;
			proxyMode?: "preferred" | "required";
		},
	): typeof fetch {
		return async (input, init) => {
			const state = await this.ensureStarted();
			if (!state.ready || !state.baseUrl) {
				throw new Error(this.state.lastError ?? "Network sidecar is not ready");
			}
			const request = new Request(input, init);
			const body = await request.arrayBuffer();
			const payloadHeaders = headersToRecord(request.headers);
			if (requestContext?.requestId && !(SIDECAR_REQUEST_ID_HEADER in payloadHeaders)) {
				payloadHeaders[SIDECAR_REQUEST_ID_HEADER] = requestContext.requestId;
			}
			if (requestContext?.traceId && !(SIDECAR_TRACE_ID_HEADER in payloadHeaders)) {
				payloadHeaders[SIDECAR_TRACE_ID_HEADER] = requestContext.traceId;
			}
			const payload: SidecarFetchRequest = {
				url: request.url,
				method: request.method,
				headers: payloadHeaders,
				bodyBase64: body.byteLength > 0 ? Buffer.from(body).toString("base64") : undefined,
				totalTimeoutMs: options?.totalTimeoutMs,
				connectTimeoutMs: options?.connectTimeoutMs,
				tlsTimeoutMs: options?.tlsTimeoutMs,
				responseHeaderTimeoutMs: options?.responseHeaderTimeoutMs,
				idleStreamTimeoutMs: options?.idleStreamTimeoutMs,
				maxAttempts: options?.maxAttempts,
				retryBaseDelayMs: options?.retryBaseDelayMs,
				retryMaxDelayMs: options?.retryMaxDelayMs,
				proxyMode: options?.proxyMode,
				proxyEnabled: this.settings.proxy.enabled,
				proxyCandidates: this.settings.proxy.candidates,
				proxyProbeTimeoutMs: this.settings.proxy.probeTimeoutMs,
				proxyStatusCacheMs: this.settings.proxy.statusCacheMs,
				bypassHosts: this.settings.bypass.hosts,
				bypassCidrs: this.settings.bypass.cidrs,
			};
			const response = await fetch(`${state.baseUrl}/v1/fetch`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
				signal: init?.signal ?? request.signal,
			});
			const headerOutcome = mergeOutcome(
				parseOutcomeFromHeaders(response.headers),
				requestContext?.transportOutcome,
			);
			applyOutcome(requestContext, headerOutcome);
			if (response.headers.get(SIDECAR_ERROR_HEADER) === "true") {
				const errorBody = await parseSidecarErrorResponse(response);
				const outcome =
					mergeOutcome(headerOutcome, errorBody.outcome) ??
					({
						owner: "sidecar",
						attemptCount: 0,
						retryCount: 0,
						streamingResponse: false,
						streamStarted: false,
						finalStatus: "transport_error",
					} satisfies SidecarTransportOutcome);
				outcome.errorMessage =
					errorBody.error ?? outcome.errorMessage ?? `Sidecar fetch failed with status ${response.status}`;
				outcome.finalStatus = "transport_error";
				applyOutcome(requestContext, outcome);
				throw createTransportError(outcome, outcome.errorMessage, response.status);
			}
			const upstreamHeaders = new Headers(response.headers);
			const streaming = upstreamHeaders.get(SIDECAR_STREAMING_HEADER) === "true";
			stripSidecarHeaders(upstreamHeaders);
			const responseOutcome =
				mergeOutcome(headerOutcome, {
					streamingResponse: headerOutcome?.streamingResponse ?? streaming,
					responseStatus: headerOutcome?.responseStatus ?? response.status,
					finalStatus: "success",
				}) ??
				({
					owner: "sidecar",
					responseStatus: response.status,
					attemptCount: 0,
					retryCount: 0,
					streamingResponse: streaming,
					streamStarted: false,
					finalStatus: "success",
				} satisfies SidecarTransportOutcome);
			applyOutcome(requestContext, responseOutcome);
			const bodyStream = response.body;
			if (!bodyStream) {
				return new Response(bodyStream, {
					status: response.status,
					statusText: response.statusText,
					headers: upstreamHeaders,
				});
			}
			const [clientStream, drainStream] = bodyStream.tee();
			this.monitorResponseDrain(drainStream, requestContext, responseOutcome);
			return new Response(clientStream, {
				status: response.status,
				statusText: response.statusText,
				headers: upstreamHeaders,
			});
		};
	}

	private monitorResponseDrain(
		drainStream: ReadableStream<Uint8Array>,
		requestContext: NetworkRequestContext | undefined,
		initialOutcome: SidecarTransportOutcome,
	): void {
		void (async () => {
			const outcome: SidecarTransportOutcome = { ...initialOutcome };
			const reader = drainStream.getReader();
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) {
						outcome.finalStatus = "success";
						applyOutcome(requestContext, outcome);
						break;
					}
					if ((value?.byteLength ?? 0) > 0) {
						outcome.streamStarted = true;
						applyOutcome(requestContext, outcome);
					}
				}
			} catch (error) {
				outcome.finalStatus = "stream_error";
				outcome.streamStarted = true;
				outcome.failureStage = "stream";
				outcome.errorMessage = error instanceof Error ? error.message : String(error);
				if (/idle timeout/i.test(outcome.errorMessage)) {
					outcome.timeoutKind = "idle_stream";
				}
				applyOutcome(requestContext, outcome);
			} finally {
				try {
					reader.releaseLock();
				} catch {}
			}
		})();
	}

	private scheduleRestart(): void {
		if (this.restartTimer || !this.settings.sidecar.enabled) {
			return;
		}
		const generation = this.lifecycleGeneration;
		this.restartTimer = setTimeout(() => {
			if (generation !== this.lifecycleGeneration) {
				this.restartTimer = undefined;
				return;
			}
			this.restartTimer = undefined;
			void this.ensureStarted().catch((error) => {
				this.state.lastError = error instanceof Error ? error.message : String(error);
				this.scheduleRestart();
			});
		}, this.settings.sidecar.restartBackoffMs);
	}

	private startHealthPolling(): void {
		if (this.healthTimer) {
			clearInterval(this.healthTimer);
		}
		this.healthTimer = setInterval(() => {
			void this.refreshHealth();
		}, this.settings.sidecar.healthCheckIntervalMs);
	}

	private isCurrentLifecycle(generation: number): boolean {
		return generation === this.lifecycleGeneration;
	}

	private isCurrentChild(child: ChildProcessByStdio<null, Readable, Readable>, generation: number): boolean {
		return this.isCurrentLifecycle(generation) && this.child === child;
	}

	private cancelCurrentStartup(error: Error): void {
		this.lifecycleGeneration++;
		const cancelStartup = this.cancelStartup;
		this.startupPromise = undefined;
		this.cancelStartup = undefined;
		cancelStartup?.(error);
	}

	private async resolveLaunchSpec(): Promise<{ command: string; args: string[]; cwd: string }> {
		const configured = this.settings.sidecar.binaryPath?.trim();
		if (configured) {
			return { command: configured, args: [], cwd: getPackageDir() };
		}
		for (const candidate of this.getBundledBinaryCandidates()) {
			try {
				await access(candidate, constants.X_OK);
				return { command: candidate, args: [], cwd: getPackageDir() };
			} catch {
				// Try next candidate.
			}
		}
		return {
			command: "go",
			args: ["run", "."],
			cwd: join(getPackageDir(), "sidecar"),
		};
	}

	private getBundledBinaryCandidates(): string[] {
		const packageDir = getPackageDir();
		const platform = process.platform;
		const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : process.arch;
		const extension = platform === "win32" ? ".exe" : "";
		const normalizedPlatform =
			platform === "darwin" || platform === "linux" ? platform : platform === "win32" ? "windows" : undefined;
		const normalizedTarget =
			normalizedPlatform && (arch === "x64" || arch === "arm64") ? `${normalizedPlatform}-${arch}` : undefined;
		if (!normalizedTarget) {
			return [];
		}
		return [join(packageDir, "sidecar", "bin", normalizedTarget, `pi-network-sidecar${extension}`)];
	}
}
