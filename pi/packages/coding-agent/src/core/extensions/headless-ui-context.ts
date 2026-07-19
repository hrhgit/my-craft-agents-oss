/**
 * Headless UI context for extensions running outside an interactive TUI.
 *
 * Used when the agent is embedded in another application (e.g. via RPC or a
 * child-process bridge). Extension UI calls are forwarded to an external
 * consumer via a transport, instead of being rendered in a terminal.
 *
 * This mirrors the behaviour mortise implemented as `createBridgeUIContext`:
 * - notify / setWidget are forwarded as JSONL-style events via the transport
 * - select / confirm / input / editor return safe defaults (interactive
 *   dialogs are expected to be handled via the EventBus `remoteui:request`
 *   event + `transport.onRemoteUI`)
 * - TUI-only methods (setStatus, setFooter, pasteToEditor, ...) are no-ops
 * - theme is a passthrough stub that strips ANSI styling
 */

import type { Component, TUI } from "@mortise/pi-tui";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type {
	AutocompleteProviderFactory,
	EditorFactory,
	ExtensionUIContext,
	ExtensionWidgetOptions,
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
	 * The headless context emits `extension_notify` and `extension_widget`
	 * events; the consumer handles them as it sees fit.
	 */
	send(event: { type: string; [key: string]: unknown }): void;

	/**
	 * Optional handler for `remoteui:request` events.
	 *
	 * Extensions emit `remoteui:request` via the shared EventBus to request
	 * interactive UI (select/confirm/input/editor dialogs). When the host
	 * receives such a request (via `EventBus.on("remoteui:request", ...)`),
	 * it can route it through this callback to resolve the request from the
	 * external consumer.
	 *
	 * The headless UI context itself does not invoke this callback — the host
	 * wires it up alongside the EventBus subscription.
	 */
	onRemoteUI?: (request: { id: string; [key: string]: unknown }) => Promise<unknown>;
}

/** Approximate terminal width used to render component factories headlessly. */
const HEADLESS_RENDER_WIDTH = 120;

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

	// No TUI is available in headless mode; factories receive undefined.
	const stubTui = undefined as unknown as TUI;

	const ctx: ExtensionUIContext = {
		capabilities: {
			kind: "none",
			dialogs: false,
			widgets: true,
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

		setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
			if (typeof content === "function") {
				// Component factory mode: (tui, theme) => Component & { dispose?() }
				try {
					const factory = content as (tui: TUI, theme: Theme) => Component & { dispose?(): void };
					const component = factory(stubTui, stubTheme);
					if (component && typeof component.render === "function") {
						const lines = component.render(HEADLESS_RENDER_WIDTH);
						if (Array.isArray(lines)) {
							transport.send({
								type: "extension_widget",
								key,
								content: lines,
								placement: options?.placement,
								source: "headless",
							});
						}
					}
					// Clean up the factory-produced component if it has a dispose hook.
					if (component && typeof component.dispose === "function") {
						component.dispose();
					}
				} catch {
					// Factory invocation failed; skip this widget update.
				}
			} else {
				// Direct mode: string[] | undefined
				transport.send({
					type: "extension_widget",
					key,
					content: content as string[] | undefined,
					placement: options?.placement,
					source: "headless",
				});
			}
		},

		// ---- UI dialogs (deferred to remoteui:request; safe fallbacks here) ----
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
