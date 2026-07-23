import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	SESSION_PERSISTENCE_MAX_PENDING_ENTRIES,
	SessionManager,
	SessionPersistenceBackpressureError,
} from "../../src/core/session-manager.ts";

function assistantMessage(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages" as const,
		provider: "anthropic",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

function readJsonl(path: string): Array<Record<string, any>> {
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, any>);
}

describe("SessionManager async durability", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	function createSession(): SessionManager {
		const dir = mkdtempSync(join(tmpdir(), "pi-session-durability-"));
		tempDirs.push(dir);
		return SessionManager.create(dir, dir);
	}

	it("keeps a draft unpublished until the first assistant and atomically flushes the ordered prefix", async () => {
		const session = createSession();
		const file = session.getSessionFile()!;
		const userId = session.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		session.setMortiseMetadata({ workspaceId: "workspace-1" });

		await session.flush();
		expect(existsSync(file)).toBe(false);
		await expect(session.getPersistedEntry(userId)).resolves.toBeUndefined();

		const assistantId = session.appendMessage(assistantMessage("reply"));
		expect(existsSync(file)).toBe(false);
		expect(session.getDurabilityState()).toMatchObject({ queuedOperations: 1, failed: false });

		await session.flush();
		const entries = readJsonl(file);
		expect(entries.map((entry) => entry.type)).toEqual(["session", "message", "message"]);
		expect(entries[0].mortise).toEqual({ workspaceId: "workspace-1" });
		expect(entries.slice(1).map((entry) => entry.id)).toEqual([userId, assistantId]);
		expect((await session.getPersistedEntry(userId))?.id).toBe(userId);
		expect(session.getDurabilityState()).toEqual({
			queuedOperations: 0,
			pendingEntries: 0,
			pendingRevisions: 0,
			backpressured: false,
			failed: false,
		});
	});

	it("publishes a user-only Session only through the explicit hidden boundary", async () => {
		const session = createSession();
		const file = session.getSessionFile()!;
		session.appendMessage({ role: "user", content: "internal task", timestamp: Date.now() });

		await session.flush();
		expect(existsSync(file)).toBe(false);
		await expect(session.publishHiddenSession()).rejects.toThrow(
			"Header-only publication is restricted to explicitly hidden Sessions",
		);

		session.setMortiseMetadata({ hidden: true, owner: "automation" });
		await session.flush();
		expect(existsSync(file)).toBe(false);
		await session.publishHiddenSession();

		const entries = readJsonl(file);
		expect(entries).toHaveLength(2);
		expect(entries[0]).toMatchObject({ type: "session", mortise: { hidden: true, owner: "automation" } });
		expect(entries[1]).toMatchObject({ type: "message", message: { role: "user", content: "internal task" } });
	});

	it("coalesces a streaming burst into one bounded writer while preserving append order", async () => {
		const session = createSession();
		const publishedUserId = session.appendMessage({ role: "user", content: "publish", timestamp: Date.now() });
		session.appendMessage(assistantMessage("published"));
		await session.flush();

		const expected: string[] = [];
		for (let index = 0; index < 500; index++) {
			expected.push(`queued-${index}`);
			session.appendCustomEntry("throughput", { value: `queued-${index}` });
		}

		expect(session.getDurabilityState()).toMatchObject({
			queuedOperations: 1,
			pendingEntries: 500,
			pendingRevisions: 500,
			failed: false,
		});
		await session.flush();

		const persisted = readJsonl(session.getSessionFile()!)
			.filter((entry) => entry.type === "custom" && entry.customType === "throughput")
			.map((entry) => entry.data.value);
		expect(persisted).toEqual(expected);
		expect((await session.getPersistedEntry(publishedUserId))?.id).toBe(publishedUserId);
	});

	it("preserves an active append when a cold manager updates host metadata", async () => {
		const active = createSession();
		active.appendMessage({ role: "user", content: "publish", timestamp: Date.now() });
		active.appendMessage(assistantMessage("published"));
		await active.flush();
		const file = active.getSessionFile()!;
		const cold = SessionManager.open(file, active.getSessionDir(), active.getCwd());

		active.appendCustomEntry("active-runtime", { sequence: 1 });
		await cold.updateHostProjection({ metadata: { workspaceId: "workspace-latest" } });
		await active.flush();

		const entries = readJsonl(file);
		expect(entries[0]).toMatchObject({ type: "session", mortise: { workspaceId: "workspace-latest" } });
		expect(entries).toContainEqual(
			expect.objectContaining({ type: "custom", customType: "active-runtime", data: { sequence: 1 } }),
		);
	});

	it("keeps the event loop responsive while flushing a representative multi-megabyte turn", async () => {
		const session = createSession();
		session.appendMessage({ role: "user", content: "publish", timestamp: Date.now() });
		session.appendMessage(assistantMessage("published"));
		await session.flush();

		const payload = "x".repeat(4 * 1024);
		for (let index = 0; index < 500; index++) {
			session.appendCustomEntry("event-loop", { index, payload });
		}

		let timerTicks = 0;
		const timer = setInterval(() => timerTicks++, 0);
		try {
			await session.flush();
		} finally {
			clearInterval(timer);
		}
		expect(timerTicks).toBeGreaterThan(0);
	});

	it("applies explicit backpressure before the pending prefix can grow without bound", async () => {
		const session = createSession();
		session.appendMessage({ role: "user", content: "publish", timestamp: Date.now() });
		session.appendMessage(assistantMessage("published"));
		await session.flush();

		for (let index = 0; index < SESSION_PERSISTENCE_MAX_PENDING_ENTRIES; index++) {
			session.appendCustomEntry("backpressure", index);
		}
		expect(session.getDurabilityState().backpressured).toBe(true);
		expect(() => session.appendCustomEntry("backpressure", "overflow")).toThrow(
			SessionPersistenceBackpressureError,
		);

		await session.flush();
		expect(session.getDurabilityState().pendingEntries).toBe(0);
	});

	it("resets durability accounting when branching a long published session to a short draft", async () => {
		const session = createSession();
		const branchId = session.appendMessage({ role: "user", content: "branch root", timestamp: Date.now() });
		session.appendMessage(assistantMessage("published"));
		for (let index = 0; index < 32; index++) {
			session.appendCustomEntry("published-history", index);
		}
		await session.flush();

		session.createBranchedSession(branchId);
		expect(session.getDurabilityState()).toMatchObject({ pendingEntries: 2, pendingRevisions: 0 });
		for (let index = 0; index < SESSION_PERSISTENCE_MAX_PENDING_ENTRIES - 2; index++) {
			session.appendCustomEntry("branched-backpressure", index);
		}

		expect(session.getDurabilityState()).toMatchObject({
			pendingEntries: SESSION_PERSISTENCE_MAX_PENDING_ENTRIES,
			backpressured: true,
		});
		expect(() => session.appendCustomEntry("branched-backpressure", "overflow")).toThrow(
			SessionPersistenceBackpressureError,
		);
	});

	it("surfaces asynchronous write failures at flush and rejects later mutations", async () => {
		const session = createSession();
		const file = session.getSessionFile()!;
		session.appendMessage({ role: "user", content: "publish", timestamp: Date.now() });
		session.appendMessage(assistantMessage("published"));
		await session.flush();

		rmSync(file, { force: true });
		mkdirSync(file);
		session.appendCustomEntry("failure", true);
		await expect(session.flush()).rejects.toBeInstanceOf(Error);
		expect(session.getDurabilityState().failed).toBe(true);
		expect(() => session.appendCustomEntry("after-failure", true)).toThrow();
	});
});
