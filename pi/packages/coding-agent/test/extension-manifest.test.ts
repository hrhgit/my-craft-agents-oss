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
					tools: ["read", "spawn_session", "mcp__session__config_validate"],
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
});
