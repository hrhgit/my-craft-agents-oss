/**
 * Vision proxy: image-reading support for models without image input capability.
 *
 * Dual-layer mechanism (product semantics: docs/product-semantics.md
 * "## 模型选择与标签" → 读图代理模型):
 *
 *   B — Turn-level transcription: when a user message contains images and the
 *       active model lacks image input, a configured vision proxy model
 *       describes each image and the description is injected into the turn as
 *       a text block (images are never silently dropped).
 *   A — On-demand inspect tool: the text-only model can call `inspect_image`
 *       (image path + optional question) to get targeted answers from the
 *       proxy model.
 *
 * Both layers share a session-scoped cache keyed by image content hash to
 * prevent duplicate proxy calls: transcription writes the cache, the inspect
 * tool reads it first (cached description + new question = incremental call
 * with the description as context; cached + no question = zero calls).
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentMessage } from "@mortise/pi-agent-core";
import { completeSimple } from "@mortise/pi-ai/stream";
import type { ImageContent, Model, TextContent } from "@mortise/pi-ai/types";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "./extensions/index.ts";
import type { ModelRegistry } from "./model-registry.ts";

/** Instructs the proxy model to produce a description usable by a text-only model. */
const DESCRIBE_PROMPT =
	"Describe this image in detail so that another model that cannot see images can understand it and answer questions about it. " +
	"Include layout, text content, colors, and any notable elements. " +
	"Respond in the same language as the user's message.";

/** Injected when no usable proxy model can be resolved (never silently drop images). */
const NO_PROXY_NOTE =
	"[The user attached an image, but this model does not support image input and no usable vision proxy model is configured for it. " +
	"Tell the user: configure a vision proxy model for this model in Settings → Model → edit this model → 读图代理模型, or describe the image in text.]";

const MAX_CACHE_ENTRIES = 64;
const PROXY_TIMEOUT_MS = 120_000;
const ASSETS_DIR_NAME = "assets";

const MIME_EXTENSIONS: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/jpg": "jpg",
	"image/webp": "webp",
	"image/gif": "gif",
	"image/bmp": "bmp",
};

export interface VisionProxyServiceOptions {
	modelRegistry: ModelRegistry;
	/** Session directory; attached images are persisted under <sessionDir>/assets/. */
	sessionDir?: string;
	/** When true (user disabled image reading), transcription is skipped. */
	isImageReadingBlocked?: () => boolean;
}

function imageHash(image: ImageContent): string {
	return createHash("sha256").update(image.data).digest("hex");
}

function imageExtension(image: ImageContent): string {
	return MIME_EXTENSIONS[image.mimeType] ?? "bin";
}

function textBlock(text: string): TextContent {
	return { type: "text", text };
}

/** Builds the injected block for one transcribed image. */
function descriptionBlock(description: string, imagePath: string): TextContent {
	return textBlock(
		`[Image attachment saved to ${imagePath}]\n<image_description>\n${description}\n</image_description>`,
	);
}

/** Whether the model needs a vision proxy (lacks native image input). */
export function needsVisionProxy(model: Model<any>): boolean {
	return !model.input.includes("image");
}

export class VisionProxyService {
	private readonly cache = new Map<string, string>();
	private readonly options: VisionProxyServiceOptions;

	constructor(options: VisionProxyServiceOptions) {
		this.options = options;
	}

	/** Resolve the configured vision proxy model for the active model, if usable. */
	resolveProxyModel(model: Model<any>): Model<any> | undefined {
		const ref = model.visionProxy;
		if (!ref) return undefined;
		const proxy = this.options.modelRegistry.find(ref.provider, ref.model);
		if (!proxy || !proxy.input.includes("image")) return undefined;
		return proxy;
	}

