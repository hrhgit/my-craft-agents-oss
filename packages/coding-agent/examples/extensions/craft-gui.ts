/**
 * Craft GUI contribution example.
 *
 * The same extension remains safe in TUI/headless modes: it checks the
 * contribution capability and uses no Craft, DOM, React, or Electron imports.
 */
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";

const contributionId = "craft-gui-example.status";

function publish(ui: ExtensionUIContext, count: number): void {
	if (!ui.capabilities.contributions) return;
	ui.upsertContribution({
		schemaVersion: 1,
		id: contributionId,
		surface: "composer.above",
		priority: 10,
		collapse: "auto",
		overflow: "collapse",
		content: {
			type: "row",
			gap: "small",
			children: [
				{ type: "icon", name: "sparkles", label: "Example extension" },
				{ type: "text", text: `Native Craft contribution updated ${count} time(s)` },
				{
					type: "button",
					label: "Update",
					action: { kind: "command", command: "craft-gui-example-update" },
				},
			],
		},
	});
}

export default function craftGuiExample(pi: ExtensionAPI) {
	let count = 0;
	pi.on("session_start", (_event, ctx) => publish(ctx.ui, count));
	pi.on("session_shutdown", (_event, ctx) => ctx.ui.clearContributions());
	pi.registerCommand("craft-gui-example-update", {
		description: "Update the native Craft GUI example",
		handler: async (_args, ctx) => publish(ctx.ui, ++count),
	});
	pi.registerCommand("craft-gui-example-hide", {
		description: "Remove the native Craft GUI example",
		handler: async (_args, ctx) => ctx.ui.removeContribution(contributionId),
	});
}
