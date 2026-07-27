#!/usr/bin/env node
import { restoreSandboxEnv } from "./restore-sandbox-env.ts";

process.title = "mortise-agent-runtime";
process.env.PI_CODING_AGENT = "true";
process.emitWarning = (() => {}) as typeof process.emitWarning;
restoreSandboxEnv();

const [, undici] = await Promise.all([import("./register-bedrock.ts"), import("undici")]);
const { runHeadlessMain } = await import("../headless-main.ts");
undici.install?.();
await runHeadlessMain(process.argv.slice(2));
