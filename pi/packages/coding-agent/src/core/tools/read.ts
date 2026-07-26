import type { AgentTool } from "@mortise/pi-agent-core";
import type { Api, ImageContent, Model, TextContent } from "@mortise/pi-ai/types";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile, stat as fsStat } from "fs/promises";
import { type Static, Type } from "typebox";
import { formatDimensionNote, resizeImage } from "../../utils/image-resize.ts";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { resolveReadPathAsync } from "./path-utils.ts";
import { buildReadHistoryEntry, type ReadHistoryStore, resolvePathWithHistory } from "./read-history.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
	forceFullRead: Type.Optional(
		Type.Boolean({
			description:
				"Bypass large-file preflight when intentionally reading from the beginning without offset/limit. Output is still truncated by normal tool limits.",
		}),
	),
});

export type ReadToolInput = Static<typeof readSchema>;

export interface ReadToolDetails {
	truncation?: TruncationResult;
	largeFilePreflight?: {
		kind: "large_file_preflight";
		path: string;
		sizeBytes: number;
		totalLines?: number;
		maxBytes: number;
		maxLines: number;
		forceParam: "forceFullRead";
	};
	pathRecovery?: {
		requestedPath: string;
		resolvedPath: string;
		autoRecovered: boolean;
		candidates: Array<{
			canonicalPath: string;
			score: number;
			reasons: string[];
			lastReadTimestamp: number;
		}>;
	};
}

/**
 * Pluggable operations for the read tool.
 * Override these to delegate file reading to remote systems (for example SSH).
 */
export interface ReadOperations {
	/** Read file contents as a Buffer */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** Check if file is readable (throw if not) */
	access: (absolutePath: string) => Promise<void>;
	/** Detect image MIME type, return null or undefined for non-images */
	detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
	/** Get file stats before reading content. */
	stat?: (absolutePath: string) => Promise<{ isFile: () => boolean; size: number }>;
}

const defaultReadOperations: ReadOperations = {
	readFile: (path) => fsReadFile(path),
	access: (path) => fsAccess(path, constants.R_OK),
	detectImageMimeType: detectSupportedImageMimeTypeFromFile,
	stat: fsStat,
};

export interface ReadToolOptions {
	/** Whether to auto-resize images to 2000x2000 max. Default: true */
	autoResizeImages?: boolean;
	/** Custom operations for file reading. Default: local filesystem */
	operations?: ReadOperations;
	/** Session-scoped history of successful text reads for later edit recovery. */
	readHistoryStore?: ReadHistoryStore;
}

function getNonVisionImageNote(model: Model<Api> | undefined): string | undefined {
	if (!model || model.input.includes("image")) {
		return undefined;
	}
	return "[Current model does not support images. The image will be omitted from this request.]";
}

function isErrorCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && String(error.code) === code;
}

function buildReadPathRecoveryDetails(
	requestedPath: string,
	recovery: ReturnType<typeof resolvePathWithHistory>,
): NonNullable<ReadToolDetails["pathRecovery"]> {
	return {
		requestedPath,
		resolvedPath: recovery.resolvedPath,
		autoRecovered: recovery.autoRecovered,
		candidates: recovery.candidates.slice(0, 3).map((candidate) => ({
			canonicalPath: candidate.canonicalPath,
			score: candidate.score,
			reasons: [...candidate.reasons],
			lastReadTimestamp: candidate.lastReadTimestamp,
		})),
	};
}

function formatReadPathRecoveryNote(requestedPath: string, resolvedPath: string): string {
	return `[Path recovered from history: ${requestedPath} -> ${resolvedPath}]\n\n`;
}

function mergeReadDetails(base: ReadToolDetails | undefined, next: ReadToolDetails): ReadToolDetails {
	return { ...base, ...next };
}

function shouldPreflightLargeTextRead(params: {
	forceFullRead?: boolean;
	offset?: number;
	limit?: number;
	totalBytes: number;
	totalLines?: number;
}): boolean {
	if (params.forceFullRead === true) return false;
	if (params.offset !== undefined || params.limit !== undefined) return false;
	return params.totalBytes > DEFAULT_MAX_BYTES || (params.totalLines ?? 0) > DEFAULT_MAX_LINES;
}

