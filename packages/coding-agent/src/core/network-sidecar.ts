import { Buffer } from "node:buffer";
import { type ChildProcessByStdio, spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { getPackageDir } from "../config.ts";
import type {
	EffectiveNetworkSettings,
	SidecarFailureSummary,
	SidecarHealthSnapshot,
	SidecarHealthState,
} from "./network-types.ts";

function headersToRecord(headers: Headers): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of headers.entries()) {
		result[key] = value;
	}
	return result;
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
	timeoutMs?: number;
	maxAttempts?: number;
}

export class SidecarManager {
	private settings: EffectiveNetworkSettings;
	private child: ChildProcessByStdio<null, Readable, Readable> | undefined;
	private state: SidecarState = { enabled: false, ready: false };
	private restartTimer: NodeJS.Timeout | undefined;
	private healthTimer: NodeJS.Timeout | undefined;

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
			this.state = { enabled: false, ready: false };
			return this.getState();
		}
		if (this.child && this.state.ready) {
			return this.getState();
		}

		const launch = await this.resolveLaunchSpec();
		this.child = spawn(launch.command, launch.args, {
			cwd: launch.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		this.state = { enabled: true, ready: false };
		const child = this.child;

		const rl = createInterface({ input: child.stdout });
		const ready = new Promise<SidecarState>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error("Timed out waiting for sidecar startup")), 10_000);
			rl.on("line", (line) => {
				try {
					const parsed = JSON.parse(line) as { type?: string; port?: number };
					if (parsed.type === "ready" && typeof parsed.port === "number") {
						clearTimeout(timeout);
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
					}
				} catch {
					// ignore noisy line
				}
			});
			child.once("exit", (code, signal) => {
				clearTimeout(timeout);
				if (!this.state.ready) {
					reject(new Error(`Sidecar exited before ready (code=${code ?? "null"}, signal=${signal ?? "null"})`));
					return;
				}
				this.state.ready = false;
				this.state.lastError = `Sidecar exited (code=${code ?? "null"}, signal=${signal ?? "null"})`;
				this.state.healthState = "down";
				this.scheduleRestart();
			});
		});

		child.stderr.on("data", (chunk) => {
			this.state.lastError = chunk.toString("utf8").trim() || this.state.lastError;
		});

		return ready;
	}

	async stop(): Promise<void> {
		if (this.restartTimer) {
			clearTimeout(this.restartTimer);
			this.restartTimer = undefined;
		}
		if (this.healthTimer) {
			clearInterval(this.healthTimer);
			this.healthTimer = undefined;
		}
		const child = this.child;
		this.child = undefined;
		if (!child) {
			return;
		}
		await new Promise<void>((resolve) => {
			child.once("exit", () => resolve());
			child.kill();
		});
		this.state.ready = false;
		this.state.healthState = "down";
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

	createFetch(options?: { timeoutMs?: number; maxAttempts?: number }): typeof fetch {
		return async (input, init) => {
			const state = await this.ensureStarted();
			if (!state.ready || !state.baseUrl) {
				throw new Error(this.state.lastError ?? "Network sidecar is not ready");
			}
			const request = new Request(input, init);
			const body = await request.arrayBuffer();
			const payload: SidecarFetchRequest = {
				url: request.url,
				method: request.method,
				headers: headersToRecord(request.headers),
				bodyBase64: body.byteLength > 0 ? Buffer.from(body).toString("base64") : undefined,
				timeoutMs: options?.timeoutMs,
				maxAttempts: options?.maxAttempts,
			};
			const response = await fetch(`${state.baseUrl}/v1/fetch`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
				signal: init?.signal ?? request.signal,
			});
			if (response.headers.get("x-pi-sidecar-error") === "true") {
				throw new Error((await response.text()) || `Sidecar fetch failed with status ${response.status}`);
			}
			return new Response(response.body, {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			});
		};
	}

	private scheduleRestart(): void {
		if (this.restartTimer || !this.settings.sidecar.enabled) {
			return;
		}
		this.restartTimer = setTimeout(() => {
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

	private async resolveLaunchSpec(): Promise<{ command: string; args: string[]; cwd: string }> {
		const configured = this.settings.sidecar.binaryPath?.trim();
		if (configured) {
			return { command: configured, args: [], cwd: getPackageDir() };
		}
		const candidate = `${getPackageDir()}\\sidecar\\pi-network-sidecar.exe`;
		try {
			await access(candidate, constants.X_OK);
			return { command: candidate, args: [], cwd: getPackageDir() };
		} catch {
			return {
				command: "go",
				args: ["run", "."],
				cwd: `${getPackageDir()}\\sidecar`,
			};
		}
	}
}
