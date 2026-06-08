import { basename, dirname, isAbsolute, relative, resolve as resolvePath, sep } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile } from "fs/promises";
import { type Static, Type } from "typebox";
import { getReadmePath } from "../../config.ts";
import { keyHint, keyText } from "../../modes/interactive/components/keybinding-hints.ts";
import { getLanguageFromPath, highlightCode, type Theme } from "../../modes/interactive/theme/theme.ts";
import { formatDimensionNote, resizeImage } from "../../utils/image-resize.ts";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.ts";
import { formatPathRelativeToCwdOrAbsolute } from "../../utils/paths.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { resolveReadPathAsync, resolveToCwd } from "./path-utils.ts";
import { buildReadHistoryEntry, type ReadHistoryStore, resolvePathWithHistory } from "./read-history.ts";
import { getTextOutput, renderToolPath, replaceTabs, str } from "./render-utils.ts";
import {
	buildReadDedupRequestKey,
	formatDeduplicationNote,
	getFileFingerprint,
	type ToolDeduplicationDetails,
	type ToolDedupStore,
} from "./tool-dedup-cache.ts";
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
		totalLines: number;
		maxBytes: number;
		maxLines: number;
		forceParam: "forceFullRead";
	};
	deduplication?: ToolDeduplicationDetails;
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

interface CompactReadClassification {
	kind: "docs" | "resource" | "skill";
	label: string;
}

const COMPACT_RESOURCE_FILE_NAMES = new Set(["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);

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
}

const defaultReadOperations: ReadOperations = {
	readFile: (path) => fsReadFile(path),
	access: (path) => fsAccess(path, constants.R_OK),
	detectImageMimeType: detectSupportedImageMimeTypeFromFile,
};

export interface ReadToolOptions {
	/** Whether to auto-resize images to 2000x2000 max. Default: true */
	autoResizeImages?: boolean;
	/** Custom operations for file reading. Default: local filesystem */
	operations?: ReadOperations;
	/** Session-scoped history of successful text reads for later edit recovery. */
	readHistoryStore?: ReadHistoryStore;
	/** Session-scoped short-term tool-result cache for near-duplicate read calls. */
	toolDedupStore?: ToolDedupStore;
}

type ReadRenderArgs = { path?: string; file_path?: string; offset?: number; limit?: number };

function formatReadLineRange(args: ReadRenderArgs | undefined, theme: Theme): string {
	if (args?.offset === undefined && args?.limit === undefined) return "";
	const startLine = args.offset ?? 1;
	const endLine = args.limit !== undefined ? startLine + args.limit - 1 : "";
	return theme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
}

function formatReadCall(args: ReadRenderArgs | undefined, theme: Theme, cwd: string): string {
	const pathDisplay = renderToolPath(str(args?.file_path ?? args?.path), theme, cwd);
	return `${theme.fg("toolTitle", theme.bold("read"))} ${pathDisplay}${formatReadLineRange(args, theme)}`;
}

function trimTrailingEmptyLines(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1] === "") {
		end--;
	}
	return lines.slice(0, end);
}

function getNonVisionImageNote(model: Model<Api> | undefined): string | undefined {
	if (!model || model.input.includes("image")) {
		return undefined;
	}
	return "[Current model does not support images. The image will be omitted from this request.]";
}

function toPosixPath(filePath: string): string {
	return filePath.split(sep).join("/");
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
	totalLines: number;
}): boolean {
	if (params.forceFullRead === true) return false;
	if (params.offset !== undefined || params.limit !== undefined) return false;
	return params.totalBytes > DEFAULT_MAX_BYTES || params.totalLines > DEFAULT_MAX_LINES;
}

function formatLargeFilePreflight(details: NonNullable<ReadToolDetails["largeFilePreflight"]>): string {
	return [
		"[large_file_preflight]",
		`path=${details.path}`,
		`size=${formatSize(details.sizeBytes)}`,
		`lines=${details.totalLines}`,
		`normalReadLimit=${details.maxLines} lines or ${formatSize(details.maxBytes)}`,
		"Use offset/limit for a targeted read, or retry with forceFullRead=true to read from the beginning under normal truncation limits.",
	].join("\n");
}

