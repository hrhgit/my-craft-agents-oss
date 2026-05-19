import { existsSync } from "node:fs";
import { delimiter, extname } from "node:path";
import { spawn, spawnSync } from "child_process";
import { getBinDir } from "../config.ts";

export interface ShellConfig {
	shell: string;
	args: string[];
}

function findCommandOnPath(command: string): string | null {
	const executable = process.platform === "win32" && extname(command) === "" ? `${command}.exe` : command;
	const lookupCommand = process.platform === "win32" ? "where" : "which";
	try {
		const result = spawnSync(lookupCommand, [executable], { encoding: "utf-8", timeout: 5000 });
		if (result.status !== 0 || !result.stdout) {
			return null;
		}
		const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
		if (!firstMatch) {
			return null;
		}
		if (process.platform === "win32" && !existsSync(firstMatch)) {
			return null;
		}
		return firstMatch;
	} catch {
		return null;
	}
}

/**
 * Find bash executable on PATH (cross-platform)
 */
function findBashOnPath(): string | null {
	return findCommandOnPath("bash");
}

function findPwshOnPath(): string | null {
	return findCommandOnPath("pwsh");
}

function isPathLike(shell: string): boolean {
	return shell.includes("/") || shell.includes("\\");
}

function getShellArgs(shell: string): string[] {
	const executableName = shell.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? shell.toLowerCase();
	if (
		executableName === "pwsh" ||
		executableName === "pwsh.exe" ||
		executableName === "powershell" ||
		executableName === "powershell.exe"
	) {
		return ["-NoLogo", "-NoProfile", "-Command"];
	}
	return ["-c"];
}

function resolveCustomShell(customShellPath: string): string | null {
	if (existsSync(customShellPath)) {
		return customShellPath;
	}
	if (!isPathLike(customShellPath)) {
		return findCommandOnPath(customShellPath);
	}
	return null;
}

/**
 * Resolve shell configuration based on platform and an optional explicit shell path.
 * Resolution order:
 * 1. User-specified shellPath
 * 2. On Windows: PowerShell 7 in known locations, then pwsh on PATH
 * 3. On Unix: /bin/bash, then bash on PATH, then fallback to sh
 */
export function getShellConfig(customShellPath?: string): ShellConfig {
	// 1. Check user-specified shell path
	if (customShellPath) {
		const resolvedShell = resolveCustomShell(customShellPath);
		if (resolvedShell) {
			return { shell: resolvedShell, args: getShellArgs(resolvedShell) };
		}
		throw new Error(`Custom shell path not found: ${customShellPath}`);
	}

	if (process.platform === "win32") {
		const pwshPaths: string[] = [];
		const programFiles = process.env.ProgramFiles;
		if (programFiles) {
			pwshPaths.push(`${programFiles}\\PowerShell\\7\\pwsh.exe`);
		}
		const programFilesX86 = process.env["ProgramFiles(x86)"];
		if (programFilesX86) {
			pwshPaths.push(`${programFilesX86}\\PowerShell\\7\\pwsh.exe`);
		}

		for (const pwshPath of pwshPaths) {
			if (existsSync(pwshPath)) {
				return { shell: pwshPath, args: getShellArgs(pwshPath) };
			}
		}

		const pwshOnPath = findPwshOnPath();
		if (pwshOnPath) {
			return { shell: pwshOnPath, args: getShellArgs(pwshOnPath) };
		}

		throw new Error(
			`No pwsh shell found. Options:\n` +
				`  1. Install PowerShell 7: https://aka.ms/powershell-release?tag=stable\n` +
				`  2. Add pwsh to PATH\n` +
				"  3. Set shellPath in settings.json\n\n" +
				`Searched pwsh in:\n${pwshPaths.map((p) => `  ${p}`).join("\n")}`,
		);
	}

	// Unix: try /bin/bash, then bash on PATH, then fallback to sh
	if (existsSync("/bin/bash")) {
		return { shell: "/bin/bash", args: getShellArgs("/bin/bash") };
	}

	const bashOnPath = findBashOnPath();
	if (bashOnPath) {
		return { shell: bashOnPath, args: getShellArgs(bashOnPath) };
	}

	return { shell: "sh", args: getShellArgs("sh") };
}

export function getShellEnv(): NodeJS.ProcessEnv {
	const binDir = getBinDir();
	const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const currentPath = process.env[pathKey] ?? "";
	const pathEntries = currentPath.split(delimiter).filter(Boolean);
	const hasBinDir = pathEntries.includes(binDir);
	const updatedPath = hasBinDir ? currentPath : [binDir, currentPath].filter(Boolean).join(delimiter);

	return {
		...process.env,
		[pathKey]: updatedPath,
	};
}

/**
 * Sanitize binary output for display/storage.
 * Removes characters that crash string-width or cause display issues:
 * - Control characters (except tab, newline, carriage return)
 * - Lone surrogates
 * - Unicode Format characters (crash string-width due to a bug)
 * - Characters with undefined code points
 */
export function sanitizeBinaryOutput(str: string): string {
	// Use Array.from to properly iterate over code points (not code units)
	// This handles surrogate pairs correctly and catches edge cases where
	// codePointAt() might return undefined
	return Array.from(str)
		.filter((char) => {
			// Filter out characters that cause string-width to crash
			// This includes:
			// - Unicode format characters
			// - Lone surrogates (already filtered by Array.from)
			// - Control chars except \t \n \r
			// - Characters with undefined code points

			const code = char.codePointAt(0);

			// Skip if code point is undefined (edge case with invalid strings)
			if (code === undefined) return false;

			// Allow tab, newline, carriage return
			if (code === 0x09 || code === 0x0a || code === 0x0d) return true;

			// Filter out control characters (0x00-0x1F, except 0x09, 0x0a, 0x0x0d)
			if (code <= 0x1f) return false;

			// Filter out Unicode format characters
			if (code >= 0xfff9 && code <= 0xfffb) return false;

			return true;
		})
		.join("");
}

/**
 * Detached child processes must be tracked so they can be killed on parent
 * shutdown signals (SIGHUP/SIGTERM).
 */
const trackedDetachedChildPids = new Set<number>();

export function trackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.add(pid);
}

export function untrackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.delete(pid);
}

export function killTrackedDetachedChildren(): void {
	for (const pid of trackedDetachedChildPids) {
		killProcessTree(pid);
	}
	trackedDetachedChildPids.clear();
}

/**
 * Kill a process and all its children (cross-platform)
 */
export function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		// Use taskkill on Windows to kill process tree
		try {
			spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
				stdio: "ignore",
				detached: true,
				windowsHide: true,
			});
		} catch {
			// Ignore errors if taskkill fails
		}
	} else {
		// Use SIGKILL on Unix/Linux/Mac
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// Fallback to killing just the child if process group kill fails
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Process already dead
			}
		}
	}
}
