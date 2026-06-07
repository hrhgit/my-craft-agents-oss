import { existsSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionActivityRegistry } from "../src/core/session-activity-registry.ts";

describe("SessionActivityRegistry", () => {
	const cleanupPaths: string[] = [];

	afterEach(() => {
		while (cleanupPaths.length > 0) {
			const target = cleanupPaths.pop()!;
			if (existsSync(target)) {
				rmSync(target, { recursive: true, force: true });
			}
		}
	});

	async function createRegistry(): Promise<{ registry: SessionActivityRegistry; agentDir: string; cwd: string }> {
		const agentDir = join(tmpdir(), `pi-session-activity-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const cwd = join(agentDir, "workspace");
		await mkdir(cwd, { recursive: true });
		cleanupPaths.push(agentDir);
		return { registry: SessionActivityRegistry.create(agentDir), agentDir, cwd };
	}

	it("records active sessions and workspace history", async () => {
		const { registry, cwd } = await createRegistry();

		await registry.upsertActiveSession({
			id: "test-session",
			ownerId: "interactive-process",
			ownerKind: "process",
			processId: process.pid,
			cwd,
			sessionId: "session-id",
			sessionFile: join(cwd, "session.jsonl"),
			sessionName: "Named",
			status: "running",
			model: "provider/model",
		});

		const active = await registry.listActiveSessions();
		expect(active).toHaveLength(1);
		expect(active[0]).toMatchObject({
			id: "test-session",
			ownerId: "interactive-process",
			ownerKind: "process",
			processId: process.pid,
			pid: process.pid,
			cwd,
			sessionId: "session-id",
			sessionName: "Named",
			status: "running",
			model: "provider/model",
		});

		const workspaces = await registry.listWorkspaces();
		expect(workspaces).toHaveLength(1);
		expect(workspaces[0]!.cwd).toBe(cwd);
		expect(workspaces[0]!.firstUsedAt).toBeTruthy();
		expect(workspaces[0]!.lastUsedAt).toBeTruthy();
	});

	it("removes active sessions without deleting workspace history", async () => {
		const { registry, cwd } = await createRegistry();
		await registry.upsertActiveSession({
			id: "test-session",
			processId: process.pid,
			cwd,
			sessionId: "session-id",
			status: "idle",
		});

		await registry.removeActiveSession("test-session");

		expect(await registry.listActiveSessions()).toEqual([]);
		expect(await registry.listWorkspaces()).toHaveLength(1);
		const workspaces = await registry.listWorkspaces();
		expect(workspaces[0]!.cwd).toBe(cwd);
	});

	it("prunes workspace history for directories that no longer exist", async () => {
		const { registry, cwd } = await createRegistry();
		await registry.recordWorkspace(cwd);

		rmSync(cwd, { recursive: true, force: true });

		expect(await registry.listWorkspaces()).toEqual([]);
	});

	it("updates an active session when it switches to another workspace", async () => {
		const { registry, agentDir, cwd } = await createRegistry();
		const nextCwd = join(agentDir, "next-workspace");
		await mkdir(nextCwd, { recursive: true });

		await registry.upsertActiveSession({
			id: "test-session",
			processId: process.pid,
			cwd,
			sessionId: "old-session-id",
			status: "idle",
		});
		await registry.upsertActiveSession({
			id: "test-session",
			processId: process.pid,
			cwd: nextCwd,
			sessionId: "next-session-id",
			status: "idle",
		});

		const active = await registry.listActiveSessions();
		expect(active).toHaveLength(1);
		expect(active[0]).toMatchObject({
			id: "test-session",
			cwd: nextCwd,
			sessionId: "next-session-id",
		});
	});

	it("ignores stale active-session writes", async () => {
		const { registry, agentDir, cwd } = await createRegistry();
		const nextCwd = join(agentDir, "next-workspace");
		await mkdir(nextCwd, { recursive: true });
		const stateDir = join(agentDir, "session-state");
		await mkdir(stateDir, { recursive: true });
		await writeFile(
			join(stateDir, "active-sessions.json"),
			`${JSON.stringify(
				[
					{
						id: "test-session",
						processId: process.pid,
						pid: process.pid,
						ownerId: "test-session",
						ownerKind: "process",
						cwd: nextCwd,
						sessionId: "next-session-id",
						status: "idle",
						startedAt: new Date().toISOString(),
						updatedAt: new Date(Date.now() + 60_000).toISOString(),
						leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
					},
				],
				null,
				2,
			)}\n`,
			"utf-8",
		);

		await registry.upsertActiveSession({
			id: "test-session",
			processId: process.pid,
			cwd,
			sessionId: "old-session-id",
			status: "idle",
		});

		const active = await registry.listActiveSessions();
		expect(active).toHaveLength(1);
		expect(active[0]).toMatchObject({
			id: "test-session",
			cwd: nextCwd,
			sessionId: "next-session-id",
		});
	});

	it("records logical agent activity without a process id", async () => {
		const { registry, cwd } = await createRegistry();

		await registry.upsertActiveSession({
			id: "agent-run",
			ownerId: "agent-run",
			ownerKind: "agent",
			cwd,
			sessionId: "session-id",
			status: "running",
			leaseExpiresAt: new Date(Date.now() + 60_000),
		});

		const active = await registry.listActiveSessions();
		expect(active).toHaveLength(1);
		expect(active[0]).toMatchObject({
			id: "agent-run",
			ownerId: "agent-run",
			ownerKind: "agent",
			cwd,
			sessionId: "session-id",
			status: "running",
		});
		expect(active[0]!.processId).toBeUndefined();
		expect(active[0]!.pid).toBeUndefined();
		expect(active[0]!.leaseExpiresAt).toBeTruthy();
	});

	it("prunes expired logical activity leases", async () => {
		const { registry, cwd } = await createRegistry();

		await registry.upsertActiveSession({
			id: "expired-agent-run",
			ownerKind: "agent",
			cwd,
			sessionId: "session-id",
			status: "running",
			leaseExpiresAt: new Date(Date.now() - 1_000),
		});

		expect(await registry.listActiveSessions()).toEqual([]);
	});

	it("prunes legacy pid-only records when the process is gone", async () => {
		const { registry, agentDir, cwd } = await createRegistry();
		const stateDir = join(agentDir, "session-state");
		await mkdir(stateDir, { recursive: true });
		await writeFile(
			join(stateDir, "active-sessions.json"),
			`${JSON.stringify(
				[
					{
						id: "legacy-session",
						pid: 2_147_483_647,
						cwd,
						sessionId: "session-id",
						status: "idle",
						startedAt: new Date().toISOString(),
						updatedAt: new Date().toISOString(),
					},
				],
				null,
				2,
			)}\n`,
			"utf-8",
		);

		expect(await registry.listActiveSessions()).toEqual([]);
	});

	it("normalizes live legacy pid-only records", async () => {
		const { registry, agentDir, cwd } = await createRegistry();
		const stateDir = join(agentDir, "session-state");
		await mkdir(stateDir, { recursive: true });
		await writeFile(
			join(stateDir, "active-sessions.json"),
			`${JSON.stringify(
				[
					{
						id: "legacy-session",
						pid: process.pid,
						cwd,
						sessionId: "session-id",
						status: "idle",
						startedAt: new Date().toISOString(),
						updatedAt: new Date().toISOString(),
					},
				],
				null,
				2,
			)}\n`,
			"utf-8",
		);

		const active = await registry.listActiveSessions();
		expect(active).toHaveLength(1);
		expect(active[0]).toMatchObject({
			id: "legacy-session",
			ownerId: "legacy-session",
			ownerKind: "process",
			processId: process.pid,
			pid: process.pid,
		});
	});

	it("removes an abandoned registry lock from a dead owner process", async () => {
		const { registry, agentDir, cwd } = await createRegistry();
		const stateDir = join(agentDir, "session-state");
		await mkdir(stateDir, { recursive: true });
		await writeFile(join(stateDir, ".lock"), `2147483647\n${Date.now()}\n`, "utf-8");

		await registry.recordWorkspace(cwd);

		const workspaces = await registry.listWorkspaces();
		expect(workspaces).toHaveLength(1);
		expect(workspaces[0]!.cwd).toBe(cwd);
	});
});
