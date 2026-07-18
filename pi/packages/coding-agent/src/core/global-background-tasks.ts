import { randomUUID } from "node:crypto";

export type GlobalBackgroundTaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface GlobalBackgroundTaskRequest<TInput = unknown> {
	type: string;
	key: string;
	priority: number;
	input: TInput;
}

export interface GlobalBackgroundTaskSnapshot {
	id: string;
	type: string;
	key: string;
	priority: number;
	status: GlobalBackgroundTaskStatus;
	createdAt: string;
	updatedAt: string;
	startedAt?: string;
	finishedAt?: string;
	error?: string;
	rerunRequested: boolean;
}

export interface GlobalBackgroundTaskContext {
	id: string;
	type: string;
	key: string;
	signal: AbortSignal;
}

export type GlobalBackgroundTaskHandler<TInput = unknown> = (
	input: TInput,
	context: GlobalBackgroundTaskContext,
) => Promise<void>;

export type GlobalBackgroundTaskEventListener = (snapshot: GlobalBackgroundTaskSnapshot) => void;

interface RegisteredHandler {
	run: GlobalBackgroundTaskHandler;
}

interface TaskRecord extends GlobalBackgroundTaskSnapshot {
	input: unknown;
	handler?: GlobalBackgroundTaskHandler;
	controller?: AbortController;
}

function nowIso(): string {
	return new Date().toISOString();
}

function taskIdentity(type: string, key: string): string {
	return `${type}\u0000${key}`;
}

/**
 * Process-global, non-preemptive background task scheduler.
 *
 * The registry is intentionally in memory. Task-specific checkpoints and
 * artifacts remain the responsibility of each handler.
 */
export class GlobalBackgroundTaskCoordinator {
	private readonly concurrency: number;
	private readonly handlers = new Map<string, RegisteredHandler>();
	private readonly tasks = new Map<string, TaskRecord>();
	private readonly activeByIdentity = new Map<string, string>();
	private readonly listeners = new Set<GlobalBackgroundTaskEventListener>();
	private runningCount = 0;
	private sequence = 0;

	constructor(options: { concurrency?: number } = {}) {
		this.concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
	}

	register<TInput>(type: string, handler: GlobalBackgroundTaskHandler<TInput>): () => void {
		if (this.handlers.has(type)) {
			throw new Error(`Global background task handler already registered: ${type}`);
		}
		this.handlers.set(type, { run: handler as GlobalBackgroundTaskHandler });
		this.schedule();
		return () => {
			const current = this.handlers.get(type);
			if (current?.run === handler) this.handlers.delete(type);
		};
	}

	enqueue<TInput>(
		request: GlobalBackgroundTaskRequest<TInput>,
		handler?: GlobalBackgroundTaskHandler<TInput>,
	): GlobalBackgroundTaskSnapshot {
		const identity = taskIdentity(request.type, request.key);
		const existingId = this.activeByIdentity.get(identity);
		if (existingId) {
			const existing = this.tasks.get(existingId);
			if (existing && (existing.status === "queued" || existing.status === "running")) {
				existing.input = request.input;
				if (handler) existing.handler = handler as GlobalBackgroundTaskHandler;
				existing.updatedAt = nowIso();
				existing.rerunRequested = existing.status === "running";
				this.emit(existing);
				return this.snapshot(existing);
			}
		}

		const stamp = nowIso();
		const record: TaskRecord = {
			id: `${request.type}-${++this.sequence}-${randomUUID()}`,
			type: request.type,
			key: request.key,
			priority: request.priority,
			input: request.input,
			handler: handler as GlobalBackgroundTaskHandler | undefined,
			status: "queued",
			createdAt: stamp,
			updatedAt: stamp,
			rerunRequested: false,
		};
		this.tasks.set(record.id, record);
		this.activeByIdentity.set(identity, record.id);
		this.emit(record);
		this.schedule();
		return this.snapshot(record);
	}

	cancel(id: string): GlobalBackgroundTaskSnapshot | undefined {
		const record = this.tasks.get(id);
		if (!record || (record.status !== "queued" && record.status !== "running"))
			return record && this.snapshot(record);
		record.rerunRequested = false;
		if (record.status === "running") {
			record.controller?.abort();
			record.updatedAt = nowIso();
			this.emit(record);
			return this.snapshot(record);
		}
		this.finish(record, "cancelled");
		this.schedule();
		return this.snapshot(record);
	}

