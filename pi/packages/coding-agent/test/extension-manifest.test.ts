import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionManifestV1 } from "../src/core/extension-manifest.ts";
import { getExtensionCatalog } from "../src/core/host-facade.ts";
import { type ResourcePathEntry, ResourceResolver } from "../src/core/resource-resolver.ts";
import { type Settings, SettingsManager } from "../src/core/settings-manager.ts";

function manifest(name: string, overrides: Partial<ExtensionManifestV1> = {}): ExtensionManifestV1 {
	return {
		schemaVersion: 1,
		name,
		version: "1.0.0",
		author: { name: "Mortise Test Author", url: "https://example.com/author" },
		publisher: "mortise-tests",
		description: `${name} extension`,
		license: "MIT",
		...overrides,
	};
}

describe("unified Mortise extension manifest", () => {
	let root: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		root = join(tmpdir(), `mortise-extension-manifest-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(root, "agent");
		cwd = join(root, "project");
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	function writeExtension(id: string): string {
		const relativePath = `extensions/${id}.js`;
		writeFileSync(join(agentDir, relativePath), "export default function() {}", "utf8");
		return relativePath;
	}

	async function resolve(entries: ResourcePathEntry[]) {
		const settingsManager = SettingsManager.inMemory({ extensions: entries } as Partial<Settings>);
		return new ResourceResolver({ cwd, agentDir, settingsManager }).resolve();
	}

	it("loads one host-neutral declaration and preserves manifest metadata", async () => {
		const path = writeExtension("status-panel");
		const extensionManifest = manifest("Status Panel", {
			capabilities: ["ui.contributions", "settings.schema"],
			permissions: ["workspace.files.read"],
		});

		const result = await resolve([{ id: "status-panel", path, manifest: extensionManifest }]);

		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0]?.metadata).toMatchObject({
			extensionManifest,
			extensionManifestStatus: "compatible",
			extensionManifestDiagnostics: [],
			extensionLoadable: true,
		});
		expect(result.extensions[0]?.metadata).not.toHaveProperty("targets");
		expect(result.extensions[0]?.metadata).not.toHaveProperty("extensionHostVersion");
	});

	it("accepts core tool identifiers in subagent templates", async () => {
		const path = writeExtension("subagent-templates");
		const extensionManifest = manifest("Subagent Templates", {
			subagents: [
				{
					id: "reviewer",
					name: "Reviewer",
					description: "Reviews changes",
					systemPrompt: "Review changes carefully.",
					tools: ["read", "subagent", "mcp__session__config_validate"],
				},
			],
		});

		const result = await resolve([{ id: "subagent-templates", path, manifest: extensionManifest }]);

		expect(result.extensions[0]?.metadata.extensionManifest?.subagents).toEqual(extensionManifest.subagents);
	});

	it.each([
		["targets", { id: "invalid", path: "extensions/invalid.js", targets: ["mortise"] }],
		[
			"engines",
			{
				id: "invalid",
				path: "extensions/invalid.js",
				manifest: { ...manifest("Invalid"), engines: { mortise: "*" } },
			},
		],
	])("rejects the removed %s field", async (_field, entry) => {
		writeExtension("invalid");
		await expect(resolve([entry as unknown as ResourcePathEntry])).rejects.toThrow(/unknown fields/);
	});

	it("loads required dependencies first and validates their versions", async () => {
		const addonPath = writeExtension("addon");
		const foundationPath = writeExtension("foundation");
		const result = await resolve([
			{ id: "addon", path: addonPath, manifest: manifest("Addon", { dependencies: { foundation: "^1.0.0" } }) },
			{ id: "foundation", path: foundationPath, manifest: manifest("Foundation") },
		]);

		expect(result.extensions.filter((entry) => entry.enabled).map((entry) => basename(entry.path))).toEqual([
			"foundation.js",
			"addon.js",
		]);
	});

	it("resolves a unique capability provider and orders it before the consumer", async () => {
		for (const id of ["consumer", "provider"]) writeExtension(id);
		const operation = {
			inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
			outputSchema: { type: "object", properties: { hits: { type: "array" } }, required: ["hits"] },
		};
		const result = await resolve([
			{
				id: "consumer",
				path: "extensions/consumer.js",
				manifest: manifest("Consumer", {
					uses: { search: { capability: "search.query", version: "^1.0.0", facets: ["service"] } },
				}),
			},
			{
				id: "provider",
				path: "extensions/provider.js",
				manifest: manifest("Provider", {
					provides: {
						"search.query": { version: "1.2.0", scope: "session", service: { operations: { query: operation } } },
					},
				}),
			},
		]);

		expect(result.extensions.filter((entry) => entry.enabled).map((entry) => entry.metadata.extensionId)).toEqual([
			"provider",
			"consumer",
		]);
		expect(
			result.extensions.find((entry) => entry.metadata.extensionId === "consumer")?.metadata
				.extensionCapabilityBindings,
		).toEqual([
			expect.objectContaining({
				alias: "search",
				status: "bound",
				providerExtensionId: "provider",
				providerVersion: "1.2.0",
				scope: "session",
			}),
		]);
	});

	it("blocks ambiguous required capabilities and degrades optional missing capabilities", async () => {
		for (const id of ["consumer", "optional", "provider-a", "provider-b"]) writeExtension(id);
		const provides = {
			"search.query": {
				version: "1.0.0",
				scope: "workspace" as const,
				service: { operations: { query: { inputSchema: {}, outputSchema: {} } } },
			},
		};
		const result = await resolve([
			{ id: "provider-a", path: "extensions/provider-a.js", manifest: manifest("A", { provides }) },
			{ id: "provider-b", path: "extensions/provider-b.js", manifest: manifest("B", { provides }) },
			{
				id: "consumer",
				path: "extensions/consumer.js",
				manifest: manifest("Consumer", { uses: { search: { capability: "search.query", version: "*" } } }),
			},
			{
				id: "optional",
				path: "extensions/optional.js",
				manifest: manifest("Optional", {
					uses: { knowledge: { capability: "knowledge.read", version: "^1.0.0", required: false } },
				}),
			},
		]);
		const consumer = result.extensions.find((entry) => entry.metadata.extensionId === "consumer")!;
		const optional = result.extensions.find((entry) => entry.metadata.extensionId === "optional")!;
		expect(consumer.enabled).toBe(false);
		expect(consumer.metadata.extensionManifestDiagnostics).toContainEqual(
			expect.objectContaining({ code: "capability-provider-ambiguous", severity: "error" }),
		);
		expect(optional.enabled).toBe(true);
		expect(optional.metadata.extensionCapabilityBindings).toContainEqual(
			expect.objectContaining({ alias: "knowledge", status: "missing", required: false }),
		);
	});

	it("propagates a required capability cycle failure to downstream consumers", async () => {
		for (const id of ["cycle-a", "cycle-b", "downstream"]) writeExtension(id);
		const service = { operations: { run: { inputSchema: {}, outputSchema: {} } } };
		const result = await resolve([
			{
				id: "cycle-a",
				path: "extensions/cycle-a.js",
				manifest: manifest("Cycle A", {
					provides: { "cycle.a": { version: "1.0.0", scope: "session", service } },
					uses: { b: { capability: "cycle.b", version: "*" } },
				}),
			},
			{
				id: "cycle-b",
				path: "extensions/cycle-b.js",
				manifest: manifest("Cycle B", {
					provides: { "cycle.b": { version: "1.0.0", scope: "session", service } },
					uses: { a: { capability: "cycle.a", version: "*" } },
				}),
			},
			{
				id: "downstream",
				path: "extensions/downstream.js",
				manifest: manifest("Downstream", { uses: { a: { capability: "cycle.a", version: "*" } } }),
			},
		]);

		for (const id of ["cycle-a", "cycle-b"]) {
			expect(
				result.extensions.find((entry) => entry.metadata.extensionId === id)?.metadata.extensionManifestDiagnostics,
			).toContainEqual(expect.objectContaining({ code: "capability-dependency-cycle", severity: "error" }));
		}
		const downstream = result.extensions.find((entry) => entry.metadata.extensionId === "downstream")!;
		expect(downstream.enabled).toBe(false);
		expect(downstream.metadata.extensionCapabilityBindings).toContainEqual(
			expect.objectContaining({ alias: "a", status: "missing", required: true }),
		);
	});

	it("accepts a fixed provider and rejects missing UI capability references", async () => {
		for (const id of ["consumer", "provider-a", "provider-b", "invalid-ui"]) writeExtension(id);
		const provide = {
			version: "1.0.0",
			scope: "global" as const,
			service: { operations: { read: { inputSchema: {}, outputSchema: {} } } },
		};
		const result = await resolve([
			{
				id: "provider-a",
				path: "extensions/provider-a.js",
				manifest: manifest("A", { provides: { "knowledge.read": provide } }),
			},
			{
				id: "provider-b",
				path: "extensions/provider-b.js",
				manifest: manifest("B", { provides: { "knowledge.read": provide } }),
			},
			{
				id: "consumer",
				path: "extensions/consumer.js",
				manifest: manifest("Consumer", {
					uses: { knowledge: { capability: "knowledge.read", version: "*", provider: "provider-b" } },
				}),
			},
			{
				id: "invalid-ui",
				path: "extensions/invalid-ui.js",
				manifest: manifest("Invalid UI", {
					provides: { "ui.result": { version: "1.0.0", scope: "session", ui: { modules: ["result"] } } },
				}),
			},
		]);
		expect(
			result.extensions.find((entry) => entry.metadata.extensionId === "consumer")?.metadata
				.extensionCapabilityBindings,
		).toContainEqual(expect.objectContaining({ status: "bound", providerExtensionId: "provider-b" }));
		expect(
			result.extensions.find((entry) => entry.metadata.extensionId === "invalid-ui")?.metadata
				.extensionManifestDiagnostics,
		).toContainEqual(expect.objectContaining({ code: "capability-ui-reference-missing" }));
	});

	it("blocks missing dependencies and declared conflicts", async () => {
		for (const id of ["base", "missing", "conflicting"]) writeExtension(id);
		const result = await resolve([
			{ id: "base", path: "extensions/base.js", manifest: manifest("Base") },
			{
				id: "missing",
				path: "extensions/missing.js",
				manifest: manifest("Missing", { dependencies: { absent: "^1.0.0" } }),
			},
			{
				id: "conflicting",
				path: "extensions/conflicting.js",
				manifest: manifest("Conflicting", { conflicts: { base: "*" } }),
			},
		]);

		expect(
			result.extensions.find((entry) => entry.metadata.extensionId === "missing")?.metadata
				.extensionManifestDiagnostics,
		).toContainEqual(expect.objectContaining({ code: "missing-dependency", severity: "error" }));
		expect(
			result.extensions.find((entry) => entry.metadata.extensionId === "conflicting")?.metadata
				.extensionManifestDiagnostics,
		).toContainEqual(expect.objectContaining({ code: "conflict", severity: "error" }));
	});

	it("keeps deterministic load ordering and warns on hint cycles", async () => {
		for (const id of ["first", "second", "third"]) writeExtension(id);
		const result = await resolve([
			{
				id: "first",
				path: "extensions/first.js",
				manifest: manifest("First", { loadOrder: { after: ["second"] } }),
			},
			{
				id: "second",
				path: "extensions/second.js",
				manifest: manifest("Second", { loadOrder: { after: ["first"] } }),
			},
			{ id: "third", path: "extensions/third.js", manifest: manifest("Third", { loadOrder: { priority: 100 } }) },
		]);

		expect(result.extensions[0]?.metadata.extensionId).toBe("third");
		for (const id of ["first", "second"]) {
			expect(
				result.extensions.find((entry) => entry.metadata.extensionId === id)?.metadata.extensionManifestDiagnostics,
			).toContainEqual(expect.objectContaining({ code: "load-order-cycle", severity: "warning" }));
		}
	});

	it("exposes a host-neutral catalog without executing extension factories", async () => {
		const extensionPath = join(agentDir, "extensions", "static.js");
		writeFileSync(extensionPath, "throw new Error('factory executed')", "utf8");
		writeFileSync(
			join(agentDir, "extensions", "package.json"),
			JSON.stringify({
				pi: {
					extensions: [
						{
							id: "static-catalog",
							path: "./static.js",
							manifest: manifest("Static Catalog"),
							ui: { schemaVersion: 1, title: "Static catalog", category: "ui" },
						},
					],
				},
			}),
			"utf8",
		);

		const result = await getExtensionCatalog({ cwd, agentDir });
		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0]).toMatchObject({ id: "static-catalog", title: "Static catalog", loaded: false });
		expect(result.extensions[0]).not.toHaveProperty("target");
		expect(result.extensions[0]).not.toHaveProperty("hostVersion");
	});

	it("discovers V1 and V2 UI declarations side by side", async () => {
		const packageDir = join(agentDir, "extensions");
		writeFileSync(join(packageDir, "legacy.js"), "export default function() {}", "utf8");
		writeFileSync(join(packageDir, "modern.js"), "export default function() {}", "utf8");
		mkdirSync(join(packageDir, "dist", "ui"), { recursive: true });
		writeFileSync(join(packageDir, "dist", "ui", "toolbar.js"), "export default { mount() {} }", "utf8");
		writeFileSync(join(packageDir, "dist", "ui", "toolbar.css"), ".toolbar {}", "utf8");
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({
				pi: {
					extensions: [
						{ id: "legacy-ui", path: "./legacy.js", ui: { schemaVersion: 1, title: "Legacy" } },
						{
							id: "modern-ui",
							path: "./modern.js",
							ui: {
								schemaVersion: 2,
								title: "Modern",
								compatibility: { uiApi: "^2.0.0", mortise: ">=0.1.0 <0.2.0" },
								frontends: [
									{
										id: "toolbar",
										entry: "./dist/ui/toolbar.js",
										styles: ["./dist/ui/toolbar.css"],
										surface: "composer.toolbar",
										mode: "append",
										scope: "session",
									},
								],
							},
						},
					],
				},
			}),
			"utf8",
		);

		const result = await getExtensionCatalog({ cwd, agentDir });
		expect(result.errors).toEqual([]);
		expect(result.extensions.map((entry) => [entry.id, entry.ui?.schemaVersion])).toEqual([
			["legacy-ui", 1],
			["modern-ui", 2],
		]);
		expect(result.extensions[1]).toMatchObject({ frontendLoadable: true, frontendDiagnostics: [] });
	});

	it.each([
		[
			"ui-api-version-mismatch",
			{ compatibility: { uiApi: "^3.0.0", mortise: ">=0.1.0 <0.2.0" }, entry: "./frontend.js" },
		],
		[
			"frontend-resource-missing",
			{ compatibility: { uiApi: "^2.0.0", mortise: ">=0.1.0 <0.2.0" }, entry: "./missing.js" },
		],
		[
			"invalid-ui-manifest",
			{ compatibility: { uiApi: "^2.0.0", mortise: ">=0.1.0 <0.2.0" }, entry: "./../outside.js" },
		],
		[
			"frontend-entry-mime-invalid",
			{ compatibility: { uiApi: "^2.0.0", mortise: ">=0.1.0 <0.2.0" }, entry: "./frontend.css" },
		],
	])("keeps the backend enabled when V2 frontend validation reports %s", async (code, input) => {
		const packageDir = join(agentDir, "extensions");
		writeFileSync(join(packageDir, "backend.js"), "export default function() {}", "utf8");
		writeFileSync(join(packageDir, "frontend.js"), "export default { mount() {} }", "utf8");
		writeFileSync(join(packageDir, "frontend.css"), ".frontend {}", "utf8");
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({
				pi: {
					extensions: [
						{
							id: "frontend-failure",
							path: "./backend.js",
							ui: {
								schemaVersion: 2,
								compatibility: input.compatibility,
								frontends: [
									{
										id: "toolbar",
										entry: input.entry,
										surface: "composer.toolbar",
										mode: "append",
										scope: "session",
									},
								],
							},
						},
					],
				},
			}),
			"utf8",
		);

		const resolved = await new ResourceResolver({
			cwd,
			agentDir,
			settingsManager: SettingsManager.inMemory(),
		}).resolve();
		const extension = resolved.extensions[0];
		expect(extension?.enabled).toBe(true);
		expect(extension?.metadata.extensionFrontendLoadable).toBe(false);
		expect(extension?.metadata.extensionFrontendDiagnostics).toContainEqual(expect.objectContaining({ code }));
	});

	it("accepts module-only UI manifests and validates module resources", async () => {
		const packageDir = join(agentDir, "extensions", "module-kit");
		mkdirSync(join(packageDir, "dist"), { recursive: true });
		writeFileSync(join(packageDir, "index.js"), "export default function() {}", "utf8");
		writeFileSync(join(packageDir, "dist", "components.js"), "export default {}", "utf8");
		writeFileSync(join(packageDir, "dist", "components.css"), ".kit {}", "utf8");
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({
				pi: {
					extensions: [
						{
							id: "module-kit",
							path: "./index.js",
							manifest: manifest("Module Kit"),
							ui: {
								schemaVersion: 2,
								compatibility: { uiApi: "^2.0.0", mortise: ">=0.1.0 <0.2.0" },
								modules: [
									{
										id: "components",
										entry: "./dist/components.js",
										styles: ["./dist/components.css"],
										apiVersion: "1.0.0",
									},
								],
							},
						},
					],
				},
			}),
			"utf8",
		);
		const result = await resolve([{ id: "module-kit", path: "extensions/module-kit" }]);
		expect(result.extensions[0]?.metadata.extensionFrontendDiagnostics).toEqual([]);
		expect(result.extensions[0]?.metadata.extensionUI).toMatchObject({
			modules: [{ id: "components", apiVersion: "1.0.0" }],
		});
	});
});
