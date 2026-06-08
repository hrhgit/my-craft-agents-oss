import { stat } from "node:fs/promises";
import path from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { resolveToCwd } from "./path-utils.ts";

export const DEFAULT_READ_DEDUP_DISTANCE_CHARS = 2000;
export const DEFAULT_SEARCH_DEDUP_DISTANCE_CHARS = 2000;

export interface FileFingerprint {
	size: number;
	mtimeMs: number;
}

export interface ToolDeduplicationDetails {
	deduped: true;
	sourceToolCallId: string;
	distanceChars: number;
	coveredRange?: {
		startLine: number;
		endLine: number;
	};
}

export interface ToolDedupStore {
	startUserTurn(turnId: string, initialChars?: number): void;
	advanceContextChars(chars: number): void;
	noteMessageContent(content: string | Array<TextContent | ImageContent>): void;
	noteAssistantContent(
		content: ReadonlyArray<{ type: string; text?: string; thinking?: string; name?: string; arguments?: unknown }>,
	): void;
	noteToolCallStart(toolCallId: string): void;
	findReadHit(params: {
		toolCallId: string;
		canonicalPath: string;
		fingerprint: FileFingerprint;
		startLine: number;
		endLine?: number;
		requestKey: string;
		maxDistanceChars?: number;
	}): ReadDedupHit | undefined;
	recordRead(params: {
		toolCallId: string;
		canonicalPath: string;
		fingerprint: FileFingerprint;
		startLine: number;
		coveredEndLine: number;
		coveredToEnd: boolean;
		requestKey: string;
		text: string;
		resultContent: ReadonlyArray<TextContent | ImageContent>;
	}): void;
	findSearchHit(params: { toolCallId: string; key: string; maxDistanceChars?: number }): SearchDedupHit | undefined;
	recordSearch(params: {
		toolCallId: string;
		key: string;
		scopePath: string;
		resultContent: ReadonlyArray<TextContent | ImageContent>;
	}): void;
	recordSyntheticResult(toolCallId: string, content: ReadonlyArray<TextContent | ImageContent>): void;
	noteToolResultContent(toolCallId: string, content: ReadonlyArray<TextContent | ImageContent>): void;
	invalidatePath(canonicalPath: string): void;
	clear(): void;
}

export interface ReadDedupHit {
	details: ToolDeduplicationDetails;
	text?: string;
	sourceToolCallId: string;
}

export interface SearchDedupHit {
	details: ToolDeduplicationDetails;
	sourceToolCallId: string;
}

interface ReadCacheEntry {
	toolCallId: string;
	turnId: string;
	canonicalPath: string;
	fingerprint: FileFingerprint;
	startLine: number;
	coveredEndLine: number;
	coveredToEnd: boolean;
	requestKey: string;
	text: string;
	resultEndChar: number;
}

interface SearchCacheEntry {
	toolCallId: string;
	turnId: string;
	key: string;
	scopePath: string;
	resultEndChar: number;
}

const MAX_READ_CACHE_ENTRIES = 80;
const MAX_SEARCH_CACHE_ENTRIES = 80;
const toolDedupStoresBySessionId = new Map<string, ToolDedupStore>();

class InMemoryToolDedupStore implements ToolDedupStore {
	private turnId = "";
	private contextCharCursor = 0;
	private readEntries: ReadCacheEntry[] = [];
	private searchEntries: SearchCacheEntry[] = [];
	private toolCallStartChars = new Map<string, number>();
	private recordedResultToolCallIds = new Set<string>();

	startUserTurn(turnId: string, initialChars = 0): void {
		this.turnId = turnId;
		this.contextCharCursor = Math.max(0, initialChars);
		this.readEntries = [];
		this.searchEntries = [];
		this.toolCallStartChars.clear();
		this.recordedResultToolCallIds.clear();
	}

	advanceContextChars(chars: number): void {
		if (!Number.isFinite(chars) || chars <= 0) return;
		this.contextCharCursor += chars;
	}

	noteMessageContent(content: string | Array<TextContent | ImageContent>): void {
		this.advanceContextChars(countContentChars(content));
	}

	noteAssistantContent(
		content: ReadonlyArray<{ type: string; text?: string; thinking?: string; name?: string; arguments?: unknown }>,
	): void {
		this.advanceContextChars(countAssistantContentChars(content));
	}

