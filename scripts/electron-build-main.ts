/**
 * Cross-platform main process build script
 * Loads .env and passes OAuth defines to esbuild
 */

import { spawn } from "bun";
import { existsSync, readFileSync, statSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import {
  copySessionServer,
  type Arch,
  type BuildConfig,
  type Platform,
} from "./build/common.ts";
import { assertNoUiValidationProductionInputs, assertNoUiValidationProductionRuntime, isUiValidationBuildEnabled } from "./build/ui-validation-boundary.ts";

const ROOT_DIR = join(import.meta.dir, "..");
const ELECTRON_DIR = join(ROOT_DIR, "apps/electron");
const DIST_DIR = join(ROOT_DIR, "apps/electron/dist");
const OUTPUT_FILE = join(DIST_DIR, "main.cjs");
const MAIN_METAFILE = join(DIST_DIR, ".main-build-meta.json");
const UI_VALIDATION_BUILD_MARKER = join(DIST_DIR, ".ui-validation-build.json");
const DEVELOPER_HOST_BUILD_MARKER = join(DIST_DIR, ".developer-host-build.json");
const WORKSPACE_SERVER_OUTPUT = join(DIST_DIR, "workspace-server.mjs");
const WORKSPACE_SERVER_METAFILE = join(DIST_DIR, ".workspace-server-build-meta.json");
const SESSION_TOOLS_CORE_DIR = join(ROOT_DIR, "packages/session-tools-core");
const SESSION_SERVER_DIR = join(ROOT_DIR, "packages/session-mcp-server");
const SESSION_SERVER_OUTPUT = join(SESSION_SERVER_DIR, "dist/index.js");
const WA_WORKER_DIR = join(ROOT_DIR, "packages/messaging-whatsapp-worker");
const WA_WORKER_SOURCE = join(WA_WORKER_DIR, "src/worker.ts");
const WA_WORKER_OUTPUT = join(WA_WORKER_DIR, "dist/worker.cjs");

// A marker is valid only after the complete validation build finishes in the
// source launcher. Any standalone, production, or interrupted rebuild clears it.
rmSync(UI_VALIDATION_BUILD_MARKER, { force: true });

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
          if ((value.startsWith('"') && value.endsWith('"')) ||
              (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
          }
          process.env[key] = value;
        }
      }
    }
  }
}

// Get build-time defines for esbuild.
// NOTE: Sentry source map upload is intentionally disabled for the main process.
// To enable in the future, add @sentry/esbuild-plugin. See apps/electron/CLAUDE.md.
function getBuildDefines(): string[] {
  const definedVars = [
    "SENTRY_ELECTRON_INGEST_URL",
    "MORTISE_DEV_RUNTIME",
  ];

  return definedVars.map((varName) => {
    const value = process.env[varName] || "";
    return `--define:process.env.${varName}="${value}"`;
  });
}

function getCurrentBuildConfig(): BuildConfig {
  const platform = process.platform;
  const arch = process.arch;

  if (platform !== "darwin" && platform !== "win32" && platform !== "linux") {
    throw new Error(`Unsupported Electron build platform: ${platform}`);
  }
  if (arch !== "x64" && arch !== "arm64") {
    throw new Error(`Unsupported Electron build arch: ${arch}`);
  }

  return {
    platform: platform as Platform,
    arch: arch as Arch,
    upload: false,
    uploadLatest: false,
    uploadScript: false,
    rootDir: ROOT_DIR,
    electronDir: ELECTRON_DIR,
  };
}

// Wait for file to stabilize (no size changes)
async function waitForFileStable(filePath: string, timeoutMs = 10000): Promise<boolean> {
  const startTime = Date.now();
  let lastSize = -1;
  let stableCount = 0;

  while (Date.now() - startTime < timeoutMs) {
    if (!existsSync(filePath)) {
      await Bun.sleep(100);
      continue;
    }

    const stats = statSync(filePath);
    if (stats.size === lastSize) {
      stableCount++;
      if (stableCount >= 3) {
        return true;
      }
    } else {
      stableCount = 0;
      lastSize = stats.size;
    }

    await Bun.sleep(100);
  }

  return false;
}

