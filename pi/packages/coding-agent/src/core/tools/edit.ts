import type { AgentTool } from "@mortise/pi-agent-core";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile, writeFile as fsWriteFile } from "fs/promises";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import {
	applyEditsToNormalizedContent,
	detectLineEnding,
	type Edit,
	EditFailure,
	generateDiffString,
	generateUnifiedPatch,
	normalizeToLF,
	resolveEditPathWithHistory,
	restoreLineEndings,
	stripBom,
} from "./edit-diff.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import type { ReadHistoryStore } from "./read-history.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const replaceEditSchema = Type.Object(
	{
		oldText: Type.String({
			description:
				"Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
		}),
		newText: Type.String({ description: "Replacement text for this targeted edit." }),
	},
	{ additionalProperties: false },
);

const editSchema = Type.Object(
	{
		path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
		edits: Type.Array(replaceEditSchema, {
			description:
				"One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
		}),
	},
	{ additionalProperties: false },
);

export type EditToolInput = Static<typeof editSchema>;
type LegacyEditToolInput = EditToolInput & {
	oldText?: unknown;
	newText?: unknown;
};

export interface EditToolErrorDetails {
	kind:
		| "path_not_found"
		| "exact_not_found"
		| "already_applied"
		| "duplicate_old_text"
		| "overlap"
		| "empty_old_text"
		| "no_change"
		| "invalid_edit_input";
	editIndex?: number;
	totalEdits?: number;
	occurrences?: number;
	approximateCandidate?: {
		startLine: number;
		endLine: number;
		score: number;
		lineScore: number;
		charScore: number;
		matchedText: string;
		reasons: string[];
	};
	readEvidence?: Array<{
		requestedPath: string;
		canonicalPath: string;
		startLine: number;
		endLine: number;
		toolCallId: string;
		timestamp: number;
	}>;
	pathCandidates?: Array<{
		canonicalPath: string;
		score: number;
		reasons: string[];
		lastReadTimestamp: number;
	}>;
}

export interface EditToolDetails {
	/** Display-oriented diff of the changes made */
	diff?: string;
	/** Standard unified patch of the changes made */
	patch?: string;
	/** Line number of the first change in the new file (for editor navigation) */
	firstChangedLine?: number;
	/** Structured error details for machine/UI consumption. */
	error?: EditToolErrorDetails;
}

/**
 * Pluggable operations for the edit tool.
 * Override these to delegate file editing to remote systems (for example SSH).
 */
export interface EditOperations {
	/** Read file contents as a Buffer */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** Write content to a file */
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	/** Check if file is readable and writable (throw if not) */
	access: (absolutePath: string) => Promise<void>;
}

const defaultEditOperations: EditOperations = {
	readFile: (path) => fsReadFile(path),
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
	access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
};

export interface EditToolOptions {
	/** Custom operations for file editing. Default: local filesystem */
	operations?: EditOperations;
	/** Session-scoped successful text reads used for conservative recovery. */
	readHistoryStore?: ReadHistoryStore;
}

function prepareEditArguments(input: unknown): EditToolInput {
	if (!input || typeof input !== "object") {
		return input as EditToolInput;
	}

	const args = input as Record<string, unknown>;

	// Some models (Opus 4.6, GLM-5.1) send edits as a JSON string instead of an array
	if (typeof args.edits === "string") {
		try {
			const parsed = JSON.parse(args.edits);
			if (Array.isArray(parsed)) args.edits = parsed;
		} catch {}
	}

	const legacy = args as LegacyEditToolInput;
	if (typeof legacy.oldText !== "string" || typeof legacy.newText !== "string") {
		return args as EditToolInput;
	}

	const edits = Array.isArray(legacy.edits) ? [...legacy.edits] : [];
	edits.push({ oldText: legacy.oldText, newText: legacy.newText });
	const { oldText: _oldText, newText: _newText, ...rest } = legacy;
	return { ...rest, edits } as EditToolInput;
}

function validateEditInput(input: EditToolInput): { path: string; edits: Edit[] } {
	if (typeof input?.path !== "string" || input.path.length === 0) {
		throw new EditFailure("invalid_edit_input", "Edit tool input is invalid. path must be a non-empty string.");
	}
	if (!Array.isArray(input.edits) || input.edits.length === 0) {
		throw new EditFailure(
			"invalid_edit_input",
			"Edit tool input is invalid. edits must contain at least one replacement.",
		);
	}
	for (let i = 0; i < input.edits.length; i++) {
		const edit = input.edits[i] as Partial<Edit> | undefined;
		if (!edit || typeof edit.oldText !== "string") {
			throw new EditFailure("invalid_edit_input", `edits[${i}].oldText must be a string.`, {
				editIndex: i,
				totalEdits: input.edits.length,
			});
		}
		if (typeof edit.newText !== "string") {
			throw new EditFailure("invalid_edit_input", `edits[${i}].newText must be a string.`, {
				editIndex: i,
				totalEdits: input.edits.length,
			});
		}
	}
	return { path: input.path, edits: input.edits };
}

function createEditToolError(
	errorMessage: string,
	details: EditToolDetails,
): Error & {
	toolResult: { content: Array<{ type: "text"; text: string }>; details: EditToolDetails };
} {
	const error = new Error(errorMessage) as Error & {
		toolResult: { content: Array<{ type: "text"; text: string }>; details: EditToolDetails };
	};
	error.toolResult = {
		content: [{ type: "text", text: errorMessage }],
		details,
	};
	return error;
}

