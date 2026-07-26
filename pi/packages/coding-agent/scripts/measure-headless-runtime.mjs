#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { arch, cpus, freemem, hostname, platform, release, tmpdir, totalmem } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(SCRIPT_DIR, "..");
const REPO_ROOT = resolve(PACKAGE_DIR, "..", "..", "..");
const SCHEMA = "mortise/headless-runtime-performance-evidence/v2";
const FIXTURE_SCHEMA = "mortise/headless-first-turn-fixture/v1";

const DEFAULTS = {
	samples: 10,
	warmup: 1,
	timeoutMs: 60_000,
	modeArg: "",
	phase: "post-split",
};

function fail(message) {
	throw new Error(message);
}

function sha256File(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function absolutePath(value) {
	return isAbsolute(value) ? value : resolve(process.cwd(), value);
}

function parseCliArgs(argv) {
	const { values } = parseArgs({
		args: argv,
		allowPositionals: false,
		options: {
			exe: { type: "string" },
			"build-manifest": { type: "string" },
			fixture: { type: "string" },
			out: { type: "string" },
			baseline: { type: "string" },
			policy: { type: "string" },
			node: { type: "string" },
			"mode-arg": { type: "string" },
			samples: { type: "string" },
			warmup: { type: "string" },
			"timeout-ms": { type: "string" },
			phase: { type: "string" },
			"legacy-profile-env": { type: "boolean", default: false },
			plan: { type: "boolean", default: false },
			help: { type: "boolean", default: false },
		},
	});
	if (values.help) {
		process.stdout.write(
			[
				"measure-headless-runtime.mjs",
				"",
				"Required:",
				"  --exe <path>             OPT-017 compiled runtime executable",
				"  --build-manifest <path>  OPT-017 immutable build manifest",
				"  --fixture <path>         Versioned deterministic provider fixture",
				"  --out <path>             Evidence JSON path (unless --plan)",
				"  --baseline <path>        Pre-split evidence (required for post-split)",
				"  --policy <path>          Frozen performance policy (required for post-split)",
				"",
				"Sampling:",
				"  --samples <n>            Measured cold processes (default 10)",
				"  --warmup <n>             Discarded cold processes (default 1)",
				"  --timeout-ms <n>         Per-process timeout (default 60000)",
				"  --phase <name>           pre-split or post-split",
				"  --mode-arg <args>        Runtime arguments; pass an empty string after the split",
				"  --plan                   Validate identities and print the plan without spawning",
			].join("\n") + "\n",
		);
		process.exit(0);
	}
	const integer = (raw, name, fallback) => {
		if (raw === undefined) return fallback;
		const value = Number(raw);
		if (!Number.isInteger(value) || value < 0) fail(`--${name} must be a non-negative integer`);
		return value;
	};
	if (!values.exe) fail("--exe is required");
	if (!values["build-manifest"]) fail("--build-manifest is required");
	if (!values.fixture) fail("--fixture is required");
	if (!values.plan && !values.out) fail("--out is required unless --plan is used");
	if (!values.plan && (values.phase ?? DEFAULTS.phase) === "post-split" && (!values.baseline || !values.policy)) {
		fail("post-split measurement requires --baseline and --policy");
	}
	const out = values.out ? absolutePath(values.out) : undefined;
	if (out) {
		const relativeOutput = relative(REPO_ROOT, out);
		if (relativeOutput === "" || (!relativeOutput.startsWith("..") && !isAbsolute(relativeOutput))) {
			fail("--out must be outside the repository source tree");
		}
	}
	return {
		exe: absolutePath(values.exe),
		buildManifest: absolutePath(values["build-manifest"]),
		fixture: absolutePath(values.fixture),
		out,
		baseline: values.baseline ? absolutePath(values.baseline) : undefined,
		policy: values.policy ? absolutePath(values.policy) : undefined,
		node: values.node ? absolutePath(values.node) : undefined,
		modeArg: values["mode-arg"] ?? DEFAULTS.modeArg,
		samples: integer(values.samples, "samples", DEFAULTS.samples),
		warmup: integer(values.warmup, "warmup", DEFAULTS.warmup),
		timeoutMs: integer(values["timeout-ms"], "timeout-ms", DEFAULTS.timeoutMs),
		phase: values.phase ?? DEFAULTS.phase,
		legacyProfileEnv: values["legacy-profile-env"] === true,
		plan: values.plan === true,
	};
}

function loadFixture(path) {
	if (!existsSync(path)) fail(`fixture does not exist: ${path}`);
	const raw = readFileSync(path);
	let value;
	try {
		value = JSON.parse(raw.toString("utf8"));
	} catch (error) {
		fail(`fixture is not valid JSON: ${error.message}`);
	}
	if (value?.schema !== FIXTURE_SCHEMA) fail(`fixture schema must be ${FIXTURE_SCHEMA}`);
	for (const [name, candidate] of [
		["prompt", value.prompt],
		["assistantText", value.assistantText],
		["provider.id", value.provider?.id],
		["provider.modelId", value.provider?.modelId],
		["provider.apiKey", value.provider?.apiKey],
	]) {
		if (typeof candidate !== "string" || candidate.length === 0) fail(`fixture ${name} must be non-empty`);
	}
	if (value.provider.api !== "openai-completions") fail("fixture provider.api must be openai-completions");
	if (value.responseDelayMs !== undefined && (!Number.isInteger(value.responseDelayMs) || value.responseDelayMs < 0)) {
		fail("fixture responseDelayMs must be a non-negative integer");
	}
	return { ...value, path, sha256: createHash("sha256").update(raw).digest("hex") };
}

function samePath(left, right) {
	const a = normalize(resolve(left));
	const b = normalize(resolve(right));
	return platform() === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function verifyBuild(config) {
	if (!existsSync(config.exe)) fail(`executable does not exist: ${config.exe}`);
	if (!existsSync(config.buildManifest)) fail(`build manifest does not exist: ${config.buildManifest}`);
	const manifestRaw = readFileSync(config.buildManifest);
	const manifest = JSON.parse(manifestRaw.toString("utf8"));
	if (manifest.immutable !== true || typeof manifest.sourceId !== "string" || typeof manifest.buildId !== "string") {
		fail("build manifest is not an immutable OPT-017 manifest");
	}
	if (!Array.isArray(manifest.artifacts) || typeof manifest.appDir !== "string") {
		fail("build manifest lacks appDir/artifacts provenance");
	}
	const runtimeArtifacts = manifest.artifacts.filter((artifact) =>
		typeof artifact?.path === "string" && artifact.path.replaceAll("\\", "/").startsWith("dist/resources/pi-runtime/"),
	);
	if (runtimeArtifacts.length === 0) fail("build manifest has no staged pi-runtime artifacts");
	let executableArtifact;
	let stagedBytes = 0;
	const aggregate = createHash("sha256");
	for (const artifact of runtimeArtifacts) {
		const artifactPath = resolve(manifest.appDir, artifact.path);
		if (!existsSync(artifactPath)) fail(`manifest artifact is missing: ${artifactPath}`);
		const sizeBytes = statSync(artifactPath).size;
		const sha256 = sha256File(artifactPath);
		if (sizeBytes !== artifact.sizeBytes || sha256 !== artifact.sha256) {
			fail(`manifest artifact mismatch: ${artifact.path}`);
		}
		if (samePath(artifactPath, config.exe)) executableArtifact = artifact;
		stagedBytes += sizeBytes;
		aggregate.update(`${artifact.path}\0${sizeBytes}\0${sha256}\n`);
	}
	if (!executableArtifact) fail("--exe is not the compiled runtime recorded by the build manifest");
	const executableSha256 = sha256File(config.exe);
	return {
		manifest: {
			path: config.buildManifest,
			sha256: createHash("sha256").update(manifestRaw).digest("hex"),
			sourceId: manifest.sourceId,
			buildId: manifest.buildId,
			platform: manifest.platform,
			arch: manifest.arch,
		},
		executable: {
			path: config.exe,
			basename: basename(config.exe),
			sizeBytes: statSync(config.exe).size,
			sha256: executableSha256,
			provenance: "verified immutable build manifest artifact",
			directExecutable: !config.exe.toLowerCase().endsWith(".js"),
		},
		stagedRuntime: {
			root: resolve(manifest.appDir, "dist", "resources", "pi-runtime"),
			artifactCount: runtimeArtifacts.length,
			sizeBytes: stagedBytes,
			aggregateSha256: aggregate.digest("hex"),
		},
	};
}

function summarize(samples) {
	const sorted = [...samples].sort((a, b) => a - b);
	const percentile = (percent) => sorted[Math.max(0, Math.ceil((percent / 100) * sorted.length) - 1)] ?? null;
	return {
		count: samples.length,
		min: sorted[0] ?? null,
		max: sorted.at(-1) ?? null,
		median: percentile(50),
		p95: percentile(95),
		samples,
	};
}

function loadJsonFile(path, label) {
	if (!path || !existsSync(path)) fail(`${label} does not exist: ${path}`);
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		fail(`${label} is not valid JSON: ${error.message}`);
	}
}

function compareWithBaseline(config, identity, metrics, fixture) {
	if (!config.baseline || !config.policy) return null;
	const baselineRaw = readFileSync(config.baseline);
	const policyRaw = readFileSync(config.policy);
	const baseline = loadJsonFile(config.baseline, "baseline evidence");
	const policy = loadJsonFile(config.policy, "performance policy");
	if (policy.schema !== "mortise/headless-runtime-performance-policy/v1") fail("unsupported performance policy schema");
	if (baseline.schema !== SCHEMA || baseline.phase !== "pre-split" || baseline.status !== "complete") {
		fail("baseline evidence must be a complete pre-split evidence set");
	}
	for (const [label, actual, expected] of [
		["baseline revision", baseline.source?.revision, policy.baselineRevision],
		["baseline source id", baseline.build?.manifest?.sourceId, policy.baselineSourceId],
		["baseline build id", baseline.build?.manifest?.buildId, policy.baselineBuildId],
		["baseline executable hash", baseline.build?.executable?.sha256, policy.baselineExecutableSha256],
		["fixture hash", baseline.fixture?.sha256, fixture.sha256],
		["host name", baseline.host?.hostname, identity.host.hostname],
		["host platform", baseline.host?.platform, identity.host.platform],
		["host architecture", baseline.host?.arch, identity.host.arch],
		["CPU model", baseline.host?.cpuModel, identity.host.cpuModel],
	]) {
		if (actual !== expected) fail(`${label} mismatch: expected ${expected}, observed ${actual}`);
	}
	const expectedSamples = Number(policy.sampling?.finalSamples);
	const expectedWarmup = Number(policy.sampling?.warmup);
	if (config.samples !== expectedSamples || config.warmup !== expectedWarmup) {
		fail(`sampling policy requires ${expectedWarmup} warmup and ${expectedSamples} measured samples`);
	}
	if (baseline.config?.samples !== Number(policy.sampling?.baseSamples) || baseline.config?.warmup !== expectedWarmup) {
		fail("baseline sampling does not match the frozen policy");
	}
	const ceilingPercent = Number(policy.budgets?.relativeRegressionCeilingPercent);
	if (!Number.isFinite(ceilingPercent) || ceilingPercent < 0) fail("performance policy regression ceiling is invalid");
	const comparisons = [];
	for (const metricName of policy.metrics ?? []) {
		const baselineMetric = baseline.metrics?.[metricName];
		const finalMetric = metrics[metricName];
		const statistics = typeof baselineMetric === "number" ? ["value"] : policy.sampling?.statistics ?? [];
		for (const statistic of statistics) {
			const baselineValue = statistic === "value" ? baselineMetric : baselineMetric?.[statistic];
			const finalValue = statistic === "value" ? finalMetric : finalMetric?.[statistic];
			if (!Number.isFinite(baselineValue) || !Number.isFinite(finalValue) || baselineValue <= 0) {
				fail(`metric ${metricName}.${statistic} is missing or invalid`);
			}
			const deltaPercent = ((finalValue - baselineValue) / baselineValue) * 100;
			comparisons.push({
				metric: metricName,
				statistic,
				baseline: baselineValue,
				final: finalValue,
				deltaPercent,
				ceilingPercent,
				status: deltaPercent <= ceilingPercent ? "pass" : "fail",
			});
		}
	}
	return {
		policy: { path: config.policy, sha256: createHash("sha256").update(policyRaw).digest("hex") },
		baseline: { path: config.baseline, sha256: createHash("sha256").update(baselineRaw).digest("hex") },
		comparisons,
		status: comparisons.every((comparison) => comparison.status === "pass") ? "pass" : "fail",
	};
}

async function processSnapshot() {
	if (platform() === "win32") {
		const script =
			"Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize | ConvertTo-Json -Compress";
		const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
			windowsHide: true,
			maxBuffer: 8 * 1024 * 1024,
		});
		const parsed = JSON.parse(stdout || "[]");
		return (Array.isArray(parsed) ? parsed : [parsed]).map((item) => ({
			pid: Number(item.ProcessId),
			parentPid: Number(item.ParentProcessId),
			rssBytes: Number(item.WorkingSetSize),
		}));
	}
	const { stdout } = await execFileAsync("ps", ["-e", "-o", "pid=,ppid=,rss="]);
	return stdout
		.trim()
		.split(/\r?\n/)
		.map((line) => line.trim().split(/\s+/).map(Number))
		.map(([pid, parentPid, rssKiB]) => ({ pid, parentPid, rssBytes: rssKiB * 1024 }));
}

