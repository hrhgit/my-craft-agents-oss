/**
 * Process @file CLI arguments into text content and image attachments.
 * Interactive mode reuses the same image-processing path when pasted/dropped
 * image file paths should become multimodal attachments.
 */

import { access, readFile, stat } from "node:fs/promises";
import type { ImageContent } from "@earendil-works/pi-ai/types";
import chalk from "chalk";
import { isAbsolute, resolve } from "path";
import { fileURLToPath } from "url";
import { resolveReadPath } from "../core/tools/path-utils.ts";
import { formatDimensionNote, resizeImage } from "../utils/image-resize.ts";
import { detectSupportedImageMimeTypeFromFile } from "../utils/mime.ts";

export interface ProcessedFiles {
	text: string;
	images: ImageContent[];
}

export interface ProcessFileOptions {
	/** Whether to auto-resize images to 2000x2000 max. Default: true */
	autoResizeImages?: boolean;
	/** Base directory used to resolve relative file args. Default: process.cwd() */
	cwd?: string;
}

const TOKEN_REGEX = /"[^"]*"|'[^']*'|\S+/g;

function resolveFileArg(fileArg: string, cwd: string): string {
	return resolve(resolveReadPath(fileArg, cwd));
}

async function processImageFile(
	absolutePath: string,
	mimeType: string,
	options?: ProcessFileOptions,
): Promise<ProcessedFiles> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	const content = await readFile(absolutePath);
	const base64Content = content.toString("base64");

	let attachment: ImageContent;
	let dimensionNote: string | undefined;

	if (autoResizeImages) {
		const resized = await resizeImage(content, mimeType);
		if (!resized) {
			return {
				text: `<file name="${absolutePath}">[Image omitted: could not be resized below the inline image size limit.]</file>\n`,
				images: [],
			};
		}
		dimensionNote = formatDimensionNote(resized);
		attachment = {
			type: "image",
			mimeType: resized.mimeType,
			data: resized.data,
		};
	} else {
		attachment = {
			type: "image",
			mimeType,
			data: base64Content,
		};
	}

	return {
		text: dimensionNote
			? `<file name="${absolutePath}">${dimensionNote}</file>\n`
			: `<file name="${absolutePath}"></file>\n`,
		images: [attachment],
	};
}

async function processTextFile(absolutePath: string): Promise<ProcessedFiles> {
	try {
		const content = await readFile(absolutePath, "utf-8");
		return {
			text: `<file name="${absolutePath}">\n${content}\n</file>\n`,
			images: [],
		};
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not read file ${absolutePath}: ${message}`);
	}
}

export async function processFileArgument(fileArg: string, options?: ProcessFileOptions): Promise<ProcessedFiles> {
	const cwd = options?.cwd ?? process.cwd();
	const absolutePath = resolveFileArg(fileArg, cwd);

	try {
		await access(absolutePath);
	} catch {
		throw new Error(`File not found: ${absolutePath}`);
	}

	const stats = await stat(absolutePath);
	if (stats.size === 0) {
		return { text: "", images: [] };
	}

	const mimeType = await detectSupportedImageMimeTypeFromFile(absolutePath);
	if (mimeType) {
		return processImageFile(absolutePath, mimeType, options);
	}

	return processTextFile(absolutePath);
}

function unquoteToken(token: string): string {
	if (
		token.length >= 2 &&
		((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'")))
	) {
		return token.slice(1, -1);
	}
	return token;
}

function normalizeInteractiveFileToken(token: string): string | null {
	if (!token.startsWith("file://")) {
		return token;
	}

	try {
		return fileURLToPath(token);
	} catch {
		return null;
	}
}

async function tryProcessInteractiveImageToken(
	token: string,
	options?: ProcessFileOptions,
): Promise<ProcessedFiles | undefined> {
	const cwd = options?.cwd ?? process.cwd();
	const unquoted = unquoteToken(token);
	const candidate = unquoted.startsWith("@") ? unquoted.slice(1) : unquoted;
	const normalizedCandidate = normalizeInteractiveFileToken(candidate);
	if (!normalizedCandidate) {
		return undefined;
	}
	if (!candidate) {
		return undefined;
	}
	if (!unquoted.startsWith("@") && !isAbsolute(normalizedCandidate)) {
		return undefined;
	}

	const absolutePath = resolveFileArg(normalizedCandidate, cwd);
	try {
		await access(absolutePath);
	} catch {
		return undefined;
	}

	const stats = await stat(absolutePath);
	if (stats.size === 0) {
		return undefined;
	}

	const mimeType = await detectSupportedImageMimeTypeFromFile(absolutePath);
	if (!mimeType) {
		return undefined;
	}

	return processImageFile(absolutePath, mimeType, options);
}

export async function extractImageAttachmentsFromText(
	text: string,
	options?: ProcessFileOptions,
): Promise<ProcessedFiles> {
	let rewrittenText = "";
	let lastIndex = 0;
	let matchedImage = false;
	const images: ImageContent[] = [];

	for (const match of text.matchAll(TOKEN_REGEX)) {
		const rawToken = match[0];
		const start = match.index ?? 0;
		const processed = await tryProcessInteractiveImageToken(rawToken, options);
		if (!processed) {
			continue;
		}

		matchedImage = true;
		rewrittenText += text.slice(lastIndex, start);
		rewrittenText += processed.text;
		lastIndex = start + rawToken.length;
		images.push(...processed.images);
	}

	if (!matchedImage) {
		return { text, images: [] };
	}

	rewrittenText += text.slice(lastIndex);
	return {
		text: rewrittenText.trim(),
		images,
	};
}

/** Process @file arguments into text content and image attachments */
export async function processFileArguments(fileArgs: string[], options?: ProcessFileOptions): Promise<ProcessedFiles> {
	let text = "";
	const images: ImageContent[] = [];

	for (const fileArg of fileArgs) {
		try {
			const processed = await processFileArgument(fileArg, options);
			text += processed.text;
			images.push(...processed.images);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(chalk.red(`Error: ${message}`));
			process.exit(1);
		}
	}

	return { text, images };
}