function formatLargeFilePreflight(details: NonNullable<ReadToolDetails["largeFilePreflight"]>): string {
	return [
		"[large_file_preflight]",
		`path=${details.path}`,
		`size=${formatSize(details.sizeBytes)}`,
		`lines=${details.totalLines ?? "not counted"}`,
		`normalReadLimit=${details.maxLines} lines or ${formatSize(details.maxBytes)}`,
		"Use offset/limit for a targeted read, or retry with forceFullRead=true to read from the beginning under normal truncation limits.",
	].join("\n");
}

export function createReadToolDefinition(
	cwd: string,
	options?: ReadToolOptions,
): ToolDefinition<typeof readSchema, ReadToolDetails | undefined> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	const ops = options?.operations ?? defaultReadOperations;
	const readHistoryStore = options?.readHistoryStore;
	return {
		name: "read",
		label: "read",
		description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
		promptSnippet: "Read file contents",
		promptGuidelines: ["Use read to examine files instead of cat or sed."],
		parameters: readSchema,
		async execute(
			toolCallId,
			{
				path,
				offset,
				limit,
				forceFullRead,
			}: { path: string; offset?: number; limit?: number; forceFullRead?: boolean },
			signal?: AbortSignal,
			_onUpdate?,
			ctx?,
		) {
			return new Promise<{ content: (TextContent | ImageContent)[]; details: ReadToolDetails | undefined }>(
				(resolve, reject) => {
					if (signal?.aborted) {
						reject(new Error("Operation aborted"));
						return;
					}
					let settled = false;
					let aborted = false;
					const settle = (fn: () => void): void => {
						if (settled) return;
						settled = true;
						signal?.removeEventListener("abort", onAbort);
						fn();
					};
					const onAbort = () => {
						aborted = true;
						settle(() => reject(new Error("Operation aborted")));
					};
					signal?.addEventListener("abort", onAbort, { once: true });

					(async () => {
						try {
							let absolutePath = await resolveReadPathAsync(path, cwd);
							let pathRecovery: ReadToolDetails["pathRecovery"];
							if (aborted) return;
							// Check if file exists and is readable.
							try {
								await ops.access(absolutePath);
							} catch (error: unknown) {
								if (!isErrorCode(error, "ENOENT")) throw error;
								const recovery = resolvePathWithHistory(path, cwd, readHistoryStore);
								pathRecovery = buildReadPathRecoveryDetails(path, recovery);
								if (!recovery.autoRecovered || recovery.resolvedPath === absolutePath) {
									const suggestions = pathRecovery.candidates.map((candidate) => candidate.canonicalPath);
									const suggestionText =
										suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}` : "";
									throw new Error(`Could not read file: ${path}. Error code: ENOENT.${suggestionText}`);
								}
								absolutePath = recovery.resolvedPath;
								await ops.access(absolutePath);
							}
							if (aborted) return;
							const mimeType = ops.detectImageMimeType ? await ops.detectImageMimeType(absolutePath) : undefined;
							let content: (TextContent | ImageContent)[];
							let details: ReadToolDetails | undefined = pathRecovery ? { pathRecovery } : undefined;
							const nonVisionImageNote = getNonVisionImageNote(ctx?.model);
							if (mimeType) {
								// Read image as binary.
								const buffer = await ops.readFile(absolutePath);
								if (autoResizeImages) {
									// Resize image if needed before sending it back to the model.
									const resized = await resizeImage(buffer, mimeType);
									if (!resized) {
										let textNote = `Read image file [${mimeType}]\n[Image omitted: could not be resized below the inline image size limit.]`;
										if (pathRecovery?.autoRecovered)
											textNote = formatReadPathRecoveryNote(path, absolutePath) + textNote;
										if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
										content = [{ type: "text", text: textNote }];
									} else {
										const dimensionNote = formatDimensionNote(resized);
										let textNote = `Read image file [${resized.mimeType}]`;
										if (pathRecovery?.autoRecovered)
											textNote = formatReadPathRecoveryNote(path, absolutePath) + textNote;
										if (dimensionNote) textNote += `\n${dimensionNote}`;
										if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
										content = [
											{ type: "text", text: textNote },
											{ type: "image", data: resized.data, mimeType: resized.mimeType },
										];
									}
								} else {
									let textNote = `Read image file [${mimeType}]`;
									if (pathRecovery?.autoRecovered)
										textNote = formatReadPathRecoveryNote(path, absolutePath) + textNote;
									if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
									content = [
										{ type: "text", text: textNote },
										{ type: "image", data: buffer.toString("base64"), mimeType },
									];
								}
							} else {
								// Read text content.
								const fileStat = await ops.stat?.(absolutePath);
								if (fileStat && !fileStat.isFile()) {
									throw new Error(`Could not read file: ${path}. Not a file.`);
								}
								if (
									shouldPreflightLargeTextRead({
										forceFullRead,
										offset,
										limit,
										totalBytes: fileStat?.size ?? 0,
									})
								) {
									const preflight: NonNullable<ReadToolDetails["largeFilePreflight"]> = {
										kind: "large_file_preflight",
										path: absolutePath,
										sizeBytes: fileStat?.size ?? 0,
										maxBytes: DEFAULT_MAX_BYTES,
										maxLines: DEFAULT_MAX_LINES,
										forceParam: "forceFullRead",
									};
									let outputText = formatLargeFilePreflight(preflight);
									if (pathRecovery?.autoRecovered)
										outputText = formatReadPathRecoveryNote(path, absolutePath) + outputText;
									content = [{ type: "text", text: outputText }];
									details = mergeReadDetails(details, { largeFilePreflight: preflight });
									settle(() => resolve({ content, details }));
									return;
								}
								const buffer = await ops.readFile(absolutePath);
								const textContent = buffer.toString("utf-8");
								const allLines = textContent.split("\n");
								const totalFileLines = allLines.length;
								// Apply offset if specified. Convert from 1-indexed input to 0-indexed array access.
								const startLine = offset ? Math.max(0, offset - 1) : 0;
								const startLineDisplay = startLine + 1;
								// Check if offset is out of bounds.
								if (startLine >= allLines.length) {
									throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
								}
								let selectedContent: string;
								let userLimitedLines: number | undefined;
								// If limit is specified by the user, honor it first. Otherwise truncateHead decides.
								if (limit !== undefined) {
									const endLine = Math.min(startLine + limit, allLines.length);
									selectedContent = allLines.slice(startLine, endLine).join("\n");
									userLimitedLines = endLine - startLine;
								} else {
									selectedContent = allLines.slice(startLine).join("\n");
								}
								// Apply truncation, respecting both line and byte limits.
								const truncation = truncateHead(selectedContent);
								let outputText: string;
								if (truncation.firstLineExceedsLimit) {
									// First line alone exceeds the byte limit. Point the model at a bash fallback.
									const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine], "utf-8"));
									outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
									details = mergeReadDetails(details, { truncation });
								} else if (truncation.truncated) {
									// Truncation occurred. Build an actionable continuation notice.
									const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
									const nextOffset = endLineDisplay + 1;
									outputText = truncation.content;
									if (truncation.truncatedBy === "lines") {
										outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
									} else {
										outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
									}
									details = mergeReadDetails(details, { truncation });
								} else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
									// User-specified limit stopped early, but the file still has more content.
									const remaining = allLines.length - (startLine + userLimitedLines);
									const nextOffset = startLine + userLimitedLines + 1;
									outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
								} else {
									// No truncation and no remaining user-limited content.
									outputText = truncation.content;
								}
								if (pathRecovery?.autoRecovered)
									outputText = formatReadPathRecoveryNote(path, absolutePath) + outputText;
								content = [{ type: "text", text: outputText }];

								if (readHistoryStore) {
									const endLine =
										userLimitedLines !== undefined ? startLineDisplay + userLimitedLines - 1 : totalFileLines;
									readHistoryStore.record(
										buildReadHistoryEntry({
											toolCallId,
											requestedPath: path,
											canonicalPath: absolutePath,
											text: selectedContent,
											startLine: startLineDisplay,
											endLine,
										}),
									);
								}
							}

							if (aborted) return;
							settle(() => resolve({ content, details }));
						} catch (error: unknown) {
							if (!aborted) settle(() => reject(error));
						}
					})();
				},
			);
		},
	};
}

export function createReadTool(cwd: string, options?: ReadToolOptions): AgentTool<typeof readSchema> {
	return wrapToolDefinition(createReadToolDefinition(cwd, options));
}