	/**
	 * Layer B: replace images in user messages with proxy descriptions.
	 *
	 * Runs before every provider request (first turn, tool-loop turns, resumed
	 * attempts) so the transcript the model sees is consistent. Cached
	 * descriptions make re-transcription zero-cost.
	 */
	async transcribeUserImages(messages: AgentMessage[], model: Model<any>): Promise<AgentMessage[]> {
		if (!needsVisionProxy(model)) return messages;
		if (this.options.isImageReadingBlocked?.()) return messages;

		let hasImages = false;
		for (const message of messages) {
			if (message.role !== "user" || !Array.isArray(message.content)) continue;
			if (message.content.some((block) => block.type === "image")) {
				hasImages = true;
				break;
			}
		}
		if (!hasImages) return messages;

		const proxy = this.resolveProxyModel(model);
		const result: AgentMessage[] = [];
		let imageIndex = 0;

		for (const message of messages) {
			if (message.role !== "user" || !Array.isArray(message.content)) {
				result.push(message);
				continue;
			}
			if (!message.content.some((block) => block.type === "image")) {
				result.push(message);
				continue;
			}

			const content: (TextContent | ImageContent)[] = [];
			for (const block of message.content) {
				if (block.type !== "image") {
					content.push(block);
					continue;
				}
				imageIndex += 1;
				if (!proxy) {
					content.push(textBlock(NO_PROXY_NOTE));
					continue;
				}

				const hash = imageHash(block);
				let description = this.cache.get(hash);
				let imagePath: string | undefined;
				if (description === undefined) {
					description = await this.describeImage(proxy, block);
					this.setCacheEntry(hash, description);
					imagePath = await this.persistImage(block, hash, imageIndex);
				}
				content.push(descriptionBlock(description, imagePath ?? this.assetsPathFor(hash, imageIndex)));
			}
			result.push({ ...message, content });
		}
		return result;
	}

	/**
	 * Layer A: on-demand targeted inspection of an image file by the proxy model.
	 *
	 * Cache first: a cached transcription description is reused verbatim when no
	 * question is asked (zero proxy calls); with a question, the cached
	 * description is attached as context so the proxy call is incremental.
	 */
	async inspectImage(
		model: Model<any>,
		params: { path: string; question?: string },
		signal?: AbortSignal,
	): Promise<{ text: string; imagePath?: string; fromCache: boolean }> {
		const proxy = this.resolveProxyModel(model);
		if (!proxy) {
			return {
				text: "No usable vision proxy model is configured for the active model. Configure one in Settings → Model → edit this model → 读图代理模型.",
				fromCache: false,
			};
		}

		let data: string;
		let mimeType = "image/png";
		try {
			const buffer = await readFile(params.path);
			data = buffer.toString("base64");
			mimeType = detectMimeType(params.path) ?? mimeType;
		} catch (error) {
			return {
				text: `Failed to read image file: ${params.path} (${(error as Error).message})`,
				fromCache: false,
			};
		}

		const image: ImageContent = { type: "image", data, mimeType };
		const hash = imageHash(image);
		const cached = this.cache.get(hash);
		const question = params.question?.trim();

		if (cached !== undefined && !question) {
			return { text: cached, imagePath: params.path, fromCache: true };
		}

		const content: (TextContent | ImageContent)[] = [image];
		if (cached !== undefined) {
			content.push(textBlock(`Previous description of this image:\n${cached}`));
		}
		content.push(textBlock(question ? question : DESCRIBE_PROMPT));

		try {
			const description = await this.describeImage(proxy, { content }, signal);
			this.setCacheEntry(hash, description);
			return { text: description, imagePath: params.path, fromCache: false };
		} catch (error) {
			return {
				text: `Vision proxy model failed: ${(error as Error).message}`,
				fromCache: false,
			};
		}
	}

