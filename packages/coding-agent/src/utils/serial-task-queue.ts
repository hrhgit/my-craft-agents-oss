export type SerialTaskPriority = "low" | "normal" | "high";

const priorityRank: Record<SerialTaskPriority, number> = {
	low: 0,
	normal: 1,
	high: 2,
};

type QueuedTask<T> = {
	key: string;
	priority: SerialTaskPriority;
	sequence: number;
	run: () => Promise<T>;
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason: unknown) => void;
};

export class SerialTaskQueue {
	private pending: Array<QueuedTask<unknown>> = [];
	private runningTask: QueuedTask<unknown> | undefined;
	private nextSequence = 0;

	schedule<T>(key: string, run: () => Promise<T>, options: { priority?: SerialTaskPriority } = {}): Promise<T> {
		const priority = options.priority ?? "normal";
		const runningTask = this.runningTask;
		if (runningTask?.key === key) {
			return runningTask.promise as Promise<T>;
		}

		const existing = this.pending.find((task) => task.key === key);
		if (existing) {
			if (priorityRank[priority] > priorityRank[existing.priority]) {
				existing.priority = priority;
			}
			return existing.promise as Promise<T>;
		}

		let resolveTask: (value: T) => void = () => {};
		let rejectTask: (reason: unknown) => void = () => {};
		const promise = new Promise<T>((resolve, reject) => {
			resolveTask = resolve;
			rejectTask = reject;
		});

		const task: QueuedTask<T> = {
			key,
			priority,
			sequence: this.nextSequence++,
			run,
			promise,
			resolve: resolveTask,
			reject: rejectTask,
		};
		this.pending.push(task as QueuedTask<unknown>);
		this.drain();
		return promise;
	}

	private drain(): void {
		if (this.runningTask) {
			return;
		}
		const nextTask = this.takeNextTask();
		if (!nextTask) {
			return;
		}

		this.runningTask = nextTask;
		void (async () => {
			try {
				nextTask.resolve(await nextTask.run());
			} catch (error) {
				nextTask.reject(error);
			} finally {
				this.runningTask = undefined;
				this.drain();
			}
		})();
	}

	private takeNextTask(): QueuedTask<unknown> | undefined {
		let selectedIndex = -1;
		let selectedTask: QueuedTask<unknown> | undefined;
		for (let i = 0; i < this.pending.length; i++) {
			const task = this.pending[i];
			if (
				!selectedTask ||
				priorityRank[task.priority] > priorityRank[selectedTask.priority] ||
				(priorityRank[task.priority] === priorityRank[selectedTask.priority] &&
					task.sequence < selectedTask.sequence)
			) {
				selectedIndex = i;
				selectedTask = task;
			}
		}
		if (selectedIndex < 0) {
			return undefined;
		}
		this.pending.splice(selectedIndex, 1);
		return selectedTask;
	}
}
