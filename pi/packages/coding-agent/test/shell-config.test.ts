import { afterEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	existsSync: vi.fn<(path: string) => boolean>(),
	spawn: vi.fn(),
	spawnSync: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		existsSync: mocks.existsSync,
	};
});

vi.mock("child_process", () => ({
	spawn: mocks.spawn,
	spawnSync: mocks.spawnSync,
}));

vi.mock("../src/config.js", () => ({
	getBinDir: () => "C:\\pi\\bin",
}));

import { getShellConfig } from "../src/utils/shell.ts";

function withPlatform<T>(platform: NodeJS.Platform, callback: () => T): T {
	const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", {
		configurable: true,
		value: platform,
	});
	try {
		return callback();
	} finally {
		if (platformDescriptor) {
			Object.defineProperty(process, "platform", platformDescriptor);
		}
	}
}

describe("getShellConfig", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		mocks.existsSync.mockReset();
		mocks.spawn.mockReset();
		mocks.spawnSync.mockReset();
	});

	test("resolves Windows shell command names from PATH when shellPath is not a file path", () => {
		const pwshPath = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
		mocks.spawnSync.mockReturnValue({
			status: 0,
			stdout: `${pwshPath}\r\n`,
		});
		mocks.existsSync.mockImplementation((path) => path === pwshPath);

		const config = withPlatform("win32", () => getShellConfig("pwsh"));

		expect(config).toEqual({
			shell: pwshPath,
			args: ["-NoLogo", "-NoProfile", "-Command"],
		});
		expect(mocks.spawnSync).toHaveBeenCalledWith("where", ["pwsh.exe"], { encoding: "utf-8", timeout: 5000 });
		expect(mocks.existsSync).toHaveBeenCalledWith("pwsh");
	});

	test("uses PowerShell arguments for explicit Windows pwsh paths", () => {
		const pwshPath = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
		mocks.existsSync.mockImplementation((path) => path === pwshPath);

		const config = withPlatform("win32", () => getShellConfig(pwshPath));

		expect(config).toEqual({
			shell: pwshPath,
			args: ["-NoLogo", "-NoProfile", "-Command"],
		});
	});

	test("keeps POSIX shell arguments for non-PowerShell executables", () => {
		const bashPath = "C:\\msys64\\usr\\bin\\bash.exe";
		mocks.existsSync.mockImplementation((path) => path === bashPath);

		const config = withPlatform("win32", () => getShellConfig(bashPath));

		expect(config).toEqual({
			shell: bashPath,
			args: ["-c"],
		});
	});
});
