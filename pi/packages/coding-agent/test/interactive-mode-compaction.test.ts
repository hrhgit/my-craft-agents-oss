import { Container } from "@mortise/pi-tui";
import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("InteractiveMode compaction events", () => {
	test("rebuilds chat and appends a synthetic compaction summary at the bottom", async () => {
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			autoCompactionEscapeHandler: undefined as (() => void) | undefined,
			autoCompactionLoader: undefined,
			defaultEditor: {},
			statusContainer: { clear: vi.fn() },
			chatContainer: { clear: vi.fn() },
			rebuildChatFromMessages: vi.fn(),
			addMessageToChat: vi.fn(),
			showError: vi.fn(),
			showStatus: vi.fn(),
			flushCompactionQueue: vi.fn().mockResolvedValue(undefined),
			settingsManager: { getShowTerminalProgress: () => false },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		};

		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: {
				type: "compaction_end";
				reason: "manual" | "threshold" | "overflow";
				result: { tokensBefore: number; summary: string } | undefined;
				aborted: boolean;
				willRetry: boolean;
				errorMessage?: string;
			},
		) => Promise<void>;

		await handleEvent.call(fakeThis, {
			type: "compaction_end",
			reason: "manual",
			result: {
				tokensBefore: 123,
				summary: "summary",
			},
			aborted: false,
			willRetry: false,
		});

		expect(fakeThis.chatContainer.clear).toHaveBeenCalledTimes(1);
		expect(fakeThis.rebuildChatFromMessages).toHaveBeenCalledTimes(1);
		expect(fakeThis.addMessageToChat).toHaveBeenCalledTimes(1);
		expect(fakeThis.addMessageToChat).toHaveBeenCalledWith(
			expect.objectContaining({
				role: "compactionSummary",
				tokensBefore: 123,
				summary: "summary",
			}),
		);
		expect(fakeThis.flushCompactionQueue).toHaveBeenCalledWith({ willRetry: false });
	});

	test("shows explicit retry status text for network retries", async () => {
		initTheme("dark");
		const statusContainer = new Container();
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			retryEscapeHandler: undefined as (() => void) | undefined,
			retryCountdown: undefined,
			retryLoader: undefined,
			retryStatusSummary: undefined,
			defaultEditor: { onEscape: undefined as (() => void) | undefined },
			session: { abortRetry: vi.fn() },
			statusContainer,
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		};

		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: {
				type: "auto_retry_start";
				attempt: number;
				maxAttempts: number;
				delayMs: number;
				errorMessage: string;
				reason?: "network" | "rate_limit" | "server" | "timeout" | "unknown";
				details?: string;
			},
		) => Promise<void>;

		await handleEvent.call(fakeThis, {
			type: "auto_retry_start",
			attempt: 2,
			maxAttempts: 3,
			delayMs: 2000,
			errorMessage:
				"OpenAI API error: Connection error. Cause: Client network socket disconnected before secure TLS connection was established (code=ECONNRESET, port=443)",
			reason: "network",
			details:
				"Client network socket disconnected before secure TLS connection was established (code=ECONNRESET, port=443)",
		});

		expect(statusContainer.children).toHaveLength(2);
		const rendered = statusContainer.children.flatMap((child) => child.render(200)).join("\n");
		expect(rendered).toContain("Network retry");
		expect(rendered).toContain("ECONNRESET");
	});
});
