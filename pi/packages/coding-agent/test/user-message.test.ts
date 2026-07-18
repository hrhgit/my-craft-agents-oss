import { describe, expect, test } from "vitest";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const BG_RESET = "\x1b[49m";
const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

describe("UserMessageComponent", () => {
	test("keeps user message height stable while moving closing OSC markers off line end", () => {
		initTheme("dark");

		const component = new UserMessageComponent("hello");
		const lines = component.render(20);

		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain(OSC133_ZONE_START);
		expect(lines[0].endsWith(BG_RESET)).toBe(true);
		expect(lines[0]).not.toContain(OSC133_ZONE_END);
		expect(lines[1]).toContain("hello");
		expect(lines[2].startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
		expect(lines[2].endsWith(BG_RESET)).toBe(true);
	});

	test("shows a visible image fallback when the message only contains an image", () => {
		initTheme("dark");

		const component = new UserMessageComponent([
			{
				type: "image",
				data: TINY_PNG_BASE64,
				mimeType: "image/png",
			},
		]);
		const rendered = component.render(40).join("\n");

		expect(rendered).toContain("[Image: [image/png] 1x1]");
	});

	test("strips raw file tags from displayed text while keeping the image visible", () => {
		initTheme("dark");

		const component = new UserMessageComponent([
			{
				type: "text",
				text: '<file name="/tmp/pasted.png"></file>',
			},
			{
				type: "image",
				data: TINY_PNG_BASE64,
				mimeType: "image/png",
			},
		]);
		const rendered = component.render(60).join("\n");

		expect(rendered).toContain("[Image: [image/png] 1x1]");
		expect(rendered).not.toContain("<file name=");
	});
});
