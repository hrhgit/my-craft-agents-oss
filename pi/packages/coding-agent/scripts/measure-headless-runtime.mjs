#!/usr/bin/env node
/*
 * measure-headless-runtime.mjs
 *
 * HEAD-E1 (OPT-018) — reproducible headless performance baseline harness.
 *
 * Emits machine-readable evidence for the production headless (RPC) entrypoint:
 *   - artifact size + sha256 of the measured executable
 *   - cold process-to-RPC-handshake time (spawn -> get_capabilities response)
 *   - idle RSS (working set after handshake, no active turn)
 *   - active RSS (working set during the first turn)
 *   - deterministic first-turn latency (prompt -> final prompt response)
 *
 * The harness pins source/build identity, executable hash, OS/CPU, sample
 * count, warmup, fixture, and timeout, and reports raw samples plus
 * median/p95. Failures are explicit and bounded; every spawned process is
 * tracked and torn down, and orphaned children are reported.
 *
 * ---------------------------------------------------------------------------
 * PRIMARY-OWNED INPUTS (this harness does NOT choose them):
 *
 *   --exe <path>        REQUIRED. The headless executable to measure. Must be a
 *                       clean, reproducibly-built runtime produced by the
 *                       OPT-017 producer. This harness refuses git-ignored
 *                       paths unless --allow-ignored is passed (mechanics-only
 *                       smoke; never baseline evidence).
 *
 *   --fixture <path>    Deterministic first-turn provider/fixture descriptor,
 *                       supported by Mortise validation. Without it the harness
 *                       still captures artifact size / cold handshake / idle
 *                       RSS, records first-turn latency + active RSS as null
 *                       with reason "no-fixture", and marks status "partial".
 *
 * Per the HEAD-E1 stop/escalate rule, the choice of a supported deterministic
 * first-turn fixture and of a clean reproducible producer belongs to the
 * primary agent. This harness intentionally has NO built-in provider injection
 * and NO default executable path.
 * ---------------------------------------------------------------------------
 */

import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { arch, cpus, freemem, hostname, platform, release, totalmem } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(SCRIPT_DIR, "..");
const REPO_ROOT = resolve(PACKAGE_DIR, "..", "..", "..");
const SCHEMA_VERSION = 1;

const DEFAULTS = {
	samples: 10,
	warmup: 1,
	timeoutMs: 30_000,
	modeArg: "--mode rpc",
	prompt: "Reply with the single word: ready",
	phase: "pre-split",
};

// -------------------------------------------------------------------------
// Argument parsing
// -------------------------------------------------------------------------

function parseCliArgs(argv) {
	const { values } = parseArgs({
		args: argv,
		allowPositionals: false,
		options: {
			exe: { type: "string" },
			node: { type: "string" },
			"mode-arg": { type: "string" },
			fixture: { type: "string" },
			prompt: { type: "string" },
			samples: { type: "string" },
			warmup: { type: "string" },
			"timeout-ms": { type: "string" },
			out: { type: "string" },
			phase: { type: "string" },
			"allow-ignored": { type: "boolean", default: false },
			plan: { type: "boolean", default: false },
			help: { type: "boolean", default: false },
		},
	});

	if (values.help) {
		printHelp();
		process.exit(0);
	}

	const toPositiveInt = (raw, name, fallback) => {
		if (raw === undefined) return fallback;
		const n = Number(raw);
		if (!Number.isInteger(n) || n < 0) {
			fail(`--${name} must be a non-negative integer, received: ${raw}`);
		}
		return n;
	};

	return {
		exe: values.exe,
		node: values.node,
		modeArg: values["mode-arg"] ?? DEFAULTS.modeArg,
		fixture: values.fixture,
		prompt: values.prompt ?? DEFAULTS.prompt,
		samples: toPositiveInt(values.samples, "samples", DEFAULTS.samples),
		warmup: toPositiveInt(values.warmup, "warmup", DEFAULTS.warmup),
		timeoutMs: toPositiveInt(values["timeout-ms"], "timeout-ms", DEFAULTS.timeoutMs),
		out: values.out,
		phase: values.phase ?? DEFAULTS.phase,
		allowIgnored: values["allow-ignored"] === true,
		plan: values.plan === true,
	};
}

