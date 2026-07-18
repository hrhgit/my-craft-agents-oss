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
	test("directExecutable does not insert a CLI path argument", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-rpc-client-direct-"));
		tempDirs.push(dir);
		const capturePath = join(dir, "argv.txt");
		const executableScript = writeChildScript(`
import { writeFileSync } from "node:fs";
writeFileSync(process.env.CAPTURE_PATH, JSON.stringify(process.argv.slice(2)));
process.stdin.resume();
setInterval(() => {}, 1000);
`);
		const client = new RpcClient({
			command: process.execPath,
			commandArgs: [executableScript],
			cliPath: "must-not-be-inserted.js",
			directExecutable: true,
			env: { CAPTURE_PATH: capturePath },
			pipeStderr: false,
		});

		await client.start();
		await waitForFile(capturePath);
		expect(JSON.parse(readFileSync(capturePath, "utf-8"))).toEqual(["--mode", "rpc"]);
		await client.stop();
	});

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

	test("envMode replace does not inherit parent environment variables", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-rpc-client-env-replace-"));
		tempDirs.push(dir);
		const capturePath = join(dir, "env-replace.txt");
		const previous = process.env.PI_RPC_ENV_LEAK_TEST;
		process.env.PI_RPC_ENV_LEAK_TEST = "should-not-leak";
		const client = new RpcClient({
			cliPath: writeChildScript(`
import { writeFileSync } from "node:fs";
writeFileSync(
	process.env.CAPTURE_PATH,
	JSON.stringify({
		capturePath: process.env.CAPTURE_PATH ?? "",
		leaked: process.env.PI_RPC_ENV_LEAK_TEST ?? "",
	}),
);
process.stdin.resume();
setInterval(() => {}, 1000);
`),
			envMode: "replace",
			env: { CAPTURE_PATH: capturePath },
			pipeStderr: false,
		});

		try {
			await client.start();
			await waitForFile(capturePath);
			expect(JSON.parse(readFileSync(capturePath, "utf-8"))).toEqual({
				capturePath,
				leaked: "",
			});
		} finally {
			if (previous === undefined) {
				delete process.env.PI_RPC_ENV_LEAK_TEST;
			} else {
				process.env.PI_RPC_ENV_LEAK_TEST = previous;
			}
			await client.stop();
		}
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

	test("emits a client lifecycle event when the child process exits", async () => {
		const client = new RpcClient({
			cliPath: writeChildScript(`
process.stdin.once("data", () => {
	process.exit(44);
});
process.stdin.resume();
`),
			pipeStderr: false,
		});
		const events: unknown[] = [];
		client.onClientEvent((event) => events.push(event));

		await client.start();
		await expect(client.getCommands()).rejects.toThrow(/Agent process exited \(code=44 signal=null\)/);

		expect(events).toContainEqual(
			expect.objectContaining({
				type: "process_exit",
				code: 44,
				signal: null,
			}),
		);
	});

	test("delivers a lifecycle event to remaining listeners when an earlier listener unsubscribes", async () => {
		const client = new RpcClient({
			cliPath: writeChildScript(`
process.stdin.once("data", () => {
	process.exit(45);
});
process.stdin.resume();
`),
			pipeStderr: false,
		});
		const events: unknown[] = [];
		let unsubscribeFirst = () => {};
		unsubscribeFirst = client.onClientEvent(() => unsubscribeFirst());
		client.onClientEvent((event) => events.push(event));

		await client.start();
		await expect(client.getCommands()).rejects.toThrow(/Agent process exited \(code=45 signal=null\)/);

		expect(events).toContainEqual(
			expect.objectContaining({
				type: "process_exit",
				code: 45,
				signal: null,
			}),
		);
	});
});
