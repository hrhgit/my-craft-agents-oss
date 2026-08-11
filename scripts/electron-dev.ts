/**
 * Cross-platform electron dev script
 * Replaces platform-specific npm scripts with a unified TypeScript solution
 */

import { spawn, type Subprocess } from "bun";
import { existsSync, rmSync, cpSync, readFileSync, statSync, mkdirSync, readdirSync } from "fs";
import { homedir } from "os";
import { join, basename } from "path";
import { connect as connectTcp } from "node:net";
import * as esbuild from "esbuild";
import { downloadUv, type Platform, type Arch } from "./build/common";
import { configureSharedBackend } from "./shared-backend-discovery";
import {
  startElectronDevControlServer,
  type ElectronDevControlResponse,
  type ElectronDevControlServer,
  type ElectronDevControlStatus,
} from "./electron-dev-control-protocol";

const ROOT_DIR = join(import.meta.dir, "..");
const ELECTRON_DIR = join(ROOT_DIR, "apps/electron");
const DIST_DIR = join(ELECTRON_DIR, "dist");
const DEFAULT_CONFIG_DIR = join(homedir(), ".mortise");

// Replace grammY's bundled polyfills (node-fetch@2 + abort-controller@3) with
// native Node globals. esbuild otherwise renames the polyfill's `class
// AbortSignal` to `_AbortSignal` to dodge collision with the global, which
// breaks node-fetch@2's `constructor.name === 'AbortSignal'` check and fails
// every Telegram API call with a TypeError. Kept in sync with
// `apps/electron/package.json` build:main and `scripts/electron-build-main.ts`.
const MAIN_PROCESS_ALIAS: Record<string, string> = {
  "node-fetch": join(ROOT_DIR, "apps/electron/src/main/shims/node-fetch.cjs"),
  "abort-controller": join(ROOT_DIR, "apps/electron/src/main/shims/abort-controller.cjs"),
};

const MAIN_PROCESS_IMPORT_META_DEFINES: Record<string, string> = {
  "import.meta.url": "__mortise_import_meta_url",
  "import.meta.resolve": "__mortise_import_meta_resolve",
};

const MAIN_PROCESS_IMPORT_META_BANNER =
  "const __mortise_import_meta_url = require('url').pathToFileURL(__filename).href; const __mortise_import_meta_resolve = (specifier) => require('url').pathToFileURL(require.resolve(specifier)).href;";

// MCP server paths
const SESSION_SERVER_DIR = join(ROOT_DIR, "packages/session-mcp-server");
const SESSION_SERVER_OUTPUT = join(SESSION_SERVER_DIR, "dist/index.js");
const WHATSAPP_WORKER_DIR = join(ROOT_DIR, "packages/messaging-whatsapp-worker");
const WHATSAPP_WORKER_OUTPUT = join(WHATSAPP_WORKER_DIR, "dist/worker.cjs");
const PI_RUNTIME_DIR = join(ROOT_DIR, "pi/packages/coding-agent");
const PI_RUNTIME_OUTPUT = join(PI_RUNTIME_DIR, `dist/pi${process.platform === "win32" ? ".exe" : ""}`);

// Platform-specific binary paths (bun creates .exe on Windows, no extension on Unix)
const IS_WINDOWS = process.platform === "win32";
const BIN_EXT = IS_WINDOWS ? ".exe" : "";
const VITE_ENTRY = join(ROOT_DIR, "node_modules/vite/bin/vite.js");
const ELECTRON_BIN = IS_WINDOWS
  ? join(ROOT_DIR, "node_modules/electron/dist/electron.exe")
  : join(ROOT_DIR, `node_modules/.bin/electron${BIN_EXT}`);

function resolveBuildPlatform(): Platform {
  if (process.platform === "darwin") return "darwin";
  if (process.platform === "win32") return "win32";
  if (process.platform === "linux") return "linux";
  throw new Error(`Unsupported platform for uv bootstrap: ${process.platform}`);
}

function resolveBuildArch(): Arch {
  if (process.arch === "arm64") return "arm64";
  if (process.arch === "x64") return "x64";
  throw new Error(`Unsupported architecture for uv bootstrap: ${process.arch}`);
}

