/**
 * Shared diff computation utilities for the edit tool.
 * Used by both edit.ts (for execution) and tool-execution.ts (for preview rendering).
 */

import * as Diff from "diff";
import { constants } from "fs";
import { access, readFile } from "fs/promises";
import type {
	ReadHistoryEntry,
	ReadHistoryPathCandidate,
	ReadHistoryPathRecovery,
	ReadHistoryStore,
} from "./read-history.ts";
import { resolvePathWithHistory } from "./read-history.ts";
import {
	diceCoefficient,
	lineDiceCoefficient,
	normalizeForApproximateMatch,
	normalizeForFuzzyMatch,
} from "./text-match-utils.ts";

export function detectLineEnding(content: string): "\r\n" | "\n" {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1) return "\n";
	if (crlfIdx === -1) return "\n";
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

export interface FuzzyMatchResult {
	found: boolean;
	index: number;
	matchLength: number;
	usedFuzzyMatch: boolean;
	contentForReplacement: string;
}

export interface Edit {
	oldText: string;
	newText: string;
}

interface MatchedEdit {
	editIndex: number;
	matchIndex: number;
	matchLength: number;
	newText: string;
}

export interface AppliedEditsResult {
	baseContent: string;
	newContent: string;
	appliedViaApproximateMatch: boolean;
}

export interface ApproximateMatchCandidate {
	startLine: number;
	endLine: number;
	score: number;
	lineScore: number;
	charScore: number;
	matchedText: string;
	reasons: string[];
}

export type EditPathRecovery = ReadHistoryPathRecovery;

export type EditFailureKind =
	| "path_not_found"
	| "exact_not_found"
	| "already_applied"
	| "duplicate_old_text"
	| "overlap"
	| "empty_old_text"
	| "no_change"
	| "invalid_edit_input";

export class EditFailure extends Error {
	readonly kind: EditFailureKind;
	readonly details?: {
		editIndex?: number;
		totalEdits?: number;
		occurrences?: number;
		approximateCandidate?: ApproximateMatchCandidate;
		readEvidence?: ReadHistoryEntry[];
		pathCandidates?: ReadonlyArray<ReadHistoryPathCandidate>;
	};

	constructor(kind: EditFailureKind, message: string, details?: EditFailure["details"]) {
		super(message);
		this.name = "EditFailure";
		this.kind = kind;
		this.details = details;
	}
}

const MIN_APPROXIMATE_OLD_TEXT_CHARS = 40;
const MIN_APPROXIMATE_OLD_TEXT_LINES = 2;
const MIN_APPROXIMATE_SCORE = 0.93;
const MIN_APPROXIMATE_GAP = 0.08;

/**
 * Find oldText in content, trying exact match first, then fuzzy match.
 * When fuzzy matching is used, the returned contentForReplacement is the
 * fuzzy-normalized version of the content.
 */
export function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
	const exactIndex = content.indexOf(oldText);
	if (exactIndex !== -1) {
		return {
			found: true,
			index: exactIndex,
			matchLength: oldText.length,
			usedFuzzyMatch: false,
			contentForReplacement: content,
		};
	}

	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);
	if (fuzzyIndex === -1) {
		return {
			found: false,
			index: -1,
			matchLength: 0,
			usedFuzzyMatch: false,
			contentForReplacement: content,
		};
	}

	return {
		found: true,
		index: fuzzyIndex,
		matchLength: fuzzyOldText.length,
		usedFuzzyMatch: true,
		contentForReplacement: fuzzyContent,
	};
}

export function stripBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

function countOccurrences(content: string, oldText: string): number {
	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	return fuzzyContent.split(fuzzyOldText).length - 1;
}

