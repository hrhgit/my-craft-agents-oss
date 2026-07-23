/**
 * Cross-platform renderer build script
 */

import { spawn } from "bun";
import { existsSync, rmSync } from "fs";
import { join } from "path";
import { assertRendererEntryBudgets } from "./build/renderer-entry-budget.ts";

const ROOT_DIR = join(import.meta.dir, "..");
const ELECTRON_DIR = join(ROOT_DIR, "apps/electron");

// Clean renderer dist first
const rendererDir = join(ELECTRON_DIR, "dist/renderer");
if (existsSync(rendererDir)) {
  rmSync(rendererDir, { recursive: true, force: true });
}

const proc = spawn({
  cmd: ["bun", "run", "vite", "build", "--config", "apps/electron/vite.config.ts"],
  cwd: ROOT_DIR,
  stdout: "inherit",
  stderr: "inherit",
  env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=4096" },
});

const exitCode = await proc.exited;
if (exitCode !== 0) process.exit(exitCode);

try {
  for (const graph of assertRendererEntryBudgets(rendererDir)) {
    console.log(
      `[renderer-entry-budget] ${graph.html}: ${graph.totalBytes} bytes across ${graph.chunks.length} static chunks`,
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