	cancelByIdentity(type: string, key: string): GlobalBackgroundTaskSnapshot | undefined {
		const id = this.activeByIdentity.get(taskIdentity(type, key));
		return id ? this.cancel(id) : undefined;
	}

	get(id: string): GlobalBackgroundTaskSnapshot | undefined {
		const record = this.tasks.get(id);
		return record && this.snapshot(record);
	}

	list(): GlobalBackgroundTaskSnapshot[] {
		return Array.from(this.tasks.values(), (record) => this.snapshot(record)).sort((left, right) =>
			right.createdAt.localeCompare(left.createdAt),
		);
	}

	get activeCount(): number {
		return Array.from(this.tasks.values()).filter(
			(record) => record.status === "queued" || record.status === "running",
		).length;
	}

	subscribe(listener: GlobalBackgroundTaskEventListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private schedule(): void {
		while (this.runningCount < this.concurrency) {
			const next = Array.from(this.tasks.values())
				.filter((record) => record.status === "queued" && (record.handler || this.handlers.has(record.type)))
				.sort(
					(left, right) =>
						left.priority - right.priority ||
						left.createdAt.localeCompare(right.createdAt) ||
						left.id.localeCompare(right.id),
				)[0];
			if (!next) return;
			void this.run(next);
		}
	}

	private async run(record: TaskRecord): Promise<void> {
		const handler = record.handler ? { run: record.handler } : this.handlers.get(record.type);
		if (!handler || record.status !== "queued") return;
		this.runningCount++;
		record.status = "running";
		record.startedAt = nowIso();
		record.updatedAt = record.startedAt;
		const controller = new AbortController();
		record.controller = controller;
		this.emit(record);
		try {
			await handler.run(record.input, {
				id: record.id,
				type: record.type,
				key: record.key,
				signal: controller.signal,
			});
			if (controller.signal.aborted) {
				this.finish(record, "cancelled");
			} else if (record.rerunRequested) {
				record.status = "queued";
				record.rerunRequested = false;
				record.controller = undefined;
				record.startedAt = undefined;
				record.updatedAt = nowIso();
				this.emit(record);
			} else {
				this.finish(record, "completed");
			}
		} catch (error) {
			if (controller.signal.aborted) {
				this.finish(record, "cancelled");
			} else {
				record.error = error instanceof Error ? error.message : String(error);
				this.finish(record, "failed");
			}
		} finally {
			record.controller = undefined;
			this.runningCount--;
			this.schedule();
		}
	}

	private finish(
		record: TaskRecord,
		status: Extract<GlobalBackgroundTaskStatus, "completed" | "failed" | "cancelled">,
	): void {
		record.status = status;
		record.finishedAt = nowIso();
		record.updatedAt = record.finishedAt;
		this.activeByIdentity.delete(taskIdentity(record.type, record.key));
		this.emit(record);
	}

	private snapshot(record: TaskRecord): GlobalBackgroundTaskSnapshot {
		return {
			id: record.id,
			type: record.type,
			key: record.key,
			priority: record.priority,
			status: record.status,
			createdAt: record.createdAt,
			updatedAt: record.updatedAt,
			startedAt: record.startedAt,
			finishedAt: record.finishedAt,
			error: record.error,
			rerunRequested: record.rerunRequested,
		};
	}

	private emit(record: TaskRecord): void {
		const snapshot = this.snapshot(record);
		for (const listener of this.listeners) listener(snapshot);
	}
}

/** Shared by all SessionRuntime instances in one Pi host process. */
export function getProcessGlobalBackgroundTaskCoordinator(): GlobalBackgroundTaskCoordinator {
	const globalState = globalThis as typeof globalThis & {
		__piGlobalBackgroundTaskCoordinator?: GlobalBackgroundTaskCoordinator;
	};
	const existing = globalState.__piGlobalBackgroundTaskCoordinator;
	if (existing) return existing;
	const coordinator = new GlobalBackgroundTaskCoordinator({ concurrency: 1 });
	globalState.__piGlobalBackgroundTaskCoordinator = coordinator;
	return coordinator;
}