	noteToolCallStart(toolCallId: string): void {
		this.toolCallStartChars.set(toolCallId, this.contextCharCursor);
	}

	findReadHit(params: {
		toolCallId: string;
		canonicalPath: string;
		fingerprint: FileFingerprint;
		startLine: number;
		endLine?: number;
		requestKey: string;
		maxDistanceChars?: number;
	}): ReadDedupHit | undefined {
		if (!this.turnId) return undefined;
		const callStartChar = this.toolCallStartChars.get(params.toolCallId) ?? this.contextCharCursor;
		const maxDistanceChars = params.maxDistanceChars ?? DEFAULT_READ_DEDUP_DISTANCE_CHARS;
		for (let i = this.readEntries.length - 1; i >= 0; i--) {
			const entry = this.readEntries[i];
			if (entry.turnId !== this.turnId) continue;
			if (entry.canonicalPath !== params.canonicalPath) continue;
			if (!sameFingerprint(entry.fingerprint, params.fingerprint)) continue;

			const distanceChars = callStartChar - entry.resultEndChar;
			if (distanceChars < 0 || distanceChars > maxDistanceChars) continue;

			if (entry.requestKey === params.requestKey) {
				return {
					sourceToolCallId: entry.toolCallId,
					details: {
						deduped: true,
						sourceToolCallId: entry.toolCallId,
						distanceChars,
						coveredRange: { startLine: entry.startLine, endLine: entry.coveredEndLine },
					},
				};
			}

			const requestedEndLine = params.endLine ?? (entry.coveredToEnd ? entry.coveredEndLine : undefined);
			if (
				requestedEndLine !== undefined &&
				params.startLine >= entry.startLine &&
				requestedEndLine <= entry.coveredEndLine
			) {
				return {
					sourceToolCallId: entry.toolCallId,
					text: sliceLineRange(entry.text, entry.startLine, params.startLine, requestedEndLine),
					details: {
						deduped: true,
						sourceToolCallId: entry.toolCallId,
						distanceChars,
						coveredRange: { startLine: params.startLine, endLine: requestedEndLine },
					},
				};
			}
		}
		return undefined;
	}

	recordRead(params: {
		toolCallId: string;
		canonicalPath: string;
		fingerprint: FileFingerprint;
		startLine: number;
		coveredEndLine: number;
		coveredToEnd: boolean;
		requestKey: string;
		text: string;
		resultContent: ReadonlyArray<TextContent | ImageContent>;
	}): void {
		if (!this.turnId) return;
		const resultEndChar = this.recordResultChars(params.toolCallId, params.resultContent);
		this.readEntries.push({
			toolCallId: params.toolCallId,
			turnId: this.turnId,
			canonicalPath: params.canonicalPath,
			fingerprint: params.fingerprint,
			startLine: params.startLine,
			coveredEndLine: params.coveredEndLine,
			coveredToEnd: params.coveredToEnd,
			requestKey: params.requestKey,
			text: params.text,
			resultEndChar,
		});
		if (this.readEntries.length > MAX_READ_CACHE_ENTRIES) {
			this.readEntries.splice(0, this.readEntries.length - MAX_READ_CACHE_ENTRIES);
		}
	}

	findSearchHit(params: { toolCallId: string; key: string; maxDistanceChars?: number }): SearchDedupHit | undefined {
		if (!this.turnId) return undefined;
		const callStartChar = this.toolCallStartChars.get(params.toolCallId) ?? this.contextCharCursor;
		const maxDistanceChars = params.maxDistanceChars ?? DEFAULT_SEARCH_DEDUP_DISTANCE_CHARS;
		for (let i = this.searchEntries.length - 1; i >= 0; i--) {
			const entry = this.searchEntries[i];
			if (entry.turnId !== this.turnId) continue;
			if (entry.key !== params.key) continue;
			const distanceChars = callStartChar - entry.resultEndChar;
			if (distanceChars < 0 || distanceChars > maxDistanceChars) continue;
			return {
				sourceToolCallId: entry.toolCallId,
				details: {
					deduped: true,
					sourceToolCallId: entry.toolCallId,
					distanceChars,
				},
			};
		}
		return undefined;
	}