function createEditErrorDetailsFromFailure(error: EditFailure): EditToolErrorDetails {
	return {
		kind: error.kind,
		editIndex: error.details?.editIndex,
		totalEdits: error.details?.totalEdits,
		occurrences: error.details?.occurrences,
		approximateCandidate: error.details?.approximateCandidate
			? {
					startLine: error.details.approximateCandidate.startLine,
					endLine: error.details.approximateCandidate.endLine,
					score: error.details.approximateCandidate.score,
					lineScore: error.details.approximateCandidate.lineScore,
					charScore: error.details.approximateCandidate.charScore,
					matchedText: error.details.approximateCandidate.matchedText,
					reasons: [...error.details.approximateCandidate.reasons],
				}
			: undefined,
		readEvidence: error.details?.readEvidence?.map((entry) => ({
			requestedPath: entry.requestedPath,
			canonicalPath: entry.canonicalPath,
			startLine: entry.startLine,
			endLine: entry.endLine,
			toolCallId: entry.toolCallId,
			timestamp: entry.timestamp,
		})),
		pathCandidates: error.details?.pathCandidates?.map((candidate) => ({
			canonicalPath: candidate.canonicalPath,
			score: candidate.score,
			reasons: [...candidate.reasons],
			lastReadTimestamp: candidate.lastReadTimestamp,
		})),
	};
}

export function createEditToolDefinition(
	cwd: string,
	options?: EditToolOptions,
): ToolDefinition<typeof editSchema, EditToolDetails | undefined> {
	const ops = options?.operations ?? defaultEditOperations;
	const readHistoryStore = options?.readHistoryStore;
	return {
		name: "edit",
		label: "edit",
		description:
			"Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
		promptSnippet:
			"Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
		promptGuidelines: [
			"Use edit for precise changes (edits[].oldText must match exactly)",
			"When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
			"Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
			"Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
		],
		parameters: editSchema,
		prepareArguments: prepareEditArguments,
		async execute(_toolCallId, input: EditToolInput, signal?: AbortSignal, _onUpdate?, _ctx?) {
			let path: string;
			let edits: Edit[];
			try {
				({ path, edits } = validateEditInput(input));
			} catch (error: unknown) {
				if (error instanceof EditFailure) {
					throw createEditToolError(error.message, {
						error: createEditErrorDetailsFromFailure(error),
					});
				}
				throw error;
			}
			const recovery = resolveEditPathWithHistory(path, cwd, readHistoryStore);
			const absolutePath = recovery.resolvedPath;

			return withFileMutationQueue(absolutePath, async () => {
				const throwIfAborted = (): void => {
					if (signal?.aborted) {
						throw new Error("Operation aborted");
					}
				};

				throwIfAborted();

				try {
					await ops.access(absolutePath);
				} catch (error: unknown) {
					throwIfAborted();
					const errorCode = error instanceof Error && "code" in error ? String(error.code) : undefined;
					if (errorCode === "ENOENT") {
						const suggestions = recovery.candidates.slice(0, 3).map((candidate) => candidate.canonicalPath);
						const suggestionText = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}` : "";
						throw createEditToolError(`Could not edit file: ${path}. Error code: ENOENT.${suggestionText}`, {
							error: {
								kind: "path_not_found",
								pathCandidates: recovery.candidates.slice(0, 3).map((candidate) => ({
									canonicalPath: candidate.canonicalPath,
									score: candidate.score,
									reasons: [...candidate.reasons],
									lastReadTimestamp: candidate.lastReadTimestamp,
								})),
							},
						});
					}

					const errorMessage =
						error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
					throw new Error(`Could not edit file: ${path}. ${errorMessage}.`);
				}
				throwIfAborted();

				const buffer = await ops.readFile(absolutePath);
				const rawContent = buffer.toString("utf-8");
				throwIfAborted();

				const { bom, text: content } = stripBom(rawContent);
				const originalEnding = detectLineEnding(content);
				const normalizedContent = normalizeToLF(content);

				let baseContent: string;
				let newContent: string;
				let appliedViaApproximateMatch = false;
				try {
					({ baseContent, newContent, appliedViaApproximateMatch } = applyEditsToNormalizedContent(
						normalizedContent,
						edits,
						absolutePath,
						readHistoryStore,
					));
				} catch (error: unknown) {
					throwIfAborted();
					if (error instanceof EditFailure) {
						throw createEditToolError(error.message, {
							error: createEditErrorDetailsFromFailure(error),
						});
					}
					throw error;
				}
				throwIfAborted();

				const finalContent = bom + restoreLineEndings(newContent, originalEnding);
				await ops.writeFile(absolutePath, finalContent);
				throwIfAborted();

				const diffResult = generateDiffString(baseContent, newContent);
				const patch = generateUnifiedPatch(path, baseContent, newContent);
				return {
					content: [
						{
							type: "text",
							text: appliedViaApproximateMatch
								? `Successfully replaced ${edits.length} block(s) in ${path} using a unique high-confidence approximate match.`
								: `Successfully replaced ${edits.length} block(s) in ${path}.`,
						},
					],
					details: { diff: diffResult.diff, patch, firstChangedLine: diffResult.firstChangedLine },
				};
			});
		},
	};
}

export function createEditTool(cwd: string, options?: EditToolOptions): AgentTool<typeof editSchema> {
	return wrapToolDefinition(createEditToolDefinition(cwd, options));
}