// Verify a JavaScript file is syntactically valid
async function verifyJsFile(filePath: string): Promise<{ valid: boolean; error?: string }> {
  if (!existsSync(filePath)) {
    return { valid: false, error: "File does not exist" };
  }

  const stats = statSync(filePath);
  if (stats.size === 0) {
    return { valid: false, error: "File is empty" };
  }

  const proc = spawn({
    cmd: ["node", "--check", filePath],
    stdout: "pipe",
    stderr: "pipe",
  });

  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    return { valid: false, error: stderr || "Syntax error" };
  }

  return { valid: true };
}

// Verify Session Tools Core package exists (raw TypeScript, bundled by consumers)
// No build step needed - it exports TypeScript directly like other packages
function verifySessionToolsCore(): void {
  console.log("🔍 Verifying Session Tools Core...");

  // Verify source exists
  const sourceFile = join(SESSION_TOOLS_CORE_DIR, "src/index.ts");
  if (!existsSync(sourceFile)) {
    console.error("❌ Session tools core source not found at", sourceFile);
    process.exit(1);
  }

  console.log("✅ Session tools core verified");
}

// Build the Session MCP Server (provides session-scoped tools for Codex sessions)
async function buildSessionServer(): Promise<void> {
  console.log("📋 Building Session MCP Server...");
  const uiValidationBuild = isUiValidationBuildEnabled();

  // Ensure dist directory exists
  const distDir = join(SESSION_SERVER_DIR, "dist");
  if (!existsSync(distDir)) {
    mkdirSync(distDir, { recursive: true });
  }

  const proc = spawn({
    cmd: [
      "bun", "build",
      join(SESSION_SERVER_DIR, "src/index.ts"),
      "--outfile", SESSION_SERVER_OUTPUT,
      "--target", "node",
      "--format", "cjs",
      "--minify-syntax",
      "--define", `process.env.MORTISE_UI_VALIDATION_BUILD=\"${uiValidationBuild ? '1' : '0'}\"`,
      "--define", `process.env.MORTISE_UI_TEST_HOST=\"${uiValidationBuild ? '1' : '0'}\"`,
    ],
    cwd: ROOT_DIR,
    stdout: "inherit",
    stderr: "inherit",
  });

  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    console.error("❌ Session server build failed with exit code", exitCode);
    process.exit(exitCode);
  }
  if (!uiValidationBuild) {
    assertNoUiValidationProductionRuntime(readFileSync(SESSION_SERVER_OUTPUT, "utf8"), "session-mcp-server/index.js");
  }

  // Verify output exists
  if (!existsSync(SESSION_SERVER_OUTPUT)) {
    console.error("❌ Session server output not found at", SESSION_SERVER_OUTPUT);
    process.exit(1);
  }

  console.log("✅ Session server built successfully");
}

// Build the WhatsApp worker (Baileys-backed subprocess spawned by WhatsAppAdapter)
async function buildWhatsAppWorker(): Promise<void> {
  if (!existsSync(WA_WORKER_SOURCE)) {
    console.log("⏭️  WhatsApp worker skipped (package not found)");
    return;
  }

  console.log("📨 Building WhatsApp worker...");

  const workerDistDir = join(WA_WORKER_DIR, "dist");
  if (!existsSync(workerDistDir)) {
    mkdirSync(workerDistDir, { recursive: true });
  }

  // Baileys is bundled INTO worker.cjs (not external) so the packaged app is
  // self-contained. Dynamic `import('@whiskeysockets/baileys')` is resolved
  // at bundle time because the specifier is a literal.
  const proc = spawn({
    cmd: [
      "bun", "run", "esbuild",
      WA_WORKER_SOURCE,
      "--bundle",
      "--platform=node",
      "--format=cjs",
      "--target=node20",
      `--outfile=${WA_WORKER_OUTPUT}`,
      "--external:electron",
      // Baileys' runtime-optional features — wrapped in try/catch at the
      // call site and not used by Mortise Agent (we send text + documents, no
      // link previews, no inline image processing, no terminal QR).
      "--external:link-preview-js",
      "--external:qrcode-terminal",
      "--external:jimp",
    ],
    cwd: ROOT_DIR,
    stdout: "inherit",
    stderr: "inherit",
  });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    console.error("❌ WhatsApp worker build failed with exit code", exitCode);
    process.exit(exitCode);
  }

  if (!existsSync(WA_WORKER_OUTPUT)) {
    console.error("❌ WhatsApp worker output not found at", WA_WORKER_OUTPUT);
    process.exit(1);
  }

  console.log("✅ WhatsApp worker built successfully");
}

