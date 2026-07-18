import { Container } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

function renderAll(container: Container, width = 120): string {
	return container.children.flatMap((child) => child.render(width)).join("\n");
}

describe("InteractiveMode user image rendering", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("renders image-only user messages instead of skipping them", () => {
		const fakeThis: any = {
			chatContainer: new Container(),
			editor: { addToHistory: vi.fn() },
			toolOutputExpanded: false,
			settingsManager: {
				getCodeBlockIndent: () => 0,
				getShowImages: () => true,
				getImageWidthCells: () => 60,
			},
			ui: { requestRender: vi.fn() },
		};

		fakeThis.getMarkdownThemeWithSettings = () =>
			Reflect.get(InteractiveMode.prototype, "getMarkdownThemeWithSettings").call(fakeThis);
		fakeThis.getUserMessageText = (message: unknown) =>
			Reflect.get(InteractiveMode.prototype, "getUserMessageText").call(fakeThis, message);
		fakeThis.getUserMessageImages = (message: unknown) =>
			Reflect.get(InteractiveMode.prototype, "getUserMessageImages").call(fakeThis, message);
		fakeThis.createUserMessageDisplayContent = (text: string, images: unknown[]) =>
			Reflect.get(InteractiveMode.prototype, "createUserMessageDisplayContent").call(fakeThis, text, images);

		const addMessageToChat = Reflect.get(InteractiveMode.prototype, "addMessageToChat") as (
			this: typeof fakeThis,
			message: {
				role: "user";
				content: Array<{ type: "image"; data: string; mimeType: string }>;
				timestamp: number;
			},
			options?: { populateHistory?: boolean },
		) => void;

		addMessageToChat.call(fakeThis, {
			role: "user",
			content: [{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }],
			timestamp: Date.now(),
		});

		expect(fakeThis.chatContainer.children.length).toBeGreaterThan(0);
		expect(renderAll(fakeThis.chatContainer)).toContain("[Image: [image/png] 1x1]");
	});
});
