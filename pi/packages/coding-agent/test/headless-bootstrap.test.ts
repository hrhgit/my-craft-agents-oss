import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("headless bootstrap", () => {
	it("restores the sandbox environment before loading the runtime graph", () => {
		const source = readFileSync(fileURLToPath(new URL("../src/bun/headless.ts", import.meta.url)), "utf8");
		const restore = source.indexOf("restoreSandboxEnv();");
		const runtimeImport = source.indexOf('import("../headless-main.ts")');

		expect(restore).toBeGreaterThanOrEqual(0);
		expect(runtimeImport).toBeGreaterThan(restore);
		expect(source).not.toMatch(/^import .*from "\.\.\/headless-main\.ts";/m);
	});
});