async function ensureBundledUvForCurrentPlatform(): Promise<void> {
  const platform = resolveBuildPlatform();
  const arch = resolveBuildArch();
  const platformKey = `${platform}-${arch}`;
  const uvBinary = platform === "win32" ? "uv.exe" : "uv";
  const uvPath = join(ELECTRON_DIR, "resources", "bin", platformKey, uvBinary);

  if (existsSync(uvPath)) {
    console.log(`✅ Bundled uv present: ${uvPath}`);
    return;
  }

  console.log(`⬇️  Bundled uv missing, bootstrapping ${platformKey}...`);
  await downloadUv({
    platform,
    arch,
    upload: false,
    uploadLatest: false,
    uploadScript: false,
    rootDir: ROOT_DIR,
    electronDir: ELECTRON_DIR,
  });
}

function getRequestedVitePort(): number | null {
  const rawPort = process.env.MORTISE_VITE_PORT ?? process.env.PORT;
  const port = Number.parseInt(rawPort ?? "", 10);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

// Multi-instance detection (matches detect-instance.sh logic)
// Detects instance number from folder name suffix (e.g., mortise-1 → instance 1)
function detectInstance(): void {
  const requestedVitePort = getRequestedVitePort();
  if (requestedVitePort !== null) {
    process.env.MORTISE_VITE_PORT = `${requestedVitePort}`;
    if (!process.env.MORTISE_CONFIG_DIR) {
      process.env.MORTISE_CONFIG_DIR = DEFAULT_CONFIG_DIR;
    }
    console.log(`🔌 Assigned Vite port=${process.env.MORTISE_VITE_PORT}, config=${process.env.MORTISE_CONFIG_DIR}`);
    return;
  }

  const folderName = basename(ROOT_DIR);
  const match = folderName.match(/-(\d+)$/);

  if (match) {
    const instanceNum = match[1];
    process.env.MORTISE_INSTANCE_NUMBER = instanceNum;
    process.env.MORTISE_VITE_PORT = `${instanceNum}173`;
    process.env.MORTISE_APP_NAME = `Mortise [${instanceNum}]`;
    if (!process.env.MORTISE_CONFIG_DIR) {
      process.env.MORTISE_CONFIG_DIR = DEFAULT_CONFIG_DIR;
    }
    process.env.MORTISE_DEEPLINK_SCHEME = `mortise${instanceNum}`;
    console.log(`🔢 Instance ${instanceNum} detected: port=${process.env.MORTISE_VITE_PORT}, config=${process.env.MORTISE_CONFIG_DIR}`);
    return;
  }

  if (!process.env.MORTISE_CONFIG_DIR) {
    process.env.MORTISE_CONFIG_DIR = DEFAULT_CONFIG_DIR;
  }
}

// Load .env file if it exists
function loadEnvFile(): void {
  const envPath = join(ROOT_DIR, ".env");
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        const eqIndex = trimmed.indexOf("=");
        if (eqIndex > 0) {
          const key = trimmed.slice(0, eqIndex).trim();
          let value = trimmed.slice(eqIndex + 1).trim();
          // Remove surrounding quotes if present
          if ((value.startsWith('"') && value.endsWith('"')) ||
              (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
          }
          // Shell/portmux-provided values are authoritative; .env only fills defaults.
          if (process.env[key] === undefined) {
            process.env[key] = value;
          }
        }
      }
    }
    console.log("📄 Loaded .env file");
  }
}

// Clean Vite cache directory
function cleanViteCache(): void {
  const viteCacheDir = join(ELECTRON_DIR, "node_modules/.vite");
  if (existsSync(viteCacheDir)) {
    rmSync(viteCacheDir, { recursive: true, force: true });
    console.log("🧹 Cleaned Vite cache");
  }
}

function latestMtime(rootPath: string): number {
  if (!existsSync(rootPath)) return 0;

  const stats = statSync(rootPath);
  if (!stats.isDirectory()) return stats.mtimeMs;

  let latest = stats.mtimeMs;
  for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
    latest = Math.max(latest, latestMtime(join(rootPath, entry.name)));
  }
  return latest;
}

