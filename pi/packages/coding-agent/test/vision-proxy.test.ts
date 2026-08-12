import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ImageContent, Model } from "@mortise/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import { createInspectImageTool, needsVisionProxy, VisionProxyService } from "../src/core/vision-proxy.ts";

const { completeSimpleMock } = vi.hoisted(() => ({ completeSimpleMock: vi.fn() }));

vi.mock("@mortise/pi-ai/stream", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@mortise/pi-ai/stream")>();
	return { ...actual, completeSimple: completeSimpleMock };
});

function makeModel(overrides: Partial<Model<any>> = {}): Model<any> {
	return {
		id: "text-model",
		name: "Text Model",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
		...overrides,
	} as Model<any>;
}

function makeImage(
	data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
): ImageContent {
	return { type: "image", data, mimeType: "image/png" };
}

function makeAssistantResponse(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "vision-model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function makeRegistry(models: Model<any>[]): ModelRegistry {
	return {
		find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
		getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: "test-key" }),
	} as unknown as ModelRegistry;
}

function userMessage(blocks: Array<{ type: "text"; text: string } | ImageContent>) {
	return { role: "user" as const, content: blocks, timestamp: Date.now() };
}

type UserContent = Array<{ type: "text"; text: string } | ImageContent>;

describe("needsVisionProxy", () => {
	it("is false when the model supports image input", () => {
		expect(needsVisionProxy(makeModel({ input: ["text", "image"] }))).toBe(false);
	});

	it("is true when the model lacks image input", () => {
		expect(needsVisionProxy(makeModel({ input: ["text"] }))).toBe(true);
	});
});

describe("VisionProxyService.resolveProxyModel", () => {
	const vision = makeModel({ id: "vision-model", name: "Vision", input: ["text", "image"] });
	const registry = makeRegistry([vision]);

	it("returns the configured proxy when it exists and supports images", () => {
		const service = new VisionProxyService({ modelRegistry: registry });
		const proxy = service.resolveProxyModel(
			makeModel({ visionProxy: { provider: "anthropic", model: "vision-model" } }),
		);
		expect(proxy?.id).toBe("vision-model");
	});

	it("returns undefined when no proxy is configured", () => {
		const service = new VisionProxyService({ modelRegistry: registry });
		expect(service.resolveProxyModel(makeModel())).toBeUndefined();
	});

	it("returns undefined when the proxy model does not exist", () => {
		const service = new VisionProxyService({ modelRegistry: registry });
		expect(
			service.resolveProxyModel(makeModel({ visionProxy: { provider: "anthropic", model: "ghost" } })),
		).toBeUndefined();
	});

	it("returns undefined when the proxy model lacks image input", () => {
		const registry = makeRegistry([makeModel({ id: "vision-model", input: ["text"] })]);
		const service = new VisionProxyService({ modelRegistry: registry });
		expect(
			service.resolveProxyModel(makeModel({ visionProxy: { provider: "anthropic", model: "vision-model" } })),
		).toBeUndefined();
	});
});

describe("VisionProxyService.transcribeUserImages", () => {
	let sessionDir: string;
	let vision: Model<any>;
	let textModel: Model<any>;
	let registry: ModelRegistry;
	let service: VisionProxyService;

	beforeEach(() => {
		sessionDir = mkdtempSync(join(tmpdir(), "pi-vision-proxy-"));
		vision = makeModel({ id: "vision-model", name: "Vision", input: ["text", "image"] });
		textModel = makeModel({ visionProxy: { provider: "anthropic", model: "vision-model" } });
		registry = makeRegistry([vision]);
		service = new VisionProxyService({ modelRegistry: registry, sessionDir });
		completeSimpleMock.mockReset();
		completeSimpleMock.mockResolvedValue(makeAssistantResponse("A red circle on a white background."));
	});

	afterEach(() => {
		rmSync(sessionDir, { recursive: true, force: true });
	});

	it("passes messages through unchanged when the model supports images", async () => {
		const messages = [userMessage([{ type: "text", text: "hi" }, makeImage()])];
		const result = await service.transcribeUserImages(messages, makeModel({ input: ["text", "image"] }));
		expect(result).toEqual(messages);
		expect(completeSimpleMock).not.toHaveBeenCalled();
	});

	it("passes messages through unchanged when there are no images", async () => {
		const messages = [userMessage([{ type: "text", text: "hi" }])];
		const result = await service.transcribeUserImages(messages, textModel);
		expect(result).toEqual(messages);
		expect(completeSimpleMock).not.toHaveBeenCalled();
	});

	it("injects a no-proxy note instead of silently dropping images", async () => {
		const noProxyModel = makeModel();
		const messages = [userMessage([{ type: "text", text: "hi" }, makeImage()])];
		const result = await service.transcribeUserImages(messages, noProxyModel);
		expect(completeSimpleMock).not.toHaveBeenCalled();
		const content = (result[0] as { content: UserContent }).content;
		expect(content).toHaveLength(2);
		expect((content[1] as { type: "text"; text: string }).text).toContain("vision proxy model");
	});

	it("describes images with the proxy model and injects a text block", async () => {
		const messages = [userMessage([{ type: "text", text: "hi" }, makeImage()])];
		const result = await service.transcribeUserImages(messages, textModel);
		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		const content = (result[0] as { content: UserContent }).content;
		const block = content[1] as { type: "text"; text: string };
		expect(block.text).toContain("<image_description>");
		expect(block.text).toContain("A red circle on a white background.");
		expect(block.text).toContain("[Image attachment saved to");
		expect(block.text).toContain("assets");
	});

	it("reuses the cache on a second transcription (zero extra proxy calls)", async () => {
		const messages = [userMessage([{ type: "text", text: "hi" }, makeImage()])];
		await service.transcribeUserImages(messages, textModel);
		await service.transcribeUserImages(messages, textModel);
		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
	});

	it("persists the image under the session assets directory", async () => {
		const messages = [userMessage([{ type: "text", text: "hi" }, makeImage()])];
		await service.transcribeUserImages(messages, textModel);
		const assets = join(sessionDir, "assets");
		expect(existsSync(assets)).toBe(true);
		const files = require("node:fs").readdirSync(assets) as string[];
		expect(files.length).toBe(1);
		expect(files[0]).toMatch(/^image-1-[0-9a-f]{8}\.png$/);
	});

	it("skips transcription when image reading is blocked", async () => {
		const blocked = new VisionProxyService({
			modelRegistry: registry,
			sessionDir,
			isImageReadingBlocked: () => true,
		});
		const messages = [userMessage([{ type: "text", text: "hi" }, makeImage()])];
		const result = await blocked.transcribeUserImages(messages, textModel);
		expect(result).toEqual(messages);
		expect(completeSimpleMock).not.toHaveBeenCalled();
	});
});