async function buildWorkspaceServer(uiValidationBuild: boolean): Promise<void> {
  console.log("🧩 Building workspace server subprocess bundle...");

  const proc = spawn({
    cmd: [
      "bun", "run", "esbuild",
      "packages/server/src/index.ts",
      "--bundle",
      "--platform=node",
      "--format=esm",
      "--target=node20",
      "--outfile=apps/electron/dist/workspace-server.mjs",
      "--banner:js=import { createRequire as __mortiseCreateRequire } from 'node:module'; import { fileURLToPath as __mortiseFileURLToPath } from 'node:url'; import { dirname as __mortiseDirname } from 'node:path'; var require = __mortiseCreateRequire(import.meta.url); var __filename = __mortiseFileURLToPath(import.meta.url); var __dirname = __mortiseDirname(__filename);",
      "--external:electron",
      `--define:process.env.MORTISE_UI_VALIDATION_BUILD=\"${uiValidationBuild ? '1' : '0'}\"`,
      `--metafile=${WORKSPACE_SERVER_METAFILE}`,
      ...(!uiValidationBuild ? ["--minify-syntax"] : []),
      ...(!uiValidationBuild ? ["--alias:@mortise/shared/protocol=./packages/shared/src/protocol/production.ts"] : []),
    ],
    cwd: ROOT_DIR,
    stdout: "inherit",
    stderr: "inherit",
  });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    rmSync(WORKSPACE_SERVER_METAFILE, { force: true });
    console.error("❌ Workspace server build failed with exit code", exitCode);
    process.exit(exitCode);
  }

  try {
    const metadata = JSON.parse(readFileSync(WORKSPACE_SERVER_METAFILE, "utf-8")) as { inputs?: Record<string, unknown> };
    if (!uiValidationBuild) {
      assertNoUiValidationProductionInputs(Object.keys(metadata.inputs ?? {}), "Electron workspace server bundle");
    }
  } finally {
    rmSync(WORKSPACE_SERVER_METAFILE, { force: true });
  }

  if (!existsSync(WORKSPACE_SERVER_OUTPUT)) {
    console.error("❌ Workspace server output not found at", WORKSPACE_SERVER_OUTPUT);
    process.exit(1);
  }

  if (!uiValidationBuild) {
    assertNoUiValidationProductionRuntime(readFileSync(WORKSPACE_SERVER_OUTPUT, "utf-8"), "Electron workspace server bundle");
  }

  console.log("✅ Workspace server subprocess bundle built successfully");
}

