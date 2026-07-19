import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const piRoot = resolve(packageDir, "..", "..");
const distDir = join(packageDir, "dist");
const binaryMode = process.argv.includes("--binary");

function resetDirectory(path) {
	rmSync(path, { recursive: true, force: true });
	mkdirSync(path, { recursive: true });
}

function copyFile(source, destination) {
	if (!existsSync(source)) throw new Error(`Required asset does not exist: ${source}`);
	mkdirSync(dirname(destination), { recursive: true });
	cpSync(source, destination, { force: true });
}

function copyDirectory(source, destination, optional = false) {
	if (!existsSync(source)) {
		if (optional) return;
		throw new Error(`Required asset directory does not exist: ${source}`);
	}
	rmSync(destination, { recursive: true, force: true });
	cpSync(source, destination, { recursive: true, force: true });
}

function copyMatching(sourceDir, destinationDir, extension, optional = false, preserveOtherFiles = false) {
	if (preserveOtherFiles) {
		mkdirSync(destinationDir, { recursive: true });
		for (const entry of readdirSync(destinationDir, { withFileTypes: true })) {
			if (entry.isFile() && entry.name.endsWith(extension)) {
				rmSync(join(destinationDir, entry.name), { force: true });
			}
		}
	} else {
		resetDirectory(destinationDir);
	}
	const files = existsSync(sourceDir)
		? readdirSync(sourceDir, { withFileTypes: true })
				.filter((entry) => entry.isFile() && entry.name.endsWith(extension))
				.map((entry) => entry.name)
				.sort()
		: [];
	if (files.length === 0 && !optional) {
		throw new Error(`No ${extension} assets found in ${sourceDir}`);
	}
	for (const file of files) copyFile(join(sourceDir, file), join(destinationDir, file));
}

function copySharedRuntimeAssets(root) {
	copyMatching(join(packageDir, "src", "modes", "interactive", "theme"), join(root, "theme"), ".json");
	copyMatching(join(packageDir, "src", "modes", "interactive", "assets"), join(root, "assets"), ".png", true);
	copyFile(join(packageDir, "src", "core", "export-html", "template.html"), join(root, "export-html", "template.html"));
	copyFile(join(packageDir, "src", "core", "export-html", "template.css"), join(root, "export-html", "template.css"));
	copyFile(join(packageDir, "src", "core", "export-html", "template.js"), join(root, "export-html", "template.js"));
	copyMatching(
		join(packageDir, "src", "core", "export-html", "vendor"),
		join(root, "export-html", "vendor"),
		".js",
	);
}

if (binaryMode) {
	copyFile(join(packageDir, "package.json"), join(distDir, "package.json"));
	copyFile(join(packageDir, "README.md"), join(distDir, "README.md"));
	copyFile(join(packageDir, "CHANGELOG.md"), join(distDir, "CHANGELOG.md"));
	copySharedRuntimeAssets(distDir);
	copyDirectory(join(packageDir, "sidecar", "bin"), join(distDir, "sidecar", "bin"));
	copyDirectory(join(packageDir, "docs"), join(distDir, "docs"));
	copyDirectory(join(packageDir, "examples"), join(distDir, "examples"));
	copyFile(
		join(piRoot, "node_modules", "@silvia-odwyer", "photon-node", "photon_rs_bg.wasm"),
		join(distDir, "photon_rs_bg.wasm"),
	);
} else {
	copyMatching(
		join(packageDir, "src", "modes", "interactive", "theme"),
		join(distDir, "modes", "interactive", "theme"),
		".json",
		false,
		true,
	);
	copyMatching(
		join(packageDir, "src", "modes", "interactive", "assets"),
		join(distDir, "modes", "interactive", "assets"),
		".png",
		true,
	);
	copyFile(
		join(packageDir, "src", "core", "export-html", "template.html"),
		join(distDir, "core", "export-html", "template.html"),
	);
	copyFile(
		join(packageDir, "src", "core", "export-html", "template.css"),
		join(distDir, "core", "export-html", "template.css"),
	);
	copyFile(
		join(packageDir, "src", "core", "export-html", "template.js"),
		join(distDir, "core", "export-html", "template.js"),
	);
	copyMatching(
		join(packageDir, "src", "core", "export-html", "vendor"),
		join(distDir, "core", "export-html", "vendor"),
		".js",
	);
}