async function sampleProcessTree(rootPid) {
	const snapshot = await processSnapshot();
	const selected = new Set([rootPid]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const process of snapshot) {
			if (selected.has(process.parentPid) && !selected.has(process.pid)) {
				selected.add(process.pid);
				changed = true;
			}
		}
	}
	const processes = snapshot.filter((process) => selected.has(process.pid));
	return { processes, rssBytes: processes.reduce((sum, process) => sum + process.rssBytes, 0) };
}

function samplingResult(rawSamples, promptSentAtMs, settledAtMs, processIds, error = null) {
	const samples = rawSamples
		.filter((sample) => promptSentAtMs && settledAtMs && sample.observedAtMs >= promptSentAtMs && sample.observedAtMs <= settledAtMs)
		.map((sample) => ({
			capturedAtMs: sample.observedAtMs - promptSentAtMs,
			rssBytes: sample.rssBytes,
			processIds,
		}));
	const peak = samples.reduce(
		(current, sample) => !current || sample.rssBytes > current.rssBytes ? sample : current,
		null,
	);
	return { peak, samples, error };
}

function startPeakProcessTreeSampler(rootPid, processIds) {
	if (platform() === "win32") {
		const script = [
			`$ids=@(${processIds.join(",")})`,
			'$ErrorActionPreference="SilentlyContinue"',
			'[Console]::Out.WriteLine("ready");[Console]::Out.Flush()',
			'while(($request=[Console]::In.ReadLine()) -ne $null){$now=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();$total=[int64]0;foreach($processId in $ids){$candidate=Get-Process -Id $processId -ErrorAction SilentlyContinue;if($candidate){$total+=$candidate.WorkingSet64}};[Console]::Out.WriteLine("$now,$total");[Console]::Out.Flush()}',
		].join(";");
		const sampler = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		const rawSamples = [];
		let buffer = "";
		let samplerError = null;
		let stopping = false;
		let resolveReady;
		const ready = new Promise((resolvePromise) => {
			resolveReady = resolvePromise;
		});
		sampler.stdout.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			let index;
			while ((index = buffer.indexOf("\n")) !== -1) {
				const line = buffer.slice(0, index).trim();
				buffer = buffer.slice(index + 1);
				if (line === "ready") {
					resolveReady();
					continue;
				}
				const [observedAtRaw, rssRaw] = line.split(",");
				const observedAtMs = Number(observedAtRaw);
				const rssBytes = Number(rssRaw);
				if (Number.isFinite(observedAtMs) && Number.isFinite(rssBytes) && rssBytes > 0) {
					rawSamples.push({ observedAtMs, rssBytes });
					if (!stopping && sampler.stdin.writable) sampler.stdin.write("sample\n");
				}
			}
		});
		sampler.stderr.on("data", (chunk) => {
			samplerError = chunk.toString("utf8").trim() || samplerError;
		});
		sampler.on("error", (error) => {
			samplerError = error.message;
			resolveReady();
		});
		return {
			ready,
			start() {
				if (sampler.stdin.writable) sampler.stdin.write("sample\n");
			},
			async stop(promptSentAtMs, settledAtMs) {
				stopping = true;
				sampler.stdin.end();
				await Promise.race([once(sampler, "exit").catch(() => {}), new Promise((resolveWait) => setTimeout(resolveWait, 2_000))]);
				if (sampler.exitCode === null && sampler.signalCode === null) sampler.kill();
				return samplingResult(rawSamples, promptSentAtMs, settledAtMs, processIds, samplerError);
			},
		};
	}

	let stopping = false;
	const rawSamples = [];
	let resolveReady;
	const ready = new Promise((resolvePromise) => {
		resolveReady = resolvePromise;
	});
	const runner = (async () => {
		while (!stopping) {
			const sample = await sampleProcessTree(rootPid);
			rawSamples.push({ observedAtMs: Date.now(), rssBytes: sample.rssBytes });
			resolveReady();
			if (!stopping) await new Promise((resolveWait) => setTimeout(resolveWait, 10));
		}
	})().catch((error) => ({ error: error.message }));
	return {
		ready,
		start() {},
		async stop(promptSentAtMs, settledAtMs) {
			stopping = true;
			const result = await runner;
			return samplingResult(rawSamples, promptSentAtMs, settledAtMs, processIds, result?.error ?? null);
		},
	};
}

