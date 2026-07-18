import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	CHECKPOINT_VERSION,
	LOCK_VERSION,
	STALE_LOCK_MS,
	type WriteSummaryResult,
	YOURSELF_INDEX_FILE_NAME,
	YOURSELF_LOCK_FILE_NAME,
	YOURSELF_OUTPUT_DIR_NAME,
	YOURSELF_STATE_DIR_NAME,
	type YourselfCheckpoint,
	type YourselfLock,
	type YourselfSummary,
} from "./types.ts";

export function getYourselfOutputDir(): string {
	return path.join(getAgentDir(), YOURSELF_OUTPUT_DIR_NAME);
}

export function getYourselfStateDir(outputDir = getYourselfOutputDir()): string {
	return path.join(outputDir, YOURSELF_STATE_DIR_NAME);
}

export function getCheckpointPath(outputDir = getYourselfOutputDir()): string {
	return path.join(getYourselfStateDir(outputDir), YOURSELF_INDEX_FILE_NAME);
}

export function getLockPath(outputDir = getYourselfOutputDir()): string {
	return path.join(getYourselfStateDir(outputDir), YOURSELF_LOCK_FILE_NAME);
}

export async function resetYourselfOutputDir(outputDir = getYourselfOutputDir()): Promise<string | undefined> {
	if (!(await pathExists(outputDir))) return undefined;
	const parentDir = path.dirname(outputDir);
	const baseName = path.basename(outputDir);
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	let backupDir = path.join(parentDir, `${baseName}.backup.${timestamp}`);
	let attempt = 1;
	while (await pathExists(backupDir)) {
		backupDir = path.join(parentDir, `${baseName}.backup.${timestamp}.${attempt}`);
		attempt++;
	}
	await fs.rename(outputDir, backupDir);
	return backupDir;
}

export async function ensureYourselfDirs(outputDir = getYourselfOutputDir()): Promise<void> {
	await fs.mkdir(getYourselfStateDir(outputDir), { recursive: true });
}

export async function pathExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
	try {
		return JSON.parse(await fs.readFile(filePath, "utf-8")) as T;
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
}

