import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionTarget } from "../src/core/extensions/index.ts";
import { getExtensionCatalog } from "../src/core/host-facade.ts";
import { DefaultPackageManager, type ResolvedResource } from "../src/core/package-manager.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { type Settings, SettingsManager } from "../src/core/settings-manager.ts";

function extensionNames(resources: ResolvedResource[]): string[] {
	return resources.map((resource) => basename(resource.path)).sort();
}

function extensionModule(commandName: string): string {
	return `export default function(pi) {
	pi.registerCommand("${commandName}", {
		description: "${commandName}",
		handler: async () => {},
	});
}`;
}

describe("extension targets", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `extension-targets-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function createPackageManager(
		settingsManager: SettingsManager,
		extensionTarget: ExtensionTarget,
	): DefaultPackageManager {
		return new DefaultPackageManager({
			cwd,
			agentDir,
			settingsManager,
			extensionTarget,
		});
	}

	it("filters local extension settings by target", async () => {
		const extensionsDir = join(agentDir, "extensions");
		mkdirSync(extensionsDir, { recursive: true });
		for (const name of ["pi-only", "mortise-only", "both", "unmarked"]) {
			writeFileSync(join(extensionsDir, `${name}.js`), "export default function() {}");
		}
		const settingsManager = SettingsManager.inMemory({
			extensions: [
				{ id: "pi-only", path: "extensions/pi-only.js", targets: ["pi"] },
				{ id: "mortise-only", path: "extensions/mortise-only.js", targets: ["mortise"] },
				{ id: "both", path: "extensions/both.js", targets: ["pi", "mortise"] },
			],
		});

		const piResult = await createPackageManager(settingsManager, "pi").resolve();
		const mortiseResult = await createPackageManager(settingsManager, "mortise").resolve();

		expect(extensionNames(piResult.extensions)).toEqual(["both.js", "pi-only.js"]);
		expect(extensionNames(mortiseResult.extensions)).toEqual(["both.js", "mortise-only.js"]);
		const mortiseOnly = mortiseResult.extensions.find((resource) => basename(resource.path) === "mortise-only.js");
		expect(mortiseOnly?.metadata.targets).toEqual(["mortise"]);
		expect(mortiseOnly?.metadata.extensionId).toBe("mortise-only");
	});

	it("rejects the legacy Craft target in local extension settings", async () => {
		const extensionsDir = join(agentDir, "extensions");
		mkdirSync(extensionsDir, { recursive: true });
		writeFileSync(join(extensionsDir, "legacy.js"), "export default function() {}");
		const settings = {
			extensions: [{ id: "legacy", path: "extensions/legacy.js", targets: ["craft"] }],
		} as unknown as Partial<Settings>;

		await expect(createPackageManager(SettingsManager.inMemory(settings), "mortise").resolve()).rejects.toThrow(
			/extension targets must explicitly contain pi, mortise, or both/,
		);
	});

	it("rejects unknown extension targets", async () => {
		const extensionsDir = join(agentDir, "extensions");
		mkdirSync(extensionsDir, { recursive: true });
		writeFileSync(join(extensionsDir, "unknown.js"), "export default function() {}");
		const settings = {
			extensions: [{ id: "unknown", path: "extensions/unknown.js", targets: ["unknown-host"] }],
		} as unknown as Partial<Settings>;

		await expect(createPackageManager(SettingsManager.inMemory(settings), "mortise").resolve()).rejects.toThrow(
			/extension targets must explicitly contain pi, mortise, or both/,
		);
	});

	it.each([
		["string entry", "extensions/unmarked.js"],
		["missing id", { path: "extensions/unmarked.js", targets: ["pi"] }],
		["missing targets", { id: "unmarked", path: "extensions/unmarked.js" }],
	])("rejects %s in extension settings", async (_label, entry) => {
		const extensionsDir = join(agentDir, "extensions");
		mkdirSync(extensionsDir, { recursive: true });
		writeFileSync(join(extensionsDir, "unmarked.js"), "export default function() {}");
		const settingsManager = SettingsManager.inMemory({ extensions: [entry] } as Partial<Settings>);

		await expect(createPackageManager(settingsManager, "pi").resolve()).rejects.toThrow(
			/extension (entries|id|targets)/,
		);
	});

	it("ignores Mortise legacy extension config objects during path discovery", async () => {
		const settings = {
			extensions: {
				"mortise-tool": { enabled: true },
			},
		} as unknown as Partial<Settings>;
		const settingsManager = SettingsManager.inMemory(settings);

		const result = await createPackageManager(settingsManager, "mortise").resolve();

		expect(result.extensions).toEqual([]);
	});

	it("does not auto-discover loose global extension files", async () => {
		const extensionsDir = join(agentDir, "extensions");
		mkdirSync(extensionsDir, { recursive: true });
		writeFileSync(join(extensionsDir, "loose.js"), "export default function() {}");

		const result = await createPackageManager(SettingsManager.inMemory(), "pi").resolve();

		expect(result.extensions).toEqual([]);
	});

	it("reads the host extension catalog without executing extension factories", async () => {
		const extensionsDir = join(agentDir, "extensions");
		mkdirSync(extensionsDir, { recursive: true });
		writeFileSync(join(extensionsDir, "static.js"), "throw new Error('factory executed')");
		writeFileSync(
			join(extensionsDir, "package.json"),
			JSON.stringify({
				pi: {
					extensions: [
						{
							id: "static-catalog",
							path: "./static.js",
							targets: ["mortise"],
							ui: { schemaVersion: 1, title: "Static catalog", category: "ui" },
						},
					],
				},
			}),
		);
		const result = await getExtensionCatalog({ cwd, agentDir, extensionTarget: "mortise" });
		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0]).toMatchObject({ id: "static-catalog", title: "Static catalog", loaded: false });
	});

	it("filters package manifest extension entries by target", async () => {
		const packageDir = join(tempDir, "target-package");
		mkdirSync(join(packageDir, "extensions"), { recursive: true });
		for (const name of ["pi-only", "mortise-only", "both", "unmarked"]) {
			writeFileSync(join(packageDir, "extensions", `${name}.js`), "export default function() {}");
		}
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({
				name: "target-package",
				pi: {
					extensions: [
						{ id: "pi-only", path: "extensions/pi-only.js", targets: ["pi"] },
						{
							id: "mortise-only",
							path: "extensions/mortise-only.js",
							targets: ["mortise"],
							ui: {
								schemaVersion: 1,
								title: "Mortise only",
								category: "ui",
								settings: {
									schemaVersion: 1,
									fields: [{ key: "visible", type: "boolean", label: "Visible", default: true }],
								},
							},
						},
						{ id: "both", path: "extensions/both.js", targets: ["pi", "mortise"] },
					],
				},
			}),
		);

		const settingsManager = SettingsManager.inMemory();
		const piResult = await createPackageManager(settingsManager, "pi").resolveExtensionSources([packageDir]);
		const mortiseResult = await createPackageManager(settingsManager, "mortise").resolveExtensionSources([
			packageDir,
		]);

		expect(extensionNames(piResult.extensions)).toEqual(["both.js", "pi-only.js"]);
		expect(extensionNames(mortiseResult.extensions)).toEqual(["both.js", "mortise-only.js"]);
		expect(
			mortiseResult.extensions.find((resource) => basename(resource.path) === "mortise-only.js")?.metadata
				.extensionUI?.title,
		).toBe("Mortise only");
	});

	it("rejects invalid extension UI schemas at the manifest boundary", async () => {
		const packageDir = join(tempDir, "invalid-ui-package");
		mkdirSync(packageDir, { recursive: true });
		writeFileSync(join(packageDir, "extension.js"), "export default function() {}");
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({
				pi: {
					extensions: [
						{
							id: "invalid-ui",
							path: "extension.js",
							targets: ["mortise"],
							ui: { schemaVersion: 2, settings: { schemaVersion: 1, fields: [] } },
						},
					],
				},
			}),
		);
		const result = await createPackageManager(SettingsManager.inMemory(), "mortise").resolveExtensionSources([
			packageDir,
		]);
		expect(result.extensions).toEqual([]);
	});

	it("preserves ids and targets from convention extension package manifests", async () => {
		const packageDir = join(tempDir, "convention-target-package");
		const piDir = join(packageDir, "extensions", "pi-extension");
		const mortiseDir = join(packageDir, "extensions", "mortise-extension");
		mkdirSync(piDir, { recursive: true });
		mkdirSync(mortiseDir, { recursive: true });
		writeFileSync(join(piDir, "main.js"), "export default function() {}");
		writeFileSync(join(mortiseDir, "main.js"), "export default function() {}");
		writeFileSync(
			join(piDir, "package.json"),
			JSON.stringify({ pi: { extensions: [{ id: "pi-extension", path: "main.js", targets: ["pi"] }] } }),
		);
		writeFileSync(
			join(mortiseDir, "package.json"),
			JSON.stringify({ pi: { extensions: [{ id: "mortise-extension", path: "main.js", targets: ["mortise"] }] } }),
		);

		const settingsManager = SettingsManager.inMemory();
		const piResult = await createPackageManager(settingsManager, "pi").resolveExtensionSources([packageDir]);
		const mortiseResult = await createPackageManager(settingsManager, "mortise").resolveExtensionSources([
			packageDir,
		]);

		expect(piResult.extensions.map((resource) => basename(resource.path))).toEqual(["main.js"]);
		expect(piResult.extensions[0]?.path).toContain("pi-extension");
		expect(piResult.extensions[0]?.metadata.extensionId).toBe("pi-extension");
		expect(mortiseResult.extensions.map((resource) => basename(resource.path))).toEqual(["main.js"]);
		expect(mortiseResult.extensions[0]?.path).toContain("mortise-extension");
		expect(mortiseResult.extensions[0]?.metadata.extensionId).toBe("mortise-extension");
	});

	it("loads only startup extensions matching the resource loader target", async () => {
		const extensionsDir = join(agentDir, "extensions");
		mkdirSync(extensionsDir, { recursive: true });
		writeFileSync(join(extensionsDir, "startup-pi.js"), extensionModule("startup-pi"));
		writeFileSync(join(extensionsDir, "startup-mortise.js"), extensionModule("startup-mortise"));
		writeFileSync(join(extensionsDir, "startup-both.js"), extensionModule("startup-both"));
		writeFileSync(join(extensionsDir, "startup-unmarked.js"), extensionModule("startup-unmarked"));
		const settingsManager = SettingsManager.inMemory({
			extensions: [
				{ id: "startup-pi", path: "extensions/startup-pi.js", activation: "startup", targets: ["pi"] },
				{
					id: "startup-mortise",
					path: "extensions/startup-mortise.js",
					activation: "startup",
					targets: ["mortise"],
				},
				{
					id: "startup-both",
					path: "extensions/startup-both.js",
					activation: "startup",
					targets: ["pi", "mortise"],
				},
			],
		});

		const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, extensionTarget: "mortise" });
		await loader.reload({ phase: "startup" });

		expect(loader.getExtensions().errors).toEqual([]);
		expect(
			loader
				.getExtensions()
				.extensions.map((extension) => basename(extension.path))
				.sort(),
		).toEqual(["startup-both.js", "startup-mortise.js"]);
	});

	it("reports duplicate logical ids for the same target", async () => {
		const extensionsDir = join(agentDir, "extensions");
		mkdirSync(extensionsDir, { recursive: true });
		writeFileSync(join(extensionsDir, "first.js"), extensionModule("first"));
		writeFileSync(join(extensionsDir, "second.js"), extensionModule("second"));
		const settingsManager = SettingsManager.inMemory({
			extensions: [
				{ id: "duplicate", path: "extensions/first.js", targets: ["pi"] },
				{ id: "duplicate", path: "extensions/second.js", targets: ["pi"] },
			],
		});
		const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, extensionTarget: "pi" });

		await loader.reload({ phase: "full" });

		expect(loader.getExtensions().errors).toContainEqual({
			path: join(extensionsDir, "second.js"),
			error: expect.stringContaining('Extension id "duplicate" conflicts'),
		});
	});

	it("provides a stable data directory across Pi and Mortise targets", async () => {
		const extensionsDir = join(agentDir, "extensions");
		mkdirSync(extensionsDir, { recursive: true });
		writeFileSync(
			join(extensionsDir, "environment.js"),
			`export default function(pi) {
	pi.registerCommand("environment", {
		description: JSON.stringify(pi.environment),
		handler: async () => {},
	});
}`,
		);
		const settingsManager = SettingsManager.inMemory({
			extensions: [{ id: "environment", path: "extensions/environment.js", targets: ["pi", "mortise"] }],
		});
		const piLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, extensionTarget: "pi" });
		const mortiseLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, extensionTarget: "mortise" });

		await piLoader.reload({ phase: "full" });
		await mortiseLoader.reload({ phase: "full" });

		const piEnvironment = JSON.parse(
			piLoader.getExtensions().extensions[0]?.commands.get("environment")?.description ?? "{}",
		);
		const mortiseEnvironment = JSON.parse(
			mortiseLoader.getExtensions().extensions[0]?.commands.get("environment")?.description ?? "{}",
		);
		expect(piEnvironment).toMatchObject({ id: "environment", target: "pi" });
		expect(mortiseEnvironment).toMatchObject({ id: "environment", target: "mortise" });
		expect(piEnvironment.dataDir).toBe(join(agentDir, "extension-data", "environment"));
		expect(mortiseEnvironment.dataDir).toBe(piEnvironment.dataDir);
	});

	it("applies the declared target to every entry in a startup extension directory", async () => {
		const bundleDir = join(agentDir, "extensions", "startup-bundle");
		mkdirSync(bundleDir, { recursive: true });
		writeFileSync(join(bundleDir, "pi.js"), extensionModule("bundle-pi"));
		writeFileSync(join(bundleDir, "mortise.js"), extensionModule("bundle-mortise"));
		writeFileSync(
			join(bundleDir, "package.json"),
			JSON.stringify({
				pi: {
					extensions: [
						{ id: "bundle-pi", path: "pi.js", activation: "startup", targets: ["pi"] },
						{ id: "bundle-mortise", path: "mortise.js", activation: "startup", targets: ["mortise"] },
					],
				},
			}),
		);
		const settingsManager = SettingsManager.inMemory({
			extensions: [
				{
					id: "startup-bundle",
					path: "extensions/startup-bundle",
					activation: "startup",
					targets: ["mortise"],
				},
			],
		});

		const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, extensionTarget: "mortise" });
		await loader.reload({ phase: "startup" });

		expect(loader.getExtensions().errors).toEqual([]);
		expect(
			loader
				.getExtensions()
				.extensions.map((extension) => basename(extension.path))
				.sort(),
		).toEqual(["mortise.js", "pi.js"]);
	});
});