async function isAlive(pid) {
	try {
		const snapshot = await processSnapshot();
		return snapshot.some((process) => process.pid === pid);
	} catch {
		return false;
	}
}

async function terminateProcessTree(child) {
	if (!child || typeof child.pid !== "number") return [];
	const before = await sampleProcessTree(child.pid).catch(() => ({ processes: [{ pid: child.pid }] }));
	if (child.exitCode === null && child.signalCode === null) {
		if (platform() === "win32") {
			await execFileAsync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }).catch(() => {});
		} else {
			child.kill("SIGKILL");
		}
	}
	await Promise.race([once(child, "exit").catch(() => {}), new Promise((resolveWait) => setTimeout(resolveWait, 2_000))]);
	const orphanPids = [];
	for (const process of before.processes) {
		if (await isAlive(process.pid)) orphanPids.push(process.pid);
	}
	return orphanPids;
}

function readJsonl(child, onRecord) {
	let buffer = "";
	child.stdout.on("data", (chunk) => {
		buffer += chunk.toString("utf8");
		let index;
		while ((index = buffer.indexOf("\n")) !== -1) {
			const line = buffer.slice(0, index).trim();
			buffer = buffer.slice(index + 1);
			if (!line) continue;
			try {
				onRecord(JSON.parse(line));
			} catch {
				// stdout diagnostics are ignored; stderr is retained in the sample.
			}
		}
	});
}

