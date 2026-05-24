import type { SessionEntry, SessionInfo } from "@earendil-works/pi-coding-agent";

export const YOURSELF_STATUS_KEY = "yourself";
export const YOURSELF_OUTPUT_DIR_NAME = "YOURSELF";
export const YOURSELF_STATE_DIR_NAME = ".state";
export const YOURSELF_INDEX_FILE_NAME = "index.json";
export const YOURSELF_LOCK_FILE_NAME = "lock.json";

export const YOURSELF_MODEL_PROVIDER = "mimo";
export const YOURSELF_MODEL_ID = "mimo-v2.5-pro";
export const YOURSELF_MODEL_REF = `${YOURSELF_MODEL_PROVIDER}/${YOURSELF_MODEL_ID}`;

export const CHECKPOINT_VERSION = 1;
export const LOCK_VERSION = 1;
export const STALE_LOCK_MS = 60 * 60 * 1000;
export const STATUS_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export type YourselfRunStatus =
	| "idle"
	| "starting"
	| "scanning"
	| "summarizing"
	| "writing"
	| "complete"
	| "error"
	| "stopped";

export interface YourselfStats {
	totalSessions: number;
	processedSessions: number;
	skippedSessions: number;
	failedSessions: number;
	writtenSummaries: number;
}

export interface YourselfRuntimeStatus {
	status: YourselfRunStatus;
	startedAt?: string;
	updatedAt?: string;
	message?: string;
	currentSession?: string;
	outputDir: string;
	stats: YourselfStats;
	lastError?: string;
}

export interface YourselfCheckpointSession {
	path: string;
	id?: string;
	mtimeMs?: number;
	size?: number;
	status: "processed" | "skipped" | "failed";
	reason?: string;
	error?: string;
	summaryHashes?: string[];
	processedAt: string;
}

export interface YourselfCheckpoint {
	version: typeof CHECKPOINT_VERSION;
	updatedAt: string;
	sessions: Record<string, YourselfCheckpointSession>;
}

export interface YourselfLock {
	version: typeof LOCK_VERSION;
	pid: number;
	createdAt: string;
	updatedAt: string;
	sessionFile?: string;
	cwd: string;
}

export interface NormalizedSession {
	info: SessionInfo;
	entries: SessionEntry[];
	headerTimestamp?: string;
}

export interface SessionTurn {
	id: string;
	startedAt: string;
	user: string;
	assistant: string;
	toolCalls: string[];
	toolResults: string[];
}

export interface SessionDigest {
	sessionPath: string;
	sessionId: string;
	cwd: string;
	date: string;
	modified: string;
	turns: SessionTurn[];
	text: string;
	hash: string;
}

export interface YourselfSummary {
	date: string;
	sessionPath: string;
	sessionId: string;
	cwd: string;
	hash: string;
	content: string;
	createdAt: string;
	model: string;
}

export interface WriteSummaryResult {
	written: boolean;
	path: string;
	hash: string;
}

export interface SummarizerResult {
	content: string;
	model: string;
	via: "pi-subagents-json" | "direct-mimo";
}
