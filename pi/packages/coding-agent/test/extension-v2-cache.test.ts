import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionsIntoRuntime } from "../src/core/extensions/loader.ts";

describe("extension v2 definition cache", () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
		delete (globalThis as typeof globalThis & { __extensionV2LoadCount?: number }).__extensionV2LoadCount;
	});

	it("reuses only an explicitly shareable v2 definition across session runtimes", async () => {
		const root = join(tmpdir(), `pi-extension-v2-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(root, { recursive: true });
		roots.push(root);
		const extensionPath = join(root, "index.ts");
		writeFileSync(
			extensionPath,
			`import { defineExtensionV2 } from "@mortise/pi-coding-agent";
const state = globalThis as typeof globalThis & { __extensionV2LoadCount?: number };
state.__extensionV2LoadCount = (state.__extensionV2LoadCount ?? 0) + 1;
export default defineExtensionV2({ isolation: "session", session(pi) { pi.registerCommand("cached", { handler: async () => {} }); } });
`,
			"utf8",
		);

		const metadataByPath = new Map([[extensionPath, { id: "cache-test", target: "pi" as const, agentDir: root }]]);
		const first = await loadExtensionsIntoRuntime(
			[extensionPath],
			root,
			createEventBus(),
			createExtensionRuntime(),
			undefined,
			metadataByPath,
		);
		const second = await loadExtensionsIntoRuntime(
			[extensionPath],
			root,
			createEventBus(),
			createExtensionRuntime(),
			undefined,
			metadataByPath,
		);

		expect(first.errors).toEqual([]);
		expect(second.errors).toEqual([]);
		expect((globalThis as typeof globalThis & { __extensionV2LoadCount?: number }).__extensionV2LoadCount).toBe(1);
		expect(first.extensions[0]?.commands.has("cached")).toBe(true);
		expect(second.extensions[0]?.commands.has("cached")).toBe(true);
	});
});