function assistantTextFromMessage(message) {
	if (!message || message.role !== "assistant") return null;
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return null;
	return message.content
		.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

async function startFixtureProvider(fixture) {
	const requests = [];
	const server = createServer(async (request, response) => {
		const chunks = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		const bodyRaw = Buffer.concat(chunks);
		let body;
		try {
			body = JSON.parse(bodyRaw.toString("utf8"));
		} catch {
			body = null;
		}
		const promptObserved = Array.isArray(body?.messages)
			? body.messages.some((message) => JSON.stringify(message.content).includes(fixture.prompt))
			: false;
		const record = {
			method: request.method,
			path: request.url,
			model: body?.model ?? null,
			stream: body?.stream ?? null,
			authorizationValid: request.headers.authorization === `Bearer ${fixture.provider.apiKey}`,
			promptObserved,
			bodySha256: createHash("sha256").update(bodyRaw).digest("hex"),
		};
		requests.push(record);
		if (
			request.method !== "POST" ||
			request.url !== "/v1/chat/completions" ||
			body?.model !== fixture.provider.modelId ||
			body?.stream !== true ||
			!record.authorizationValid ||
			!promptObserved
		) {
			response.writeHead(400, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: { message: "fixture request mismatch" } }));
			return;
		}
		if (fixture.responseDelayMs) await new Promise((resolveDelay) => setTimeout(resolveDelay, fixture.responseDelayMs));
		response.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		const id = `mortise-fixture-${requests.length}`;
		response.write(
			`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: fixture.provider.modelId, choices: [{ index: 0, delta: { role: "assistant", content: fixture.assistantText }, finish_reason: null }] })}\n\n`,
		);
		response.write(
			`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: fixture.provider.modelId, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } })}\n\n`,
		);
		response.end("data: [DONE]\n\n");
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	return {
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		requests,
		async close() {
			server.close();
			await once(server, "close");
		},
	};
}

function prepareProfile(fixture, baseUrl) {
	const root = mkdtempSync(join(tmpdir(), "mortise-opt018-headless-"));
	const agentDir = join(root, "agent");
	const sessionDir = join(root, "sessions");
	const workspaceDir = join(root, "workspace");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });
	mkdirSync(workspaceDir, { recursive: true });
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				[fixture.provider.id]: {
					baseUrl,
					api: fixture.provider.api,
					authHeader: true,
					models: [
						{
							id: fixture.provider.modelId,
							name: "Mortise deterministic fixture",
							reasoning: false,
							input: ["text"],
							contextWindow: 32_000,
							maxTokens: 1_024,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						},
					],
				},
			},
		}),
	);
	writeFileSync(
		join(agentDir, "auth.json"),
		JSON.stringify({ [fixture.provider.id]: { type: "api_key", key: fixture.provider.apiKey } }),
	);
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ defaultProvider: fixture.provider.id, defaultModel: fixture.provider.modelId }),
	);
	return { root, agentDir, sessionDir, workspaceDir };
}

