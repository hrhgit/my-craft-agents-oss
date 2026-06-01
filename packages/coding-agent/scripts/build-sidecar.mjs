#!/usr/bin/env node
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageDir = resolve(__dirname, "..");
const sidecarDir = join(packageDir, "sidecar");

const ALL_PLATFORMS = [
	"darwin-arm64",
	"darwin-x64",
	"linux-x64",
	"linux-arm64",
	"windows-x64",
	"windows-arm64",
];

function parseArgs(argv) {
	let outDir = join(sidecarDir, "bin");
	let platform;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--out") {
			outDir = resolve(argv[++index]);
			continue;
		}
		if (arg === "--platform") {
			platform = argv[++index];
			continue;
		}
		throw new Error(`Unknown option: ${arg}`);
	}
	if (platform && !ALL_PLATFORMS.includes(platform)) {
		throw new Error(`Invalid platform: ${platform}`);
	}
	return { outDir, platforms: platform ? [platform] : ALL_PLATFORMS };
}

function goEnvForPlatform(platform) {
	const [os, arch] = platform.split("-");
	return {
		GOOS: os,
		GOARCH: arch === "x64" ? "amd64" : arch,
		CGO_ENABLED: "0",
	};
}

function outputPath(outDir, platform) {
	return join(outDir, platform, platform.startsWith("windows-") ? "pi-network-sidecar.exe" : "pi-network-sidecar");
}

function buildSidecar(outDir, platform) {
	const targetPath = outputPath(outDir, platform);
	mkdirSync(dirname(targetPath), { recursive: true });
	const result = spawnSync("go", ["build", "-o", targetPath, "."], {
		cwd: sidecarDir,
		env: { ...process.env, ...goEnvForPlatform(platform) },
		stdio: "inherit",
	});
	if (result.status !== 0) {
		throw new Error(`go build failed for ${platform}`);
	}
}

const { outDir, platforms } = parseArgs(process.argv.slice(2));
rmSync(outDir, { recursive: true, force: true });
for (const platform of platforms) {
	buildSidecar(outDir, platform);
}
