import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

const tempDirs: string[] = [];

function writeChildScript(contents: string): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-rpc-client-exit-"));
	tempDirs.push(dir);
	const path = join(dir, "child.mjs");
	writeFileSync(path, contents);
	return path;
}

async function waitForFile(path: string): Promise<void> {
	const deadline = Date.now() + 2000;
	while (!existsSync(path)) {
		if (Date.now() > deadline) {
			throw new Error(`Timed out waiting for file: ${path}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("RpcClient child process failures", () => {
	test("passes hostHooksModule to the child environment with legacy alias", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-rpc-client-env-"));
		tempDirs.push(dir);
		const capturePath = join(dir, "env.txt");
		const interceptorPath = join(dir, "interceptor.js");
		const client = new RpcClient({
			cliPath: writeChildScript(`
import { writeFileSync } from "node:fs";
writeFileSync(
	process.env.CAPTURE_PATH,
	JSON.stringify({
		hostHooks: process.env.PI_HOST_HOOKS_MODULE ?? "",
		legacy: process.env.PI_FETCH_INTERCEPTOR_MODULE ?? "",
	}),
);
process.stdin.resume();
setInterval(() => {}, 1000);
`),
			env: { CAPTURE_PATH: capturePath },
			hostHooksModule: interceptorPath,
			pipeStderr: false,
		});

		await client.start();
		await waitForFile(capturePath);
		expect(JSON.parse(readFileSync(capturePath, "utf-8"))).toEqual({
			hostHooks: interceptorPath,
			legacy: interceptorPath,
		});
		await client.stop();
	});

	test("rejects an in-flight request when the child process exits", async () => {
		const client = new RpcClient({
			cliPath: writeChildScript(`
process.stdin.once("data", () => {
	process.exit(43);
});
process.stdin.resume();
`),
		});

		await client.start();

		await expect(client.getCommands()).rejects.toThrow(/Agent process exited \(code=43 signal=null\)/);
	});
});