export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	const tempPath = path.join(
		path.dirname(filePath),
		`.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
	);
	try {
		await fs.writeFile(tempPath, content, { encoding: "utf-8", mode: 0o600 });
		await fs.rename(tempPath, filePath);
	} finally {
		await fs.rm(tempPath, { force: true });
	}
}

export async function writeJsonAtomic(filePath: string, payload: object): Promise<void> {
	await writeFileAtomic(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

export async function loadCheckpoint(outputDir = getYourselfOutputDir()): Promise<YourselfCheckpoint> {
	await ensureYourselfDirs(outputDir);
	const checkpoint = await readJsonFile<YourselfCheckpoint>(getCheckpointPath(outputDir));
	if (checkpoint?.version === CHECKPOINT_VERSION && checkpoint.sessions && typeof checkpoint.sessions === "object") {
		return checkpoint;
	}
	return {
		version: CHECKPOINT_VERSION,
		updatedAt: new Date().toISOString(),
		sessions: {},
	};
}

export async function saveCheckpoint(
	checkpoint: YourselfCheckpoint,
	outputDir = getYourselfOutputDir(),
): Promise<void> {
	checkpoint.updatedAt = new Date().toISOString();
	await writeJsonAtomic(getCheckpointPath(outputDir), checkpoint);
}

function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error) {
			return error.code === "EPERM";
		}
		return false;
	}
}

function isLockStale(lock: YourselfLock): boolean {
	const updatedAt = new Date(lock.updatedAt || lock.createdAt).getTime();
	const tooOld = Number.isFinite(updatedAt) ? Date.now() - updatedAt > STALE_LOCK_MS : true;
	return tooOld || !isProcessAlive(lock.pid);
}

export async function acquireLock(
	outputDir = getYourselfOutputDir(),
	input: { sessionFile?: string; cwd: string },
): Promise<{ acquired: true; lock: YourselfLock } | { acquired: false; lock: YourselfLock }> {
	await ensureYourselfDirs(outputDir);
	const lockPath = getLockPath(outputDir);
	const now = new Date().toISOString();
	const nextLock: YourselfLock = {
		version: LOCK_VERSION,
		pid: process.pid,
		createdAt: now,
		updatedAt: now,
		sessionFile: input.sessionFile,
		cwd: input.cwd,
	};

	try {
		const handle = await fs.open(lockPath, "wx");
		try {
			await handle.writeFile(`${JSON.stringify(nextLock, null, 2)}\n`, "utf-8");
		} finally {
			await handle.close();
		}
		return { acquired: true, lock: nextLock };
	} catch (error) {
		if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) {
			throw error;
		}
	}

	const existingLock = await readJsonFile<YourselfLock>(lockPath);
	if (existingLock && !isLockStale(existingLock)) {
		return { acquired: false, lock: existingLock };
	}

	await fs.rm(lockPath, { force: true });
	const handle = await fs.open(lockPath, "wx");
	try {
		await handle.writeFile(`${JSON.stringify(nextLock, null, 2)}\n`, "utf-8");
	} finally {
		await handle.close();
	}
	return { acquired: true, lock: nextLock };
}

export async function touchLock(outputDir = getYourselfOutputDir()): Promise<void> {
	const lockPath = getLockPath(outputDir);
	const lock = await readJsonFile<YourselfLock>(lockPath);
	if (!lock || lock.pid !== process.pid) return;
	lock.updatedAt = new Date().toISOString();
	await writeJsonAtomic(lockPath, lock);
}

export async function releaseLock(outputDir = getYourselfOutputDir()): Promise<void> {
	const lockPath = getLockPath(outputDir);
	const lock = await readJsonFile<YourselfLock>(lockPath);
	if (!lock || lock.pid !== process.pid) return;
	await fs.rm(lockPath, { force: true });
}

export function normalizeForHash(text: string): string {
	return text
		.replace(/\r\n/g, "\n")
		.replace(/[ \t]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export function hashText(text: string): string {
	return createHash("sha256").update(normalizeForHash(text)).digest("hex");
}

export function shortHash(text: string): string {
	return hashText(text).slice(0, 16);
}

function getSummaryMarker(hash: string): string {
	return `<!-- yourself:${hash} -->`;
}

function normalizeDateFileName(date: string): string {
	return /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}.md` : "unknown-date.md";
}

function formatSummaryBlock(summary: YourselfSummary): string {
	return [
		getSummaryMarker(summary.hash),
		`## ${summary.createdAt} · ${summary.sessionId}`,
		"",
		`- Session: ${summary.sessionPath}`,
		`- CWD: ${summary.cwd || "(unknown)"}`,
		`- Model: ${summary.model}`,
		`- Hash: ${summary.hash}`,
		"",
		summary.content.trim(),
		"",
	].join("\n");
}

export async function hasSummaryMarker(
	summary: Pick<YourselfSummary, "date" | "hash">,
	outputDir = getYourselfOutputDir(),
): Promise<boolean> {
	const datePath = path.join(outputDir, normalizeDateFileName(summary.date));
	if (!(await pathExists(datePath))) return false;
	const existing = await fs.readFile(datePath, "utf-8");
	return existing.includes(getSummaryMarker(summary.hash));
}

export async function writeSummary(
	summary: YourselfSummary,
	outputDir = getYourselfOutputDir(),
): Promise<WriteSummaryResult> {
	await ensureYourselfDirs(outputDir);
	const datePath = path.join(outputDir, normalizeDateFileName(summary.date));
	const marker = getSummaryMarker(summary.hash);
	const existing = (await pathExists(datePath)) ? await fs.readFile(datePath, "utf-8") : "";
	if (existing.includes(marker)) {
		return { written: false, path: datePath, hash: summary.hash };
	}

	const header = existing.trim() ? existing.replace(/\s*$/, "\n\n") : `# YOURSELF · ${summary.date}\n\n`;
	await writeFileAtomic(datePath, `${header}${formatSummaryBlock(summary)}`);
	return { written: true, path: datePath, hash: summary.hash };
}

export function homeRelative(filePath: string): string {
	const home = os.homedir();
	return filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath;
}
