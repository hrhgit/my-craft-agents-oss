import type { ThinkingLevel } from "@mortise/pi-agent-core";

export type DeliveryMode = "steer" | "followUp";

export interface RemoteModel {
	provider: string;
	id: string;
	name: string;
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
}

export interface RemoteState {
	sessionId: string;
	sessionFile?: string;
	sessionName?: string;
	cwd: string;
	model?: RemoteModel;
	thinkingLevel: ThinkingLevel;
	webSearch: boolean;
	planMode: boolean;
	isStreaming: boolean;
}

export interface RemoteSessionInfo {
	file: string;
	id: string;
	name?: string;
	cwd: string;
	createdAt: number;
	updatedAt: number;
	messageCount: number;
	firstMessage: string;
}

export type ClientEvent =
	| { type: "auth"; token: string }
	| { type: "prompt"; text: string; delivery?: DeliveryMode }
	| { type: "abort" }
	| { type: "set_model"; provider: string; id: string }
	| { type: "set_thinking_level"; level: ThinkingLevel }
	| { type: "set_settings"; webSearch?: boolean; planMode?: boolean }
	| { type: "ping" };

export type ServerEvent =
	| { type: "ready"; state: RemoteState }
	| { type: "state"; state: RemoteState }
	| { type: "assistant_delta"; text: string }
	| { type: "thinking_delta"; text: string }
	| { type: "tool_start"; toolCallId: string; toolName: string; input?: unknown }
	| { type: "tool_update"; toolCallId: string; toolName: string; text: string }
	| { type: "tool_end"; toolCallId: string; toolName: string; isError: boolean; output?: string }
	| { type: "agent_start" }
	| { type: "agent_end" }
	| { type: "error"; message: string }
	| { type: "pong" };

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh";
}

export function isDeliveryMode(value: unknown): value is DeliveryMode {
	return value === "steer" || value === "followUp";
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}
