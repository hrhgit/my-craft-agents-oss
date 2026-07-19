import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createTestExtensionsResult } from "./utilities.ts";

describe("hidden extension commands", () => {
	it("omits GUI-only commands from discovery without disabling direct execution", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-hidden-command-test-"));
		let invokedWith: string | undefined;

		try {
			const result = await createTestExtensionsResult(
				[
					(pi) => {
						pi.registerCommand("gui-only", {
							description: "Used by a GUI contribution",
							hidden: true,
							handler: async (args) => {
								invokedWith = args;
							},
						});
					},
				],
				tempDir,
			);
			const sessionManager = SessionManager.inMemory();
			const modelRegistry = ModelRegistry.create(AuthStorage.create(path.join(tempDir, "auth.json")));
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);

			expect(runner.getRegisteredCommands().map((command) => command.invocationName)).not.toContain("gui-only");
			const command = runner.getCommand("gui-only");
			expect(command?.hidden).toBe(true);
			if (!command) throw new Error("Hidden command was not directly resolvable");

			await command.handler("from-gui", runner.createCommandContext(command.extensionId));
			expect(invokedWith).toBe("from-gui");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
