import { describe, expect, it } from "vitest";
import { SerialTaskQueue } from "../src/utils/serial-task-queue.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolvePromise: () => void = () => {};
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}

describe("SerialTaskQueue", () => {
	it("runs pending tasks by priority after the current task finishes", async () => {
		const queue = new SerialTaskQueue();
		const order: string[] = [];
		const blocker = deferred();

		const first = queue.schedule("first", async () => {
			order.push("first-start");
			await blocker.promise;
			order.push("first-end");
		});
		const low = queue.schedule(
			"low",
			async () => {
				order.push("low");
			},
			{ priority: "low" },
		);
		const high = queue.schedule(
			"high",
			async () => {
				order.push("high");
			},
			{ priority: "high" },
		);

		await Promise.resolve();
		expect(order).toEqual(["first-start"]);

		blocker.resolve();
		await Promise.all([first, low, high]);

		expect(order).toEqual(["first-start", "first-end", "high", "low"]);
	});

	it("reuses and promotes a pending task with the same key", async () => {
		const queue = new SerialTaskQueue();
		const order: string[] = [];
		const blocker = deferred();

		const first = queue.schedule("first", async () => {
			await blocker.promise;
		});
		const sharedLow = queue.schedule(
			"shared",
			async () => {
				order.push("shared");
				return "done";
			},
			{ priority: "low" },
		);
		const other = queue.schedule(
			"other",
			async () => {
				order.push("other");
			},
			{ priority: "normal" },
		);
		const sharedHigh = queue.schedule(
			"shared",
			async () => {
				throw new Error("should reuse the pending shared task");
			},
			{ priority: "high" },
		);

		expect(sharedHigh).toBe(sharedLow);
		blocker.resolve();

		await Promise.all([first, sharedHigh, other]);

		expect(await sharedLow).toBe("done");
		expect(order).toEqual(["shared", "other"]);
	});

	it("prioritizes a promoted shared task over older normal work", async () => {
		const queue = new SerialTaskQueue();
		const order: string[] = [];
		const blocker = deferred();

		const first = queue.schedule("first", async () => {
			await blocker.promise;
		});
		const requestResources = queue.schedule(
			"request-resources",
			async () => {
				order.push("request-resources");
			},
			{ priority: "low" },
		);
		const normal = queue.schedule(
			"normal",
			async () => {
				order.push("normal");
			},
			{ priority: "normal" },
		);
		const promotedRequestResources = queue.schedule(
			"request-resources",
			async () => {
				throw new Error("should reuse the pending request resource task");
			},
			{ priority: "high" },
		);

		expect(promotedRequestResources).toBe(requestResources);
		blocker.resolve();

		await Promise.all([first, promotedRequestResources, normal]);

		expect(order).toEqual(["request-resources", "normal"]);
	});
});
