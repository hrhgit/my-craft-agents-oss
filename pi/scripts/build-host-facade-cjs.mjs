import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const common = {
	bundle: true,
	platform: "node",
	format: "cjs",
	target: "node22",
	external: ["@mariozechner/clipboard", "@silvia-odwyer/photon-node"],
	sourcemap: true,
	define: {
		"import.meta.url": "__piImportMetaUrl",
		"import.meta.resolve": "__piImportMetaResolve",
	},
	banner: {
		js: 'const __piImportMetaUrl = require("node:url").pathToFileURL(__filename).href; const __piImportMetaResolve = (specifier) => require("node:url").pathToFileURL(require.resolve(specifier)).href;',
	},
};

await Promise.all([
	build({
		...common,
		entryPoints: [join(repoRoot, "packages/coding-agent/src/core/host-facade.ts")],
		outfile: join(repoRoot, "packages/coding-agent/dist/core/host-facade.cjs"),
	}),
	build({
		...common,
		entryPoints: [join(repoRoot, "packages/coding-agent/src/modes/rpc/public.ts")],
		outfile: join(repoRoot, "packages/coding-agent/dist/modes/rpc/rpc-client.cjs"),
	}),
]);
