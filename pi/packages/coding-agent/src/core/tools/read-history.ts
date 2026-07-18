import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { resolveToCwd } from "./path-utils.ts";
import { normalizeForApproximateMatch, normalizeForFuzzyMatch } from "./text-match-utils.ts";

export interface ReadHistoryEntry {
	toolCallId: string;
	source: "read" | "observed";
	requestedPath: string;
	canonicalPath: string;
	startLine: number;
	endLine: number;
	text: string;
	normalizedText: string;
	fuzzyText: string;
	approximateText: string;
	contentHash: string;
	timestamp: number;
}

export interface ReadHistoryStore {
	record(entry: ReadHistoryEntry): void;
	getByCanonicalPath(canonicalPath: string): ReadHistoryEntry[];
	findPathCandidates(requestedPath: string, options?: ReadHistoryPathCandidateOptions): ReadHistoryPathCandidate[];
	clear(): void;
}

export interface ReadHistoryPathCandidateOptions {
	sources?: ReadonlyArray<ReadHistoryEntry["source"]>;
}

export interface ReadHistoryPathCandidate {
	canonicalPath: string;
	score: number;
	reasons: string[];
	lastReadTimestamp: number;
	/** The originally requested path from the best matching read history entry. */
	entryRequestedPath: string;
}

export interface ReadHistoryPathRecovery {
	resolvedPath: string;
	candidates: ReadonlyArray<ReadHistoryPathCandidate>;
	autoRecovered: boolean;
}