function spawnRuntime(config, build, profile) {
	const modeArgs = config.modeArg.trim() ? config.modeArg.trim().split(/\s+/) : [];
	const command = build.executable.directExecutable ? build.executable.path : config.node ?? process.execPath;
	const args = build.executable.directExecutable ? modeArgs : [build.executable.path, ...modeArgs];
	return spawn(command, args, {
		cwd: profile.workspaceDir,
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
		env: {
			...process.env,
			...(config.legacyProfileEnv
				? {
					PI_CODING_AGENT_DIR: profile.agentDir,
					PI_CODING_AGENT_SESSION_DIR: profile.sessionDir,
					PI_CODING_AGENT_PROJECT_DIR: ".mortise",
					MORTISE_CODING_AGENT_DIR: profile.agentDir,
					MORTISE_CODING_AGENT_SESSION_DIR: profile.sessionDir,
					MORTISE_CODING_AGENT_PROJECT_DIR: ".mortise",
				}
				: {}),
			MORTISE_AGENT_DIR: profile.agentDir,
			MORTISE_SESSION_DIR: profile.sessionDir,
			MORTISE_PROJECT_CONFIG_DIR: ".mortise",
			MORTISE_DEBUG: "0",
		},
	});
}

async function runSample(config, build, fixture, provider, label) {
	const profile = prepareProfile(fixture, provider.baseUrl);
	const requestStartIndex = provider.requests.length;
	const startedAt = process.hrtime.bigint();
	const child = spawnRuntime(config, build, profile);
	const stderr = [];
	let handshakeMs = null;
	let idleProcessTree = null;
	let activeProcessTree = null;
	let activeProcessTreeSamples = [];
	let promptSentAt = null;
	let promptSentAtMs = null;
	let settledAt = null;
	let settledAtMs = null;
	let activeSampler = null;
	let promptAcknowledged = false;
	let settled = false;
	let assistantText = null;
	let completed = false;
	let failure = null;
	let resolveCompletion;
	const completion = new Promise((resolveDone) => {
		resolveCompletion = resolveDone;
	});
	const timer = setTimeout(() => {
		failure = `timeout after ${config.timeoutMs}ms`;
		resolveCompletion();
	}, config.timeoutMs);
	child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
	child.on("error", (error) => {
		failure = `spawn error: ${error.message}`;
		resolveCompletion();
	});
	child.on("exit", (code, signal) => {
		if (!completed && !failure) {
			failure = `runtime exited before agent_settled: code=${code} signal=${signal}`;
			resolveCompletion();
		}
	});
	readJsonl(child, (record) => {
		void (async () => {
			if (handshakeMs === null && record.type === "response" && record.command === "get_capabilities") {
				if (record.success !== true) {
					failure = `capabilities failed: ${record.error ?? "unknown"}`;
					resolveCompletion();
					return;
				}
				handshakeMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
				idleProcessTree = await sampleProcessTree(child.pid);
				activeSampler = startPeakProcessTreeSampler(
					child.pid,
					idleProcessTree.processes.map((process) => process.pid),
				);
				await activeSampler.ready;
				promptSentAt = process.hrtime.bigint();
				promptSentAtMs = Date.now();
				child.stdin.write(`${JSON.stringify({ id: `${label}-prompt`, type: "prompt", message: fixture.prompt })}\n`);
				activeSampler.start();
				return;
			}
			if (record.id === `${label}-prompt` && record.type === "response" && record.command === "prompt") {
				promptAcknowledged = record.success === true;
				if (!promptAcknowledged) {
					failure = `prompt rejected: ${record.error ?? "unknown"}`;
					resolveCompletion();
				}
				return;
			}
			if ((record.type === "message_update" || record.type === "message_end") && record.message?.role === "assistant") {
				const observedText = assistantTextFromMessage(record.message);
				if (observedText) assistantText = observedText;
			}
			if (record.type === "agent_settled") {
				settledAt = process.hrtime.bigint();
				settledAtMs = Date.now();
				settled = true;
				completed = true;
				resolveCompletion();
			}
		})();
	});
	child.stdin.write(`${JSON.stringify({ id: `${label}-capabilities`, type: "get_capabilities" })}\n`);
	await completion;
	clearTimeout(timer);
	if (activeSampler) {
		const activeSampling = await activeSampler.stop(promptSentAtMs, settledAtMs);
		activeProcessTree = activeSampling.peak;
		activeProcessTreeSamples = activeSampling.samples;
		if (activeSampling.error) failure ??= `active RSS sampling failed: ${activeSampling.error}`;
	}
	const settledMs = promptSentAt && settledAt ? Number(settledAt - promptSentAt) / 1e6 : null;
	const orphanPids = await terminateProcessTree(child);
	const providerRequests = provider.requests.slice(requestStartIndex);
	if (!failure && !promptAcknowledged) failure = "prompt ACK was not observed";
	if (!failure && !settled) failure = "agent_settled was not observed";
	if (!failure && activeProcessTreeSamples.length === 0) failure = "active RSS sampler captured no process-tree samples";
	if (!failure && assistantText !== fixture.assistantText) {
		failure = `assistant text mismatch: expected ${JSON.stringify(fixture.assistantText)}, received ${JSON.stringify(assistantText)}`;
	}
	if (!failure && providerRequests.length !== 1) failure = `expected one provider request, received ${providerRequests.length}`;
	if (!failure && orphanPids.length > 0) failure = `orphan processes remain: ${orphanPids.join(",")}`;
	let profileRemoved = false;
	try {
		rmSync(profile.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
		profileRemoved = !existsSync(profile.root);
	} catch (error) {
		failure ??= `profile cleanup failed: ${error.message}`;
	}
	if (!profileRemoved) failure ??= "isolated profile was not removed";
	return {
		label,
		status: failure ? "failed" : "ok",
		failure,
		handshakeMs,
		idleProcessTree,
		activeProcessTree,
		activeProcessTreeSamples,
		promptToAgentSettledMs: settledMs,
		promptAcknowledged,
		agentSettled: settled,
		assistantText,
		providerRequests,
		teardown: { orphanPids, profileRemoved },
		stderr: Buffer.concat(stderr).toString("utf8").slice(-4_000),
	};
}

async function gitCapture(args) {
	try {
		return (await execFileAsync("git", args, { cwd: REPO_ROOT })).stdout.trim();
	} catch {
		return null;
	}
}

async function captureHost(config, build, fixture) {
	const [revision, dirty] = await Promise.all([gitCapture(["rev-parse", "HEAD"]), gitCapture(["status", "--porcelain"])]);
	const cpuList = cpus();
	return {
		schema: SCHEMA,
		phase: config.phase,
		capturedAt: new Date().toISOString(),
		source: { revision, worktreeDirty: dirty === null ? null : dirty.length > 0 },
		build,
		fixture: { path: fixture.path, sha256: fixture.sha256, schema: fixture.schema },
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
			samples: config.samples,
			warmup: config.warmup,
			timeoutMs: config.timeoutMs,
			modeArg: config.modeArg,
			legacyProfileEnv: config.legacyProfileEnv,
			baseline: config.baseline ?? null,
			policy: config.policy ?? null,
		},
	};
}

