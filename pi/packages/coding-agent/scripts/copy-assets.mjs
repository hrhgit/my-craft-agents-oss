import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const piRoot = resolve(packageDir, "..", "..");
const distDir = join(packageDir, "dist");

function copyFile(source, destination) {
	if (!existsSync(source)) throw new Error(`Required runtime asset does not exist: ${source}`);
	mkdirSync(dirname(destination), { recursive: true });
	cpSync(source, destination, { force: true });
}

function copyDirectory(source, destination) {
	if (!existsSync(source)) throw new Error(`Required runtime asset directory does not exist: ${source}`);
	rmSync(destination, { recursive: true, force: true });
	cpSync(source, destination, { recursive: true, force: true });
}

copyDirectory(join(packageDir, "sidecar", "bin"), join(distDir, "sidecar", "bin"));
copyFile(
	join(piRoot, "node_modules", "@silvia-odwyer", "photon-node", "photon_rs_bg.wasm"),
	join(distDir, "photon_rs_bg.wasm"),
);
const packageMetadata = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
writeFileSync(join(distDir, "package.json"), `${JSON.stringify(packageMetadata, null, 2)}\n`, "utf8");