	recordSearch(params: {
		toolCallId: string;
		key: string;
		scopePath: string;
		resultContent: ReadonlyArray<TextContent | ImageContent>;
	}): void {
		if (!this.turnId) return;
		const resultEndChar = this.recordResultChars(params.toolCallId, params.resultContent);
		this.searchEntries.push({
			toolCallId: params.toolCallId,
			turnId: this.turnId,
			key: params.key,
			scopePath: params.scopePath,
			resultEndChar,
		});
		if (this.searchEntries.length > MAX_SEARCH_CACHE_ENTRIES) {
			this.searchEntries.splice(0, this.searchEntries.length - MAX_SEARCH_CACHE_ENTRIES);
		}
	}

	recordSyntheticResult(_toolCallId: string, content: ReadonlyArray<TextContent | ImageContent>): void {
		this.recordResultChars(_toolCallId, content);
	}

	noteToolResultContent(toolCallId: string, content: ReadonlyArray<TextContent | ImageContent>): void {
		if (this.recordedResultToolCallIds.has(toolCallId)) return;
		this.recordResultChars(toolCallId, content);
	}

	invalidatePath(canonicalPath: string): void {
		const normalizedPath = normalizePathForKey(canonicalPath);
		this.readEntries = this.readEntries.filter(
			(entry) => normalizePathForKey(entry.canonicalPath) !== normalizedPath,
		);
		this.searchEntries = this.searchEntries.filter(
			(entry) => !isPathWithinScope(normalizedPath, normalizePathForKey(entry.scopePath)),
		);
	}

	clear(): void {
		this.turnId = "";
		this.contextCharCursor = 0;
		this.readEntries = [];
		this.searchEntries = [];
		this.toolCallStartChars.clear();
		this.recordedResultToolCallIds.clear();
	}

	private recordResultChars(toolCallId: string, content: ReadonlyArray<TextContent | ImageContent>): number {
		this.advanceContextChars(countContentChars([...content]));
		this.recordedResultToolCallIds.add(toolCallId);
		return this.contextCharCursor;
	}
}

export function getToolDedupStore(sessionId: string): ToolDedupStore {
	let store = toolDedupStoresBySessionId.get(sessionId);
	if (!store) {
		store = new InMemoryToolDedupStore();
		toolDedupStoresBySessionId.set(sessionId, store);
	}
	return store;
}

export function createToolDedupStoreForTesting(): ToolDedupStore {
	return new InMemoryToolDedupStore();
}

export function cleanupToolDedupStore(sessionId: string): void {
	toolDedupStoresBySessionId.delete(sessionId);
}

export async function getFileFingerprint(filePath: string): Promise<FileFingerprint | undefined> {
	try {
		const fileStat = await stat(filePath);
		if (!fileStat.isFile()) return undefined;
		return { size: fileStat.size, mtimeMs: fileStat.mtimeMs };
	} catch {
		return undefined;
	}
}

export function buildReadDedupRequestKey(input: { path: string; offset?: number; limit?: number }): string {
	return stableStringify({
		tool: "read",
		path: normalizePathForKey(input.path),
		offset: input.offset ?? null,
		limit: input.limit ?? null,
	});
}

export function buildSearchDedupKey(
	toolName: "grep" | "find" | "ls",
	cwd: string,
	args: Record<string, unknown>,
): string {
	return stableStringify({
		tool: toolName,
		cwd: normalizePathForKey(cwd),
		args,
	});
}

export function formatDeduplicationNote(details: ToolDeduplicationDetails, message: string): string {
	const range = details.coveredRange
		? ` coveredRange=${details.coveredRange.startLine}-${details.coveredRange.endLine}`
		: "";
	return `[deduped=true sourceToolCallId=${details.sourceToolCallId} distanceChars=${details.distanceChars}${range}]\n${message}`;
}

export function findShellMutationPaths(command: string, cwd: string): string[] {
	const paths = new Set<string>();
	for (const rawPath of findRedirectionTargets(command)) {
		paths.add(resolveToCwd(rawPath, cwd));
	}
	for (const rawPath of findPowerShellPathArguments(command)) {
		paths.add(resolveToCwd(rawPath, cwd));
	}
	return [...paths];
}