function needsBuild(outputPath: string, sourcePaths: string[]): boolean {
  if (!existsSync(outputPath)) return true;
  const outputMtime = statSync(outputPath).mtimeMs;
  return sourcePaths.some(sourcePath => latestMtime(sourcePath) > outputMtime);
}

async function waitForFilesReady(filePaths: string[], timeoutMs = 10000): Promise<boolean> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    if (filePaths.every(filePath => existsSync(filePath) && statSync(filePath).size > 0)) {
      return true;
    }
    await Bun.sleep(50);
  }
  return false;
}

// Copy resources to dist
function copyResources(): void {
  const srcDir = join(ELECTRON_DIR, "resources");
  const destDir = join(ELECTRON_DIR, "dist/resources");
  if (!existsSync(srcDir)) return;

  const forceCopy = process.env.MORTISE_DEV_FORCE_COPY_RESOURCES === "1";
  if (!forceCopy && existsSync(destDir) && latestMtime(destDir) >= latestMtime(srcDir)) {
    console.log("📦 Resources unchanged, reusing dist/resources");
    return;
  }

  cpSync(srcDir, destDir, { recursive: true, force: true });
  console.log("📦 Copied resources to dist");
}

// Build the WhatsApp worker bundle (dist/worker.cjs). Runs the canonical
// `scripts/build-wa-worker.ts` as a subprocess so the dev path stays in
// sync with the packaged/CI build. Rebuild only when its inputs changed.
async function buildWaWorker(): Promise<void> {
  if (
    process.env.MORTISE_DEV_FORCE_REBUILD_WORKER !== "1" &&
    !needsBuild(WHATSAPP_WORKER_OUTPUT, [
      join(WHATSAPP_WORKER_DIR, "src"),
      join(WHATSAPP_WORKER_DIR, "package.json"),
      join(ROOT_DIR, "scripts/build-wa-worker.ts"),
    ])
  ) {
    console.log("📨 WhatsApp worker unchanged, reusing dist/worker.cjs");
    return;
  }

  console.log("📨 Building WhatsApp worker...");
  const proc = spawn({
    cmd: ["bun", "run", "scripts/build-wa-worker.ts"],
    cwd: ROOT_DIR,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`WhatsApp worker build failed with exit code ${exitCode}`);
  }
}

// Build MCP servers for sessions (one-time, no watch needed)
async function buildMcpServers(): Promise<void> {
  if (
    process.env.MORTISE_DEV_FORCE_REBUILD_MCP !== "1" &&
    !needsBuild(SESSION_SERVER_OUTPUT, [
      join(SESSION_SERVER_DIR, "src"),
      join(SESSION_SERVER_DIR, "package.json"),
    ])
  ) {
    console.log("🌉 MCP server unchanged, reusing dist/index.js");
    return;
  }

  console.log("🌉 Building MCP servers...");

  // Ensure dist directories exist
  const sessionDistDir = join(SESSION_SERVER_DIR, "dist");
  if (!existsSync(sessionDistDir)) mkdirSync(sessionDistDir, { recursive: true });

  // Build session MCP server (esbuild, packages external — deps resolve from root node_modules)
  const sessionResult = await runEsbuild(
    "packages/session-mcp-server/src/index.ts",
    "packages/session-mcp-server/dist/index.js",
    {},
    { packagesExternal: true }
  );

  if (!sessionResult.success) {
    throw new Error(`Session MCP server build failed: ${sessionResult.error}`);
  }
  console.log("✅ Session MCP server built");
}