async function main() {
	const config = parseCliArgs(process.argv.slice(2));
	const fixture = loadFixture(config.fixture);
	const build = verifyBuild(config);
	const identity = await captureHost(config, build, fixture);
	if (config.plan) {
		process.stdout.write(`${JSON.stringify({ ...identity, plan: { willSpawn: false } }, null, 2)}\n`);
		return;
	}
	const provider = await startFixtureProvider(fixture);
	const rawSamples = [];
	try {
		for (let index = 0; index < config.warmup + config.samples; index++) {
			const warmup = index < config.warmup;
			const label = warmup ? `warmup-${index + 1}` : `sample-${index - config.warmup + 1}`;
			const sample = await runSample(config, build, fixture, provider, label);
			rawSamples.push({ ...sample, warmup });
			process.stderr.write(
				`[measure-headless-runtime] ${label} ${sample.status} handshake=${sample.handshakeMs?.toFixed(1) ?? "n/a"}ms settled=${sample.promptToAgentSettledMs?.toFixed(1) ?? "n/a"}ms\n`,
			);
		}
	} finally {
		await provider.close();
	}
	const measured = rawSamples.filter((sample) => !sample.warmup);
	const failures = rawSamples.filter((sample) => sample.status !== "ok");
	const metric = (select) => summarize(measured.map(select).filter((value) => typeof value === "number"));
	const metrics = {
		compiledExecutableBytes: build.executable.sizeBytes,
		completeStagedRuntimeBytes: build.stagedRuntime.sizeBytes,
		coldProcessToCapabilitiesHandshakeMs: metric((sample) => sample.handshakeMs),
		idleProcessTreeRssBytes: metric((sample) => sample.idleProcessTree?.rssBytes),
		activeProcessTreeRssBytes: metric((sample) => sample.activeProcessTree?.rssBytes),
		promptToAgentSettledMs: metric((sample) => sample.promptToAgentSettledMs),
	};
	const comparison = compareWithBaseline(config, identity, metrics, fixture);
	const blockers = failures.map((sample) => `${sample.label}: ${sample.failure}`);
	for (const failed of comparison?.comparisons.filter((item) => item.status === "fail") ?? []) {
		blockers.push(
			`${failed.metric}.${failed.statistic} regressed ${failed.deltaPercent.toFixed(2)}% (ceiling ${failed.ceilingPercent}%)`,
		);
	}
	const evidence = {
		...identity,
		metrics,
		comparison,
		rawSamples,
		status:
			failures.length === 0 && measured.length === config.samples && comparison?.status !== "fail"
				? "complete"
				: "invalid",
		blockers,
	};
	mkdirSync(dirname(config.out), { recursive: true });
	writeFileSync(config.out, `${JSON.stringify(evidence, null, 2)}\n`);
	process.stderr.write(`[measure-headless-runtime] status=${evidence.status} evidence=${config.out}\n`);
	if (evidence.status !== "complete") process.exitCode = 1;
}

main().catch((error) => {
	process.stderr.write(`[measure-headless-runtime] FATAL: ${error?.stack ?? error}\n`);
	process.exitCode = 2;
});
