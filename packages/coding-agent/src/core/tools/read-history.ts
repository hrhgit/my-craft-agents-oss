import { createHash } from "node:crypto";
import { normalizeForApproximateMatch, normalizeForFuzzyMatch } from "./text-match-utils.js";

export interface ReadHistoryEntry {
	toolCallId: string;
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
	findPathCandidates(requestedPath: string): ReadHistoryPathCandidate[];
	clear(): void;
}

export interface ReadHistoryPathCandidate {
	canonicalPath: string;
	score: number;
	reasons: string[];
	lastReadTimestamp: number;
	/** The originally requested path from the best matching read history entry. */
	entryRequestedPath: string;
}

const MAX_READ_HISTORY_ENTRIES = 80;

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

	findPathCandidates(requestedPath: string): ReadHistoryPathCandidate[] {
		const grouped = new Map<string, ReadHistoryPathCandidate>();
		const normalizedRequested = normalizePathForComparison(requestedPath);
		const requestedSegments = normalizedRequested.split("/").filter(Boolean);
		const requestedBasename = requestedSegments.at(-1) ?? normalizedRequested;
		const requestedSuffix = requestedSegments.slice(-3).join("/");

		for (const entry of this.entries) {
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

export function hashText(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function normalizePathForComparison(path: string): string {
	return path.replace(/\\/g, "/").toLowerCase();
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