async function buildPiRuntime(): Promise<void> {
  if (
    process.env.MORTISE_DEV_FORCE_REBUILD_PI !== "1" &&
    !needsBuild(PI_RUNTIME_OUTPUT, [
      join(ROOT_DIR, "pi/packages/ai/src"),
      join(ROOT_DIR, "pi/packages/ai/package.json"),
      join(ROOT_DIR, "pi/packages/agent/src"),
      join(ROOT_DIR, "pi/packages/agent/package.json"),
      join(PI_RUNTIME_DIR, "src"),
      join(PI_RUNTIME_DIR, "scripts"),
      join(PI_RUNTIME_DIR, "package.json"),
      join(ROOT_DIR, "pi/scripts"),
      join(ROOT_DIR, "pi/package.json"),
      join(ROOT_DIR, "pi/package-lock.json"),
    ])
  ) {
    console.log(`🤖 Mortise Agent runtime unchanged, reusing ${PI_RUNTIME_OUTPUT}`);
    return;
  }

  console.log("🤖 Building Mortise Agent runtime...");
  for (const [script, label] of [
    ["pi:build", "Pi workspace build"],
    ["pi:build:binary", "Pi binary build"],
  ] as const) {
    const proc = spawn({
      cmd: ["bun", "run", script],
      cwd: ROOT_DIR,
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`${label} failed with exit code ${exitCode}`);
    }
  }

  if (!existsSync(PI_RUNTIME_OUTPUT) || statSync(PI_RUNTIME_OUTPUT).size === 0) {
    throw new Error(`Mortise Agent runtime build did not produce ${PI_RUNTIME_OUTPUT}`);
  }
  console.log(`✅ Mortise Agent runtime built: ${PI_RUNTIME_OUTPUT}`);
}

// Get environment variables for electron process
function getElectronEnv(): Record<string, string> {
  const vitePort = process.env.MORTISE_VITE_PORT || "5173";

  // Codex binary path is resolved at runtime by the binary-resolver module.
  // It checks: CODEX_PATH env var > bundled binary > local dev fork > system PATH.
  // You can override with CODEX_PATH env var if needed for debugging.

  return {
    ...process.env as Record<string, string>,
    VITE_DEV_SERVER_URL: `http://localhost:${vitePort}`,
    MORTISE_DEV_RUNTIME: "1",
    MORTISE_CONFIG_DIR: process.env.MORTISE_CONFIG_DIR || "",
    MORTISE_APP_NAME: process.env.MORTISE_APP_NAME || "Mortise",
    MORTISE_DEEPLINK_SCHEME: process.env.MORTISE_DEEPLINK_SCHEME || "mortise",
    MORTISE_INSTANCE_NUMBER: process.env.MORTISE_INSTANCE_NUMBER || "",
  };
}

// Externals for the main-process bundle.
// `electron` is provided by the Electron runtime and is not bundleable.
const MAIN_BUNDLE_EXTERNALS = ["electron"];

