import * as fs from "node:fs/promises";
import { type ExtensionContext, type SessionEntry, type SessionInfo, SessionManager } from "@mortise/pi-coding-agent";
import {
	hashText,
	hasSummaryMarker,
	loadCheckpoint,
	releaseLock,
	saveCheckpoint,
	shortHash,
	touchLock,
	writeSummary,
} from "./state.ts";
import { summarizeDigest } from "./summarizer.ts";
import {
	type NormalizedSession,
	type SessionDigest,
	type SessionTurn,
	YOURSELF_MODEL_REF,
	type YourselfCheckpoint,
	type YourselfRuntimeStatus,
	type YourselfStats,
	type YourselfSummary,
} from "./types.ts";

const MAX_TEXT_CHARS = 40_000;
const MAX_TOOL_RESULT_CHARS = 2_000;
const MAX_TOOL_ARG_CHARS = 1_000;
const MAX_TURNS = 24;

export interface YourselfWorkerOptions {
	outputDir: string;
	currentSessionFile?: string;
	status: YourselfRuntimeStatus;
	onStatus: (status: YourselfRuntimeStatus) => void;
	signal: AbortSignal;
}

function updateStatus(
	options: YourselfWorkerOptions,
	patch: Partial<Omit<YourselfRuntimeStatus, "stats">> & { stats?: Partial<YourselfStats> },
): void {
	options.status = {
		...options.status,
		...patch,
		updatedAt: new Date().toISOString(),
		stats: {
			...options.status.stats,
			...patch.stats,
		},
	};
	options.onStatus(options.status);
}

function samePath(left: string | undefined, right: string | undefined): boolean {
	if (!left || !right) return false;
	return left.replace(/\\/g, "/").toLowerCase() === right.replace(/\\/g, "/").toLowerCase();
}

function timestampFromEntry(entry: SessionEntry): number {
	const entryTime = new Date(entry.timestamp).getTime();
	if (entry.type === "message" && typeof entry.message.timestamp === "number") {
		return entry.message.timestamp;
	}
	return Number.isFinite(entryTime) ? entryTime : Date.now();
}

function dateFromSession(info: SessionInfo, entries: SessionEntry[]): string {
	const firstMessage = entries.find((entry) => entry.type === "message");
	const time = firstMessage ? timestampFromEntry(firstMessage) : info.modified.getTime();
	const date = new Date(time);
	if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
	return date.toISOString().slice(0, 10);
}

