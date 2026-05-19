import { basename } from "node:path";

export type ShellToolName = "bash" | "pwsh";

export function isShellToolName(name: string): name is ShellToolName {
	return name === "bash" || name === "pwsh";
}

export function getShellToolName(shellPath?: string): ShellToolName {
	if (shellPath) {
		const executable = basename(shellPath).toLowerCase();
		if (
			executable === "pwsh" ||
			executable === "pwsh.exe" ||
			executable === "powershell" ||
			executable === "powershell.exe"
		) {
			return "pwsh";
		}
	}

	return process.platform === "win32" ? "pwsh" : "bash";
}

export function getAlternateShellToolName(name: ShellToolName): ShellToolName {
	return name === "bash" ? "pwsh" : "bash";
}
