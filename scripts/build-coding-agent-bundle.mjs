#!/usr/bin/env node
import { chmodSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageDir = join(repoRoot, "packages", "coding-agent");
const fullEntryPoint = join(packageDir, "dist", "cli.js");
const interactiveEntryPoint = join(packageDir, "dist", "cli-interactive.js");
const outdir = join(packageDir, "dist");
const outfile = join(outdir, "cli.bundle.js");
const fullOutfile = join(outdir, "cli.full.bundle.js");
const interactiveOutfile = join(outdir, "cli.interactive.bundle.js");
const metafilePath = join(packageDir, "dist", "cli.bundle.meta.json");
const writeMetafile = process.env.PI_BUNDLE_METAFILE === "1";

if (!existsSync(fullEntryPoint)) {
	throw new Error(`Build packages/coding-agent first; missing ${fullEntryPoint}`);
}

if (!existsSync(interactiveEntryPoint)) {
	throw new Error(`Build packages/coding-agent first; missing ${interactiveEntryPoint}`);
}

rmSync(outfile, { force: true });
rmSync(fullOutfile, { force: true });
rmSync(interactiveOutfile, { force: true });
rmSync(join(outdir, "chunks"), { force: true, recursive: true });

const commonBuildOptions = {
	outdir,
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	splitting: true,
	external: [
		"@mariozechner/clipboard",
		"@earendil-works/pi-ai",
		"@silvia-odwyer/photon-node",
		"canvas",
		"cross-spawn",
		"hosted-git-info",
		"highlight.js/lib/index.js",
		"jiti",
		"jsdom",
		"proper-lockfile",
		"undici",
		"yaml",
	],
	legalComments: "none",
	metafile: writeMetafile,
};

const fullResult = await build({
	...commonBuildOptions,
	entryPoints: {
		"cli.full.bundle": fullEntryPoint,
	},
	entryNames: "[name]",
	chunkNames: "chunks/full/[name]-[hash]",
});

const interactiveResult = await build({
	...commonBuildOptions,
	entryPoints: {
		"cli.interactive.bundle": interactiveEntryPoint,
	},
	entryNames: "[name]",
	chunkNames: "chunks/interactive/[name]-[hash]",
});

if (writeMetafile && fullResult.metafile && interactiveResult.metafile) {
	writeFileSync(
		metafilePath,
		`${JSON.stringify(
			{
				inputs: {
					...fullResult.metafile.inputs,
					...interactiveResult.metafile.inputs,
				},
				outputs: {
					...fullResult.metafile.outputs,
					...interactiveResult.metafile.outputs,
				},
			},
			null,
			2,
		)}\n`,
	);
}

writeFileSync(
	outfile,
	`#!/usr/bin/env node
const PACKAGE_COMMANDS = new Set(["install", "remove", "uninstall", "update", "list", "config"]);

function valueAfter(args, index) {
	const inlineValueIndex = args[index].indexOf("=");
	if (inlineValueIndex >= 0) {
		return args[index].slice(inlineValueIndex + 1);
	}
	return args[index + 1];
}

function shouldUseFullBundle(args) {
	if (!process.stdin.isTTY) {
		return true;
	}
	if (process.env.PI_CHECK_PACKAGE_UPDATES === "1") {
		return true;
	}
	const firstArg = args[0];
	if (firstArg === "mux" || PACKAGE_COMMANDS.has(firstArg)) {
		return true;
	}
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (
			arg === "--help" ||
			arg === "-h" ||
			arg === "--version" ||
			arg === "-v" ||
			arg === "--print" ||
			arg === "-p" ||
			arg === "--export" ||
			arg === "--list-models"
		) {
			return true;
		}
		if (arg === "--mode" || arg.startsWith("--mode=")) {
			const mode = valueAfter(args, index);
			if (mode === "json" || mode === "rpc") {
				return true;
			}
			if (arg === "--mode") {
				index++;
			}
		}
	}
	return false;
}

const args = process.argv.slice(2);
await import(shouldUseFullBundle(args) ? "./cli.full.bundle.js" : "./cli.interactive.bundle.js");
`,
);
chmodSync(outfile, 0o755);
chmodSync(fullOutfile, 0o755);
chmodSync(interactiveOutfile, 0o755);
