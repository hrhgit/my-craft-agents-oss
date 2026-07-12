import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../config.ts";

export interface PiGlobalHostState {
	version: 1;
	pid: number;
	port: number;
	token: string;
	agentDir: string;
	startedAt: string;
	protocolVersion: number;
	packageVersion: string;
}

export function getPiGlobalHostStatePath(agentDir = getAgentDir()): string {
	return join(agentDir, "host", "state.json");
}

export function readPiGlobalHostState(agentDir = getAgentDir()): PiGlobalHostState | undefined {
	const statePath = getPiGlobalHostStatePath(agentDir);
	if (!existsSync(statePath)) return undefined;
	try {
		const value = JSON.parse(readFileSync(statePath, "utf8")) as Partial<PiGlobalHostState>;
		if (
			value.version !== 1 ||
			typeof value.pid !== "number" ||
			typeof value.port !== "number" ||
			typeof value.token !== "string" ||
			typeof value.agentDir !== "string" ||
			typeof value.startedAt !== "string" ||
			typeof value.protocolVersion !== "number" ||
			typeof value.packageVersion !== "string"
		) {
			return undefined;
		}
		return value as PiGlobalHostState;
	} catch {
		return undefined;
	}
}
