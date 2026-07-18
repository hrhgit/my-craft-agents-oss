import { describe, expect, it, vi } from "vitest";
import craftGuiExample from "../examples/extensions/craft-gui.ts";
import type { ExtensionAPI, ExtensionUIContext } from "../src/index.ts";

describe("Craft GUI validation example", () => {
	it("publishes a runnable contract and restores scenario state on teardown", async () => {
		const handlers = new Map<string, (args: string, ctx: { ui: ExtensionUIContext }) => Promise<void>>();
		const events = new Map<string, (event: unknown, ctx: { ui: ExtensionUIContext }) => void>();
		const definitions: Array<Record<string, unknown>> = [];
		const contributions: Array<Record<string, unknown>> = [];
		const ui = {
			capabilities: { contributions: true },
			upsertContribution: vi.fn((value: Record<string, unknown>) => contributions.push(value)),
			removeContribution: vi.fn(),
			clearContributions: vi.fn(),
			validation: {
				available: true,
				protocolVersions: [1],
				upsertDefinition: vi.fn((value: Record<string, unknown>) => definitions.push(value)),
				updateState: vi.fn(),
				removeDefinition: vi.fn(),
				clearDefinitions: vi.fn(),
			},
		} as unknown as ExtensionUIContext;
		const pi = {
			on: (name: string, handler: (event: unknown, ctx: { ui: ExtensionUIContext }) => void) =>
				events.set(name, handler),
			registerCommand: (
				name: string,
				command: { handler: (args: string, ctx: { ui: ExtensionUIContext }) => Promise<void> },
			) => handlers.set(name, command.handler),
		} as unknown as ExtensionAPI;

		craftGuiExample(pi);
		events.get("session_start")?.({}, { ui });
		expect(contributions).toHaveLength(2);
		expect(contributions[0]?.content).toBeTruthy();
		expect(contributions[1]).toMatchObject({
			id: "craft-gui-example.sandbox",
			content: { type: "sandbox-app", permissions: ["commands", "resize", "validation"] },
		});
		const initial = definitions.at(-1) as {
			scenarios?: Array<{ teardownCommand?: string }>;
			snapshot?: { state?: { count?: number } };
		};
		expect(initial.scenarios?.[0]?.teardownCommand).toBe("craft-gui-example-scenario-reset");
		expect(initial.snapshot?.state?.count).toBe(0);

		await handlers.get("craft-gui-example-scenario-count")?.(JSON.stringify({ count: 7 }), { ui });
		expect((definitions.at(-1) as { snapshot?: { state?: { count?: number } } }).snapshot?.state?.count).toBe(7);
		await handlers.get("craft-gui-example-scenario-reset")?.("{}", { ui });
		expect((definitions.at(-1) as { snapshot?: { state?: { count?: number } } }).snapshot?.state?.count).toBe(0);
	});
});
