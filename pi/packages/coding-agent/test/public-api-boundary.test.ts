import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadExtensions } from "../src/core/extensions/loader.ts";
import * as hostFacade from "../src/core/host-facade.ts";
import * as extensionApi from "../src/extension-api.ts";
import * as rootApi from "../src/index.ts";
import * as internalHostFacade from "../src/internal/host-facade.ts";

const RAW_EXECUTION_EXPORTS = [
	"createAgentSession",
	"SessionManager",
	"createAllToolDefinitions",
	"createAllTools",
	"createBashTool",
	"createBashToolDefinition",
	"createCodingTools",
	"createCodingToolDefinitions",
	"createEditTool",
	"createEditToolDefinition",
	"createFindTool",
	"createFindToolDefinition",
	"createGrepTool",
	"createGrepToolDefinition",
	"createLsTool",
	"createLsToolDefinition",
	"createReadOnlyTools",
	"createReadOnlyToolDefinitions",
	"createReadTool",
	"createReadToolDefinition",
	"createTool",
	"createToolDefinition",
	"createWebFetchTool",
	"createWebFetchToolDefinition",
	"createWriteTool",
	"createWriteToolDefinition",
	"withFileMutationQueue",
] as const;

describe("public runtime API boundaries", () => {
	it("does not expose raw Session or built-in tool execution through the Extension API", () => {
		for (const symbol of RAW_EXECUTION_EXPORTS) {
			expect(extensionApi).not.toHaveProperty(symbol);
		}
	});

	it("does not expose built-in tool execution factories on the root API", () => {
		for (const symbol of RAW_EXECUTION_EXPORTS) {
			expect(rootApi).not.toHaveProperty(symbol);
		}
	});

	it("keeps raw Session and tool execution behind the Mortise-internal facade", () => {
		for (const symbol of RAW_EXECUTION_EXPORTS) {
			expect(hostFacade).not.toHaveProperty(symbol);
		}
		expect(internalHostFacade).toHaveProperty("SessionManager");
		expect(internalHostFacade).toHaveProperty("createAllToolDefinitions");
	});

	it("marks the embedded coding runtime package as private", () => {
		const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
			private?: boolean;
			exports?: Record<string, unknown>;
		};
		expect(manifest.private).toBe(true);
		expect(manifest.exports?.["./rpc"]).toBeUndefined();
		expect(manifest.exports?.["./internal/rpc"]).toBeDefined();
	});

	it("loads the package name through the restricted Extension API", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "mortise-extension-api-boundary-"));
		const extensionPath = join(tempDir, "boundary-extension.ts");
		const forbidden = JSON.stringify(RAW_EXECUTION_EXPORTS);
		writeFileSync(
			extensionPath,
			`import * as api from "@mortise/pi-coding-agent";
			const forbidden = ${forbidden};
			export default function extension(pi) {
				if ("exec" in pi) throw new Error("Extension API exposed direct process execution");
				for (const symbol of forbidden) {
					if (symbol in api) throw new Error(\`Extension API exposed \${symbol}\`);
				}
				if (typeof api.defineTool !== "function") throw new Error("Restricted Extension helpers are unavailable");
				pi.registerCommand("boundary-ok", { handler: async () => {} });
			}
			`,
			"utf8",
		);

		try {
			const metadata = new Map([[extensionPath, { id: "boundary-extension", agentDir: tempDir }]]);
			const result = await loadExtensions([extensionPath], tempDir, undefined, undefined, metadata);
			expect(result.errors).toEqual([]);
			expect(result.extensions).toHaveLength(1);
			expect(result.extensions[0]?.commands.has("boundary-ok")).toBe(true);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("does not resolve the raw Agent engine for Extensions", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "mortise-extension-agent-boundary-"));
		const extensionPath = join(tempDir, "raw-agent-extension.ts");
		writeFileSync(
			extensionPath,
			`import { Agent } from "@mortise/pi-agent-core";
			export default function extension() {
				if (Agent) throw new Error("Raw Agent engine resolved");
			}
			`,
			"utf8",
		);

		try {
			const metadata = new Map([[extensionPath, { id: "raw-agent-extension", agentDir: tempDir }]]);
			const result = await loadExtensions([extensionPath], tempDir, undefined, undefined, metadata);
			expect(result.extensions).toEqual([]);
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0]?.error).not.toContain("Raw Agent engine resolved");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it.each([
		"@mortise/pi-coding-agent/rpc",
		"@mortise/pi-coding-agent/internal/rpc",
		"@mortise/pi-coding-agent/host-facade",
		"@mortise/pi-coding-agent/internal/host-facade",
	])("does not resolve host-only package subpath %s for Extensions", async (specifier) => {
		const tempDir = mkdtempSync(join(tmpdir(), "mortise-extension-host-boundary-"));
		const extensionPath = join(tempDir, "host-boundary-extension.ts");
		writeFileSync(
			extensionPath,
			`import * as api from ${JSON.stringify(specifier)};
			export default function extension() {
				if (api) throw new Error("Host-only package subpath resolved");
			}
			`,
			"utf8",
		);

		try {
			const metadata = new Map([[extensionPath, { id: "host-boundary-extension", agentDir: tempDir }]]);
			const result = await loadExtensions([extensionPath], tempDir, undefined, undefined, metadata);
			expect(result.extensions).toEqual([]);
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0]?.error).not.toContain("Host-only package subpath resolved");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("resolves Extension imports only through the dedicated Extension API", () => {
		const loaderSource = readFileSync(
			fileURLToPath(new URL("../src/core/extensions/loader.ts", import.meta.url)),
			"utf8",
		);

		expect(loaderSource).not.toContain('"@mortise/pi-agent-core"');
		expect(loaderSource).toContain('path.join(packageDir, "dist", "extension-api.js")');
		expect(loaderSource).not.toContain('path.join(packageDir, "dist", "index.js")');
	});
});
