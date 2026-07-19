import type { ExtensionAPI } from "@mortise/pi-coding-agent";

export default function manifestV1Example(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.ui.capabilities.contributions) return;
		ctx.ui.upsertContribution({
			schemaVersion: 1,
			id: "manifest-v1-example.status",
			surface: "composer.above",
			content: {
				type: "row",
				gap: "small",
				children: [
					{ type: "icon", name: "check", label: "Manifest compatible" },
					{ type: "text", text: "Manifest V1 extension loaded", tone: "success" },
				],
			},
		});
	});
	pi.on("session_shutdown", (_event, ctx) => ctx.ui.clearContributions());
}