function printHelp() {
	process.stdout.write(
		[
			"measure-headless-runtime.mjs — HEAD-E1 headless performance baseline harness",
			"",
			"Usage:",
			"  node scripts/measure-headless-runtime.mjs --exe <path> --out <path> [options]",
			"",
			"Required:",
			"  --exe <path>        Clean reproducibly-built headless executable (OPT-017 producer).",
			"  --out <path>        JSON evidence output path (must be outside committed source).",
			"",
			"Deterministic first turn (primary-owned):",
			"  --fixture <path>    Mortise-validation-supported deterministic provider fixture.",
			"                      Omitted => first-turn latency + active RSS = null (status partial).",
			"  --prompt <text>     First-turn prompt (default: deterministic ready prompt).",
			"",
			"Runtime shape:",
			"  --node <path>       Node runtime when --exe is a .js bundle (default: current node).",
			"  --mode-arg <args>   RPC mode argument(s) (default: \"--mode rpc\").",
			"",
			"Sampling:",
			"  --samples <n>       Measured samples (default: 10).",
			"  --warmup <n>        Discarded warmup samples (default: 1).",
			"  --timeout-ms <n>    Per-sample timeout (default: 30000).",
			"  --phase <name>      Evidence phase label, e.g. pre-split | post-split.",
			"",
			"Safety / diagnostics:",
			"  --allow-ignored     Permit a git-ignored --exe (mechanics smoke ONLY, never evidence).",
			"  --plan              Print pinned identity + plan as JSON and exit (no process spawned).",
			"  --help              Show this help.",
		].join("\n") + "\n",
	);
}

function fail(message) {
	process.stderr.write(`[measure-headless-runtime] ERROR: ${message}\n`);
	process.exit(2);
}

// -------------------------------------------------------------------------
// Identity pinning
// -------------------------------------------------------------------------

async function gitCapture(args) {
	try {
		const { stdout } = await execFileAsync("git", args, { cwd: REPO_ROOT });
		return stdout.trim();
	} catch {
		return null;
	}
}

async function captureIdentity(config, exeInfo) {
	const [revision, dirtyRaw] = await Promise.all([
		gitCapture(["rev-parse", "HEAD"]),
		gitCapture(["status", "--porcelain"]),
	]);
	const cpuList = cpus();
	return {
		schemaVersion: SCHEMA_VERSION,
		phase: config.phase,
		capturedAt: new Date().toISOString(),
		source: {
			revision,
			worktreeDirty: dirtyRaw === null ? null : dirtyRaw.length > 0,
		},
		executable: exeInfo,
		host: {
			hostname: hostname(),
			platform: platform(),
			release: release(),
			arch: arch(),
			cpuModel: cpuList[0]?.model ?? null,
			cpuCount: cpuList.length,
			totalMemBytes: totalmem(),
			freeMemBytesAtStart: freemem(),
			nodeVersion: process.version,
		},
		config: {
			runner: config.node ?? (exeInfo.directExecutable ? null : process.execPath),
			modeArg: config.modeArg,
			samples: config.samples,
			warmup: config.warmup,
			timeoutMs: config.timeoutMs,
			prompt: config.prompt,
			fixture: config.fixtureInfo,
			allowIgnored: config.allowIgnored,
		},
	};
}

async function resolveExecutable(config) {
	if (!config.exe) fail("--exe is required (a clean, reproducibly-built headless executable).");
	const exePath = isAbsolute(config.exe) ? config.exe : resolve(process.cwd(), config.exe);
	if (!existsSync(exePath)) fail(`--exe path does not exist: ${exePath}`);

	const ignored = await gitCapture(["check-ignore", exePath]);
	const isIgnored = ignored !== null && ignored.length > 0;
	if (isIgnored && !config.allowIgnored) {
		fail(
			`--exe is a git-ignored artifact and is NOT admissible baseline evidence: ${exePath}\n` +
				"       Provide a clean, reproducibly-built runtime from the OPT-017 producer,\n" +
				"       or pass --allow-ignored for a mechanics-only smoke run (never evidence).",
		);
	}

	const stat = statSync(exePath);
	const hash = createHash("sha256").update(readFileSync(exePath)).digest("hex");
	const base = basename(exePath).toLowerCase();
	const directExecutable = base === "pi" || base === "pi.exe" || !base.endsWith(".js");

	return {
		path: exePath,
		basename: basename(exePath),
		sizeBytes: stat.size,
		mtime: stat.mtimeMs,
		sha256: hash,
		gitIgnored: isIgnored,
		admissibleEvidence: !isIgnored,
		directExecutable,
	};
}