// Run a one-shot esbuild using the JavaScript API
async function runEsbuild(
  entryPoint: string,
  outfile: string,
  defines: Record<string, string> = {},
  options: { packagesExternal?: boolean; alias?: Record<string, string>; importMetaCompat?: boolean } = {}
): Promise<{ success: boolean; error?: string }> {
  try {
    await esbuild.build({
      entryPoints: [join(ROOT_DIR, entryPoint)],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: join(ROOT_DIR, outfile),
      external: MAIN_BUNDLE_EXTERNALS,
      ...(options.packagesExternal ? { packages: "external" as const } : {}),
      ...(options.alias ? { alias: options.alias } : {}),
      ...(options.importMetaCompat ? { banner: { js: MAIN_PROCESS_IMPORT_META_BANNER } } : {}),
      define: {
        ...(options.importMetaCompat ? MAIN_PROCESS_IMPORT_META_DEFINES : {}),
        ...defines,
      },
      logLevel: "warning",
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// Verify a built JavaScript bundle is parseable. `node --check` performs
// syntax-only validation — it does NOT execute module-level code or resolve
// `require()`, so Electron-specific top-level requires (e.g. @sentry/electron)
// are safe. This catches truncated writes, FS corruption, and edge cases that
// esbuild's build-success signal doesn't cover.
async function verifyJsFile(filePath: string): Promise<{ valid: boolean; error?: string }> {
  if (!existsSync(filePath)) {
    return { valid: false, error: "File does not exist" };
  }

  const stats = statSync(filePath);
  if (stats.size === 0) {
    return { valid: false, error: "File is empty" };
  }

  try {
    const proc = spawn({
      cmd: ["node", "--check", filePath],
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      return { valid: false, error: stderr.trim() || `node --check exited ${exitCode}` };
    }
    return { valid: true };
  } catch (err) {
    return { valid: false, error: String(err) };
  }
}

async function main(): Promise<void> {
  const startedAt = performance.now();
  console.log("🚀 Starting Electron dev environment...\n");

  // Setup
  loadEnvFile();
  detectInstance();
  const sharedBackend = await configureSharedBackend(process.env, DEFAULT_CONFIG_DIR);
  if (sharedBackend) {
    console.log(`🔗 Reusing shared Mortise backend PID ${sharedBackend.pid} at ${sharedBackend.url}`);
  }
  if (process.env.MORTISE_DEV_CLEAN_VITE_CACHE === "1") {
    cleanViteCache();
  }

  // Ensure dist directory exists
  if (!existsSync(DIST_DIR)) {
    mkdirSync(DIST_DIR, { recursive: true });
  }

  const vitePort = process.env.MORTISE_VITE_PORT || "5173";
  const mainCjsPath = join(DIST_DIR, "main.cjs");
  const preloadCjsPath = join(DIST_DIR, "bootstrap-preload.cjs");
  const toolbarPreloadCjsPath = join(DIST_DIR, "browser-toolbar-preload.cjs");
  console.log("📡 Starting dev servers...\n");

  const processes: Subprocess[] = [];
  const esbuildContexts: esbuild.BuildContext[] = [];
  const sequentialStart = process.env.MORTISE_DEV_SEQUENTIAL_START === "1";
  const parallelStart = process.env.MORTISE_DEV_PARALLEL_START === "1";
  let viteProc: Subprocess | undefined;
  let electronProc: Subprocess | undefined;
  let electronState: ElectronDevControlStatus["state"] = "idle";
  let controlServer: ElectronDevControlServer | undefined;
  let restartPromise: Promise<void> | undefined;
  let restartPreviousElectronPid: number | undefined;
  let cleanupPromise: Promise<void> | undefined;
  let shuttingDown = false;

  function startVite(): Subprocess {
    if (viteProc) return viteProc;
    // Run Vite in Bun directly. Windows package-manager shims can exit before
    // their node.exe child, leaving the dev port occupied after Electron quits.
    viteProc = spawn({
      cmd: [
        process.execPath,
        VITE_ENTRY,
        "dev",
        "--config",
        "apps/electron/vite.config.ts",
        "--host",
        "127.0.0.1",
        "--port",
        vitePort,
        "--strictPort",
      ],
      cwd: ROOT_DIR,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
      env: process.env as Record<string, string>,
    });
    processes.push(viteProc);
    return viteProc;
  }

  async function terminateProcessTree(proc: Subprocess): Promise<void> {
    if (process.platform !== "win32" || !proc.pid) {
      try { proc.kill(); } catch {}
      return;
    }

    try {
      const killer = spawn({
        cmd: ["taskkill.exe", "/PID", String(proc.pid), "/T", "/F"],
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      await killer.exited;
    } catch {
      try { proc.kill(); } catch {}
    }
  }

  function controlStatus(): ElectronDevControlStatus {
    return {
      state: electronState,
      supervisorPid: process.pid,
      ...(viteProc?.pid ? { vitePid: viteProc.pid } : {}),
      vitePort: Number(vitePort),
      ...(electronProc?.pid ? { electronPid: electronProc.pid } : {}),
    };
  }

  async function launchElectron(): Promise<ElectronDevControlResponse> {
    const operationStartedAt = performance.now();
    if (shuttingDown) {
      return { ok: false, operationId: "", error: "Electron dev supervisor is shutting down", ...controlStatus() };
    }
    if (electronProc && electronProc.exitCode === null) {
      return { ok: true, operationId: "", elapsedMs: 0, ...controlStatus() };
    }

    electronState = "starting";
    console.log("🚀 Starting Electron...\n");
    const child = spawn({
      cmd: [ELECTRON_BIN, "apps/electron"],
      cwd: ROOT_DIR,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
      env: getElectronEnv(),
    });
    electronProc = child;
    electronState = "running";
    void child.exited.then(exitCode => {
      if (electronProc !== child) return;
      electronProc = undefined;
      electronState = "idle";
      console.log(`\nℹ️  Electron exited with code ${exitCode}; dev servers remain available.`);
    });
    return {
      ok: true,
      operationId: "",
      elapsedMs: Math.round(performance.now() - operationStartedAt),
      ...controlStatus(),
    };
  }

  function restartElectron(): Promise<ElectronDevControlResponse> {
    const operationStartedAt = performance.now();
    if (!restartPromise) {
      const previous = electronProc;
      restartPreviousElectronPid = previous?.pid;
      electronState = "restarting";
      electronProc = undefined;
      restartPromise = (async () => {
        const termination = previous ? terminateProcessTree(previous) : undefined;
        if (previous) await waitForSubprocessExit(previous);
        if (!shuttingDown) await launchElectron();
        await termination;
      })().catch(error => {
        electronState = "idle";
        console.error("❌ Electron restart failed:", error);
      }).finally(() => {
        restartPromise = undefined;
        restartPreviousElectronPid = undefined;
      });
    }

    return Promise.resolve({
      ok: !shuttingDown,
      operationId: "",
      previousElectronPid: restartPreviousElectronPid,
      elapsedMs: Math.round(performance.now() - operationStartedAt),
      ...(shuttingDown ? { error: "Electron dev supervisor is shutting down" } : {}),
      ...controlStatus(),
    });
  }

  async function waitForSubprocessExit(proc: Subprocess, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (proc.exitCode === null && Date.now() < deadline) await Bun.sleep(50);
    if (proc.exitCode === null) throw new Error(`Process ${proc.pid ?? "unknown"} did not exit within ${timeoutMs}ms`);
  }

  const cleanup = (): Promise<void> => cleanupPromise ??= (async () => {
    console.log("\n🛑 Shutting down...");
    shuttingDown = true;
    electronState = "stopping";
    if (controlServer) await controlServer.close();
    if (restartPromise) await restartPromise.catch(() => undefined);
    for (const ctx of esbuildContexts) {
      try {
        await ctx.dispose();
      } catch {
        // Context may already be disposed
      }
    }
    await Promise.all([
      ...processes.map(terminateProcessTree),
      ...(electronProc ? [terminateProcessTree(electronProc)] : []),
    ]);
  })();

  try {
    for (const outputPath of [mainCjsPath, preloadCjsPath, toolbarPreloadCjsPath]) {
      if (existsSync(outputPath)) rmSync(outputPath);
    }

    const contextOptions: esbuild.BuildOptions[] = [
      {
        entryPoints: [join(ROOT_DIR, "apps/electron/src/main/index.ts")],
        bundle: true,
        platform: "node",
        format: "cjs",
        outfile: mainCjsPath,
        external: MAIN_BUNDLE_EXTERNALS,
        alias: MAIN_PROCESS_ALIAS,
        define: {
          ...MAIN_PROCESS_IMPORT_META_DEFINES,
          __MORTISE_UI_VALIDATION_BUILD__: "true",
          __MORTISE_DEV_HOST_BUILD__: "false",
        },
        banner: { js: MAIN_PROCESS_IMPORT_META_BANNER },
        logLevel: "info",
      },
      {
        entryPoints: [join(ROOT_DIR, "apps/electron/src/preload/bootstrap.ts")],
        bundle: true,
        platform: "node",
        format: "cjs",
        outfile: preloadCjsPath,
        external: ["electron"],
        define: { __MORTISE_UI_VALIDATION_BUILD__: "true", __MORTISE_DEV_HOST_BUILD__: "false" },
        logLevel: "info",
      },
      {
        entryPoints: [join(ROOT_DIR, "apps/electron/src/preload/browser-toolbar.ts")],
        bundle: true,
        platform: "node",
        format: "cjs",
        outfile: toolbarPreloadCjsPath,
        external: ["electron"],
        logLevel: "info",
      },
    ];

    const prepareElectronBundles = async (): Promise<void> => {
      const contexts = await Promise.all(contextOptions.map(async options => {
        const context = await esbuild.context(options);
        esbuildContexts.push(context);
        return context;
      }));
      console.log("🔨 Building Electron process bundles...");
      await Promise.all(contexts.map(context => context.rebuild()));
      if (!await waitForFilesReady([mainCjsPath, preloadCjsPath, toolbarPreloadCjsPath])) {
        throw new Error("Electron process bundles were not produced in time");
      }
      if (process.env.MORTISE_DEV_VERIFY_BUILDS === "1") {
        console.log("🔍 Verifying build output...");
        const results = await Promise.all([
          verifyJsFile(mainCjsPath),
          verifyJsFile(preloadCjsPath),
          verifyJsFile(toolbarPreloadCjsPath),
        ]);
        if (results.some(result => !result.valid)) {
          throw new Error(`Electron build verification failed: ${JSON.stringify(results)}`);
        }
      }
      await Promise.all(contexts.map(context => context.watch()));
      console.log("👀 Watching main process, preload, and browser toolbar preload...");
      logTiming("electron-bundles-ready", startedAt);
    };

    const prepareRuntimeArtifacts = async (includeUv: boolean): Promise<void> => {
      await Promise.all([
        ...(includeUv ? [ensureBundledUvForCurrentPlatform()] : []),
        buildPiRuntime(),
        buildMcpServers(),
        buildWaWorker(),
      ]);
      logTiming("runtime-artifacts-ready", startedAt);
    };

    if (sequentialStart || !parallelStart) {
      if (sequentialStart) console.log("⏱️  Sequential startup benchmark mode enabled");
      else console.log("⚡ Cache-friendly sequential startup enabled");
      await ensureBundledUvForCurrentPlatform();
      copyResources();
      await prepareRuntimeArtifacts(false);
      const vite = startVite();
      await waitForViteReady(vitePort, vite);
      logTiming("vite-ready", startedAt);
      await prepareElectronBundles();
    } else {
      const vite = startVite();
      const runtimeArtifacts = prepareRuntimeArtifacts(true);
      copyResources();
      const viteReady = waitForViteReady(vitePort, vite)
        .then(() => logTiming("vite-ready", startedAt));
      // Vite and unchanged runtime artifacts can progress independently. Keep
      // esbuild after Vite is ready because both compete for the same CPU and
      // filesystem; in practice that makes the cold renderer path faster and
      // more stable than three-way parallel startup.
      await Promise.all([runtimeArtifacts, viteReady]);
      await prepareElectronBundles();
    }

    controlServer = await startElectronDevControlServer(ROOT_DIR, {
      status: controlStatus,
      start: launchElectron,
      restart: restartElectron,
    });
    console.log(`🎛️  Electron dev supervisor ready on 127.0.0.1:${controlServer.port}`);
    await launchElectron();
    logTiming("electron-spawned", startedAt);
  } catch (error) {
    await cleanup();
    throw error;
  }

  const stopAndExit = () => { void cleanup().finally(() => process.exit(0)); };
  process.on("SIGINT", stopAndExit);
  process.on("SIGTERM", stopAndExit);

  // Windows doesn't have SIGINT/SIGTERM in the same way
  if (process.platform === "win32") {
    process.on("SIGHUP", stopAndExit);
  }

  if (!viteProc) throw new Error("Vite was not started");
  const viteExitCode = await viteProc.exited;
  if (!cleanupPromise) {
    console.error(`❌ Vite exited unexpectedly with code ${viteExitCode}`);
    await cleanup();
    throw new Error(`Vite exited unexpectedly with code ${viteExitCode}`);
  }
}

async function waitForViteReady(port: string, viteProc: Subprocess, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (viteProc.exitCode !== null) throw new Error(`Vite exited before readiness with code ${viteProc.exitCode}`);
    try {
      const attemptTimeoutMs = Math.min(1000, Math.max(1, deadline - Date.now()));
      await new Promise<void>((resolve, reject) => {
        const socket = connectTcp({ host: "127.0.0.1", port: Number(port) });
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new Error("Vite readiness probe timed out"));
        }, attemptTimeoutMs);
        socket.once("connect", () => {
          clearTimeout(timer);
          socket.destroy();
          resolve();
        });
        socket.once("error", error => {
          clearTimeout(timer);
          socket.destroy();
          reject(error);
        });
      });
      return;
    } catch {}
    await Bun.sleep(50);
  }
  throw new Error(`Vite did not start listening on 127.0.0.1:${port} within ${timeoutMs}ms`);
}

function logTiming(phase: string, startedAt: number): void {
  console.log(`[mortise-dev-timing] ${JSON.stringify({ phase, elapsedMs: Math.round(performance.now() - startedAt) })}`);
}

main().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});
