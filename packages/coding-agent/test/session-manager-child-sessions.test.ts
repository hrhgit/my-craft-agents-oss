import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { SessionManager } from "../src/core/session-manager.ts";

describe("SessionManager.listChildrenBySpawnedFrom", () => {
	let previousAgentDir: string | undefined;
	let tempAgentDir: string | undefined;

	afterEach(() => {
		if (previousAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = previousAgentDir;
		}
		if (tempAgentDir) {
			rmSync(tempAgentDir, { recursive: true, force: true });
			tempAgentDir = undefined;
		}
	});

	it("returns only sessions whose header.spawnedFrom matches the parent session id", async () => {
		previousAgentDir = process.env[ENV_AGENT_DIR];
		tempAgentDir = mkdtempSync(join(tmpdir(), "pi-child-sessions-"));
		process.env[ENV_AGENT_DIR] = tempAgentDir;

		const sessionsDir = join(tempAgentDir, "sessions", "workspace");
		mkdirSync(sessionsDir, { recursive: true });
		const created = "2026-07-05T00:00:00.000Z";
		const childPath = join(sessionsDir, "child.jsonl");
		const otherPath = join(sessionsDir, "other.jsonl");

		writeFileSync(
			childPath,
			`${[
				JSON.stringify({
					type: "session",
					version: 3,
					id: "child-session",
					timestamp: created,
					cwd: "E:/project",
					parentSession: "parent.jsonl",
					spawnedFrom: "parent-session",
					spawnConfig: { model: "gpt-test", thinkingLevel: "low" },
				}),
				JSON.stringify({
					type: "message",
					id: "msg-1",
					parentId: null,
					timestamp: created,
					message: {
						role: "user",
						content: [{ type: "text", text: "child prompt" }],
						timestamp: Date.parse(created),
					},
				}),
				JSON.stringify({
					type: "session_info",
					id: "info-1",
					parentId: "msg-1",
					timestamp: created,
					name: "Child Name",
				}),
			].join("\n")}\n`,
		);
		writeFileSync(
			otherPath,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "other-session",
				timestamp: created,
				cwd: "E:/project",
				spawnedFrom: "different-parent",
			})}\n`,
		);

		const children = await SessionManager.listChildrenBySpawnedFrom("parent-session");

		expect(children).toHaveLength(1);
		expect(children[0]).toMatchObject({
			id: "child-session",
			path: childPath,
			name: "Child Name",
			spawnedFrom: "parent-session",
			parentSessionPath: "parent.jsonl",
			firstMessage: "child prompt",
			spawnConfig: { model: "gpt-test", thinkingLevel: "low" },
		});
	});
});
