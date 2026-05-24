import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { acquireLock, getYourselfOutputDir, homeRelative, releaseLock, resetYourselfOutputDir } from "./state.js";
import { isMimoAvailable } from "./summarizer.js";
import { STATUS_SPINNER_FRAMES, YOURSELF_MODEL_REF, YOURSELF_STATUS_KEY, type YourselfRuntimeStatus } from "./types.js";
import { runYourselfWorker } from "./worker.js";

function createInitialStatus(outputDir: string): YourselfRuntimeStatus {
	const now = new Date().toISOString();
	return {
		status: "idle",
		startedAt: now,
		updatedAt: now,
		message: "Idle",
		outputDir,
		stats: {
			totalSessions: 0,
			processedSessions: 0,
			skippedSessions: 0,
			failedSessions: 0,
			writtenSummaries: 0,
		},
	};
}

function formatStatus(status: YourselfRuntimeStatus, frame: string): string {
	const stats = status.stats;
	const prefix =
		status.status === "complete" ? "✓" : status.status === "error" ? "✗" : status.status === "stopped" ? "■" : frame;
	const progress =
		stats.totalSessions > 0
			? `${stats.processedSessions + stats.skippedSessions + stats.failedSessions}/${stats.totalSessions}`
			: "0/0";
	const detail =
		status.status === "error" ? (status.lastError ?? status.message ?? "error") : (status.message ?? status.status);
	return `${prefix} YOURSELF ${status.status} ${progress} · wrote ${stats.writtenSummaries} · ${detail}`;
}

function summarizeStatus(status: YourselfRuntimeStatus): string {
	const stats = status.stats;
	return [
		`YOURSELF status: ${status.status}`,
		`Output: ${homeRelative(status.outputDir)}`,
		`Model: ${YOURSELF_MODEL_REF}`,
		`Sessions: ${stats.processedSessions} processed, ${stats.skippedSessions} skipped, ${stats.failedSessions} failed, ${stats.totalSessions} total`,
		`Written summaries: ${stats.writtenSummaries}`,
		status.currentSession ? `Current: ${status.currentSession}` : undefined,
		status.message ? `Message: ${status.message}` : undefined,
		status.lastError ? `Last error: ${status.lastError}` : undefined,
		status.updatedAt ? `Updated: ${status.updatedAt}` : undefined,
	]
		.filter((line): line is string => Boolean(line))
		.join("\n");
}

const YOURSELF_COMMAND_ARGUMENTS = [
	{ value: "status", label: "status", description: "Show current scan status" },
	{ value: "reset", label: "reset", description: "Reset memory output and restart the scan" },
];

function completeYourselfArgument(prefix: string) {
	const trimmedPrefix = prefix.trimStart();
	if (trimmedPrefix.includes(" ")) {
		return null;
	}

	const normalizedPrefix = trimmedPrefix.toLowerCase();
	const items = YOURSELF_COMMAND_ARGUMENTS.filter((item) => item.value.startsWith(normalizedPrefix));
	return items.length > 0 ? items : null;
}

export default function (pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT_CHILD === "1") return;

	const outputDir = getYourselfOutputDir();
	let status = createInitialStatus(outputDir);
	let controller: AbortController | undefined;
	let spinnerTimer: ReturnType<typeof setInterval> | undefined;
	let spinnerIndex = 0;
	let lastContext: ExtensionContext | undefined;

	const setStatus = (nextStatus: YourselfRuntimeStatus) => {
		status = nextStatus;
		if (!lastContext?.hasUI) return;
		const frame = STATUS_SPINNER_FRAMES[spinnerIndex % STATUS_SPINNER_FRAMES.length] ?? "⠋";
		lastContext.ui.setStatus(YOURSELF_STATUS_KEY, formatStatus(status, frame));
	};

	const stopSpinner = () => {
		if (spinnerTimer) clearInterval(spinnerTimer);
		spinnerTimer = undefined;
	};

	const startSpinner = () => {
		if (spinnerTimer) return;
		spinnerTimer = setInterval(() => {
			spinnerIndex++;
			setStatus(status);
		}, 120);
		spinnerTimer.unref?.();
	};

	const startWorker = async (ctx: ExtensionContext) => {
		lastContext = ctx;
		if (controller) {
			setStatus({ ...status, message: "Already running", updatedAt: new Date().toISOString() });
			return;
		}
		if (!isMimoAvailable(ctx)) {
			setStatus({
				...status,
				status: "error",
				updatedAt: new Date().toISOString(),
				lastError: `Model not found: ${YOURSELF_MODEL_REF}`,
				message: "MiMo model unavailable",
			});
			return;
		}

		const lock = await acquireLock(outputDir, { sessionFile: ctx.sessionManager.getSessionFile(), cwd: ctx.cwd });
		if (!lock.acquired) {
			setStatus({
				...status,
				status: "idle",
				updatedAt: new Date().toISOString(),
				message: `Another YOURSELF scan is running (pid ${lock.lock.pid})`,
			});
			return;
		}

		controller = new AbortController();
		status = createInitialStatus(outputDir);
		setStatus({
			...status,
			status: "starting",
			message: "Starting YOURSELF scan",
			updatedAt: new Date().toISOString(),
		});
		startSpinner();

		void runYourselfWorker(ctx, {
			outputDir,
			currentSessionFile: ctx.sessionManager.getSessionFile(),
			status,
			onStatus: setStatus,
			signal: controller.signal,
		}).finally(() => {
			controller = undefined;
			stopSpinner();
			setStatus(status);
		});
	};

	pi.on("session_start", (_event, ctx) => {
		lastContext = ctx;
		void startWorker(ctx).catch((error) => {
			setStatus({
				...status,
				status: "error",
				updatedAt: new Date().toISOString(),
				lastError: error instanceof Error ? error.message : String(error),
				message: "Failed to start YOURSELF scan",
			});
			void releaseLock(outputDir);
		});
	});

	pi.on("session_shutdown", () => {
		controller?.abort();
		controller = undefined;
		stopSpinner();
		if (lastContext?.hasUI) {
			lastContext.ui.setStatus(YOURSELF_STATUS_KEY, undefined);
		}
	});

	pi.registerCommand("yourself", {
		description: "Manage YOURSELF memory consolidation. Usage: /yourself status|reset",
		getArgumentCompletions: completeYourselfArgument,
		handler: async (args, ctx) => {
			lastContext = ctx;
			const subcommand = args.trim().toLowerCase() || "status";
			if (subcommand === "status") {
				ctx.ui.notify(summarizeStatus(status), status.status === "error" ? "error" : "info");
				return;
			}
			if (subcommand !== "reset") {
				ctx.ui.notify("Usage: /yourself status|reset", "warning");
				return;
			}

			if (controller) {
				controller.abort();
				controller = undefined;
				stopSpinner();
				await releaseLock(outputDir);
			}

			const backupDir = await resetYourselfOutputDir(outputDir);
			status = createInitialStatus(outputDir);
			setStatus({
				...status,
				message: backupDir ? `Reset; backup: ${homeRelative(backupDir)}` : "Reset; no existing output",
				updatedAt: new Date().toISOString(),
			});
			ctx.ui.notify(
				backupDir
					? `YOURSELF reset. Backup: ${homeRelative(backupDir)}. Restarting scan.`
					: "YOURSELF reset. Restarting scan.",
				"info",
			);
			await startWorker(ctx);
		},
	});
}
