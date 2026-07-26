#!/usr/bin/env node
import * as undici from "undici";
import "./register-bedrock.ts";
import { runHeadlessMain } from "../headless-main.ts";
import { restoreSandboxEnv } from "./restore-sandbox-env.ts";

process.title = "mortise-agent-runtime";
process.env.PI_CODING_AGENT = "true";
process.emitWarning = (() => {}) as typeof process.emitWarning;
restoreSandboxEnv();
undici.install?.();
await runHeadlessMain(process.argv.slice(2));
