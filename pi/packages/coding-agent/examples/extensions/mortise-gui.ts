/**
 * Mortise GUI contribution example.
 *
 * The same extension remains safe in TUI/headless modes: it checks the
 * contribution capability and uses no Mortise, DOM, React, or Electron imports.
 */
import type { ExtensionAPI, ExtensionUIContext } from "@mortise/pi-coding-agent";

const contributionId = "mortise-gui-example.status";
const sandboxContributionId = "mortise-gui-example.sandbox";
const sandboxDefinitionId = "mortise-gui-example.sandbox-contract";

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
				{ type: "text", text: `Native Mortise contribution updated ${count} time(s)` },
				{
					type: "button",
					label: "Update",
					action: { kind: "command", command: "mortise-gui-example-update" },
				},
			],
		},
	});
	if (ui.validation.available) {
		ui.validation.upsertDefinition({
			schemaVersion: 1,
			id: "mortise-gui-example.contract",
			contributionId,
			verificationLevel: "semantic",
			readyWhen: ["panel.ready"],
			signals: [{ id: "panel.ready", label: "Example panel ready", status: "ready" }],
			actions: [
				{
					id: "update",
					label: "Update",
					command: "mortise-gui-example-update",
					inputSchema: { type: "object", additionalProperties: false },
				},
			],
			scenarios: [
				{
					id: "count",
					label: "Show a deterministic count",
					command: "mortise-gui-example-scenario-count",
					inputSchema: {
						type: "object",
						required: ["count"],
						properties: { count: { type: "number" } },
						additionalProperties: false,
					},
					teardownCommand: "mortise-gui-example-scenario-reset",
					teardownInputSchema: { type: "object", additionalProperties: false },
				},
			],
			snapshot: {
				id: "status",
				role: "region",
				label: "Mortise GUI example",
				state: { count },
				children: [{ id: "update", role: "button", label: "Update", state: { disabled: false } }],
			},
		});
	}
}

function publishSandbox(ui: ExtensionUIContext, count: number): void {
	if (!ui.capabilities.contributions) return;
	const validationEnabled = ui.validation.available && ui.validation.protocolVersions.includes(1);
	ui.upsertContribution({
		schemaVersion: 1,
		id: sandboxContributionId,
		surface: "composer.above",
		priority: 9,
		collapse: "auto",
		overflow: "collapse",
		content: {
			type: "sandbox-app",
			appId: "validation-counter",
			title: "Sandbox validation counter",
			html: '<main><strong id="count"></strong><button id="increment" type="button">Increment sandbox count</button></main>',
			css: "body{margin:0;font:13px system-ui}main{display:flex;align-items:center;gap:12px;padding:12px}",
			script: `
				const count = document.querySelector('#count');
				const button = document.querySelector('#increment');
				const definition = value => ({
					schemaVersion: 1,
					id: '${sandboxDefinitionId}',
					contributionId: '${sandboxContributionId}',
					verificationLevel: 'semantic',
					readyWhen: ['sandbox.ready'],
					signals: [{ id: 'sandbox.ready', label: 'Sandbox ready', status: 'ready' }],
					actions: [{ id: 'increment', label: 'Increment', command: 'mortise-gui-example-sandbox-increment', inputSchema: { type: 'object', additionalProperties: false } }],
					scenarios: [{
						id: 'count', label: 'Set sandbox count', command: 'mortise-gui-example-sandbox-scenario-count',
						inputSchema: { type: 'object', required: ['count'], properties: { count: { type: 'number' } }, additionalProperties: false },
						teardownCommand: 'mortise-gui-example-sandbox-scenario-reset',
						teardownInputSchema: { type: 'object', additionalProperties: false }
					}],
					snapshot: { id: 'sandbox', role: 'region', label: 'Sandbox validation counter', state: { count: value }, children: [
						{ id: 'increment', role: 'button', label: 'Increment sandbox count', state: { disabled: false } }
					] }
				});
				window.addEventListener('mortiseready', async event => {
					const value = Number(event.detail?.initialState?.count ?? 0);
					count.textContent = 'Sandbox count: ' + value;
					if (window.mortise.validation.capabilities.available) await window.mortise.validation.publish(definition(value));
					await window.mortise.resize(document.body.scrollHeight);
				});
				button.addEventListener('click', () => window.mortise.invokeCommand('mortise-gui-example-sandbox-increment'));
			`,
			initialState: { count },
			minHeight: 80,
			maxHeight: 180,
			preferredHeight: 96,
			permissions: validationEnabled ? ["commands", "resize", "validation"] : ["commands", "resize"],
		},
	});
}

export default function mortiseGuiExample(pi: ExtensionAPI) {
	let count = 0;
	let countBeforeScenario: number | undefined;
	let sandboxCount = 0;
	let sandboxCountBeforeScenario: number | undefined;
	pi.on("session_start", (_event, ctx) => {
		publish(ctx.ui, count);
		publishSandbox(ctx.ui, sandboxCount);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.clearContributions();
		ctx.ui.validation.clearDefinitions();
	});
	pi.registerCommand("mortise-gui-example-update", {
		description: "Update the native Mortise GUI example",
		handler: async (_args, ctx) => publish(ctx.ui, ++count),
	});
	pi.registerCommand("mortise-gui-example-hide", {
		description: "Remove the native Mortise GUI example",
		handler: async (_args, ctx) => ctx.ui.removeContribution(contributionId),
	});
	pi.registerCommand("mortise-gui-example-scenario-count", {
		description: "Set up the deterministic UI validation count scenario",
		handler: async (args, ctx) => {
			const parsed = JSON.parse(args || "{}") as { count?: unknown };
			if (typeof parsed.count !== "number" || !Number.isFinite(parsed.count))
				throw new Error("count must be a finite number");
			countBeforeScenario ??= count;
			count = parsed.count;
			publish(ctx.ui, count);
		},
	});
	pi.registerCommand("mortise-gui-example-scenario-reset", {
		description: "Tear down the deterministic UI validation count scenario",
		handler: async (_args, ctx) => {
			count = countBeforeScenario ?? 0;
			countBeforeScenario = undefined;
			publish(ctx.ui, count);
		},
	});
	pi.registerCommand("mortise-gui-example-sandbox-increment", {
		description: "Increment the sandbox Mortise GUI example",
		handler: async (_args, ctx) => publishSandbox(ctx.ui, ++sandboxCount),
	});
	pi.registerCommand("mortise-gui-example-sandbox-scenario-count", {
		description: "Set up the deterministic sandbox validation count scenario",
		handler: async (args, ctx) => {
			const parsed = JSON.parse(args || "{}") as { count?: unknown };
			if (typeof parsed.count !== "number" || !Number.isFinite(parsed.count))
				throw new Error("count must be a finite number");
			sandboxCountBeforeScenario ??= sandboxCount;
			sandboxCount = parsed.count;
			publishSandbox(ctx.ui, sandboxCount);
		},
	});
	pi.registerCommand("mortise-gui-example-sandbox-scenario-reset", {
		description: "Tear down the deterministic sandbox validation count scenario",
		handler: async (_args, ctx) => {
			sandboxCount = sandboxCountBeforeScenario ?? 0;
			sandboxCountBeforeScenario = undefined;
			publishSandbox(ctx.ui, sandboxCount);
		},
	});
}
