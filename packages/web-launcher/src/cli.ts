#!/usr/bin/env node

import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

type Command = "serve" | "build" | "doctor";

interface CliOptions {
	command: Command;
	host: string;
	port: number;
	openBrowser: boolean;
	explicitPort: boolean;
}

interface WorkspacePaths {
	packageDir: string;
	repoRoot: string;
	exampleDir: string;
	distDir: string;
	indexHtmlPath: string;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4173;
const MAX_PORT_ATTEMPTS = 20;
const VERSION = "0.75.3";

const MIME_TYPES: Record<string, string> = {
	".css": "text/css; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".ico": "image/x-icon",
	".jpg": "image/jpeg",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".png": "image/png",
	".svg": "image/svg+xml; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
	".webp": "image/webp",
};

function printHelp(): void {
	console.log(`pi-web ${VERSION}

Usage:
  pi-web [serve] [--host <host>] [--port <port>] [--open|--no-open]
  pi-web build
  pi-web doctor

Commands:
  serve    Serve the built web app from packages/web-ui/example/dist
  build    Build the web app in packages/web-ui/example
  doctor   Show resolved paths and build status

Options:
  --host <host>   Host to bind to (default: ${DEFAULT_HOST})
  --port <port>   Port to bind to (default: ${DEFAULT_PORT})
  --open          Open the browser after the server starts
  --no-open       Do not open the browser
  -h, --help      Show this help
  -v, --version   Show version
`);
}

function parsePort(value: string): number {
	const port = Number(value);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error(`Invalid port: ${value}`);
	}
	return port;
}

function parseCliOptions(argv: string[]): CliOptions {
	const commandArg = argv[0];
	let command: Command = "serve";
	let optionArgs = argv;

	if (commandArg === "serve" || commandArg === "build" || commandArg === "doctor") {
		command = commandArg;
		optionArgs = argv.slice(1);
	}

	let forcedOpenValue: boolean | undefined;
	optionArgs = optionArgs.filter((arg) => {
		if (arg === "--no-open") {
			forcedOpenValue = false;
			return false;
		}
		return true;
	});

	const parsed = parseArgs({
		args: optionArgs,
		allowPositionals: false,
		options: {
			help: { type: "boolean", short: "h" },
			host: { type: "string" },
			open: { type: "boolean" },
			port: { type: "string" },
			version: { type: "boolean", short: "v" },
		},
		strict: true,
	});

	if (parsed.values.help) {
		printHelp();
		process.exit(0);
	}

	if (parsed.values.version) {
		console.log(VERSION);
		process.exit(0);
	}

	const openValue = forcedOpenValue ?? parsed.values.open;
	const openBrowser = openValue === undefined ? process.stdout.isTTY : openValue;
	const port = parsed.values.port === undefined ? DEFAULT_PORT : parsePort(parsed.values.port);

	return {
		command,
		host: parsed.values.host ?? DEFAULT_HOST,
		port,
		openBrowser,
		explicitPort: parsed.values.port !== undefined,
	};
}

function resolveWorkspacePaths(): WorkspacePaths {
	const cliPath = fileURLToPath(import.meta.url);
	const packageDir = resolve(dirname(cliPath), "..");
	const repoRoot = resolve(packageDir, "..", "..");
	const exampleDir = resolve(repoRoot, "packages", "web-ui", "example");
	const distDir = resolve(exampleDir, "dist");
	const indexHtmlPath = resolve(distDir, "index.html");

	return {
		packageDir,
		repoRoot,
		exampleDir,
		distDir,
		indexHtmlPath,
	};
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path, fsConstants.F_OK);
		return true;
	} catch {
		return false;
	}
}

async function runBuild(paths: WorkspacePaths): Promise<number> {
	const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";

	return new Promise((resolveExitCode, reject) => {
		const child = spawn(npmExecutable, ["run", "build"], {
			cwd: paths.exampleDir,
			stdio: "inherit",
		});

		child.on("error", reject);
		child.on("exit", (code) => {
			resolveExitCode(code ?? 1);
		});
	});
}