function redactSensitive(text: string): string {
	return text
		.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]")
		.replace(/\b(?:sk|pk|rk|ghp|github_pat|xox[baprs])-?[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_TOKEN]")
		.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[REDACTED_EMAIL]")
		.replace(
			/(?i:api[_-]?key|token|secret|password|passwd|authorization|bearer)(["'`\s:=]+)([A-Za-z0-9._~+\-/=]{8,})/g,
			"$1[REDACTED_SECRET]",
		)
		.replace(/Bearer\s+[A-Za-z0-9._~+\-/=]{12,}/gi, "Bearer [REDACTED_TOKEN]");
}

function truncateText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n[...${text.length - maxChars} chars truncated]`;
}

function extractTextContent(content: unknown, options: { includeThinking?: boolean } = {}): string {
	if (typeof content === "string") return redactSensitive(content);
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		if ("type" in block && block.type === "text" && "text" in block && typeof block.text === "string") {
			parts.push(block.text);
		}
		if (
			options.includeThinking &&
			"type" in block &&
			block.type === "thinking" &&
			"thinking" in block &&
			typeof block.thinking === "string"
		) {
			parts.push(block.thinking);
		}
	}
	return redactSensitive(parts.join("\n"));
}

function summarizeToolCall(name: string, args: Record<string, unknown>): string {
	const renderedArgs = JSON.stringify(args, (_key, value: unknown) => {
		if (typeof value === "string") return truncateText(redactSensitive(value), MAX_TOOL_ARG_CHARS);
		return value;
	});
	return `tool:${name} ${truncateText(renderedArgs, MAX_TOOL_ARG_CHARS)}`;
}

function extractToolCalls(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	const calls: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		if (!("type" in block) || block.type !== "toolCall" || !("name" in block) || typeof block.name !== "string")
			continue;
		const args =
			"arguments" in block &&
			block.arguments &&
			typeof block.arguments === "object" &&
			!Array.isArray(block.arguments)
				? (block.arguments as Record<string, unknown>)
				: {};
		calls.push(summarizeToolCall(block.name, args));
	}
	return calls;
}

function shouldSkipUserText(text: string): boolean {
	const trimmed = text.trim();
	return trimmed.startsWith("The conversation history before this point was compacted into the following summary:");
}

function extractTurns(entries: SessionEntry[]): SessionTurn[] {
	const turns: SessionTurn[] = [];
	let current: SessionTurn | undefined;

	for (const entry of entries) {
		if (entry.type === "compaction" || entry.type === "branch_summary") {
			const summaryText = redactSensitive(entry.summary.trim());
			if (summaryText) {
				turns.push({
					id: entry.id,
					startedAt: entry.timestamp,
					user: entry.type === "compaction" ? "[历史压缩摘要]" : "[分支摘要]",
					assistant: truncateText(summaryText, 3000),
					toolCalls: [],
					toolResults: [],
				});
			}
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "user") {
			const user = truncateText(extractTextContent(message.content), 6000).trim();
			if (!user || shouldSkipUserText(user)) continue;
			current = {
				id: entry.id,
				startedAt: entry.timestamp,
				user,
				assistant: "",
				toolCalls: [],
				toolResults: [],
			};
			turns.push(current);
			continue;
		}
		if (!current) continue;
		if (message.role === "assistant") {
			const assistantText = truncateText(extractTextContent(message.content), 6000).trim();
			if (assistantText) {
				current.assistant = current.assistant ? `${current.assistant}\n${assistantText}` : assistantText;
			}
			current.toolCalls.push(...extractToolCalls(message.content));
			continue;
		}
		if (message.role === "toolResult") {
			const resultText = truncateText(extractTextContent(message.content), MAX_TOOL_RESULT_CHARS).trim();
			if (resultText) {
				current.toolResults.push(`result:${message.toolName}${message.isError ? " error" : ""} ${resultText}`);
			}
		}
	}

	return turns
		.filter((turn) => turn.user || turn.assistant || turn.toolCalls.length > 0 || turn.toolResults.length > 0)
		.slice(-MAX_TURNS);
}

function renderTurns(turns: SessionTurn[]): string {
	return turns
		.map((turn, index) => {
			const lines = [`### Turn ${index + 1} · ${turn.startedAt}`, "", `[User]\n${turn.user}`];
			if (turn.assistant) lines.push("", `[Assistant]\n${turn.assistant}`);
			if (turn.toolCalls.length > 0) lines.push("", `[Tool calls]\n${turn.toolCalls.join("\n")}`);
			if (turn.toolResults.length > 0) lines.push("", `[Tool results]\n${turn.toolResults.join("\n")}`);
			return lines.join("\n");
		})
		.join("\n\n");
}

function buildDigest(session: NormalizedSession): SessionDigest | undefined {
	const turns = extractTurns(session.entries);
	if (turns.length === 0) return undefined;
	const date = dateFromSession(session.info, session.entries);
	const renderedTurns = truncateText(renderTurns(turns), MAX_TEXT_CHARS);
	const created = Number.isNaN(session.info.created.getTime())
		? session.headerTimestamp
		: session.info.created.toISOString();
	const modified = Number.isNaN(session.info.modified.getTime())
		? new Date().toISOString()
		: session.info.modified.toISOString();
	const text = [
		`# Session ${session.info.id}`,
		"",
		`- Path: ${session.info.path}`,
		`- CWD: ${session.info.cwd || "(unknown)"}`,
		`- Created: ${created ?? "(unknown)"}`,
		`- Modified: ${modified}`,
		"",
		renderedTurns,
	].join("\n");
	return {
		sessionPath: session.info.path,
		sessionId: session.info.id,
		cwd: session.info.cwd,
		date,
		modified,
		turns,
		text,
		hash: shortHash(text),
	};
}

async function getFileFingerprint(filePath: string): Promise<{ mtimeMs: number; size: number }> {
	const stat = await fs.stat(filePath);
	return { mtimeMs: stat.mtimeMs, size: stat.size };
}