async function main(): Promise<void> {
  loadEnvFile();

  // Ensure dist directory exists
  if (!existsSync(DIST_DIR)) {
    mkdirSync(DIST_DIR, { recursive: true });
  }

  // Verify session tools core exists (shared utilities for session-scoped tools)
  verifySessionToolsCore();

  // Build session server (provides session-scoped tools)
  // Depends on session-tools-core being built first
  await buildSessionServer();

  // Keep tracked Electron resources in sync with freshly-built subprocesses.
  // electron:build:resources copies apps/electron/resources into dist/resources,
  // and electron-builder also includes resources/* directly.
  const buildConfig = getCurrentBuildConfig();
  copySessionServer(buildConfig);

  // Build WhatsApp worker (Baileys subprocess — optional package)
  await buildWhatsAppWorker();

  // Build workspace server bundle used by Electron to keep agent runtime out of
  // the main process in packaged builds.
  const buildDefines = getBuildDefines();
  const uiValidationBuild = isUiValidationBuildEnabled();
  const developerHostBuild = process.env.MORTISE_DEV_HOST_BUILD === '1';
  if (developerHostBuild && !uiValidationBuild) {
    throw new Error('MORTISE_DEV_HOST_BUILD=1 requires MORTISE_UI_VALIDATION_BUILD=1');
  }
  await buildWorkspaceServer(uiValidationBuild);

  console.log("🔨 Building main process...");

  const proc = spawn({
    cmd: [
      "bun", "run", "esbuild",
      "apps/electron/src/main/index.ts",
      "--bundle",
      "--platform=node",
      "--format=cjs",
      "--outfile=apps/electron/dist/main.cjs",
      "--define:import.meta.url=__mortise_import_meta_url",
      "--define:import.meta.resolve=__mortise_import_meta_resolve",
      "--banner:js=const __mortise_import_meta_url = require('url').pathToFileURL(__filename).href; const __mortise_import_meta_resolve = (specifier) => require('url').pathToFileURL(require.resolve(specifier)).href;",
      "--external:electron",
      `--define:__MORTISE_UI_VALIDATION_BUILD__=${uiValidationBuild}`,
      `--define:__MORTISE_DEV_HOST_BUILD__=${developerHostBuild}`,
      `--define:process.env.MORTISE_UI_VALIDATION_BUILD=\"${uiValidationBuild ? '1' : '0'}\"`,
      `--metafile=${MAIN_METAFILE}`,
      ...(!uiValidationBuild ? ["--minify-syntax"] : []),
      // Replace grammY's bundled polyfills (node-fetch@2 + abort-controller@3)
      // with native Node globals. esbuild otherwise renames the polyfill's
      // `class AbortSignal` to `_AbortSignal` to dodge collision with the
      // global, which then breaks node-fetch@2's `constructor.name` check and
      // fails every Telegram API call with a TypeError.
      "--alias:node-fetch=./apps/electron/src/main/shims/node-fetch.cjs",
      "--alias:abort-controller=./apps/electron/src/main/shims/abort-controller.cjs",
      ...(!uiValidationBuild ? ["--alias:@mortise/shared/protocol=./packages/shared/src/protocol/production.ts"] : []),
      ...buildDefines,
    ],
    cwd: ROOT_DIR,
    stdout: "inherit",
    stderr: "inherit",
  });

  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    console.error("❌ esbuild failed with exit code", exitCode);
    process.exit(exitCode);
  }

  try {
    const metadata = JSON.parse(readFileSync(MAIN_METAFILE, "utf-8")) as { inputs?: Record<string, unknown> };
    if (!uiValidationBuild) {
      assertNoUiValidationProductionInputs(Object.keys(metadata.inputs ?? {}), "Electron main bundle");
    }
  } finally {
    rmSync(MAIN_METAFILE, { force: true });
  }

  // Wait for file to stabilize
  console.log("⏳ Waiting for file to stabilize...");
  const stable = await waitForFileStable(OUTPUT_FILE);

  if (!stable) {
    console.error("❌ Output file did not stabilize");
    process.exit(1);
  }

  // Verify the output
  console.log("🔍 Verifying build output...");
  const verification = await verifyJsFile(OUTPUT_FILE);

  if (!verification.valid) {
    console.error("❌ Build verification failed:", verification.error);
    process.exit(1);
  }

  if (!uiValidationBuild) {
    assertNoUiValidationProductionRuntime(readFileSync(OUTPUT_FILE, "utf-8"), "Electron main bundle");
  }

  writeFileSync(DEVELOPER_HOST_BUILD_MARKER, `${JSON.stringify({
    schemaVersion: 1,
    developerHostBuild,
    uiValidationBuild,
  })}\n`, 'utf8');

  console.log("✅ Build complete and verified");
  process.exit(0);
}

main();