async function printDoctor(paths: WorkspacePaths): Promise<void> {
	const distExists = await pathExists(paths.distDir);
	const indexExists = await pathExists(paths.indexHtmlPath);

	console.log(`repoRoot: ${paths.repoRoot}`);
	console.log(`exampleDir: ${paths.exampleDir}`);
	console.log(`distDir: ${paths.distDir}`);
	console.log(`indexHtml: ${paths.indexHtmlPath}`);
	console.log(`distExists: ${distExists}`);
	console.log(`indexHtmlExists: ${indexExists}`);
}

function getContentType(path: string): string {
	return MIME_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function normalizeUrlPath(requestPath: string): string {
	const trimmedPath = requestPath.split("?")[0].split("#")[0];
	const decodedPath = decodeURIComponent(trimmedPath);
	return decodedPath === "/" ? "/index.html" : decodedPath;
}

function resolveAssetPath(distDir: string, urlPath: string): string | null {
	const normalizedRequestPath = normalize(urlPath).replace(/^(\.\.(\/|\\|$))+/, "");
	const assetPath = resolve(distDir, `.${normalizedRequestPath}`);
	const relativePath = relative(distDir, assetPath);

	if (relativePath.startsWith("..") || relativePath.includes(`..${process.platform === "win32" ? "\\" : "/"}`)) {
		return null;
	}

	return assetPath;
}

async function sendFile(response: ServerResponse<IncomingMessage>, filePath: string): Promise<void> {
	try {
		const file = await readFile(filePath);
		response.writeHead(200, { "Content-Type": getContentType(filePath) });
		response.end(file);
	} catch (error) {
		response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
		response.end(`Failed to read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function createRequestHandler(
	paths: WorkspacePaths,
	request: IncomingMessage,
	response: ServerResponse,
): Promise<void> {
	const requestPath = normalizeUrlPath(request.url ?? "/");
	const assetPath = resolveAssetPath(paths.distDir, requestPath);

	if (!assetPath) {
		response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
		response.end("Forbidden");
		return;
	}

	try {
		const assetStat = await stat(assetPath);
		if (assetStat.isDirectory()) {
			await sendFile(response, join(assetPath, "index.html"));
			return;
		}
		await sendFile(response, assetPath);
		return;
	} catch {
		await sendFile(response, paths.indexHtmlPath);
	}
}

function openBrowser(url: string): void {
	if (!process.stdout.isTTY) {
		return;
	}

	if (process.platform === "win32") {
		spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
		return;
	}

	const command = process.platform === "darwin" ? "open" : "xdg-open";
	spawn(command, [url], { detached: true, stdio: "ignore" }).unref();
}

async function listenWithFallback(
	options: CliOptions,
	paths: WorkspacePaths,
): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
	for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
		const port = options.port + attempt;
		const server = createServer((request, response) => {
			void createRequestHandler(paths, request, response);
		});

		const result = await new Promise<{ server: ReturnType<typeof createServer>; port: number } | "retry">(
			(resolveListen, reject) => {
				server.once("error", (error: NodeJS.ErrnoException) => {
					if (error.code === "EADDRINUSE" && !options.explicitPort) {
						server.close(() => resolveListen("retry"));
						return;
					}
					reject(error);
				});

				server.listen(port, options.host, () => {
					resolveListen({ server, port });
				});
			},
		);

		if (result !== "retry") {
			return result;
		}
	}

	throw new Error(`Unable to find a free port starting at ${options.port}`);
}

async function serve(options: CliOptions, paths: WorkspacePaths): Promise<void> {
	const hasBuild = await pathExists(paths.indexHtmlPath);
	if (!hasBuild) {
		throw new Error(
			`Web build not found at ${paths.indexHtmlPath}. Run "pi-web build" or rebuild with pi-install.ps1 first.`,
		);
	}

	const { server, port } = await listenWithFallback(options, paths);
	const url = `http://${options.host}:${port}`;

	console.log(`Serving Pi Web from ${paths.distDir}`);
	console.log(`URL: ${url}`);
	console.log("Press Ctrl+C to stop.");

	if (options.openBrowser) {
		openBrowser(url);
	}

	const shutdown = () => {
		server.close(() => process.exit(0));
	};

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

async function main(): Promise<void> {
	const options = parseCliOptions(process.argv.slice(2));
	const paths = resolveWorkspacePaths();

	if (options.command === "build") {
		const exitCode = await runBuild(paths);
		process.exit(exitCode);
	}

	if (options.command === "doctor") {
		await printDoctor(paths);
		return;
	}

	await serve(options, paths);
}

void main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