function resolveFixture(config) {
	if (!config.fixture) {
		return { supplied: false, reason: "no-fixture", path: null, sha256: null };
	}
	const fixturePath = isAbsolute(config.fixture) ? config.fixture : resolve(process.cwd(), config.fixture);
	if (!existsSync(fixturePath)) fail(`--fixture path does not exist: ${fixturePath}`);
	const hash = createHash("sha256").update(readFileSync(fixturePath)).digest("hex");
	return { supplied: true, reason: null, path: fixturePath, sha256: hash };
}

// -------------------------------------------------------------------------
// Statistics
// -------------------------------------------------------------------------

function summarize(samples) {
	if (samples.length === 0) return { count: 0, min: null, max: null, median: null, p95: null, samples: [] };
	const sorted = [...samples].sort((a, b) => a - b);
	const percentile = (p) => {
		const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
		return sorted[Math.max(0, idx)];
	};
	return {
		count: sorted.length,
		min: sorted[0],
		max: sorted[sorted.length - 1],
		median: percentile(50),
		p95: percentile(95),
		samples,
	};
}

// -------------------------------------------------------------------------
// OS process metrics (RSS / working set)
// -------------------------------------------------------------------------

async function sampleRssBytes(pid) {
	try {
		if (platform() === "win32") {
			// tasklist is always present on Windows; "Mem Usage" is reported in KB
			// with locale digit-grouping (commas). This is a working-set proxy.
			const { stdout } = await execFileAsync("tasklist", [
				"/FI",
				`PID eq ${pid}`,
				"/FO",
				"CSV",
				"/NH",
			]);
			const line = stdout.split(/\r?\n/).find((l) => l.includes(String(pid)));
			if (!line) return null;
			const cols = line.split('","').map((c) => c.replace(/"/g, "").trim());
			const memField = cols[cols.length - 1]; // e.g. "123,456 K"
			const kb = Number(memField.replace(/[^0-9]/g, ""));
			return Number.isFinite(kb) ? kb * 1024 : null;
		}
		const { stdout } = await execFileAsync("ps", ["-o", "rss=", "-p", String(pid)]);
		const kb = Number(stdout.trim());
		return Number.isFinite(kb) ? kb * 1024 : null;
	} catch {
		return null;
	}
}

// -------------------------------------------------------------------------
// Process lifecycle
// -------------------------------------------------------------------------

const spawnedPids = new Set();

function spawnRuntime(config, exeInfo) {
	const modeArgs = config.modeArg.trim().length > 0 ? config.modeArg.trim().split(/\s+/) : [];
	let command;
	let args;
	if (exeInfo.directExecutable) {
		command = exeInfo.path;
		args = modeArgs;
	} else {
		command = config.node ?? process.execPath;
		args = [exeInfo.path, ...modeArgs];
	}
	const child = spawn(command, args, {
		cwd: PACKAGE_DIR,
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, PI_EXTENSION_TARGET: "mortise", MORTISE_DEBUG: "0" },
	});
	if (typeof child.pid === "number") spawnedPids.add(child.pid);
	return child;
}

function killTree(child) {
	if (!child || child.exitCode !== null || child.signalCode !== null) return;
	try {
		if (platform() === "win32" && typeof child.pid === "number") {
			spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
		} else {
			child.kill("SIGKILL");
		}
	} catch {
		// best-effort teardown
	}
}

function readJsonlLines(child, onLine) {
	let buffer = "";
	child.stdout.on("data", (chunk) => {
		buffer += chunk.toString("utf8");
		let newlineIndex = buffer.indexOf("\n");
		while (newlineIndex !== -1) {
			const line = buffer.slice(0, newlineIndex).trim();
			buffer = buffer.slice(newlineIndex + 1);
			if (line.length > 0) onLine(line);
			newlineIndex = buffer.indexOf("\n");
		}
	});
}

/**
 * One cold sample: spawn a fresh process, time spawn -> get_capabilities
 * response, sample idle RSS, then (if fixture supplied) send the first-turn
 * prompt and time prompt -> final response while sampling active RSS.
 */
function runOneSample(config, exeInfo, fixtureInfo) {
	return new Promise((resolvePromise) => {
		const started = process.hrtime.bigint();
		const child = spawnRuntime(config, exeInfo);
		const stderrChunks = [];
		let settled = false;
		let handshakeMs = null;
		let idleRssBytes = null;
		let activeRssBytes = null;
		let firstTurnMs = null;
		let firstTurnError = null;
		const promptId = "e1-first-turn";
		let promptSentAt = null;

		const timer = setTimeout(() => finish("timeout"), config.timeoutMs);

		function finish(status, extra) {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			killTree(child);
			resolvePromise({
				status,
				handshakeMs,
				idleRssBytes,
				activeRssBytes,
				firstTurnMs,
				firstTurnError: firstTurnError ?? extra ?? null,
				stderr: Buffer.concat(stderrChunks).toString("utf8").slice(-4000),
			});
		}

		child.on("error", (err) => finish("spawn-error", err.message));
		child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
		child.on("exit", (code, signal) => {
			if (!settled) finish(code === 0 ? "exited-early" : "exited-error", `code=${code} signal=${signal}`);
		});

		readJsonlLines(child, async (line) => {
			let msg;
			try {
				msg = JSON.parse(line);
			} catch {
				return; // ignore non-JSON diagnostic lines
			}

			if (handshakeMs === null && msg.command === "get_capabilities" && msg.type === "response") {
				handshakeMs = Number(process.hrtime.bigint() - started) / 1e6;
				idleRssBytes = typeof child.pid === "number" ? await sampleRssBytes(child.pid) : null;

				if (!fixtureInfo.supplied) {
					finish("ok-no-fixture");
					return;
				}
				// Deterministic first turn (fixture-driven; provider determinism
				// is the fixture's responsibility, not this harness's).
				promptSentAt = process.hrtime.bigint();
				child.stdin.write(`${JSON.stringify({ id: promptId, type: "prompt", message: config.prompt })}\n`);
				// Sample active RSS shortly after the turn begins.
				setTimeout(async () => {
					if (typeof child.pid === "number") activeRssBytes = await sampleRssBytes(child.pid);
				}, 50);
				return;
			}

			if (msg.id === promptId && msg.type === "response" && msg.command === "prompt") {
				firstTurnMs = Number(process.hrtime.bigint() - promptSentAt) / 1e6;
				if (msg.success === false) firstTurnError = String(msg.error ?? "prompt failed");
				finish("ok");
			}
		});

		// Kick off the handshake.
		child.stdin.write(`${JSON.stringify({ id: "e1-handshake", type: "get_capabilities" })}\n`);
	});
}

// -------------------------------------------------------------------------
// Orchestration
// -------------------------------------------------------------------------

async function runSampleSet(config, exeInfo, fixtureInfo) {
	const handshake = [];
	const idleRss = [];
	const activeRss = [];
	const firstTurn = [];
	const failures = [];

	const total = config.warmup + config.samples;
	for (let i = 0; i < total; i++) {
		const isWarmup = i < config.warmup;
		const result = await runOneSample(config, exeInfo, fixtureInfo);
		const label = isWarmup ? `warmup ${i + 1}` : `sample ${i - config.warmup + 1}`;

		const handshakeOk = result.status === "ok" || result.status === "ok-no-fixture";
		if (!handshakeOk) {
			failures.push({ label, status: result.status, detail: result.firstTurnError, stderr: result.stderr });
			process.stderr.write(`[measure-headless-runtime] ${label} FAILED: ${result.status}\n`);
			continue;
		}

		process.stderr.write(
			`[measure-headless-runtime] ${label}: handshake=${result.handshakeMs?.toFixed(1)}ms` +
				(result.firstTurnMs !== null ? ` firstTurn=${result.firstTurnMs.toFixed(1)}ms` : " firstTurn=n/a") +
				"\n",
		);

		if (isWarmup) continue;
		if (result.handshakeMs !== null) handshake.push(result.handshakeMs);
		if (result.idleRssBytes !== null) idleRss.push(result.idleRssBytes);
		if (result.activeRssBytes !== null) activeRss.push(result.activeRssBytes);
		if (result.firstTurnMs !== null && !result.firstTurnError) firstTurn.push(result.firstTurnMs);
	}

	return {
		coldHandshakeMs: summarize(handshake),
		idleRssBytes: summarize(idleRss),
		activeRssBytes: fixtureInfo.supplied ? summarize(activeRss) : { reason: "no-fixture", count: 0 },
		firstTurnLatencyMs: fixtureInfo.supplied ? summarize(firstTurn) : { reason: "no-fixture", count: 0 },
		failures,
	};
}

async function verifyTeardown() {
	const orphans = [];
	for (const pid of spawnedPids) {
		const rss = await sampleRssBytes(pid);
		if (rss !== null) orphans.push(pid);
	}
	return orphans;
}

async function main() {
	const cli = parseCliArgs(process.argv.slice(2));
	const exeInfo = await resolveExecutable(cli);
	const fixtureInfo = resolveFixture(cli);
	const config = { ...cli, fixtureInfo };

	const identity = await captureIdentity(config, exeInfo);

	if (cli.plan) {
		const plan = {
			...identity,
			plan: {
				willSpawn: false,
				metrics: ["artifactSize", "coldHandshakeMs", "idleRssBytes", "activeRssBytes", "firstTurnLatencyMs"],
				firstTurnMeasured: fixtureInfo.supplied,
				note: fixtureInfo.supplied
					? "Fixture supplied: all five metrics will be measured."
					: "No fixture: first-turn latency + active RSS are skipped (status partial).",
			},
		};
		process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
		return;
	}

	if (!cli.out) fail("--out is required (JSON evidence path, outside committed source).");

	const metrics = await runSampleSet(config, exeInfo, fixtureInfo);
	const orphanChildren = await verifyTeardown();

	const blockers = [];
	if (!exeInfo.admissibleEvidence) {
		blockers.push("executable is git-ignored (mechanics smoke only, not admissible baseline evidence)");
	}
	if (!fixtureInfo.supplied) {
		blockers.push("no deterministic first-turn fixture supplied (first-turn latency + active RSS skipped)");
	}
	if (metrics.failures.length > 0) {
		blockers.push(`${metrics.failures.length} sample(s) failed`);
	}
	if (orphanChildren.length > 0) {
		blockers.push(`${orphanChildren.length} orphaned child process(es) detected`);
	}

	const status = blockers.length === 0 ? "complete" : fixtureInfo.supplied ? "degraded" : "partial";

	const evidence = {
		...identity,
		artifact: {
			path: exeInfo.path,
			basename: exeInfo.basename,
			sizeBytes: exeInfo.sizeBytes,
			sha256: exeInfo.sha256,
			admissibleEvidence: exeInfo.admissibleEvidence,
		},
		metrics: {
			coldHandshakeMs: metrics.coldHandshakeMs,
			idleRssBytes: metrics.idleRssBytes,
			activeRssBytes: metrics.activeRssBytes,
			firstTurnLatencyMs: metrics.firstTurnLatencyMs,
		},
		failures: metrics.failures,
		teardown: { orphanChildren, clean: orphanChildren.length === 0 },
		status,
		blockers,
	};

	const outPath = isAbsolute(cli.out) ? cli.out : resolve(process.cwd(), cli.out);
	writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
	process.stderr.write(`[measure-headless-runtime] status=${status} evidence written: ${outPath}\n`);

	// Bounded, explicit failure signalling for CI/primary consumption.
	if (status === "degraded" || metrics.failures.length > 0 || orphanChildren.length > 0) {
		process.exitCode = 1;
	}
}

main().catch((err) => {
	process.stderr.write(`[measure-headless-runtime] FATAL: ${err?.stack ?? err}\n`);
	for (const pid of spawnedPids) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// already gone
		}
	}
	process.exit(2);
});
