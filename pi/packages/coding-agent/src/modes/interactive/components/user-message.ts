import type { ImageContent, TextContent } from "@mortise/pi-ai/types";
import {
	Box,
	Container,
	getCapabilities,
	getImageDimensions,
	Image,
	imageFallback,
	Markdown,
	type MarkdownTheme,
	Spacer,
	Text,
	type TUI,
} from "@mortise/pi-tui";
import { convertToPng } from "../../../utils/image-convert.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

export interface UserMessageComponentOptions {
	showImages?: boolean;
	imageWidthCells?: number;
	ui?: TUI;
}

/**
 * Component that renders a user message
 */
export class UserMessageComponent extends Container {
	private readonly content: string | (TextContent | ImageContent)[];
	private readonly markdownTheme: MarkdownTheme;
	private readonly ui?: TUI;
	private showImages: boolean;
	private imageWidthCells: number;
	private convertedImages = new Map<number, { data: string; mimeType: string }>();
	private attemptedKittyConversions = new Set<number>();

	constructor(
		content: string | (TextContent | ImageContent)[],
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		options: UserMessageComponentOptions = {},
	) {
		super();
		this.content = content;
		this.markdownTheme = markdownTheme;
		this.ui = options.ui;
		this.showImages = options.showImages ?? true;
		this.imageWidthCells = options.imageWidthCells ?? 60;
		this.rebuild();
		this.maybeConvertImagesForKitty();
	}

	setShowImages(show: boolean): void {
		if (this.showImages === show) {
			return;
		}
		this.showImages = show;
		this.rebuild();
		this.maybeConvertImagesForKitty();
	}

	setImageWidthCells(width: number): void {
		const nextWidth = Math.max(1, Math.floor(width));
		if (this.imageWidthCells === nextWidth) {
			return;
		}
		this.imageWidthCells = nextWidth;
		this.rebuild();
	}

	override invalidate(): void {
		super.invalidate();
		this.rebuild();
	}

	private getContentBlocks(): (TextContent | ImageContent)[] {
		if (typeof this.content === "string") {
			return [{ type: "text", text: this.content }];
		}
		return this.content;
	}

	private getTextContent(): string {
		return this.getContentBlocks()
			.filter((content): content is TextContent => content.type === "text")
			.map((content) => content.text)
			.join("");
	}

	private getDisplayText(): string {
		return this.getTextContent().replace(/<file name="[^"]*">([\s\S]*?)<\/file>/g, "$1");
	}

	private getImageBlocks(): ImageContent[] {
		return this.getContentBlocks().filter((content): content is ImageContent => content.type === "image");
	}

	private getImageIndicator(image: ImageContent): string {
		const dimensions = getImageDimensions(image.data, image.mimeType) ?? undefined;
		return imageFallback(image.mimeType, dimensions);
	}

	private maybeConvertImagesForKitty(): void {
		if (!this.ui || !this.showImages) {
			return;
		}

		const caps = getCapabilities();
		if (caps.images !== "kitty") {
			return;
		}

		const imageBlocks = this.getImageBlocks();
		for (let i = 0; i < imageBlocks.length; i += 1) {
			const image = imageBlocks[i];
			if (!image || image.mimeType === "image/png") {
				continue;
			}
			if (this.convertedImages.has(i) || this.attemptedKittyConversions.has(i)) {
				continue;
			}

			this.attemptedKittyConversions.add(i);
			convertToPng(image.data, image.mimeType).then((converted) => {
				if (!converted) {
					return;
				}
				this.convertedImages.set(i, converted);
				this.rebuild();
				this.ui?.requestRender();
			});
		}
	}

	private rebuild(): void {
		this.clear();

		const displayText = this.getDisplayText();
		const imageBlocks = this.getImageBlocks();
		const caps = getCapabilities();

		const fallbackIndicators: string[] = [];
		const inlineImages: Array<{ data: string; mimeType: string }> = [];

		for (let i = 0; i < imageBlocks.length; i += 1) {
			const image = imageBlocks[i];
			if (!image) {
				continue;
			}

			if (!this.showImages || !caps.images) {
				fallbackIndicators.push(this.getImageIndicator(image));
				continue;
			}

			if (caps.images === "kitty") {
				const converted = this.convertedImages.get(i);
				if (image.mimeType !== "image/png" && !converted) {
					fallbackIndicators.push(this.getImageIndicator(image));
					continue;
				}
				inlineImages.push({
					data: converted?.data ?? image.data,
					mimeType: converted?.mimeType ?? image.mimeType,
				});
				continue;
			}

			inlineImages.push({
				data: image.data,
				mimeType: image.mimeType,
			});
		}

		const hasDisplayText = displayText.trim().length > 0;
		const hasFallbackIndicators = fallbackIndicators.length > 0;
		if (hasDisplayText || hasFallbackIndicators) {
			const contentBox = new Box(1, 1, (content: string) => theme.bg("userMessageBg", content));
			if (hasDisplayText) {
				contentBox.addChild(
					new Markdown(
						displayText,
						0,
						0,
						this.markdownTheme,
						{
							color: (content: string) => theme.fg("userMessageText", content),
						},
						{ preserveOrderedListMarkers: true },
					),
				);
			}
			if (hasFallbackIndicators) {
				if (hasDisplayText) {
					contentBox.addChild(new Spacer(1));
				}
				contentBox.addChild(new Text(theme.fg("userMessageText", fallbackIndicators.join("\n")), 0, 0));
			}
			this.addChild(contentBox);
		}

		for (const image of inlineImages) {
			if (this.children.length > 0) {
				this.addChild(new Spacer(1));
			}
			this.addChild(
				new Image(
					image.data,
					image.mimeType,
					{ fallbackColor: (content: string) => theme.fg("userMessageText", content) },
					{ maxWidthCells: this.imageWidthCells },
				),
			);
		}
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}
}
