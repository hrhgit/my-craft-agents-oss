import { describe, expect, it } from "vitest";
import type { ExtensionManifestV1 } from "../src/core/extension-manifest.ts";
import { type ExtensionServiceError, ExtensionServiceRegistry } from "../src/core/extensions/service-registry.ts";

const operation = {
	inputSchema: {
		type: "object",
		properties: { query: { type: "string" } },
		required: ["query"],
		additionalProperties: false,
	},
	outputSchema: {
		type: "object",
		properties: { result: { type: "string" } },
		required: ["result"],
		additionalProperties: false,
	},
};

function manifest(overrides: Partial<ExtensionManifestV1>): ExtensionManifestV1 {
	return { schemaVersion: 1, name: "Test", version: "1.0.0", author: { name: "Test" }, ...overrides };
}

describe("ExtensionServiceRegistry", () => {
	it("invokes a declared service through an alias with schema validation and progress", async () => {
		const registry = new ExtensionServiceRegistry({ runtimeId: "runtime-1" });
		registry.declareExtension(
			"provider",
			manifest({
				provides: {
					"search.query": { version: "1.0.0", scope: "session", service: { operations: { query: operation } } },
				},
			}),
		);
		registry.declareExtension(
			"consumer",
			manifest({ uses: { search: { capability: "search.query", version: "^1.0.0", facets: ["service"] } } }),
		);
		registry.provide("provider", "search.query", {
			query: (input, ctx) => {
				ctx.reportProgress({ completed: 1, total: 1 });
				return { result: (input as { query: string }).query.toUpperCase() };
			},
		});
		const progress: unknown[] = [];
		await expect(
			registry
				.use("consumer", "search")
				.invoke(
					"query",
					{ query: "mortise" },
					{ runtimeId: "runtime-1", onProgress: (item) => progress.push(item) },
				),
		).resolves.toEqual({ result: "MORTISE" });
		expect(progress).toEqual([{ completed: 1, total: 1 }]);
		await expect(registry.use("consumer", "search").invoke("query", { query: 1 })).rejects.toMatchObject({
			code: "extension_service_invalid_input",
		});
	});

	it("rejects undeclared and incomplete implementations", () => {
		const registry = new ExtensionServiceRegistry();
		registry.declareExtension(
			"provider",
			manifest({
				provides: {
					"search.query": { version: "1.0.0", scope: "session", service: { operations: { query: operation } } },
				},
			}),
		);
		expect(() => registry.provide("provider", "other", { query: () => ({}) })).toThrow(/did not declare/);
		expect(() => registry.provide("provider", "search.query", {})).toThrow(/implement exactly/);
	});

	it("removes every service and declaration owned by an unregistered extension", async () => {
		const registry = new ExtensionServiceRegistry();
		registry.declareExtension(
			"provider",
			manifest({
				provides: {
					"search.query": { version: "1.0.0", scope: "session", service: { operations: { query: operation } } },
				},
			}),
		);
		registry.provide("provider", "search.query", { query: () => ({ result: "stale" }) });
		registry.unregisterExtension("provider");
		expect(registry.catalog().providers).toEqual([]);
		await expect(registry.invokeCapability("search.query", "query", { query: "x" })).rejects.toMatchObject({
			code: "extension_service_unavailable",
		});
	});

	it("reports ambiguity and supports a fixed provider", async () => {
		const registry = new ExtensionServiceRegistry();
		for (const id of ["a", "b"]) {
			registry.declareExtension(
				id,
				manifest({
					provides: {
						"search.query": { version: "1.0.0", scope: "session", service: { operations: { query: operation } } },
					},
				}),
			);
			registry.provide(id, "search.query", { query: () => ({ result: id }) });
		}
		registry.declareExtension(
			"ambiguous",
			manifest({ uses: { search: { capability: "search.query", version: "*" } } }),
		);
		registry.declareExtension(
			"fixed",
			manifest({ uses: { search: { capability: "search.query", version: "*", provider: "b" } } }),
		);
		await expect(registry.use("ambiguous", "search").invoke("query", { query: "x" })).rejects.toMatchObject({
			code: "extension_service_ambiguous",
		});
		await expect(registry.use("fixed", "search").invoke("query", { query: "x" })).resolves.toEqual({ result: "b" });
	});

	it("supports parent scopes, timeout, cancellation, and stale runtime rejection", async () => {
		const global = new ExtensionServiceRegistry({ scope: "global", runtimeId: "global" });
		const session = new ExtensionServiceRegistry({ scope: "session", parent: global, runtimeId: "session" });
		global.declareExtension(
			"provider",
			manifest({
				provides: {
					"search.query": { version: "1.0.0", scope: "global", service: { operations: { query: operation } } },
				},
			}),
		);
		global.provide("provider", "search.query", {
			query: async (_input, ctx) => {
				await new Promise<void>((resolve, reject) => {
					const timer = setTimeout(resolve, 100);
					ctx.signal.addEventListener(
						"abort",
						() => {
							clearTimeout(timer);
							reject(ctx.signal.reason);
						},
						{ once: true },
					);
				});
				return { result: "done" };
			},
		});
		session.declareExtension(
			"consumer",
			manifest({ uses: { search: { capability: "search.query", version: "*" } } }),
		);
		await expect(
			session.use("consumer", "search").invoke("query", { query: "x" }, { timeoutMs: 5 }),
		).rejects.toMatchObject({ code: "extension_service_timed_out" });
		const controller = new AbortController();
		controller.abort();
		await expect(
			session.use("consumer", "search").invoke("query", { query: "x" }, { signal: controller.signal }),
		).rejects.toMatchObject({ code: "extension_service_cancelled" });
		const handle = session.use("consumer", "search");
		session.invalidate("reloaded");
		await expect(handle.invoke("query", { query: "x" })).rejects.toEqual(
			expect.objectContaining<Partial<ExtensionServiceError>>({ code: "extension_service_runtime_stale" }),
		);
		expect(() => new ExtensionServiceRegistry({ scope: "global", parent: session })).toThrow(/must outlive/);
	});

	it("resolves a matching parent provider when a nearer provider has an incompatible version", async () => {
		const global = new ExtensionServiceRegistry({ scope: "global" });
		const workspace = new ExtensionServiceRegistry({ scope: "workspace", parent: global });
		const session = new ExtensionServiceRegistry({ scope: "session", parent: workspace });
		global.declareExtension(
			"stable-provider",
			manifest({
				provides: {
					"search.query": { version: "1.0.0", scope: "global", service: { operations: { query: operation } } },
				},
			}),
		);
		workspace.declareExtension(
			"preview-provider",
			manifest({
				provides: {
					"search.query": { version: "2.0.0", scope: "workspace", service: { operations: { query: operation } } },
				},
			}),
		);
		session.declareExtension(
			"consumer",
			manifest({ uses: { search: { capability: "search.query", version: "^1.0.0" } } }),
		);
		global.provide("stable-provider", "search.query", { query: () => ({ result: "stable" }) });
		workspace.provide("preview-provider", "search.query", { query: () => ({ result: "preview" }) });

		await expect(session.use("consumer", "search").invoke("query", { query: "x" })).resolves.toEqual({
			result: "stable",
		});
	});

	it("keeps an issued invocation on its provider while rejecting calls after unregister", async () => {
		const registry = new ExtensionServiceRegistry();
		registry.declareExtension(
			"provider",
			manifest({
				provides: {
					"search.query": { version: "1.0.0", scope: "session", service: { operations: { query: operation } } },
				},
			}),
		);
		registry.declareExtension(
			"consumer",
			manifest({ uses: { search: { capability: "search.query", version: "*" } } }),
		);
		let release!: () => void;
		const providerSettled = new Promise<void>((resolve) => {
			release = resolve;
		});
		registry.provide("provider", "search.query", {
			query: async () => {
				await providerSettled;
				return { result: "original" };
			},
		});
		const handle = registry.use("consumer", "search");
		const issued = handle.invoke("query", { query: "before unregister" });
		registry.unregisterExtension("provider");
		expect(handle.available).toBe(false);
		await expect(handle.invoke("query", { query: "after unregister" })).rejects.toMatchObject({
			code: "extension_service_unavailable",
		});
		release();
		await expect(issued).resolves.toEqual({ result: "original" });
	});

	it("rejects child resolution after its parent lifecycle ends", async () => {
		const workspace = new ExtensionServiceRegistry({ scope: "workspace" });
		const session = new ExtensionServiceRegistry({ scope: "session", parent: workspace });
		workspace.declareExtension(
			"provider",
			manifest({
				provides: {
					"search.query": { version: "1.0.0", scope: "workspace", service: { operations: { query: operation } } },
				},
			}),
		);
		session.declareExtension(
			"consumer",
			manifest({ uses: { search: { capability: "search.query", version: "*" } } }),
		);
		workspace.provide("provider", "search.query", { query: () => ({ result: "ready" }) });
		const handle = session.use("consumer", "search");
		workspace.invalidate("workspace closed");
		await expect(handle.invoke("query", { query: "x" })).rejects.toMatchObject({
			code: "extension_service_runtime_stale",
		});
	});

	it("registers only declarations owned by the current lifecycle scope", () => {
		const session = new ExtensionServiceRegistry({ scope: "session" });
		session.declareExtension(
			"provider",
			manifest({
				provides: {
					"search.query": { version: "1.0.0", scope: "workspace", service: { operations: { query: operation } } },
				},
			}),
		);
		const dispose = session.provide("provider", "search.query", { query: () => ({ result: "wrong scope" }) });
		expect(session.catalog().providers).toEqual([]);
		expect(dispose).not.toThrow();
	});
});
