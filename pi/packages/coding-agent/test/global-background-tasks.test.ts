import { describe, expect, it } from "vitest";
import {
	GlobalBackgroundTaskCoordinator,
	getProcessGlobalBackgroundTaskCoordinator,
} from "../src/core/global-background-tasks.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for task state");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe("GlobalBackgroundTaskCoordinator", () => {
	it("supports host-owned inline handlers and a process singleton", async () => {
		const first = getProcessGlobalBackgroundTaskCoordinator();
		const second = getProcessGlobalBackgroundTaskCoordinator();
		expect(second).toBe(first);
		const completed = deferred();
		const snapshot = first.enqueue(
			{ type: "inline-test", key: "global", priority: 1, input: "payload" },
			async (input) => {
				expect(input).toBe("payload");
				completed.resolve();
			},
		);

		await completed.promise;
		await waitFor(() => first.get(snapshot.id)?.status === "completed");
	});

	it("runs queued work by priority without preempting the active task", async () => {
		const coordinator = new GlobalBackgroundTaskCoordinator();
		const blocker = deferred();
		const order: string[] = [];
		coordinator.register<string>("task", async (input) => {
			order.push(input);
			if (input === "active") await blocker.promise;
		});

		coordinator.enqueue({ type: "task", key: "active", priority: 50, input: "active" });
		await waitFor(() => order.length === 1);
		coordinator.enqueue({ type: "task", key: "low", priority: 30, input: "low" });
		coordinator.enqueue({ type: "task", key: "high", priority: 10, input: "high" });
		blocker.resolve();

		await waitFor(() => coordinator.activeCount === 0);
		expect(order).toEqual(["active", "high", "low"]);
	});

	it("coalesces a running identity and reruns once with the latest input", async () => {
		const coordinator = new GlobalBackgroundTaskCoordinator();
		const firstRun = deferred();
		const inputs: number[] = [];
		coordinator.register<number>("memory", async (input) => {
			inputs.push(input);
			if (inputs.length === 1) await firstRun.promise;
		});

		const initial = coordinator.enqueue({ type: "memory", key: "repo", priority: 30, input: 1 });
		await waitFor(() => inputs.length === 1);
		const coalesced = coordinator.enqueue({ type: "memory", key: "repo", priority: 30, input: 2 });
		expect(coalesced.id).toBe(initial.id);
		expect(coalesced.rerunRequested).toBe(true);
		firstRun.resolve();

		await waitFor(() => coordinator.activeCount === 0);
		expect(inputs).toEqual([1, 2]);
		expect(coordinator.get(initial.id)?.status).toBe("completed");
	});

	it("cancels a running task through its signal", async () => {
		const coordinator = new GlobalBackgroundTaskCoordinator();
		coordinator.register("audit", async (_input, context) => {
			await new Promise<void>((resolve) =>
				context.signal.addEventListener("abort", () => resolve(), { once: true }),
			);
		});

		const task = coordinator.enqueue({ type: "audit", key: "cwd", priority: 20, input: null });
		await waitFor(() => coordinator.get(task.id)?.status === "running");
		coordinator.cancel(task.id);
		await waitFor(() => coordinator.get(task.id)?.status === "cancelled");
		expect(coordinator.activeCount).toBe(0);
	});
});