function getNotFoundError(
	path: string,
	editIndex: number,
	totalEdits: number,
	details?: EditFailure["details"],
): EditFailure {
	if (totalEdits === 1) {
		let message = `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`;
		if (details?.approximateCandidate) {
			message += ` A unique highly similar block exists at lines ${details.approximateCandidate.startLine}-${details.approximateCandidate.endLine} (score ${details.approximateCandidate.score.toFixed(2)}).`;
		}
		if (details?.readEvidence && details.readEvidence.length > 0) {
			const evidence = details.readEvidence[0];
			message += ` This text was previously read from lines ${evidence.startLine}-${evidence.endLine} in the same file.`;
		}
		return new EditFailure("exact_not_found", message, details);
	}
	let message = `Could not find edits[${editIndex}] in ${path}. The oldText must match exactly including all whitespace and newlines.`;
	if (details?.approximateCandidate) {
		message += ` A unique highly similar block exists at lines ${details.approximateCandidate.startLine}-${details.approximateCandidate.endLine} (score ${details.approximateCandidate.score.toFixed(2)}).`;
	}
	return new EditFailure("exact_not_found", message, { ...details, editIndex, totalEdits });
}

function getDuplicateError(path: string, editIndex: number, totalEdits: number, occurrences: number): EditFailure {
	if (totalEdits === 1) {
		return new EditFailure(
			"duplicate_old_text",
			`Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
			{ occurrences },
		);
	}
	return new EditFailure(
		"duplicate_old_text",
		`Found ${occurrences} occurrences of edits[${editIndex}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
		{ editIndex, totalEdits, occurrences },
	);
}

function getEmptyOldTextError(path: string, editIndex: number, totalEdits: number): EditFailure {
	if (totalEdits === 1) {
		return new EditFailure("empty_old_text", `oldText must not be empty in ${path}.`, { editIndex, totalEdits });
	}
	return new EditFailure("empty_old_text", `edits[${editIndex}].oldText must not be empty in ${path}.`, {
		editIndex,
		totalEdits,
	});
}

function getInvalidEditInputError(
	path: string,
	editIndex: number,
	totalEdits: number,
	field: "oldText" | "newText",
): EditFailure {
	if (totalEdits === 1) {
		return new EditFailure("invalid_edit_input", `${field} must be a string in ${path}.`, {
			editIndex,
			totalEdits,
		});
	}
	return new EditFailure("invalid_edit_input", `edits[${editIndex}].${field} must be a string in ${path}.`, {
		editIndex,
		totalEdits,
	});
}

function getNoChangeError(path: string, totalEdits: number, alreadyApplied = false): EditFailure {
	if (alreadyApplied) {
		return new EditFailure(
			"already_applied",
			`No changes made to ${path}. The requested replacement appears to be already applied.`,
		);
	}
	if (totalEdits === 1) {
		return new EditFailure(
			"no_change",
			`No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
		);
	}
	return new EditFailure("no_change", `No changes made to ${path}. The replacements produced identical content.`);
}

function getOverlapError(path: string, previousEditIndex: number, currentEditIndex: number): EditFailure {
	return new EditFailure(
		"overlap",
		`edits[${previousEditIndex}] and edits[${currentEditIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
		{ editIndex: currentEditIndex },
	);
}

function findReadEvidence(path: string, oldText: string, store?: ReadHistoryStore): ReadHistoryEntry[] {
	if (!store) return [];
	const normalizedOldText = normalizeToLF(oldText);
	const fuzzyOldText = normalizeForFuzzyMatch(normalizedOldText);
	return store
		.getByCanonicalPath(path)
		.filter((entry) => entry.source === "read" && entry.fuzzyText.includes(fuzzyOldText))
		.sort((a, b) => b.timestamp - a.timestamp);
}

function shouldAttemptApproximateMatch(oldText: string): boolean {
	const normalized = normalizeForApproximateMatch(normalizeToLF(oldText), { stripTrailingDelimiters: true });
	const lines = normalized.split("\n").filter((line) => line.length > 0);
	return normalized.length >= MIN_APPROXIMATE_OLD_TEXT_CHARS && lines.length >= MIN_APPROXIMATE_OLD_TEXT_LINES;
}

function findApproximateCandidate(content: string, oldText: string): ApproximateMatchCandidate | undefined {
	if (!shouldAttemptApproximateMatch(oldText)) {
		return undefined;
	}

	const rawLines = content.split("\n");
	const targetText = normalizeForApproximateMatch(oldText, { stripTrailingDelimiters: true });
	const targetLines = targetText.split("\n").filter((line) => line.length > 0);
	if (targetLines.length < MIN_APPROXIMATE_OLD_TEXT_LINES) return undefined;

	const candidates: ApproximateMatchCandidate[] = [];
	for (let start = 0; start < rawLines.length; start++) {
		for (
			let len = Math.max(1, targetLines.length - 1);
			len <= Math.min(rawLines.length - start, targetLines.length + 1);
			len++
		) {
			const sliceRaw = rawLines.slice(start, start + len);
			const candidateText = sliceRaw.join("\n");
			const candidateApproximate = normalizeForApproximateMatch(candidateText, { stripTrailingDelimiters: true });
			const sliceNormalized = candidateApproximate.split("\n").filter((line) => line.length > 0);
			if (sliceNormalized.length === 0) continue;
			const lineScore = lineDiceCoefficient(targetLines, sliceNormalized);
			if (lineScore < 0.7) continue;
			const charScore = candidateApproximate.length === 0 ? 0 : diceLike(targetText, candidateApproximate);
			const score = charScore;
			if (score < MIN_APPROXIMATE_SCORE) continue;
			const reasons = [];
			if (lineScore < 0.98 && charScore >= 0.98) reasons.push("same text with minor structural differences");
			if (lineScore >= 0.98 && charScore < 0.98) reasons.push("same structure with small text differences");
			if (reasons.length === 0) reasons.push("unique high-confidence approximate block");
			candidates.push({
				startLine: start + 1,
				endLine: start + len,
				score,
				lineScore,
				charScore,
				matchedText: candidateText,
				reasons,
			});
		}
	}

	const targetLineCount = targetLines.length;
	candidates.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score;
		// When scores are equal, prefer the candidate closest to target length
		const aDiff = Math.abs(a.endLine - a.startLine + 1 - targetLineCount);
		const bDiff = Math.abs(b.endLine - b.startLine + 1 - targetLineCount);
		if (aDiff !== bDiff) return aDiff - bDiff;
		return a.startLine - b.startLine;
	});
	const best = candidates[0];
	const second = candidates[1];
	if (!best) return undefined;
	// Only apply gap check when candidates don't overlap (different regions).
	// Overlapping candidates (same start, different lengths) are not ambiguous.
	if (second && best.score - second.score < MIN_APPROXIMATE_GAP && best.startLine !== second.startLine) {
		return undefined;
	}
	return best;
}

function diceLike(a: string, b: string): number {
	return diceCoefficient(a, b);
}

function findSingleOccurrenceIndex(content: string, text: string): number {
	const first = content.indexOf(text);
	if (first === -1) return -1;
	const second = content.indexOf(text, first + 1);
	return second === -1 ? first : -1;
}

function resolveAlreadyApplied(baseContent: string, newText: string): boolean {
	const normalizedNewText = normalizeToLF(newText);
	return normalizedNewText.length > 0 && findSingleOccurrenceIndex(baseContent, normalizedNewText) !== -1;
}

export function resolveEditPathWithHistory(
	path: string,
	cwd: string,
	readHistoryStore?: ReadHistoryStore,
): EditPathRecovery {
	return resolvePathWithHistory(path, cwd, readHistoryStore, { sources: ["read"] });
}

/**
 * Apply one or more targeted replacements to LF-normalized content.
 * All edits are matched against the same original content, then applied in reverse order.
 */
export function applyEditsToNormalizedContent(
	normalizedContent: string,
	edits: Edit[],
	path: string,
	readHistoryStore?: ReadHistoryStore,
): AppliedEditsResult {
	const normalizedEdits = edits.map((edit, editIndex) => {
		if (typeof edit.oldText !== "string") {
			throw getInvalidEditInputError(path, editIndex, edits.length, "oldText");
		}
		if (typeof edit.newText !== "string") {
			throw getInvalidEditInputError(path, editIndex, edits.length, "newText");
		}
		return {
			oldText: normalizeToLF(edit.oldText),
			newText: normalizeToLF(edit.newText),
		};
	});

	for (let i = 0; i < normalizedEdits.length; i++) {
		if (normalizedEdits[i].oldText.length === 0) {
			throw getEmptyOldTextError(path, i, normalizedEdits.length);
		}
	}

	const initialMatches = normalizedEdits.map((edit) => fuzzyFindText(normalizedContent, edit.oldText));
	const baseContent = initialMatches.some((match) => match.usedFuzzyMatch)
		? normalizeForFuzzyMatch(normalizedContent)
		: normalizedContent;

	const matchedEdits: MatchedEdit[] = [];
	let appliedViaApproximateMatch = false;
	for (let i = 0; i < normalizedEdits.length; i++) {
		const edit = normalizedEdits[i];
		const matchResult = fuzzyFindText(baseContent, edit.oldText);
		if (!matchResult.found) {
			if (resolveAlreadyApplied(baseContent, edit.newText)) {
				throw getNoChangeError(path, normalizedEdits.length, true);
			}
			const readEvidence = findReadEvidence(path, edit.oldText, readHistoryStore);
			const approximateCandidate = findApproximateCandidate(baseContent, edit.oldText);
			if (approximateCandidate) {
				// Search using normalized text so tabs/spaces don't prevent matching.
				const normalizedMatched = normalizeForApproximateMatch(approximateCandidate.matchedText, {
					stripTrailingDelimiters: true,
				});
				const normalizedBase = normalizeForApproximateMatch(baseContent, { stripTrailingDelimiters: true });
				const normIndex = normalizedBase.indexOf(normalizedMatched);
				if (normIndex !== -1) {
					// Find the corresponding region in the raw baseContent by counting lines.
					const normBefore = normalizedBase.slice(0, normIndex);
					const linesBefore = normBefore.split("\n").length - 1;
					const rawLines = baseContent.split("\n");
					const rawIndex = rawLines.slice(0, linesBefore).join("\n").length + (linesBefore > 0 ? 1 : 0);
					const matchedRawLines = approximateCandidate.matchedText.split("\n");
					const rawLength = matchedRawLines.join("\n").length;
					matchedEdits.push({
						editIndex: i,
						matchIndex: rawIndex,
						matchLength: rawLength,
						newText: edit.newText,
					});
					appliedViaApproximateMatch = true;
					continue;
				}
			}
			throw getNotFoundError(path, i, normalizedEdits.length, { readEvidence, approximateCandidate });
		}

		const occurrences = countOccurrences(baseContent, edit.oldText);
		if (occurrences > 1) {
			throw getDuplicateError(path, i, normalizedEdits.length, occurrences);
		}

		matchedEdits.push({
			editIndex: i,
			matchIndex: matchResult.index,
			matchLength: matchResult.matchLength,
			newText: edit.newText,
		});
	}

	matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
	for (let i = 1; i < matchedEdits.length; i++) {
		const previous = matchedEdits[i - 1];
		const current = matchedEdits[i];
		if (previous.matchIndex + previous.matchLength > current.matchIndex) {
			throw getOverlapError(path, previous.editIndex, current.editIndex);
		}
	}

	let newContent = baseContent;
	for (let i = matchedEdits.length - 1; i >= 0; i--) {
		const edit = matchedEdits[i];
		newContent =
			newContent.substring(0, edit.matchIndex) +
			edit.newText +
			newContent.substring(edit.matchIndex + edit.matchLength);
	}

	if (baseContent === newContent) {
		throw getNoChangeError(path, normalizedEdits.length);
	}

	return { baseContent, newContent, appliedViaApproximateMatch };
}

/** Generate a standard unified patch. */
export function generateUnifiedPatch(path: string, oldContent: string, newContent: string, contextLines = 4): string {
	return Diff.createTwoFilesPatch(path, path, oldContent, newContent, undefined, undefined, {
		context: contextLines,
		headerOptions: Diff.FILE_HEADERS_ONLY,
	});
}

/**
 * Generate a display-oriented diff string with line numbers and context.
 * Returns both the diff string and the first changed line number (in the new file).
 */
export function generateDiffString(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
	const parts = Diff.diffLines(oldContent, newContent);
	const output: string[] = [];

	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const maxLineNum = Math.max(oldLines.length, newLines.length);
	const lineNumWidth = String(maxLineNum).length;

	let oldLineNum = 1;
	let newLineNum = 1;
	let lastWasChange = false;
	let firstChangedLine: number | undefined;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") raw.pop();

		if (part.added || part.removed) {
			if (firstChangedLine === undefined) {
				firstChangedLine = newLineNum;
			}
			for (const line of raw) {
				if (part.added) {
					const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
					output.push(`+${lineNum} ${line}`);
					newLineNum++;
				} else {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(`-${lineNum} ${line}`);
					oldLineNum++;
				}
			}
			lastWasChange = true;
		} else {
			const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);
			const hasLeadingChange = lastWasChange;
			const hasTrailingChange = nextPartIsChange;

			if (hasLeadingChange && hasTrailingChange) {
				if (raw.length <= contextLines * 2) {
					for (const line of raw) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				} else {
					const leadingLines = raw.slice(0, contextLines);
					const trailingLines = raw.slice(raw.length - contextLines);
					const skippedLines = raw.length - leadingLines.length - trailingLines.length;
					for (const line of leadingLines) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;
					for (const line of trailingLines) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				}
			} else if (hasLeadingChange) {
				const shownLines = raw.slice(0, contextLines);
				const skippedLines = raw.length - shownLines.length;
				for (const line of shownLines) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}
				if (skippedLines > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;
				}
			} else if (hasTrailingChange) {
				const skippedLines = Math.max(0, raw.length - contextLines);
				if (skippedLines > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;
				}
				for (const line of raw.slice(skippedLines)) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}
			} else {
				oldLineNum += raw.length;
				newLineNum += raw.length;
			}
			lastWasChange = false;
		}
	}

	return { diff: output.join("\n"), firstChangedLine };
}

