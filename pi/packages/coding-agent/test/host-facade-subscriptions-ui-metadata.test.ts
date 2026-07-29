import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	deleteSessionUiMetadata,
	readSessionUiMetadata,
	subscribeGlobalConfig,
	writeSessionUiMetadata,
} from "../src/core/host-facade.ts";

const roots: string[] = [];

function temporaryRoot(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	roots.push(root);
	return root;
}

afterEach(() => {
	delete process.env.MORTISE_AGENT_DIR;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("host facade subscriptions and Session UI metadata", () => {
	it("emits a typed source for Pi-owned global config changes", async () => {
		const agentDir = temporaryRoot("pi-host-config-subscription-");
		process.env.MORTISE_AGENT_DIR = agentDir;
		const change = await new Promise<{ schemaVersion: 1; source: string }>((resolve, reject) => {
			const timeout = setTimeout(() => {
				subscription.close();
				reject(new Error("Pi config subscription timed out"));
			}, 5_000);
			const subscription = subscribeGlobalConfig((event) => {
				clearTimeout(timeout);
				subscription.close();
				resolve(event);
			});
			setTimeout(() => writeFileSync(join(agentDir, "settings.json"), "{}\n", "utf8"), 25);
		});

		expect(change).toEqual({ schemaVersion: 1, source: "settings" });
	});

	it("owns validation, atomic persistence, projection, and deletion of UI metadata", () => {
		const root = temporaryRoot("pi-host-ui-metadata-");
		const sessionPath = join(root, "session.jsonl");
		writeFileSync(sessionPath, "{}\n", "utf8");
		const metadata = {
			schemaVersion: 1 as const,
			messages: [
				{
					messageId: "message-1",
					metadata: { attachments: [{ id: "attachment-1" }], annotations: [{ id: "annotation-1" }] },
				},
			],
		};

		expect(writeSessionUiMetadata({ sessionPath, projectionId: "session-1", metadata })).toEqual(metadata);
		expect(readSessionUiMetadata({ sessionPath, projectionId: "session-1" })).toEqual(metadata);
		expect(existsSync(join(root, ".pi-ui"))).toBe(true);

		deleteSessionUiMetadata({ sessionPath, projectionId: "session-1" });
		expect(readSessionUiMetadata({ sessionPath, projectionId: "session-1" })).toEqual({
			schemaVersion: 1,
			messages: [],
		});
	});
});
