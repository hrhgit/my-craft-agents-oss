/**
 * Headless UI context for extensions running outside an interactive TUI.
 *
 * Used when the agent is embedded in another application (e.g. via RPC or a
 * child-process bridge). Extension UI calls are forwarded to an external
 * consumer via a transport, instead of being rendered in a terminal.
 *
 * - notifications are forwarded as serializable events
 * - contribution and interaction methods report or return unavailable
 */

import type { ExtensionUIContext } from "./types.ts";

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
 * forwarded or explicitly unavailable.
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
	const ctx: ExtensionUIContext = {
		capabilities: {
			kind: "none",
			dialogs: false,
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
	};

	return ctx;
}
