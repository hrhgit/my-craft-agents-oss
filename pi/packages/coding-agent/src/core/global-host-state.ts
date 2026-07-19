import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../config.ts";

export const PI_GLOBAL_HOST_INSTANCE_ID_ENV = "PI_GLOBAL_HOST_INSTANCE_ID";

export interface PiGlobalHostState {
	version: 1;
	pid: number;
	port: number;
	token: string;
	agentDir: string;
	startedAt: string;
	protocolVersion: number;
	packageVersion: string;
	instanceId?: string;
}

export function getPiGlobalHostStatePath(agentDir = getAgentDir(), instanceId?: string): string {
	if (!instanceId) return join(agentDir, "host", "state.json");
	const instanceHash = createHash("sha256").update(instanceId).digest("hex");
	return join(agentDir, "host", "instances", instanceHash, "state.json");
}

export function readPiGlobalHostState(agentDir = getAgentDir(), instanceId?: string): PiGlobalHostState | undefined {
	const statePath = getPiGlobalHostStatePath(agentDir, instanceId);
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
			typeof value.packageVersion !== "string" ||
			(value.instanceId !== undefined && typeof value.instanceId !== "string")
		) {
			return undefined;
		}
		return value as PiGlobalHostState;
	} catch {
		return undefined;
	}
}