const MAX_READ_HISTORY_ENTRIES = 200;
const MAX_OBSERVED_PATHS_PER_TEXT = 80;
const ANSI_ESCAPE_PATTERN = /\x1B\[[0-?]*[ -/]*[@-~]/g;

class InMemoryReadHistoryStore implements ReadHistoryStore {
	private entries: ReadHistoryEntry[] = [];

	record(entry: ReadHistoryEntry): void {
		this.entries.push(entry);
		if (this.entries.length > MAX_READ_HISTORY_ENTRIES) {
			this.entries.splice(0, this.entries.length - MAX_READ_HISTORY_ENTRIES);
		}
	}

	getByCanonicalPath(canonicalPath: string): ReadHistoryEntry[] {
		return this.entries.filter((entry) => entry.canonicalPath === canonicalPath);
	}

	findPathCandidates(requestedPath: string, options?: ReadHistoryPathCandidateOptions): ReadHistoryPathCandidate[] {
		const grouped = new Map<string, ReadHistoryPathCandidate>();
		const allowedSources = options?.sources ? new Set(options.sources) : undefined;
		const normalizedRequested = normalizePathForComparison(requestedPath);
		const requestedSegments = normalizedRequested.split("/").filter(Boolean);
		const requestedBasename = requestedSegments.at(-1) ?? normalizedRequested;
		const requestedSuffix = requestedSegments.slice(-3).join("/");

		for (const entry of this.entries) {
			if (allowedSources && !allowedSources.has(entry.source)) continue;
			const normalizedCandidate = normalizePathForComparison(entry.canonicalPath);
			const candidateSegments = normalizedCandidate.split("/").filter(Boolean);
			const candidateBasename = candidateSegments.at(-1) ?? normalizedCandidate;
			const candidateSuffix = candidateSegments.slice(-3).join("/");

			let score = 0;
			const reasons: string[] = [];
			if (candidateBasename === requestedBasename) {
				score += 0.55;
				reasons.push(`same basename (${candidateBasename})`);
			}
			if (candidateSuffix.length > 0 && candidateSuffix === requestedSuffix) {
				score += 0.35;
				reasons.push("same path suffix");
			}
			const pathSimilarity =
				normalizedCandidate === normalizedRequested
					? 1
					: normalizedSimilarity(normalizedRequested, normalizedCandidate);
			if (pathSimilarity >= 0.75) {
				score += Math.min(0.3, pathSimilarity * 0.3);
				reasons.push(`path similarity ${pathSimilarity.toFixed(2)}`);
			}
			if (score <= 0) continue;

			const existing = grouped.get(entry.canonicalPath);
			if (!existing || score > existing.score || entry.timestamp > existing.lastReadTimestamp) {
				grouped.set(entry.canonicalPath, {
					canonicalPath: entry.canonicalPath,
					score,
					reasons,
					lastReadTimestamp: entry.timestamp,
					entryRequestedPath: entry.requestedPath,
				});
			}
		}

		return [...grouped.values()].sort((a, b) => {
			if (b.score !== a.score) return b.score - a.score;
			return b.lastReadTimestamp - a.lastReadTimestamp;
		});
	}

	clear(): void {
		this.entries = [];
	}
}

const readHistoryBySessionId = new Map<string, ReadHistoryStore>();

export function getReadHistoryStore(sessionId: string): ReadHistoryStore {
	let store = readHistoryBySessionId.get(sessionId);
	if (!store) {
		store = new InMemoryReadHistoryStore();
		readHistoryBySessionId.set(sessionId, store);
	}
	return store;
}

export function cleanupReadHistoryStore(sessionId: string): void {
	readHistoryBySessionId.delete(sessionId);
}

export function buildReadHistoryEntry(params: {
	toolCallId: string;
	requestedPath: string;
	canonicalPath: string;
	text: string;
	startLine: number;
	endLine: number;
	timestamp?: number;
}): ReadHistoryEntry {
	const normalizedText = normalizeToLF(params.text);
	return {
		toolCallId: params.toolCallId,
		source: "read",
		requestedPath: params.requestedPath,
		canonicalPath: params.canonicalPath,
		startLine: params.startLine,
		endLine: params.endLine,
		text: params.text,
		normalizedText,
		fuzzyText: normalizeForFuzzyMatch(normalizedText),
		approximateText: normalizeForApproximateMatch(normalizedText, { stripTrailingDelimiters: true }),
		contentHash: hashText(normalizedText),
		timestamp: params.timestamp ?? Date.now(),
	};
}

export function buildObservedPathHistoryEntry(params: {
	toolCallId: string;
	canonicalPath: string;
	requestedPath?: string;
	timestamp?: number;
}): ReadHistoryEntry {
	return {
		toolCallId: params.toolCallId,
		source: "observed",
		requestedPath: params.requestedPath ?? params.canonicalPath,
		canonicalPath: params.canonicalPath,
		startLine: 0,
		endLine: 0,
		text: "",
		normalizedText: "",
		fuzzyText: "",
		approximateText: "",
		contentHash: "",
		timestamp: params.timestamp ?? Date.now(),
	};
}

export function resolvePathWithHistory(
	path: string,
	cwd: string,
	readHistoryStore?: ReadHistoryStore,
	options?: ReadHistoryPathCandidateOptions,
): ReadHistoryPathRecovery {
	const absolutePath = resolveToCwd(path, cwd);
	const candidates = readHistoryStore?.findPathCandidates(path, options) ?? [];
	if (candidates.length === 0) {
		return { resolvedPath: absolutePath, candidates, autoRecovered: false };
	}

	const [best, second] = candidates;
	if (best) {
		const entryBasename = best.entryRequestedPath.replace(/\\/g, "/").split("/").at(-1) ?? "";
		const requestBasename = path.replace(/\\/g, "/").split("/").at(-1) ?? "";
		const basenamesMatch = entryBasename === requestBasename;
		const strongScore = best.score >= 0.85;
		const gapOk = !second || best.score - second.score >= 0.15;
		if (gapOk && (strongScore || basenamesMatch)) {
			return {
				resolvedPath: best.canonicalPath,
				candidates,
				autoRecovered: true,
			};
		}
	}

	return { resolvedPath: absolutePath, candidates, autoRecovered: false };
}

export async function recordObservedFilePathsFromText(params: {
	store: ReadHistoryStore | undefined;
	toolCallId: string;
	text: string;
	cwd: string;
}): Promise<number> {
	if (!params.store || !params.text.trim()) return 0;
	const seen = new Set<string>();
	let recorded = 0;
	for (const rawCandidate of extractPathCandidatesFromText(params.text)) {
		if (recorded >= MAX_OBSERVED_PATHS_PER_TEXT) break;
		for (const candidate of expandCandidateVariants(rawCandidate)) {
			const canonicalPath = resolveToCwd(candidate, params.cwd);
			const key = normalizePathForComparison(canonicalPath);
			if (seen.has(key)) continue;
			seen.add(key);
			if (!(await isReadableFile(canonicalPath))) continue;
			params.store.record(
				buildObservedPathHistoryEntry({
					toolCallId: params.toolCallId,
					requestedPath: rawCandidate,
					canonicalPath,
				}),
			);
			recorded++;
			break;
		}
	}
	return recorded;
}

export function hashText(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function normalizePathForComparison(path: string): string {
	return path.replace(/\\/g, "/").toLowerCase();
}

function stripAnsi(text: string): string {
	return text.replace(ANSI_ESCAPE_PATTERN, "");
}

function extractPathCandidatesFromText(text: string): string[] {
	const candidates: string[] = [];
	const push = (value: string | undefined) => {
		const cleaned = cleanPathCandidate(value);
		if (cleaned) candidates.push(cleaned);
	};

	for (const rawLine of stripAnsi(text).split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;

		for (const match of line.matchAll(/[A-Za-z]:[\\/][^\r\n"'`<>|]*/g)) {
			push(match[0]);
		}

		const grepMatch = line.match(/^(.+?)(?::\d+(?::|-)\s)/);
		if (grepMatch) push(grepMatch[1]);

		if (looksLikeStandalonePath(line)) push(line);
	}

	return candidates;
}

function looksLikeStandalonePath(value: string): boolean {
	if (/^[A-Za-z]:[\\/]/.test(value)) return true;
	if (value.startsWith("./") || value.startsWith("../") || value.startsWith(".\\")) return true;
	if (!/[\\/]/.test(value)) return false;
	return /\.[A-Za-z0-9]{1,12}(?::\d+)?$/.test(value);
}

function cleanPathCandidate(value: string | undefined): string | undefined {
	if (!value) return undefined;
	let cleaned = value.trim();
	cleaned = cleaned.replace(/^[`"'(<[]+/, "").replace(/[`"',;:)>\\\]]+$/g, "");
	cleaned = cleaned.replace(/:\d+(?::|-)?$/, "");
	if (!cleaned || cleaned === "." || cleaned === "..") return undefined;
	return cleaned;
}

function expandCandidateVariants(value: string): string[] {
	const variants = [value];
	for (const part of value.split(/\s{2,}/)) {
		const cleaned = cleanPathCandidate(part);
		if (cleaned && cleaned !== value) variants.push(cleaned);
	}
	if (/\s/.test(value)) {
		const firstToken = cleanPathCandidate(value.split(/\s+/, 1)[0]);
		if (firstToken && firstToken !== value) variants.push(firstToken);
	}
	return variants;
}

async function isReadableFile(filePath: string): Promise<boolean> {
	try {
		return (await stat(filePath)).isFile();
	} catch {
		return false;
	}
}

function normalizedSimilarity(a: string, b: string): number {
	const maxLength = Math.max(a.length, b.length);
	if (maxLength === 0) return 1;
	const distance = levenshteinDistance(a, b);
	return 1 - distance / maxLength;
}

function levenshteinDistance(a: string, b: string): number {
	const rows = a.length + 1;
	const cols = b.length + 1;
	const matrix = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));

	for (let i = 0; i < rows; i++) matrix[i][0] = i;
	for (let j = 0; j < cols; j++) matrix[0][j] = j;

	for (let i = 1; i < rows; i++) {
		for (let j = 1; j < cols; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
		}
	}

	return matrix[rows - 1][cols - 1];
}
