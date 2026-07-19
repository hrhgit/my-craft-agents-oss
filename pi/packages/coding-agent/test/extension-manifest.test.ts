import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionManifestV1 } from "../src/core/extension-manifest.ts";
import { DefaultPackageManager, type ResourcePathEntry } from "../src/core/package-manager.ts";
import { type Settings, SettingsManager } from "../src/core/settings-manager.ts";

function manifest(name: string, overrides: Partial<ExtensionManifestV1> = {}): ExtensionManifestV1 {
	return {
		schemaVersion: 1,
		name,
		version: "1.0.0",
		author: { name: "Mortise Test Author", url: "https://example.com/author" },
		publisher: "mortise-tests",
		description: `${name} extension`,
		homepage: "https://example.com/extensions",
		repository: "https://example.com/repository",
		license: "MIT",
		engines: { mortise: "^0.1.0" },
		...overrides,
	};
}

describe("extension manifest v1", () => {
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

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function writeExtension(id: string): string {
		const relativePath = `extensions/${id}.js`;
		writeFileSync(join(agentDir, relativePath), "export default function() {}", "utf8");
		return relativePath;
	}

	async function resolve(entries: ResourcePathEntry[]) {
		const settingsManager = SettingsManager.inMemory({ extensions: entries } as Partial<Settings>);
		return new DefaultPackageManager({
			cwd,
			agentDir,
			settingsManager,
			extensionTarget: "mortise",
			hostVersions: { mortise: "0.1.0" },
		}).resolve();
	}

	it("preserves author, version, declarations, and compatibility metadata", async () => {
		const path = writeExtension("status-panel");
		const extensionManifest = manifest("Status Panel", {
			capabilities: ["ui.contributions", "settings.schema"],
			permissions: ["workspace.files.read"],
		});

		const result = await resolve([{ id: "status-panel", path, targets: ["mortise"], manifest: extensionManifest }]);

		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0]?.metadata).toMatchObject({
			extensionManifest,
			extensionManifestStatus: "compatible",
			extensionManifestDiagnostics: [],
			extensionHostVersion: "0.1.0",
			extensionLoadable: true,
		});
	});

	it("blocks an extension outside its Mortise engine range", async () => {
		const path = writeExtension("future-only");
		const result = await resolve([
			{
				id: "future-only",
				path,
				targets: ["mortise"],
				manifest: manifest("Future Only", { engines: { mortise: ">=2.0.0" } }),
			},
		]);

		expect(result.extensions[0]?.enabled).toBe(false);
		expect(result.extensions[0]?.metadata.extensionManifestStatus).toBe("blocked");
		expect(result.extensions[0]?.metadata.extensionManifestDiagnostics).toContainEqual(
			expect.objectContaining({ code: "host-incompatible", severity: "error" }),
		);
	});

	it("reports duplicate legacy ids as blocked instead of merely legacy", async () => {
		const firstPath = writeExtension("duplicate-first");
		const secondPath = writeExtension("duplicate-second");
		const result = await resolve([
			{ id: "duplicate", path: firstPath, targets: ["mortise"] },
			{ id: "duplicate", path: secondPath, targets: ["mortise"] },
		]);

		const duplicate = result.extensions.find((entry) => entry.path.endsWith("duplicate-second.js"))!;
		expect(duplicate.enabled).toBe(false);
		expect(duplicate.metadata.extensionManifestStatus).toBe("blocked");
		expect(duplicate.metadata.extensionManifestDiagnostics).toContainEqual(
			expect.objectContaining({ code: "duplicate-id", severity: "error" }),
		);
	});

	it("loads required dependencies first and validates their versions", async () => {
		const addonPath = writeExtension("addon");
		const foundationPath = writeExtension("foundation");
		const result = await resolve([
			{
				id: "addon",
				path: addonPath,
				targets: ["mortise"],
				manifest: manifest("Addon", { dependencies: { foundation: "^1.0.0" } }),
			},
			{
				id: "foundation",
				path: foundationPath,
				targets: ["mortise"],
				manifest: manifest("Foundation"),
			},
		]);

		expect(result.extensions.filter((entry) => entry.enabled).map((entry) => basename(entry.path))).toEqual([
			"foundation.js",
			"addon.js",
		]);
	});

	it("blocks missing required dependencies but only warns for optional dependencies", async () => {
		const requiredPath = writeExtension("required-addon");
		const optionalPath = writeExtension("optional-addon");
		const result = await resolve([
			{
				id: "required-addon",
				path: requiredPath,
				targets: ["mortise"],
				manifest: manifest("Required Addon", { dependencies: { absent: "^1.0.0" } }),
			},
			{
				id: "optional-addon",
				path: optionalPath,
				targets: ["mortise"],
				manifest: manifest("Optional Addon", { optionalDependencies: { absent: "^1.0.0" } }),
			},
		]);

		const required = result.extensions.find((entry) => entry.metadata.extensionId === "required-addon")!;
		const optional = result.extensions.find((entry) => entry.metadata.extensionId === "optional-addon")!;
		expect(required.metadata.extensionManifestStatus).toBe("blocked");
		expect(required.metadata.extensionManifestDiagnostics?.[0]?.code).toBe("missing-dependency");
		expect(optional.enabled).toBe(true);
		expect(optional.metadata.extensionManifestStatus).toBe("warning");
		expect(optional.metadata.extensionManifestDiagnostics?.[0]?.code).toBe("optional-dependency-missing");
	});

	it("blocks declared conflicts and required dependency cycles", async () => {
		for (const id of ["base", "conflicting", "cycle-a", "cycle-b"]) writeExtension(id);
		const result = await resolve([
			{ id: "base", path: "extensions/base.js", targets: ["mortise"], manifest: manifest("Base") },
			{
				id: "conflicting",
				path: "extensions/conflicting.js",
				targets: ["mortise"],
				manifest: manifest("Conflicting", { conflicts: { base: "*" } }),
			},
			{
				id: "cycle-a",
				path: "extensions/cycle-a.js",
				targets: ["mortise"],
				manifest: manifest("Cycle A", { dependencies: { "cycle-b": "*" } }),
			},
			{
				id: "cycle-b",
				path: "extensions/cycle-b.js",
				targets: ["mortise"],
				manifest: manifest("Cycle B", { dependencies: { "cycle-a": "*" } }),
			},
		]);

		expect(
			result.extensions.find((entry) => entry.metadata.extensionId === "conflicting")?.metadata
				.extensionManifestDiagnostics,
		).toContainEqual(expect.objectContaining({ code: "conflict" }));
		for (const id of ["cycle-a", "cycle-b"]) {
			expect(
				result.extensions.find((entry) => entry.metadata.extensionId === id)?.metadata.extensionManifestDiagnostics,
			).toContainEqual(expect.objectContaining({ code: "dependency-cycle" }));
		}
	});

	it("uses deterministic load-order hints and warns instead of blocking on hint cycles", async () => {
		for (const id of ["first", "second", "third"]) writeExtension(id);
		const result = await resolve([
			{
				id: "first",
				path: "extensions/first.js",
				targets: ["mortise"],
				manifest: manifest("First", { loadOrder: { after: ["second"] } }),
			},
			{
				id: "second",
				path: "extensions/second.js",
				targets: ["mortise"],
				manifest: manifest("Second", { loadOrder: { after: ["first"] } }),
			},
			{
				id: "third",
				path: "extensions/third.js",
				targets: ["mortise"],
				manifest: manifest("Third", { loadOrder: { priority: 100 } }),
			},
		]);

		expect(result.extensions[0]?.metadata.extensionId).toBe("third");
		for (const id of ["first", "second"]) {
			const entry = result.extensions.find((candidate) => candidate.metadata.extensionId === id)!;
			expect(entry.enabled).toBe(true);
			expect(entry.metadata.extensionManifestDiagnostics).toContainEqual(
				expect.objectContaining({ code: "load-order-cycle", severity: "warning" }),
			);
		}
	});

	it.each([
		["invalid version", { version: "latest" }],
		["missing target engine", { engines: { pi: "^0.1.0" } }],
		["self dependency", { dependencies: { invalid: "^1.0.0" } }],
	])("rejects %s at the strict manifest boundary", async (_label, manifestOverrides) => {
		const path = writeExtension("invalid");
		const entry = {
			id: "invalid",
			path,
			targets: ["mortise"],
			manifest: manifest("Invalid", manifestOverrides as Partial<ExtensionManifestV1>),
		} as ResourcePathEntry;
		await expect(resolve([entry])).rejects.toThrow(/extension manifest/);
	});
});