function isAlreadyProcessed(
	checkpoint: YourselfCheckpoint,
	info: SessionInfo,
	fingerprint: { mtimeMs: number; size: number },
): boolean {
	const existing = checkpoint.sessions[info.path];
	return (
		existing?.status === "processed" && existing.mtimeMs === fingerprint.mtimeMs && existing.size === fingerprint.size
	);
}

type RawSessionEntry = Record<string, unknown> & {
	type: string;
	id?: string;
	parentId?: string | null;
	timestamp?: string;
};

function isRawSessionEntry(value: unknown): value is RawSessionEntry {
	return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
}

function normalizeRawEntry(entry: RawSessionEntry, index: number, previousId: string | null): SessionEntry {
	const id = typeof entry.id === "string" && entry.id ? entry.id : `line-${index}`;
	const parentId = entry.parentId === null || typeof entry.parentId === "string" ? entry.parentId : previousId;
	const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : new Date().toISOString();
	return { ...entry, id, parentId, timestamp } as SessionEntry;
}

function getActiveBranch(entries: SessionEntry[]): SessionEntry[] {
	if (entries.length === 0) return [];
	const hasStructuredParents = entries.every((entry) => typeof entry.id === "string" && "parentId" in entry);
	if (!hasStructuredParents) return entries;

	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const branch: SessionEntry[] = [];
	let current: SessionEntry | undefined = entries[entries.length - 1];
	const seen = new Set<string>();
	while (current && !seen.has(current.id)) {
		seen.add(current.id);
		branch.unshift(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	return branch;
}

async function openSession(info: SessionInfo): Promise<NormalizedSession> {
	const parsed = (await fs.readFile(info.path, "utf-8"))
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => {
			try {
				return JSON.parse(line) as unknown;
			} catch {
				return undefined;
			}
		})
		.filter((entry): entry is RawSessionEntry => isRawSessionEntry(entry));
	const header = parsed.find((entry) => entry.type === "session");
	let previousId: string | null = null;
	const entries = parsed
		.filter((entry) => entry.type !== "session")
		.map((entry, index) => {
			const normalized = normalizeRawEntry(entry, index, previousId);
			previousId = normalized.id;
			return normalized;
		});
	return {
		info,
		entries: getActiveBranch(entries),
		headerTimestamp: typeof header?.timestamp === "string" ? header.timestamp : undefined,
	};
}

function abortIfNeeded(signal: AbortSignal): void {
	if (signal.aborted) throw new Error("YOURSELF scan aborted");
}

export async function runYourselfWorker(ctx: ExtensionContext, options: YourselfWorkerOptions): Promise<void> {
	const checkpoint = await loadCheckpoint(options.outputDir);
	try {
		updateStatus(options, { status: "scanning", message: "Scanning global sessions" });
		let loaded = 0;
		let total = 0;
		const sessions = await SessionManager.listAll((nextLoaded, nextTotal) => {
			loaded = nextLoaded;
			total = nextTotal;
			updateStatus(options, {
				status: "scanning",
				message: `Scanning sessions ${loaded}/${total}`,
				stats: { totalSessions: nextTotal },
			});
		});
		updateStatus(options, {
			status: "summarizing",
			message: `Found ${sessions.length} sessions`,
			stats: { totalSessions: sessions.length },
		});

		for (const info of sessions) {
			abortIfNeeded(options.signal);
			await touchLock(options.outputDir);
			updateStatus(options, {
				status: "summarizing",
				currentSession: info.path,
				message: `${options.status.stats.processedSessions}/${options.status.stats.totalSessions} processed`,
			});

			let fingerprint: { mtimeMs: number; size: number };
			try {
				fingerprint = await getFileFingerprint(info.path);
			} catch (error) {
				checkpoint.sessions[info.path] = {
					path: info.path,
					id: info.id,
					status: "failed",
					error: error instanceof Error ? error.message : String(error),
					processedAt: new Date().toISOString(),
				};
				updateStatus(options, { stats: { failedSessions: options.status.stats.failedSessions + 1 } });
				await saveCheckpoint(checkpoint, options.outputDir);
				continue;
			}

			if (samePath(info.path, options.currentSessionFile)) {
				if (isAlreadyProcessed(checkpoint, info, fingerprint)) {
					updateStatus(options, { stats: { processedSessions: options.status.stats.processedSessions + 1 } });
					continue;
				}

				checkpoint.sessions[info.path] = {
					path: info.path,
					id: info.id,
					mtimeMs: fingerprint.mtimeMs,
					size: fingerprint.size,
					status: "skipped",
					reason: "current session",
					processedAt: new Date().toISOString(),
				};
				updateStatus(options, { stats: { skippedSessions: options.status.stats.skippedSessions + 1 } });
				await saveCheckpoint(checkpoint, options.outputDir);
				continue;
			}

			if (isAlreadyProcessed(checkpoint, info, fingerprint)) {
				updateStatus(options, { stats: { processedSessions: options.status.stats.processedSessions + 1 } });
				continue;
			}

			try {
				const normalizedSession = await openSession(info);
				const digest = buildDigest(normalizedSession);
				if (!digest) {
					checkpoint.sessions[info.path] = {
						path: info.path,
						id: info.id,
						mtimeMs: fingerprint.mtimeMs,
						size: fingerprint.size,
						status: "skipped",
						reason: "no summarizable turns",
						processedAt: new Date().toISOString(),
					};
					updateStatus(options, { stats: { skippedSessions: options.status.stats.skippedSessions + 1 } });
					await saveCheckpoint(checkpoint, options.outputDir);
					continue;
				}

				if (await hasSummaryMarker(digest, options.outputDir)) {
					checkpoint.sessions[info.path] = {
						path: info.path,
						id: info.id,
						mtimeMs: fingerprint.mtimeMs,
						size: fingerprint.size,
						status: "processed",
						summaryHashes: [digest.hash],
						processedAt: new Date().toISOString(),
					};
					updateStatus(options, { stats: { processedSessions: options.status.stats.processedSessions + 1 } });
					await saveCheckpoint(checkpoint, options.outputDir);
					continue;
				}

				const summarizerResult = await summarizeDigest(ctx, digest, options.signal);
				const summary: YourselfSummary = {
					date: digest.date,
					sessionPath: digest.sessionPath,
					sessionId: digest.sessionId,
					cwd: digest.cwd,
					hash: digest.hash,
					content: summarizerResult.content,
					createdAt: new Date().toISOString(),
					model:
						summarizerResult.via === "direct-mimo"
							? `${YOURSELF_MODEL_REF} (direct fallback)`
							: summarizerResult.model,
				};

				updateStatus(options, {
					status: "writing",
					currentSession: info.path,
					message: `Writing ${summary.date}.md`,
				});
				const writeResult = await writeSummary(summary, options.outputDir);
				checkpoint.sessions[info.path] = {
					path: info.path,
					id: info.id,
					mtimeMs: fingerprint.mtimeMs,
					size: fingerprint.size,
					status: "processed",
					summaryHashes: [digest.hash, hashText(summarizerResult.content).slice(0, 16)],
					processedAt: new Date().toISOString(),
				};
				updateStatus(options, {
					status: "summarizing",
					stats: {
						processedSessions: options.status.stats.processedSessions + 1,
						writtenSummaries: options.status.stats.writtenSummaries + (writeResult.written ? 1 : 0),
					},
				});
				await saveCheckpoint(checkpoint, options.outputDir);
			} catch (error) {
				checkpoint.sessions[info.path] = {
					path: info.path,
					id: info.id,
					mtimeMs: fingerprint.mtimeMs,
					size: fingerprint.size,
					status: "failed",
					error: error instanceof Error ? error.message : String(error),
					processedAt: new Date().toISOString(),
				};
				updateStatus(options, {
					status: "summarizing",
					lastError: error instanceof Error ? error.message : String(error),
					stats: { failedSessions: options.status.stats.failedSessions + 1 },
				});
				await saveCheckpoint(checkpoint, options.outputDir);
			}
		}

		updateStatus(options, { status: "complete", currentSession: undefined, message: "YOURSELF scan complete" });
	} catch (error) {
		if (options.signal.aborted) {
			updateStatus(options, { status: "stopped", message: "YOURSELF scan stopped" });
			return;
		}
		updateStatus(options, {
			status: "error",
			lastError: error instanceof Error ? error.message : String(error),
			message: "YOURSELF scan failed",
		});
	} finally {
		await saveCheckpoint(checkpoint, options.outputDir);
		await releaseLock(options.outputDir);
	}
}