export interface EditDiffResult {
	diff: string;
	firstChangedLine: number | undefined;
}

export interface EditDiffError {
	error: string;
}

export async function computeEditsDiff(
	path: string,
	edits: Edit[],
	cwd: string,
	readHistoryStore?: ReadHistoryStore,
): Promise<EditDiffResult | EditDiffError> {
	const recovery = resolveEditPathWithHistory(path, cwd, readHistoryStore);
	const absolutePath = recovery.resolvedPath;

	try {
		try {
			await access(absolutePath, constants.R_OK);
		} catch (error: unknown) {
			const errorCode = error instanceof Error && "code" in error ? String(error.code) : undefined;
			if (errorCode === "ENOENT") {
				const suggestions = recovery.candidates.slice(0, 3).map((candidate) => candidate.canonicalPath);
				const suggestionText = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}` : "";
				return { error: `Could not edit file: ${path}. Error code: ENOENT.${suggestionText}` };
			}
			const errorMessage = error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
			return { error: `Could not edit file: ${path}. ${errorMessage}.` };
		}

		const rawContent = await readFile(absolutePath, "utf-8");
		const { text: content } = stripBom(rawContent);
		const normalizedContent = normalizeToLF(content);
		const { baseContent, newContent } = applyEditsToNormalizedContent(
			normalizedContent,
			edits,
			absolutePath,
			readHistoryStore,
		);
		return generateDiffString(baseContent, newContent);
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

export async function computeEditDiff(
	path: string,
	oldText: string,
	newText: string,
	cwd: string,
	readHistoryStore?: ReadHistoryStore,
): Promise<EditDiffResult | EditDiffError> {
	return computeEditsDiff(path, [{ oldText, newText }], cwd, readHistoryStore);
}