function getPiDocsClassification(absolutePath: string): CompactReadClassification | undefined {
	const packageRoot = dirname(getReadmePath());
	const relativePath = relative(resolvePath(packageRoot), resolvePath(absolutePath));
	if (
		relativePath === "" ||
		relativePath === ".." ||
		relativePath.startsWith(`..${sep}`) ||
		isAbsolute(relativePath)
	) {
		return undefined;
	}

	const label = toPosixPath(relativePath);
	if (label === "README.md" || label.startsWith("docs/") || label.startsWith("examples/")) {
		return { kind: "docs", label };
	}
	return undefined;
}

function getCompactReadClassification(
	args: ReadRenderArgs | undefined,
	cwd: string,
): CompactReadClassification | undefined {
	const rawPath = str(args?.file_path ?? args?.path);
	if (!rawPath) return undefined;

	const absolutePath = resolveToCwd(rawPath, cwd);
	const fileName = basename(absolutePath);
	if (fileName === "SKILL.md") {
		return { kind: "skill", label: basename(dirname(absolutePath)) || fileName };
	}

	const docsClassification = getPiDocsClassification(absolutePath);
	if (docsClassification) return docsClassification;

	if (COMPACT_RESOURCE_FILE_NAMES.has(fileName)) {
		return { kind: "resource", label: formatPathRelativeToCwdOrAbsolute(absolutePath, cwd) };
	}

	return undefined;
}

function formatCompactReadCall(
	classification: CompactReadClassification,
	args: ReadRenderArgs | undefined,
	theme: Theme,
): string {
	const expandHint = theme.fg("dim", ` (${keyText("app.tools.expand")} to expand)`);
	if (classification.kind === "skill") {
		return (
			theme.fg("customMessageLabel", `\x1b[1m[skill]\x1b[22m `) +
			theme.fg("customMessageText", classification.label) +
			formatReadLineRange(args, theme) +
			expandHint
		);
	}

	return (
		theme.fg("toolTitle", theme.bold(`read ${classification.kind}`)) +
		" " +
		theme.fg("accent", classification.label) +
		formatReadLineRange(args, theme) +
		expandHint
	);
}

function formatReadResult(
	args: ReadRenderArgs | undefined,
	result: { content: (TextContent | ImageContent)[]; details?: ReadToolDetails },
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
	_cwd: string,
	isError: boolean,
): string {
	if (!options.expanded && !isError) {
		return "";
	}

	const rawPath = str(args?.file_path ?? args?.path);
	const output = getTextOutput(result, showImages);
	const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
	const renderedLines = lang ? highlightCode(replaceTabs(output), lang) : output.split("\n");
	const lines = trimTrailingEmptyLines(renderedLines);
	const maxLines = options.expanded ? lines.length : 10;
	const displayLines = lines.slice(0, maxLines);
	const remaining = lines.length - maxLines;
	let text = `\n${displayLines.map((line) => (lang ? replaceTabs(line) : theme.fg("toolOutput", replaceTabs(line)))).join("\n")}`;
	if (remaining > 0) {
		text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")})`;
	}

	const truncation = result.details?.truncation;
	if (truncation?.truncated) {
		if (truncation.firstLineExceedsLimit) {
			text += `\n${theme.fg("warning", `[First line exceeds ${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit]`)}`;
		} else if (truncation.truncatedBy === "lines") {
			text += `\n${theme.fg("warning", `[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines ?? DEFAULT_MAX_LINES} line limit)]`)}`;
		} else {
			text += `\n${theme.fg("warning", `[Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)]`)}`;
		}
	}
	return text;
}

