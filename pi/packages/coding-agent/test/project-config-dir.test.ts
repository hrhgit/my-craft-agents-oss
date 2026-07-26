import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

function writeSkill(root: string, name: string): void {
	const dir = join(root, "skills", name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} description\n---\n${name} body\n`);
}

describe("Mortise project config isolation", () => {
	let root: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		root = join(tmpdir(), `project-config-dir-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(root, "workspace");
		agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("uses .mortise by default and never reads or writes .pi", async () => {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		mkdirSync(join(cwd, ".mortise"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ skills: ["pi-only"] }));
		writeFileSync(join(cwd, ".mortise", "settings.json"), JSON.stringify({ skills: ["mortise-only"] }));

		const manager = SettingsManager.create(cwd, agentDir);
		expect(manager.getProjectSettings()).toMatchObject({ skills: ["mortise-only"] });
		manager.setProjectSkillPaths(["updated-mortise"]);
		await manager.flush();

		expect(JSON.parse(readFileSync(join(cwd, ".pi", "settings.json"), "utf8"))).toEqual({ skills: ["pi-only"] });
		expect(JSON.parse(readFileSync(join(cwd, ".mortise", "settings.json"), "utf8"))).toMatchObject({
			skills: ["updated-mortise"],
		});
	});

	it("loads resources only from the Mortise project root", async () => {
		const piRoot = join(cwd, ".pi");
		const mortiseRoot = join(cwd, ".mortise");
		writeSkill(piRoot, "pi-only");
		writeSkill(mortiseRoot, "mortise-only");
		mkdirSync(join(piRoot, "extensions"), { recursive: true });
		mkdirSync(join(mortiseRoot, "extensions"), { recursive: true });
		writeFileSync(join(piRoot, "extensions", "pi-only.ts"), "export default function () {}\n");
		writeFileSync(join(mortiseRoot, "extensions", "mortise-only.ts"), "export default function () {}\n");
		writeFileSync(
			join(mortiseRoot, "settings.json"),
			JSON.stringify({
				extensions: [{ id: "mortise-only", path: "extensions/mortise-only.ts", targets: ["mortise"] }],
			}),
		);

		const manager = SettingsManager.create(cwd, agentDir);
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: manager,
			extensionTarget: "mortise",
			noPromptTemplates: true,
			noContextFiles: true,
		});
		await loader.reload();

		const skillNames = loader.getSkills().skills.map((skill) => skill.name);
		const extensionIds = loader.getExtensions().extensions.map((extension) => extension.id);
		expect(skillNames).toContain("mortise-only");
		expect(skillNames).not.toContain("pi-only");
		expect(extensionIds).toContain("mortise-only");
		expect(extensionIds).not.toContain("pi-only");
	});
});
