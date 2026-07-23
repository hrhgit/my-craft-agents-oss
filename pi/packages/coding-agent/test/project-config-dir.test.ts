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

describe("project config directory isolation", () => {
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

	it("keeps standalone Pi on .pi by default", async () => {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ theme: "standalone" }));
		const manager = SettingsManager.create(cwd, agentDir);

		expect(manager.getProjectSettings()).toMatchObject({ theme: "standalone" });
		manager.setProjectSkillPaths(["standalone-skill"]);
		await manager.flush();
		expect(JSON.parse(readFileSync(join(cwd, ".pi", "settings.json"), "utf8"))).toMatchObject({
			theme: "standalone",
			skills: ["standalone-skill"],
		});
	});

	it("uses the process project directory before an RPC runtime is opened", () => {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		mkdirSync(join(cwd, ".mortise"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ theme: "pi-only" }));
		writeFileSync(join(cwd, ".mortise", "settings.json"), JSON.stringify({ theme: "mortise-only" }));
		const previous = process.env.PI_CODING_AGENT_PROJECT_DIR;
		process.env.PI_CODING_AGENT_PROJECT_DIR = ".mortise";
		try {
			const manager = SettingsManager.create(cwd, agentDir);
			expect(manager.getProjectSettings()).toMatchObject({ theme: "mortise-only" });
		} finally {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_PROJECT_DIR;
			else process.env.PI_CODING_AGENT_PROJECT_DIR = previous;
		}
	});

	it("loads and writes only the explicit Mortise project directory", async () => {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		mkdirSync(join(cwd, ".mortise"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "settings.json"),
			JSON.stringify({
				theme: "pi-only",
				extensions: [{ id: "pi-only", path: "extensions/pi-only.ts", targets: ["mortise"] }],
			}),
		);
		writeFileSync(
			join(cwd, ".mortise", "settings.json"),
			JSON.stringify({
				theme: "mortise-only",
				extensions: [{ id: "mortise-only", path: "extensions/mortise-only.ts", targets: ["mortise"] }],
			}),
		);
		writeSkill(join(cwd, ".pi"), "pi-only");
		writeSkill(join(cwd, ".mortise"), "mortise-only");
		mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
		mkdirSync(join(cwd, ".mortise", "extensions"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "extensions", "pi-only.ts"), "export default function () {}\n");
		writeFileSync(join(cwd, ".mortise", "extensions", "mortise-only.ts"), "export default function () {}\n");

		const manager = SettingsManager.create(cwd, agentDir, ".mortise");
		expect(manager.getProjectSettings()).toMatchObject({ theme: "mortise-only" });
		manager.setProjectSkillPaths(["mortise-skill"]);
		await manager.flush();

		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			projectConfigDir: ".mortise",
			settingsManager: manager,
			extensionTarget: "mortise",
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();
		const names = loader.getSkills().skills.map((skill) => skill.name);
		const extensionIds = loader.getExtensions().extensions.map((extension) => extension.id);

		expect(names).toContain("mortise-only");
		expect(names).not.toContain("pi-only");
		expect(extensionIds).toContain("mortise-only");
		expect(extensionIds).not.toContain("pi-only");
		expect(JSON.parse(readFileSync(join(cwd, ".pi", "settings.json"), "utf8"))).toMatchObject({
			theme: "pi-only",
		});
		expect(JSON.parse(readFileSync(join(cwd, ".mortise", "settings.json"), "utf8"))).toMatchObject({
			theme: "mortise-only",
			skills: ["mortise-skill"],
		});
	});
});
