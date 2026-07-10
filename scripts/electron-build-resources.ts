/**
 * Cross-platform resources copy script.
 *
 * Delegates to the Electron app script so Windows packaging, root builds, and
 * app-local builds all stage the same resources and Pi CLI runtime.
 */

import { spawn } from "bun";
import { join } from "path";

const ROOT_DIR = join(import.meta.dir, "..");
const ELECTRON_DIR = join(ROOT_DIR, "apps/electron");

const proc = spawn({
  cmd: ["bun", "scripts/copy-assets.ts"],
  cwd: ELECTRON_DIR,
  stdout: "inherit",
  stderr: "inherit",
});

process.exit(await proc.exited);
