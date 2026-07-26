import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizePath } from "./utils/paths.ts";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));

export const isBunBinary =
	import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN") || import.meta.url.includes("%7EBUN");
export const isBunRuntime = !!process.versions.bun;

export const PACKAGE_NAME = "@mortise/pi-coding-agent";
export const APP_NAME = "mortise";
export const CONFIG_DIR_NAME = ".mortise";
export const VERSION = (() => {
	try {
		const value = JSON.parse(readFileSync(join(getPackageDir(), "package.json"), "utf8")) as { version?: string };
		return value.version || "0.0.0";
	} catch {
		return "0.0.0";
	}
})();

export const ENV_AGENT_DIR = "MORTISE_AGENT_DIR";
export const ENV_SESSION_DIR = "MORTISE_SESSION_DIR";
export const ENV_PROJECT_CONFIG_DIR = "MORTISE_PROJECT_CONFIG_DIR";

export function getProjectConfigDir(): string {
	return process.env[ENV_PROJECT_CONFIG_DIR]?.trim() || CONFIG_DIR_NAME;
}

export function expandTildePath(path: string): string {
	return normalizePath(path);
}

export function getAgentDir(): string {
	const explicitAgentDir = process.env[ENV_AGENT_DIR]?.trim();
	if (explicitAgentDir) return expandTildePath(explicitAgentDir);
	const configDir = process.env.MORTISE_CONFIG_DIR?.trim();
	return join(configDir ? expandTildePath(configDir) : join(homedir(), CONFIG_DIR_NAME), "agent");
}

export function getModelsPath(): string {
	return join(getAgentDir(), "models.json");
}

export function getSettingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

export function getBinDir(): string {
	return join(getAgentDir(), "bin");
}

export function getSessionsDir(): string {
	return join(getAgentDir(), "sessions");
}

/** Locate assets shipped beside the compiled runtime or the source package root. */
export function getPackageDir(): string {
	if (isBunBinary) return dirname(process.execPath);
	let current = moduleDirectory;
	while (current !== dirname(current)) {
		if (existsSync(join(current, "package.json"))) {
			const parent = dirname(current);
			return basename(current) === "dist" && existsSync(join(parent, "package.json")) ? parent : current;
		}
		current = dirname(current);
	}
	return moduleDirectory;
}