function countContentChars(content: string | Array<TextContent | ImageContent>): number {
	if (typeof content === "string") return content.length;
	return content.reduce((sum, block) => {
		if (block.type === "text") return sum + block.text.length;
		return sum;
	}, 0);
}

function countAssistantContentChars(
	content: ReadonlyArray<{ type: string; text?: string; thinking?: string; name?: string; arguments?: unknown }>,
): number {
	let chars = 0;
	for (const block of content) {
		if (block.type === "text" && typeof block.text === "string") {
			chars += block.text.length;
		} else if (block.type === "thinking" && typeof block.thinking === "string") {
			chars += block.thinking.length;
		} else if (block.type === "toolCall") {
			chars += (block.name ?? "").length + stableStringify(block.arguments ?? {}).length;
		}
	}
	return chars;
}

function sameFingerprint(a: FileFingerprint, b: FileFingerprint): boolean {
	return a.size === b.size && a.mtimeMs === b.mtimeMs;
}

function sliceLineRange(text: string, textStartLine: number, startLine: number, endLine: number): string {
	const lines = text.split("\n");
	const startIndex = Math.max(0, startLine - textStartLine);
	const endIndex = Math.max(startIndex, endLine - textStartLine + 1);
	return lines.slice(startIndex, endIndex).join("\n");
}

function normalizePathForKey(value: string): string {
	const normalized = path.resolve(value);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isPathWithinScope(normalizedPath: string, normalizedScope: string): boolean {
	if (normalizedPath === normalizedScope) return true;
	const relativePath = path.relative(normalizedScope, normalizedPath);
	return relativePath !== "" && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

function stableStringify(value: unknown): string {
	if (value === undefined) return "undefined";
	if (typeof value === "function") return "[function]";
	if (typeof value === "symbol") return value.toString();
	if (typeof value === "bigint") return value.toString();
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value) ?? "undefined";
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableStringify(item)).join(",")}]`;
	}
	const record = value as Record<string, unknown>;
	const entries = Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
	return `{${entries.join(",")}}`;
}

function findRedirectionTargets(command: string): string[] {
	const paths: string[] = [];
	const pattern = /(?:^|[\s])(?:\d?>|>>)\s*("(?:[^"]+)"|'(?:[^']+)'|[^\s|&;]+)/g;
	for (const match of command.matchAll(pattern)) {
		const target = cleanShellPathToken(match[1]);
		if (target) paths.push(target);
	}
	return paths;
}

function findPowerShellPathArguments(command: string): string[] {
	const paths: string[] = [];
	const commandPattern = /\b(?:Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item)\b/gi;
	for (const segment of splitShellCommandSegments(command)) {
		if (!commandPattern.test(segment)) {
			commandPattern.lastIndex = 0;
			continue;
		}
		commandPattern.lastIndex = 0;
		const flagPattern = /(?:-Path|-LiteralPath|-FilePath|-Destination)\s+("(?:[^"]+)"|'(?:[^']+)'|[^\s|&;]+)/gi;
		for (const match of segment.matchAll(flagPattern)) {
			const target = cleanShellPathToken(match[1]);
			if (target && !target.startsWith("-")) paths.push(target);
		}

		const positionalPattern =
			/\b(?:Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item)\b\s+("(?:[^"]+)"|'(?:[^']+)'|[^\s|&;]+)/i;
		const positionalMatch = segment.match(positionalPattern);
		const positionalTarget = cleanShellPathToken(positionalMatch?.[1]);
		if (positionalTarget && !positionalTarget.startsWith("-")) {
			paths.push(positionalTarget);
		}
	}
	return paths;
}

function splitShellCommandSegments(command: string): string[] {
	const segments: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	for (const char of command) {
		if (quote) {
			current += char;
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			current += char;
			continue;
		}
		if (char === "|" || char === "&" || char === ";") {
			if (current.trim()) segments.push(current.trim());
			current = "";
			continue;
		}
		current += char;
	}
	if (current.trim()) segments.push(current.trim());
	return segments;
}

function cleanShellPathToken(token: string | undefined): string | undefined {
	if (!token) return undefined;
	const trimmed = token.trim();
	if (!trimmed) return undefined;
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}