export function createReadToolDefinition(
	cwd: string,
	options?: ReadToolOptions,
): ToolDefinition<typeof readSchema, ReadToolDetails | undefined> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	const ops = options?.operations ?? defaultReadOperations;
	const readHistoryStore = options?.readHistoryStore;
	const toolDedupStore = options?.toolDedupStore;
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
					let aborted = false;
					const onAbort = () => {
						aborted = true;
						reject(new Error("Operation aborted"));
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
							const fingerprint = await getFileFingerprint(absolutePath);
							const requestedStartLine = offset !== undefined ? Math.max(1, offset) : 1;
							const requestedEndLine =
								limit !== undefined && limit > 0 ? requestedStartLine + limit - 1 : undefined;
							const readDedupRequestKey = buildReadDedupRequestKey({
								path: absolutePath,
								offset,
								limit,
							});
							if (fingerprint) {
								const dedupHit = toolDedupStore?.findReadHit({
									toolCallId,
									canonicalPath: absolutePath,
									fingerprint,
									startLine: requestedStartLine,
									endLine: requestedEndLine,
									requestKey: readDedupRequestKey,
								});
								if (dedupHit) {
									const dedupText =
										dedupHit.text !== undefined
											? `Reused cached read slice from ${absolutePath}.\n\n${dedupHit.text}`
											: `Reused previous read result for ${absolutePath}.`;
									const content: TextContent[] = [
										{ type: "text", text: formatDeduplicationNote(dedupHit.details, dedupText) },
									];
									toolDedupStore?.recordSyntheticResult(toolCallId, content);
									resolve({
										content,
										details: mergeReadDetails(pathRecovery ? { pathRecovery } : undefined, {
											deduplication: dedupHit.details,
										}),
									});
									return;
								}
							}
							const mimeType = ops.detectImageMimeType ? await ops.detectImageMimeType(absolutePath) : undefined;
							let content: (TextContent | ImageContent)[];
							let details: ReadToolDetails | undefined = pathRecovery ? { pathRecovery } : undefined;
							let dedupRecordText: string | undefined;
							let dedupCoveredEndLine: number | undefined;
							let dedupCoveredToEnd: boolean | undefined;
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
								const buffer = await ops.readFile(absolutePath);
								const textContent = buffer.toString("utf-8");
								const allLines = textContent.split("\n");
								const totalFileLines = allLines.length;
								const totalFileBytes = Buffer.byteLength(textContent, "utf-8");
								if (
									shouldPreflightLargeTextRead({
										forceFullRead,
										offset,
										limit,
										totalBytes: totalFileBytes,
										totalLines: totalFileLines,
									})
								) {
									const preflight: NonNullable<ReadToolDetails["largeFilePreflight"]> = {
										kind: "large_file_preflight",
										path: absolutePath,
										sizeBytes: totalFileBytes,
										totalLines: totalFileLines,
										maxBytes: DEFAULT_MAX_BYTES,
										maxLines: DEFAULT_MAX_LINES,
										forceParam: "forceFullRead",
									};
									let outputText = formatLargeFilePreflight(preflight);
									if (pathRecovery?.autoRecovered)
										outputText = formatReadPathRecoveryNote(path, absolutePath) + outputText;
									content = [{ type: "text", text: outputText }];
									details = mergeReadDetails(details, { largeFilePreflight: preflight });
									toolDedupStore?.recordSyntheticResult(toolCallId, content);
									signal?.removeEventListener("abort", onAbort);
									resolve({ content, details });
									return;
								}
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
									dedupRecordText = truncation.content;
									dedupCoveredEndLine = endLineDisplay;
									dedupCoveredToEnd = false;
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
									dedupRecordText = truncation.content;
									dedupCoveredEndLine = startLineDisplay + userLimitedLines - 1;
									dedupCoveredToEnd = false;
								} else {
									// No truncation and no remaining user-limited content.
									outputText = truncation.content;
									dedupRecordText = truncation.content;
									dedupCoveredEndLine =
										userLimitedLines !== undefined ? startLineDisplay + userLimitedLines - 1 : totalFileLines;
									dedupCoveredToEnd = true;
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
							if (
								fingerprint &&
								dedupRecordText !== undefined &&
								dedupCoveredEndLine !== undefined &&
								dedupCoveredToEnd !== undefined
							) {
								toolDedupStore?.recordRead({
									toolCallId,
									canonicalPath: absolutePath,
									fingerprint,
									startLine: requestedStartLine,
									coveredEndLine: dedupCoveredEndLine,
									coveredToEnd: dedupCoveredToEnd,
									requestKey: readDedupRequestKey,
									text: dedupRecordText,
									resultContent: content,
								});
							} else {
								toolDedupStore?.recordSyntheticResult(toolCallId, content);
							}
							signal?.removeEventListener("abort", onAbort);
							resolve({ content, details });
						} catch (error: any) {
							signal?.removeEventListener("abort", onAbort);
							if (!aborted) reject(error);
						}
					})();
				},
			);
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const classification = !context.expanded ? getCompactReadClassification(args, context.cwd) : undefined;
			text.setText(
				classification
					? formatCompactReadCall(classification, args, theme)
					: formatReadCall(args, theme, context.cwd),
			);
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(
				formatReadResult(context.args, result, options, theme, context.showImages, context.cwd, context.isError),
			);
			return text;
		},
	};
}

export function createReadTool(cwd: string, options?: ReadToolOptions): AgentTool<typeof readSchema> {
	return wrapToolDefinition(createReadToolDefinition(cwd, options));
}
