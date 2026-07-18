import { existsSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "../config.ts";
import { resolvePath } from "../utils/paths.ts";

export type ActiveSessionStatus = "idle" | "running";
export type ActiveSessionOwnerKind = "agent" | "process";

export interface ActiveSessionRecord {
	id: string;
	ownerId: string;
	ownerKind: ActiveSessionOwnerKind;
	processId?: number;
	pid?: number;
	cwd: string;
	sessionId: string;
	sessionFile?: string;
	sessionName?: string;
	status: ActiveSessionStatus;
	startedAt: string;
	updatedAt: string;
	leaseExpiresAt?: string;
	model?: string;
}

export interface ActiveSessionInput {
	id: string;
	ownerId?: string;
	ownerKind?: ActiveSessionOwnerKind;
	processId?: number;
	pid?: number;
	cwd: string;
	sessionId: string;
	sessionFile?: string;
	sessionName?: string;
	status: ActiveSessionStatus;
	leaseDurationMs?: number;
	leaseExpiresAt?: string | Date;
	model?: string;
}

export interface WorkspaceHistoryRecord {
	cwd: string;
	firstUsedAt: string;
	lastUsedAt: string;
}

const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_DELAY_MS = 25;
const LOCK_RETRY_COUNT = 600;
const MAX_ACTIVE_SESSIONS = 200;
const MAX_WORKSPACES = 500;
const DEFAULT_ACTIVE_SESSION_LEASE_MS = 90_000;

async function sleep(ms: number): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function nowIso(): string {
	return new Date().toISOString();
}

function isPidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
		return code === "EPERM";
	}
}

function getProcessId(record: Pick<ActiveSessionRecord, "pid" | "processId">): number | undefined {
	const processId = record.processId ?? record.pid;
	return typeof processId === "number" && Number.isInteger(processId) && processId > 0 ? processId : undefined;
}

function parseTimestamp(value: string | Date | undefined): number | undefined {
	if (value === undefined) return undefined;
	const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
	return Number.isNaN(time) ? undefined : time;
}

