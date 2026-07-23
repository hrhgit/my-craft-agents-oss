/**
 * Headless UI context for extensions running outside an interactive TUI.
 *
 * Used when the agent is embedded in another application (e.g. via RPC or a
 * child-process bridge). Extension UI calls are forwarded to an external
 * consumer via a transport, instead of being rendered in a terminal.
 *
 * - notifications are forwarded as serializable events
 * - contribution and interaction methods report or return unavailable
 * - TUI-only methods (setStatus, setFooter, pasteToEditor, ...) are no-ops
 * - theme is a passthrough stub that strips ANSI styling
 */

import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type {
	AutocompleteProviderFactory,
	EditorFactory,
	ExtensionUIContext,
	WorkingIndicatorOptions,
} from "./types.ts";

/**
 * Transport for forwarding headless extension UI events to an external consumer.
 *
 * The consumer (e.g. a host process embedding Pi via RPC) provides an
 * implementation that routes events to its own UI layer.
 */
export interface HeadlessUITransport {
	/**
	 * Send an extension UI event to the external consumer.
	 *
	 * Events are plain JSON-serialisable objects with a `type` discriminator.
	 * The headless context emits notifications; versioned GUI requires an RPC
	 * host that advertises contribution or interaction capabilities.
	 */
	send(event: { type: string; [key: string]: unknown }): void;
}

/**
 * Create an {@link ExtensionUIContext} that bridges extension UI calls to an
 * external consumer via the given {@link HeadlessUITransport}.
 *
 * This is intended for non-interactive (headless) run modes where no TUI is
 * available: extensions still get a usable `ctx.ui` surface, but UI is either
 * forwarded (notify/setWidget) or safely degraded (dialogs, TUI methods).
 *
 * @example
 * ```ts
 * import { createHeadlessUIContext } from "@mortise/pi-coding-agent";
 *
 * const ui = createHeadlessUIContext({
 *   send(event) {
 *     process.stdout.write(JSON.stringify(event) + "\n");
 *   },
 * });
 * ```
 */
export function createHeadlessUIContext(transport: HeadlessUITransport): ExtensionUIContext {
	// Passthrough theme: strip ANSI styling so the external renderer can treat
	// lines as plain text. Matches the stub used by mortise's createBridgeUIContext.
	const stubTheme = {
		fg: (_name: string, text: string) => text,
		bold: (text: string) => text,
		dim: (text: string) => text,
		italic: (text: string) => text,
		underline: (text: string) => text,
		strikethrough: (text: string) => text,
		bg: (_name: string, text: string) => text,
	} as unknown as Theme;

	const ctx: ExtensionUIContext = {
		capabilities: {
			kind: "none",
			dialogs: false,
			widgets: false,
			customComponents: false,
			terminalInput: false,
			editorControl: false,
			contributions: false,
			interactionSchemas: [],
		},
		validation: {
			available: false,
			protocolVersions: [],
			upsertDefinition(): void {},
			updateState(): void {},
			removeDefinition(): void {},
			clearDefinitions(): void {},
		},
		upsertContribution(): void {},
		removeContribution(): void {},
		clearContributions(): void {},
		interact: async () => ({ schemaVersion: 1, status: "cancelled", reason: "host-disconnected" }),
		// ---- Core bridge methods ----
		notify(message: string, type?: "info" | "warning" | "error"): void {
			transport.send({ type: "extension_notify", message, notificationType: type, source: "headless" });
		},

		setWidget(): void {},

		// ---- UI dialogs are unavailable without a versioned interaction host. ----
		select(): Promise<string | undefined> {
			return Promise.resolve(undefined);
		},
		confirm(): Promise<boolean> {
			return Promise.resolve(false);
		},
		input(): Promise<string | undefined> {
			return Promise.resolve(undefined);
		},
		editor(_title: string, prefill?: string): Promise<string | undefined> {
			return Promise.resolve(prefill);
		},

		// ---- Status / working indicator (no-op without a TUI) ----
		setStatus(): void {},
		setWorkingMessage(): void {},
		setWorkingVisible(): void {},
		setWorkingIndicator(_options?: WorkingIndicatorOptions): void {},
		setHiddenThinkingLabel(): void {},

		// ---- Terminal / editor methods (no TUI available) ----
		onTerminalInput(): () => void {
			return () => {};
		},
		setTitle(): void {},
		pasteToEditor(): void {},
		setEditorText(): void {},
		getEditorText(): string {
			return "";
		},
		setFooter(): void {},
		setHeader(): void {},
		custom<T>(): Promise<T> {
			return Promise.reject(new Error("custom UI not available in headless mode"));
		},
		addAutocompleteProvider(_factory: AutocompleteProviderFactory): void {},
		setEditorComponent(_factory: EditorFactory | undefined): void {},
		getEditorComponent(): EditorFactory | undefined {
			return undefined;
		},

		// ---- Theme (passthrough stub; no real theme switching) ----
		get theme(): Theme {
			return stubTheme;
		},
		getAllThemes(): { name: string; path: string | undefined }[] {
			return [];
		},
		getTheme(): Theme | undefined {
			return undefined;
		},
		setTheme(): { success: boolean; error?: string } {
			return { success: false, error: "Theme switching not available in headless mode" };
		},

		// ---- Tool expansion state ----
		getToolsExpanded(): boolean {
			return false;
		},
		setToolsExpanded(): void {},
	};

	return ctx;
}
