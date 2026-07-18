import { randomUUID } from "node:crypto";
import type { AgentSessionRuntime } from "./agent-session-runtime.ts";
import type { SessionStartEvent } from "./extensions/index.ts";
import type { ExtensionTarget } from "./extensions/types.ts";
import {
	GlobalBackgroundTaskCoordinator,
	type GlobalBackgroundTaskEventListener,
	getProcessGlobalBackgroundTaskCoordinator,
} from "./global-background-tasks.ts";
import type { SessionManager } from "./session-manager.ts";

export interface PiGlobalHostRuntimeOpenOptions {
	runtimeId?: string;
	cwd: string;
	agentDir?: string;
	sessionManager: SessionManager;
	sessionStartEvent?: SessionStartEvent;
	deferResourceLoad?: boolean;
	persistInitialState?: boolean;
	extensionTarget: ExtensionTarget;
}

export interface PiGlobalHostRuntimeSnapshot {
	runtimeId: string;
	cwd: string;
	sessionId: string;
	sessionFile?: string;
	isStreaming: boolean;
}

export interface PiGlobalHostOptions {
	idleTimeoutMs?: number;
	backgroundTaskConcurrency?: number;
	onIdle?: () => void | Promise<void>;
}

interface RuntimeRecord {
	runtimeId: string;
	runtime: AgentSessionRuntime;
}

/** Owns concurrent AgentSessionRuntime instances inside one Pi process. */
export class PiGlobalHost {
	readonly backgroundTasks: GlobalBackgroundTaskCoordinator;
	private readonly rootRuntime: AgentSessionRuntime;
	private readonly runtimes = new Map<string, RuntimeRecord>();
	private readonly idleTimeoutMs: number;
	private readonly onIdle?: () => void | Promise<void>;
	private clientCount = 0;
	private idleTimer?: ReturnType<typeof setTimeout>;
	private disposed = false;
	private readonly unsubscribeBackgroundTasks: () => void;

	constructor(rootRuntime: AgentSessionRuntime, options: PiGlobalHostOptions = {}) {
		this.rootRuntime = rootRuntime;
		this.idleTimeoutMs = options.idleTimeoutMs ?? 30_000;
		this.onIdle = options.onIdle;
		this.backgroundTasks =
			options.backgroundTaskConcurrency === undefined
				? getProcessGlobalBackgroundTaskCoordinator()
				: new GlobalBackgroundTaskCoordinator({ concurrency: options.backgroundTaskConcurrency });
		this.unsubscribeBackgroundTasks = this.backgroundTasks.subscribe(() => this.refreshIdleTimer());
	}

	attachClient(): () => void {
		this.assertActive();
		this.clientCount++;
		this.refreshIdleTimer();
		let attached = true;
		return () => {
			if (!attached) return;
			attached = false;
			this.clientCount = Math.max(0, this.clientCount - 1);
			this.refreshIdleTimer();
		};
	}

	async openRuntime(options: PiGlobalHostRuntimeOpenOptions): Promise<PiGlobalHostRuntimeSnapshot> {
		this.assertActive();
		const runtimeId = options.runtimeId ?? randomUUID();
		const existing = this.runtimes.get(runtimeId);
		if (existing) return this.snapshot(existing);
		const runtime = await this.rootRuntime.createSibling(options);
		const record = { runtimeId, runtime };
		this.runtimes.set(runtimeId, record);
		this.refreshIdleTimer();
		return this.snapshot(record);
	}

	getRuntime(runtimeId: string): AgentSessionRuntime | undefined {
		return this.runtimes.get(runtimeId)?.runtime;
	}

	listRuntimes(): PiGlobalHostRuntimeSnapshot[] {
		return Array.from(this.runtimes.values(), (record) => this.snapshot(record));
	}

	async closeRuntime(runtimeId: string): Promise<boolean> {
		const record = this.runtimes.get(runtimeId);
		if (!record) return false;
		this.runtimes.delete(runtimeId);
		await record.runtime.dispose();
		this.refreshIdleTimer();
		return true;
	}

	subscribeBackgroundTasks(listener: GlobalBackgroundTaskEventListener): () => void {
		return this.backgroundTasks.subscribe(listener);
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.unsubscribeBackgroundTasks();
		const runtimes = Array.from(this.runtimes.values());
		this.runtimes.clear();
		await Promise.allSettled(runtimes.map(({ runtime }) => runtime.dispose()));
		await this.rootRuntime.dispose();
	}

	private snapshot(record: RuntimeRecord): PiGlobalHostRuntimeSnapshot {
		return {
			runtimeId: record.runtimeId,
			cwd: record.runtime.cwd,
			sessionId: record.runtime.session.sessionId,
			sessionFile: record.runtime.session.sessionFile,
			isStreaming: record.runtime.session.isStreaming,
		};
	}

	private refreshIdleTimer(): void {
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = undefined;
		}
		if (this.disposed || this.clientCount > 0 || this.runtimes.size > 0 || this.backgroundTasks.activeCount > 0)
			return;
		this.idleTimer = setTimeout(() => {
			this.idleTimer = undefined;
			void this.onIdle?.();
		}, this.idleTimeoutMs);
		this.idleTimer.unref?.();
	}

	private assertActive(): void {
		if (this.disposed) throw new Error("PiGlobalHost is disposed");
	}
}

export function createPiGlobalHost(rootRuntime: AgentSessionRuntime, options: PiGlobalHostOptions = {}): PiGlobalHost {
	return new PiGlobalHost(rootRuntime, options);
}
