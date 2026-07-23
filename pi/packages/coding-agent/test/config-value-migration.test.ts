import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { readGlobalModelsFile, saveGlobalProvider } from "../src/core/host-facade.ts";
import { runMigrations } from "../src/migrations.ts";

describe("retired credential migrations", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	function createAgentDir(): string {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-retired-credential-migration-test-"));
		tempDirs.push(agentDir);
		return agentDir;
	}

	function withAgentDir(agentDir: string, fn: () => void): void {
		const previousAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = agentDir;
		try {
			fn();
		} finally {
			if (previousAgentDir === undefined) {
				delete process.env[ENV_AGENT_DIR];
			} else {
				process.env[ENV_AGENT_DIR] = previousAgentDir;
			}
		}
	}

	it("does not import oauth.json or settings.apiKeys into auth.json", () => {
		const agentDir = createAgentDir();
		const oauth = `${JSON.stringify({ github: { access: "access", refresh: "refresh", expires: 1 } }, null, 2)}\n`;
		const settings = `${JSON.stringify({ theme: "dark", apiKeys: { anthropic: "legacy-key" } }, null, 2)}\n`;
		fs.writeFileSync(path.join(agentDir, "oauth.json"), oauth, "utf-8");
		fs.writeFileSync(path.join(agentDir, "settings.json"), settings, "utf-8");

		withAgentDir(agentDir, () => runMigrations(agentDir));

		expect(fs.existsSync(path.join(agentDir, "auth.json"))).toBe(false);
		expect(fs.existsSync(path.join(agentDir, "oauth.json.migrated"))).toBe(false);
		expect(fs.readFileSync(path.join(agentDir, "oauth.json"), "utf-8")).toBe(oauth);
		expect(fs.readFileSync(path.join(agentDir, "settings.json"), "utf-8")).toBe(settings);
	});

	it("does not rewrite implicit environment variable syntax", () => {
		const agentDir = createAgentDir();
		const auth = `${JSON.stringify({ anthropic: { type: "api_key", key: "ANTHROPIC_API_KEY" } }, null, 2)}\n`;
		const models = `${JSON.stringify(
			{
				providers: {
					custom: {
						baseUrl: "https://example.com/v1",
						api: "openai-completions",
						apiKey: "CUSTOM_API_KEY",
						headers: { "x-api-key": "HEADER_API_KEY" },
						models: [{ id: "model-a" }],
					},
				},
			},
			null,
			2,
		)}\n`;
		fs.writeFileSync(path.join(agentDir, "auth.json"), auth, "utf-8");
		fs.writeFileSync(path.join(agentDir, "models.json"), models, "utf-8");

		withAgentDir(agentDir, () => runMigrations(agentDir));

		expect(fs.readFileSync(path.join(agentDir, "auth.json"), "utf-8")).toBe(auth);
		expect(fs.readFileSync(path.join(agentDir, "models.json"), "utf-8")).toBe(models);
	});

	it("does not read an embedded provider apiKey", () => {
		const agentDir = createAgentDir();

		withAgentDir(agentDir, () => {
			saveGlobalProvider({
				key: "custom",
				provider: {
					baseUrl: "https://example.com/v1",
					api: "openai-completions",
					models: [{ id: "model-a" }],
					apiKey: "retired-provider-key",
				},
			});
			expect(readGlobalModelsFile().providers?.custom).not.toHaveProperty("apiKey");
		});

		expect(fs.existsSync(path.join(agentDir, "auth.json"))).toBe(false);
	});
});