	private async describeImage(
		proxy: Model<any>,
		imageOrContent: ImageContent | { content: (TextContent | ImageContent)[] },
		signal?: AbortSignal,
	): Promise<string> {
		const content =
			"content" in imageOrContent
				? imageOrContent.content
				: ([imageOrContent, textBlock(DESCRIBE_PROMPT)] as (TextContent | ImageContent)[]);
		const auth = await this.options.modelRegistry.getApiKeyAndHeaders(proxy);
		if (!auth.ok) {
			throw new Error(`No API key found for vision proxy model "${proxy.provider}/${proxy.id}"`);
		}
		const response = await completeSimple(
			proxy,
			{ messages: [{ role: "user", content, timestamp: Date.now() }] },
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				timeoutMs: PROXY_TIMEOUT_MS,
				signal,
			},
		);
		const text = response.content
			.filter((block): block is TextContent => block.type === "text")
			.map((block) => block.text)
			.join("\n")
			.trim();
		if (!text) throw new Error("Vision proxy model returned an empty description");
		return text;
	}

	private assetsDir(): string {
		return this.options.sessionDir ? join(this.options.sessionDir, ASSETS_DIR_NAME) : "";
	}

	private assetsPathFor(hash: string, imageIndex: number): string {
		return join(this.assetsDir(), `image-${imageIndex}-${hash.slice(0, 8)}.png`);
	}

	private async persistImage(image: ImageContent, hash: string, imageIndex: number): Promise<string> {
		if (!this.options.sessionDir) return this.assetsPathFor(hash, imageIndex);
		const dir = this.assetsDir();
		const path = join(dir, `image-${imageIndex}-${hash.slice(0, 8)}.${imageExtension(image)}`);
		try {
			await mkdir(dir, { recursive: true });
			await writeFile(path, Buffer.from(image.data, "base64"));
		} catch {
			// Persistence is best-effort: description is still injected.
			return this.assetsPathFor(hash, imageIndex);
		}
		return path;
	}

	private setCacheEntry(hash: string, description: string): void {
		this.cache.set(hash, description);
		if (this.cache.size > MAX_CACHE_ENTRIES) {
			const oldest = this.cache.keys().next().value;
			if (oldest !== undefined) this.cache.delete(oldest);
		}
	}
}

const inspectImageSchema = Type.Object({
	path: Type.String({ minLength: 1 }),
	question: Type.Optional(Type.String()),
});

export type InspectImageParams = Static<typeof inspectImageSchema>;

/** Tool definition for the on-demand image inspection tool (Layer A). */
export function createInspectImageTool(service: VisionProxyService): ToolDefinition<typeof inspectImageSchema> {
	return {
		name: "inspect_image",
		label: "Inspect image",
		description:
			"Analyze an image file with the configured vision proxy model. Use this when the user attached an image " +
			"and you need details beyond the description already injected in the conversation (the image is saved under " +
			"the session assets directory and referenced in the injected image block). Prefer the existing injected " +
			"description first; only call this tool for details it does not cover, and ask a specific question instead " +
			"of requesting a full re-description.",
		parameters: inspectImageSchema,
		promptSnippet: "inspect_image(image path + optional question) — analyze an image with the vision proxy model",
		promptGuidelines: [
			"When the user attaches an image, its description is injected into the conversation automatically. Use that description first.",
			"Call inspect_image only for details the injected description does not cover, and always pass a specific question.",
		],
		execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
			const model = ctx.model;
			if (!model) {
				return {
					content: [textBlock("No active model; cannot resolve a vision proxy model.")],
					details: undefined,
				};
			}
			const result = await service.inspectImage(model, { path: params.path, question: params.question }, signal);
			return {
				content: [
					textBlock(
						result.fromCache
							? `${result.text}\n\n(Reused the transcription already injected in this conversation; no additional vision model call was made.)`
							: result.text,
					),
				],
				details: { imagePath: result.imagePath, fromCache: result.fromCache },
			};
		},
	};
}

function detectMimeType(path: string): string | undefined {
	const lower = path.toLowerCase();
	if (lower.endsWith(".png")) return "image/png";
	if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
	if (lower.endsWith(".webp")) return "image/webp";
	if (lower.endsWith(".gif")) return "image/gif";
	if (lower.endsWith(".bmp")) return "image/bmp";
	return undefined;
}