describe("VisionProxyService.inspectImage", () => {
	let sessionDir: string;
	let vision: Model<any>;
	let textModel: Model<any>;
	let registry: ModelRegistry;
	let service: VisionProxyService;
	let imagePath: string;

	beforeEach(() => {
		sessionDir = mkdtempSync(join(tmpdir(), "pi-vision-inspect-"));
		vision = makeModel({ id: "vision-model", name: "Vision", input: ["text", "image"] });
		textModel = makeModel({ visionProxy: { provider: "anthropic", model: "vision-model" } });
		registry = makeRegistry([vision]);
		service = new VisionProxyService({ modelRegistry: registry, sessionDir });
		imagePath = join(sessionDir, "sample.png");
		// The file content must match makeImage()'s base64 data so inspect and
		// transcription share the same content hash (shared cache).
		require("node:fs").writeFileSync(imagePath, Buffer.from(makeImage().data, "base64"));
		completeSimpleMock.mockReset();
		completeSimpleMock.mockResolvedValue(makeAssistantResponse("A red circle on a white background."));
	});

	afterEach(() => {
		rmSync(sessionDir, { recursive: true, force: true });
	});

	it("returns an error text when no proxy model is configured", async () => {
		const result = await service.inspectImage(makeModel(), { path: imagePath });
		expect(result.text).toContain("No usable vision proxy model");
		expect(completeSimpleMock).not.toHaveBeenCalled();
	});

	it("returns an error text when the file cannot be read", async () => {
		const result = await service.inspectImage(textModel, { path: join(sessionDir, "missing.png") });
		expect(result.text).toContain("Failed to read image file");
		expect(completeSimpleMock).not.toHaveBeenCalled();
	});

	it("reuses the transcription cache when no question is asked (zero proxy calls)", async () => {
		const messages = [userMessage([{ type: "text", text: "hi" }, makeImage()])];
		await service.transcribeUserImages(messages, textModel);
		completeSimpleMock.mockClear();
		const result = await service.inspectImage(textModel, { path: imagePath });
		expect(result.fromCache).toBe(true);
		expect(result.text).toContain("A red circle on a white background.");
		expect(completeSimpleMock).not.toHaveBeenCalled();
	});

	it("calls the proxy with the cached description as context when a question is asked", async () => {
		const messages = [userMessage([{ type: "text", text: "hi" }, makeImage()])];
		await service.transcribeUserImages(messages, textModel);
		completeSimpleMock.mockClear();
		const result = await service.inspectImage(textModel, { path: imagePath, question: "What color is it?" });
		expect(result.fromCache).toBe(false);
		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		const content = completeSimpleMock.mock.calls[0][1].messages[0].content as Array<{ type: string; text?: string }>;
		const text = content
			.filter((c) => c.type === "text")
			.map((c) => c.text)
			.join("\n");
		expect(text).toContain("Previous description of this image");
		expect(text).toContain("A red circle on a white background.");
		expect(text).toContain("What color is it?");
	});

	it("calls the proxy directly when nothing is cached", async () => {
		const result = await service.inspectImage(textModel, { path: imagePath, question: "Any text?" });
		expect(result.fromCache).toBe(false);
		expect(result.text).toContain("A red circle on a white background.");
		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
	});
});

describe("createInspectImageTool", () => {
	it("defines the inspect_image tool with path and optional question", () => {
		const service = new VisionProxyService({ modelRegistry: makeRegistry([]) });
		const tool = createInspectImageTool(service);
		expect(tool.name).toBe("inspect_image");
		expect(tool.parameters).toBeDefined();
		expect(tool.description).toContain("vision proxy");
	});

	it("executes against the current context model", async () => {
		const vision = makeModel({ id: "vision-model", name: "Vision", input: ["text", "image"] });
		const textModel = makeModel({ visionProxy: { provider: "anthropic", model: "vision-model" } });
		const service = new VisionProxyService({ modelRegistry: makeRegistry([vision]) });
		const dir = mkdtempSync(join(tmpdir(), "pi-vision-tool-"));
		const imagePath = join(dir, "shot.png");
		require("node:fs").writeFileSync(imagePath, Buffer.from(makeImage().data, "base64"));
		completeSimpleMock.mockReset();
		completeSimpleMock.mockResolvedValue(makeAssistantResponse("A cat."));
		const tool = createInspectImageTool(service);
		const result = await tool.execute(
			"call-1",
			{ path: imagePath, question: "What is this?" },
			undefined,
			undefined,
			{
				model: textModel,
			} as never,
		);
		expect(result.content[0]).toMatchObject({ type: "text", text: "A cat." });
		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		rmSync(dir, { recursive: true, force: true });
	});
});
