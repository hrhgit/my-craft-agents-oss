import { writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";

type MockChild = {
	pid: number;
	stdout: PassThrough;
	stderr: PassThrough;
	on: (event: string, listener: (...args: unknown[]) => void) => MockChild;
};

const mocks = vi.hoisted(() => ({
	spawn: vi.fn<(command: string, args?: readonly string[]) => MockChild>(),
}));

vi.mock("node:child_process", () => ({
	spawn: mocks.spawn,
}));

import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { getOrThrow } from "../../src/harness/types.ts";
import { createTempDir } from "./session-test-utils.ts";

type MockSpawnCall = {
	command: string;
	args: string[];
};

async function withPlatform<T>(platform: NodeJS.Platform, callback: () => Promise<T> | T): Promise<T> {
	const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", {
		configurable: true,
		value: platform,
	});
	try {
		return await callback();
	} finally {
		if (platformDescriptor) {
			Object.defineProperty(process, "platform", platformDescriptor);
		}
	}
}

function createMockChild(output?: string): MockChild {
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const child = {
		pid: 123,
		stdout,
		stderr,
		on(event: string, listener: (...args: unknown[]) => void) {
			if (event === "close") {
				queueMicrotask(() => {
					if (output) {
						stdout.end(output);
					} else {
						stdout.end();
					}
					stderr.end();
					listener(0);
				});
			}
			return child;
		},
	};
	return child;
}

describe("NodeExecutionEnv shell resolution", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		mocks.spawn.mockReset();
	});

	test("resolves pwsh command names from PATH on Windows and uses PowerShell arguments", async () => {
		const root = createTempDir();
		const pwshPath = `${root}/pwsh.exe`;
		await writeFile(pwshPath, "");
		const spawnCalls: MockSpawnCall[] = [];

		mocks.spawn.mockImplementation((command: string, args?: readonly string[]) => {
			spawnCalls.push({ command, args: [...(args ?? [])] });
			if (command === "where") {
				return createMockChild(`${pwshPath}\n`);
			}
			return createMockChild("ok\n");
		});

		await withPlatform("win32", async () => {
			const env = new NodeExecutionEnv({ cwd: root, shellPath: "pwsh" });
			const result = getOrThrow(await env.exec("Write-Output ok"));
			expect(result).toEqual({ stdout: "ok\n", stderr: "", exitCode: 0 });
		});

		expect(spawnCalls).toEqual([
			{ command: "where", args: ["pwsh.exe"] },
			{
				command: pwshPath,
				args: ["-NoLogo", "-NoProfile", "-Command", "Write-Output ok"],
			},
		]);
	});

	test("uses PowerShell arguments for explicit Windows pwsh paths", async () => {
		const root = createTempDir();
		const pwshPath = `${root}/pwsh.exe`;
		await writeFile(pwshPath, "");
		const spawnCalls: MockSpawnCall[] = [];

		mocks.spawn.mockImplementation((command: string, args?: readonly string[]) => {
			spawnCalls.push({ command, args: [...(args ?? [])] });
			return createMockChild("ok\n");
		});

		await withPlatform("win32", async () => {
			const env = new NodeExecutionEnv({ cwd: root, shellPath: pwshPath });
			const result = getOrThrow(await env.exec("Write-Output ok"));
			expect(result).toEqual({ stdout: "ok\n", stderr: "", exitCode: 0 });
		});

		expect(spawnCalls).toEqual([
			{
				command: pwshPath,
				args: ["-NoLogo", "-NoProfile", "-Command", "Write-Output ok"],
			},
		]);
	});
});