function pathKey(targetPath: string): string {
	const resolved = resolvePath(targetPath);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function isExistingDirectory(targetPath: string): Promise<boolean> {
	try {
		return (await stat(targetPath)).isDirectory();
	} catch {
		return false;
	}
}

async function readJsonArray<T>(filePath: string): Promise<T[]> {
	if (!existsSync(filePath)) return [];
	try {
		const raw = await readFile(filePath, "utf-8");
		const value = JSON.parse(raw) as unknown;
		return Array.isArray(value) ? (value as T[]) : [];
	} catch {
		return [];
	}
}

function normalizeProcessId(processId: number | undefined): number | undefined {
	return typeof processId === "number" && Number.isInteger(processId) && processId > 0 ? processId : undefined;
}

function normalizeLeaseExpiresAt(input: ActiveSessionInput, nowMs: number): string {
	const explicit = parseTimestamp(input.leaseExpiresAt);
	if (explicit !== undefined) return new Date(explicit).toISOString();
	const duration = input.leaseDurationMs;
	const leaseDurationMs =
		typeof duration === "number" && Number.isFinite(duration) && duration > 0
			? duration
			: DEFAULT_ACTIVE_SESSION_LEASE_MS;
	return new Date(nowMs + leaseDurationMs).toISOString();
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
	await rename(tempPath, filePath);
}

export class SessionActivityRegistry {
	private readonly stateDir: string;
	private readonly activePath: string;
	private readonly workspacePath: string;
	private readonly lockPath: string;

	private constructor(agentDir: string) {
		this.stateDir = join(agentDir, "session-state");
		this.activePath = join(this.stateDir, "active-sessions.json");
		this.workspacePath = join(this.stateDir, "workspaces.json");
		this.lockPath = join(this.stateDir, ".lock");
	}

	static create(agentDir: string = getAgentDir()): SessionActivityRegistry {
		return new SessionActivityRegistry(resolvePath(agentDir));
	}

	private async withLock<T>(fn: () => Promise<T>): Promise<T> {
		await mkdir(this.stateDir, { recursive: true });
		for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt++) {
			let handle: Awaited<ReturnType<typeof open>>;
			try {
				handle = await open(this.lockPath, "wx");
			} catch (error) {
				const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
				if (code !== "EEXIST") throw error;
				await this.removeStaleLock();
				await sleep(LOCK_RETRY_DELAY_MS);
				continue;
			}
			try {
				await handle.writeFile(`${process.pid}\n${Date.now()}\n`, "utf-8");
				return await fn();
			} finally {
				await handle.close();
				await rm(this.lockPath, { force: true });
			}
		}
		throw new Error(`Timed out acquiring session activity lock: ${this.lockPath}`);
	}

	private async removeStaleLock(): Promise<void> {
		try {
			const raw = await readFile(this.lockPath, "utf-8").catch(() => "");
			const [pidLine, timestampLine] = raw.split(/\r?\n/);
			const lockPid = Number.parseInt(pidLine ?? "", 10);
			if (Number.isInteger(lockPid) && lockPid > 0) {
				if (!isPidAlive(lockPid)) {
					await rm(this.lockPath, { force: true });
				}
				return;
			}
			const lockTimestamp = Number.parseInt(timestampLine ?? "", 10);
			if (Number.isFinite(lockTimestamp) && Date.now() - lockTimestamp > LOCK_STALE_MS) {
				await rm(this.lockPath, { force: true });
				return;
			}
			const lockStat = await stat(this.lockPath);
			if (Date.now() - lockStat.mtime.getTime() > LOCK_STALE_MS) {
				await rm(this.lockPath, { force: true });
			}
		} catch {
			// Another process removed it.
		}
	}

	private async readActiveSessionsUnlocked(): Promise<ActiveSessionRecord[]> {
		return await readJsonArray<ActiveSessionRecord>(this.activePath);
	}

	private async writeActiveSessionsUnlocked(sessions: ActiveSessionRecord[]): Promise<void> {
		await writeJson(this.activePath, sessions);
	}

	private normalizeActiveSession(session: ActiveSessionRecord): ActiveSessionRecord {
		const processId = getProcessId(session);
		const ownerKind =
			session.ownerKind === "agent" || session.ownerKind === "process"
				? session.ownerKind
				: processId !== undefined
					? "process"
					: "agent";
		const ownerId =
			typeof session.ownerId === "string" && session.ownerId.trim().length > 0 ? session.ownerId.trim() : session.id;
		const normalized: ActiveSessionRecord = {
			...session,
			ownerId,
			ownerKind,
		};
		if (processId !== undefined) {
			normalized.processId = processId;
			normalized.pid = processId;
		} else {
			delete normalized.processId;
			delete normalized.pid;
		}
		return normalized;
	}

	private pruneActiveSessions(sessions: ActiveSessionRecord[]): ActiveSessionRecord[] {
		const now = Date.now();
		return sessions.filter((session) => {
			const leaseExpiresAt = parseTimestamp(session.leaseExpiresAt);
			if (leaseExpiresAt !== undefined) {
				return leaseExpiresAt > now;
			}
			const processId = getProcessId(session);
			return processId !== undefined && isPidAlive(processId);
		});
	}

	private activeSessionsChanged(before: ActiveSessionRecord[], after: ActiveSessionRecord[]): boolean {
		return JSON.stringify(before) !== JSON.stringify(after);
	}

	private async pruneWorkspaces(workspaces: WorkspaceHistoryRecord[]): Promise<WorkspaceHistoryRecord[]> {
		const byCwd = new Map<string, WorkspaceHistoryRecord>();
		for (const workspace of workspaces) {
			const cwd = resolvePath(workspace.cwd);
			if (!(await isExistingDirectory(cwd))) continue;

			const key = pathKey(cwd);
			const existing = byCwd.get(key);
			if (existing) {
				existing.firstUsedAt =
					existing.firstUsedAt < workspace.firstUsedAt ? existing.firstUsedAt : workspace.firstUsedAt;
				existing.lastUsedAt =
					existing.lastUsedAt > workspace.lastUsedAt ? existing.lastUsedAt : workspace.lastUsedAt;
			} else {
				byCwd.set(key, {
					cwd,
					firstUsedAt: workspace.firstUsedAt,
					lastUsedAt: workspace.lastUsedAt,
				});
			}
		}
		return Array.from(byCwd.values())
			.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))
			.slice(0, MAX_WORKSPACES);
	}

	private workspacesChanged(before: WorkspaceHistoryRecord[], after: WorkspaceHistoryRecord[]): boolean {
		if (before.length !== after.length) return true;
		return before.some((workspace, index) => {
			const next = after[index];
			return (
				!next ||
				resolvePath(workspace.cwd) !== next.cwd ||
				workspace.firstUsedAt !== next.firstUsedAt ||
				workspace.lastUsedAt !== next.lastUsedAt
			);
		});
	}

	async listActiveSessions(): Promise<ActiveSessionRecord[]> {
		return await this.withLock(async () => {
			const storedSessions = await this.readActiveSessionsUnlocked();
			const sessions = storedSessions.map((session) => this.normalizeActiveSession(session));
			const pruned = this.pruneActiveSessions(sessions);
			if (this.activeSessionsChanged(storedSessions, pruned)) {
				await this.writeActiveSessionsUnlocked(pruned);
			}
			return pruned.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		});
	}

	async upsertActiveSession(input: ActiveSessionInput): Promise<ActiveSessionRecord> {
		const cwd = resolvePath(input.cwd);
		const nowMs = Date.now();
		const now = new Date(nowMs).toISOString();
		return await this.withLock(async () => {
			const sessions = this.pruneActiveSessions(
				(await this.readActiveSessionsUnlocked()).map((session) => this.normalizeActiveSession(session)),
			);
			const existing = sessions.find((session) => session.id === input.id);
			if (existing && existing.updatedAt > now) {
				return existing;
			}
			const processId = normalizeProcessId(input.processId ?? input.pid);
			const ownerId = input.ownerId?.trim() || existing?.ownerId || input.id;
			const ownerKind = input.ownerKind ?? existing?.ownerKind ?? (processId !== undefined ? "process" : "agent");
			const next: ActiveSessionRecord = {
				...existing,
				id: input.id,
				ownerId,
				ownerKind,
				cwd,
				sessionId: input.sessionId,
				sessionFile: input.sessionFile,
				sessionName: input.sessionName?.trim() || undefined,
				status: input.status,
				startedAt: existing?.startedAt ?? now,
				updatedAt: now,
				leaseExpiresAt: normalizeLeaseExpiresAt(input, nowMs),
				model: input.model,
			};
			if (processId !== undefined) {
				next.processId = processId;
				next.pid = processId;
			} else {
				delete next.processId;
				delete next.pid;
			}
			const remaining = sessions.filter((session) => session.id !== input.id);
			remaining.push(next);
			remaining.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
			await this.writeActiveSessionsUnlocked(remaining.slice(0, MAX_ACTIVE_SESSIONS));
			await this.recordWorkspaceUnlocked(cwd, now);
			return next;
		});
	}

	async removeActiveSession(id: string): Promise<void> {
		await this.withLock(async () => {
			const sessions = await this.readActiveSessionsUnlocked();
			const remaining = sessions.filter((session) => session.id !== id);
			if (remaining.length !== sessions.length) {
				await this.writeActiveSessionsUnlocked(remaining);
			}
		});
	}

	private async readWorkspacesUnlocked(): Promise<WorkspaceHistoryRecord[]> {
		return await readJsonArray<WorkspaceHistoryRecord>(this.workspacePath);
	}

	private async writeWorkspacesUnlocked(workspaces: WorkspaceHistoryRecord[]): Promise<void> {
		await writeJson(this.workspacePath, workspaces);
	}

	private async recordWorkspaceUnlocked(cwd: string, timestamp: string): Promise<void> {
		const resolvedCwd = resolvePath(cwd);
		const storedWorkspaces = await this.readWorkspacesUnlocked();
		const workspaces = await this.pruneWorkspaces(storedWorkspaces);
		if (!(await isExistingDirectory(resolvedCwd))) {
			if (this.workspacesChanged(storedWorkspaces, workspaces)) {
				await this.writeWorkspacesUnlocked(workspaces);
			}
			return;
		}

		const key = pathKey(resolvedCwd);
		const existing = workspaces.find((workspace) => pathKey(workspace.cwd) === key);
		if (existing) {
			existing.cwd = resolvedCwd;
			existing.lastUsedAt = timestamp;
		} else {
			workspaces.push({ cwd: resolvedCwd, firstUsedAt: timestamp, lastUsedAt: timestamp });
		}
		workspaces.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
		await this.writeWorkspacesUnlocked(workspaces.slice(0, MAX_WORKSPACES));
	}

	async recordWorkspace(cwd: string): Promise<void> {
		await this.withLock(async () => {
			await this.recordWorkspaceUnlocked(cwd, nowIso());
		});
	}

	async listWorkspaces(): Promise<WorkspaceHistoryRecord[]> {
		return await this.withLock(async () => {
			const storedWorkspaces = await this.readWorkspacesUnlocked();
			const workspaces = await this.pruneWorkspaces(storedWorkspaces);
			if (this.workspacesChanged(storedWorkspaces, workspaces)) {
				await this.writeWorkspacesUnlocked(workspaces);
			}
			return workspaces;
		});
	}
}
