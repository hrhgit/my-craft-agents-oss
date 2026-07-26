#!/usr/bin/env node
import { chmodSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { assertHeadlessMetafile } from "../../scripts/build/headless-runtime-boundary.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageDir = join(repoRoot, "packages", "coding-agent");
const entryPoint = join(packageDir, "dist", "bun", "headless.js");
const outfile = join(packageDir, "dist", "headless.bundle.js");
const metafilePath = join(packageDir, "dist", "headless.bundle.meta.json");

if (!existsSync(entryPoint)) {
	throw new Error(`Build packages/coding-agent first; missing ${entryPoint}`);
}

rmSync(outfile, { force: true });
rmSync(metafilePath, { force: true });

const result = await build({
	entryPoints: [entryPoint],
	outfile,
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	external: [
		"@mariozechner/clipboard",
		"@mortise/pi-ai",
		"@silvia-odwyer/photon-node",
		"canvas",
		"cross-spawn",
		"jiti",
		"proper-lockfile",
		"undici",
		"yaml",
	],
	legalComments: "none",
	metafile: true,
});

assertHeadlessMetafile(result.metafile);
writeFileSync(metafilePath, `${JSON.stringify(result.metafile, null, 2)}\n`);
chmodSync(outfile, 0o755);
