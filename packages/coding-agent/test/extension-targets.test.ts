import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionTarget } from "../src/core/extensions/index.ts";
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
		for (const name of ["pi-only", "craft-only", "both", "unmarked"]) {
			writeFileSync(join(extensionsDir, `${name}.js`), "export default function() {}");
		}
		const settingsManager = SettingsManager.inMemory({
			extensions: [
				{ id: "pi-only", path: "extensions/pi-only.js", targets: ["pi"] },
				{ id: "craft-only", path: "extensions/craft-only.js", targets: ["craft"] },
				{ id: "both", path: "extensions/both.js", targets: ["pi", "craft"] },
			],
		});

		const piResult = await createPackageManager(settingsManager, "pi").resolve();
		const craftResult = await createPackageManager(settingsManager, "craft").resolve();

		expect(extensionNames(piResult.extensions)).toEqual(["both.js", "pi-only.js"]);
		expect(extensionNames(craftResult.extensions)).toEqual(["both.js", "craft-only.js"]);
		const craftOnly = craftResult.extensions.find((resource) => basename(resource.path) === "craft-only.js");
		expect(craftOnly?.metadata.targets).toEqual(["craft"]);
		expect(craftOnly?.metadata.extensionId).toBe("craft-only");
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

	it("ignores Craft legacy extension config objects during path discovery", async () => {
		const settings = {
			extensions: {
				"craft-tool": { enabled: true },
			},
		} as unknown as Partial<Settings>;
		const settingsManager = SettingsManager.inMemory(settings);

		const result = await createPackageManager(settingsManager, "craft").resolve();

		expect(result.extensions).toEqual([]);
	});

	it("does not auto-discover loose global extension files", async () => {
		const extensionsDir = join(agentDir, "extensions");
		mkdirSync(extensionsDir, { recursive: true });
		writeFileSync(join(extensionsDir, "loose.js"), "export default function() {}");

		const result = await createPackageManager(SettingsManager.inMemory(), "pi").resolve();

		expect(result.extensions).toEqual([]);
	});

	it("filters package manifest extension entries by target", async () => {
		const packageDir = join(tempDir, "target-package");
		mkdirSync(join(packageDir, "extensions"), { recursive: true });
		for (const name of ["pi-only", "craft-only", "both", "unmarked"]) {
			writeFileSync(join(packageDir, "extensions", `${name}.js`), "export default function() {}");
		}
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({
				name: "target-package",
				pi: {
					extensions: [
						{ id: "pi-only", path: "extensions/pi-only.js", targets: ["pi"] },
						{ id: "craft-only", path: "extensions/craft-only.js", targets: ["craft"] },
						{ id: "both", path: "extensions/both.js", targets: ["pi", "craft"] },
					],
				},
			}),
		);

		const settingsManager = SettingsManager.inMemory();
		const piResult = await createPackageManager(settingsManager, "pi").resolveExtensionSources([packageDir]);
		const craftResult = await createPackageManager(settingsManager, "craft").resolveExtensionSources([packageDir]);

		expect(extensionNames(piResult.extensions)).toEqual(["both.js", "pi-only.js"]);
		expect(extensionNames(craftResult.extensions)).toEqual(["both.js", "craft-only.js"]);
	});

	it("preserves ids and targets from convention extension package manifests", async () => {
		const packageDir = join(tempDir, "convention-target-package");
		const piDir = join(packageDir, "extensions", "pi-extension");
		const craftDir = join(packageDir, "extensions", "craft-extension");
		mkdirSync(piDir, { recursive: true });
		mkdirSync(craftDir, { recursive: true });
		writeFileSync(join(piDir, "main.js"), "export default function() {}");
		writeFileSync(join(craftDir, "main.js"), "export default function() {}");
		writeFileSync(
			join(piDir, "package.json"),
			JSON.stringify({ pi: { extensions: [{ id: "pi-extension", path: "main.js", targets: ["pi"] }] } }),
		);
		writeFileSync(
			join(craftDir, "package.json"),
			JSON.stringify({ pi: { extensions: [{ id: "craft-extension", path: "main.js", targets: ["craft"] }] } }),
		);

		const settingsManager = SettingsManager.inMemory();
		const piResult = await createPackageManager(settingsManager, "pi").resolveExtensionSources([packageDir]);
		const craftResult = await createPackageManager(settingsManager, "craft").resolveExtensionSources([packageDir]);

		expect(piResult.extensions.map((resource) => basename(resource.path))).toEqual(["main.js"]);
		expect(piResult.extensions[0]?.path).toContain("pi-extension");
		expect(piResult.extensions[0]?.metadata.extensionId).toBe("pi-extension");
		expect(craftResult.extensions.map((resource) => basename(resource.path))).toEqual(["main.js"]);
		expect(craftResult.extensions[0]?.path).toContain("craft-extension");
		expect(craftResult.extensions[0]?.metadata.extensionId).toBe("craft-extension");
	});

	it("loads only startup extensions matching the resource loader target", async () => {
		const extensionsDir = join(agentDir, "extensions");
		mkdirSync(extensionsDir, { recursive: true });
		writeFileSync(join(extensionsDir, "startup-pi.js"), extensionModule("startup-pi"));
		writeFileSync(join(extensionsDir, "startup-craft.js"), extensionModule("startup-craft"));
		writeFileSync(join(extensionsDir, "startup-both.js"), extensionModule("startup-both"));
		writeFileSync(join(extensionsDir, "startup-unmarked.js"), extensionModule("startup-unmarked"));
		const settingsManager = SettingsManager.inMemory({
			extensions: [
				{ id: "startup-pi", path: "extensions/startup-pi.js", activation: "startup", targets: ["pi"] },
				{ id: "startup-craft", path: "extensions/startup-craft.js", activation: "startup", targets: ["craft"] },
				{
					id: "startup-both",
					path: "extensions/startup-both.js",
					activation: "startup",
					targets: ["pi", "craft"],
				},
			],
		});

		const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, extensionTarget: "craft" });
		await loader.reload({ phase: "startup" });

		expect(loader.getExtensions().errors).toEqual([]);
		expect(
			loader
				.getExtensions()
				.extensions.map((extension) => basename(extension.path))
				.sort(),
		).toEqual(["startup-both.js", "startup-craft.js"]);
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

	it("provides a stable data directory across Pi and Craft targets", async () => {
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
			extensions: [{ id: "environment", path: "extensions/environment.js", targets: ["pi", "craft"] }],
		});
		const piLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, extensionTarget: "pi" });
		const craftLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, extensionTarget: "craft" });

		await piLoader.reload({ phase: "full" });
		await craftLoader.reload({ phase: "full" });

		const piEnvironment = JSON.parse(
			piLoader.getExtensions().extensions[0]?.commands.get("environment")?.description ?? "{}",
		);
		const craftEnvironment = JSON.parse(
			craftLoader.getExtensions().extensions[0]?.commands.get("environment")?.description ?? "{}",
		);
		expect(piEnvironment).toMatchObject({ id: "environment", target: "pi" });
		expect(craftEnvironment).toMatchObject({ id: "environment", target: "craft" });
		expect(piEnvironment.dataDir).toBe(join(agentDir, "extension-data", "environment"));
		expect(craftEnvironment.dataDir).toBe(piEnvironment.dataDir);
	});

	it("applies the declared target to every entry in a startup extension directory", async () => {
		const bundleDir = join(agentDir, "extensions", "startup-bundle");
		mkdirSync(bundleDir, { recursive: true });
		writeFileSync(join(bundleDir, "pi.js"), extensionModule("bundle-pi"));
		writeFileSync(join(bundleDir, "craft.js"), extensionModule("bundle-craft"));
		writeFileSync(
			join(bundleDir, "package.json"),
			JSON.stringify({
				pi: {
					extensions: [
						{ id: "bundle-pi", path: "pi.js", activation: "startup", targets: ["pi"] },
						{ id: "bundle-craft", path: "craft.js", activation: "startup", targets: ["craft"] },
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
					targets: ["craft"],
				},
			],
		});

		const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, extensionTarget: "craft" });
		await loader.reload({ phase: "startup" });

		expect(loader.getExtensions().errors).toEqual([]);
		expect(
			loader
				.getExtensions()
				.extensions.map((extension) => basename(extension.path))
				.sort(),
		).toEqual(["craft.js", "pi.js"]);
	});
});
