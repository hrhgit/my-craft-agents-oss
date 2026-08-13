import { randomUUID } from 'node:crypto';
import {
  RpcClient as PiRpcClient,
  type PiRuntimeHandle,
  type RpcCapabilities,
  type RpcClientEvent,
  type RpcClientOptions,
  type RpcRuntimeOpenOptions,
} from '@mortise/pi-coding-agent/internal/rpc';
import { writeRuntimeLog } from '../../utils/runtime-log.ts';

const DEFAULT_IDLE_TIMEOUT_MS = 0;
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;

export interface PiHostLease {
  client: PiRpcClient;
  runtime: PiRuntimeHandle;
  capabilities: RpcCapabilities;
  startupEvents: RpcClientEvent[];
  acquireRuntime(options: RpcRuntimeOpenOptions): Promise<PiHostLease>;
  release(): Promise<void>;
}

export interface PiHostAcquireOptions {
  key: string;
  client: RpcClientOptions;
  runtime: RpcRuntimeOpenOptions & { agentDir: string; projectConfigDir: string };
}

interface HostRecord {
  key: string;
  instanceId: string;
  client: PiRpcClient;
  ready: Promise<RpcCapabilities>;
  capabilities?: RpcCapabilities;
  runtimeCount: number;
  runtimes: Map<string, { handle: PiRuntimeHandle; refCount: number }>;
  pendingRuntimeOpens: Map<string, Promise<{ handle: PiRuntimeHandle; startupEvents: RpcClientEvent[] }>>;
  pendingStartupEvents: Map<string, RpcClientEvent[]>;
  workspaceServices: Map<string, { ready: Promise<void>; lease?: PiHostLease; refCount: number }>;
  idleTimer?: ReturnType<typeof setTimeout>;
  unsubscribeLifecycle?: () => void;
  stale?: boolean;
}

export class PiHostProtocolError extends Error {
  readonly protocolVersion?: number;

  constructor(message: string, protocolVersion?: number) {
    super(message);
    this.name = 'PiHostProtocolError';
    this.protocolVersion = protocolVersion;
  }
}

/** Process-level owner for shared Pi RPC hosts and runtime-scoped leases. */
export class PiHostManager {
  private readonly hosts = new Map<string, HostRecord>();
  private readonly idleTimeoutMs: number;
  private readonly startupTimeoutMs: number;
  private readonly createClient: (options: RpcClientOptions) => PiRpcClient;

  constructor(options: {
    idleTimeoutMs?: number;
    startupTimeoutMs?: number;
    createClient?: (options: RpcClientOptions) => PiRpcClient;
  } = {}) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.createClient = options.createClient ?? ((clientOptions) => new PiRpcClient(clientOptions));
  }

  async acquire(options: PiHostAcquireOptions): Promise<PiHostLease> {
    let record = this.hosts.get(options.key);
    if (!record) {
      record = this.createHost(
        options.key,
        options.client,
        options.runtime.agentDir,
        options.runtime.projectConfigDir,
      );
      this.hosts.set(options.key, record);
    }

    if (record.idleTimer) {
      clearTimeout(record.idleTimer);
      record.idleTimer = undefined;
    }

    let capabilities: RpcCapabilities;
    try {
      capabilities = await record.ready;
    } catch (error) {
      await this.stopRecord(record, 'startup-failed');
      throw error;
    }

    if (capabilities.protocolVersion < 3 || !capabilities.features.multiRuntime) {
      await this.stopRecord(record, 'protocol-incompatible');
      throw new PiHostProtocolError(
        `Pi RPC v3 multi-runtime support is required, received protocol ${capabilities.protocolVersion}`,
        capabilities.protocolVersion,
      );
    }

    try {
      let workspaceServiceKey: string | undefined;
      if (options.runtime.extensionServiceScope !== 'workspace' && options.runtime.extensionServiceWorkspaceKey) {
        await this.ensureWorkspaceService(record, capabilities, options.runtime);
        workspaceServiceKey = options.runtime.extensionServiceWorkspaceKey;
        this.retainWorkspaceService(record, workspaceServiceKey);
      }
      try {
        const lease = await this.acquireRuntimeLease(record, capabilities, options.runtime);
        return workspaceServiceKey
          ? this.withWorkspaceServiceLifecycle(record, workspaceServiceKey, lease)
          : lease;
      } catch (error) {
        if (workspaceServiceKey) await this.releaseWorkspaceService(record, workspaceServiceKey);
        throw error;
      }
    } catch (error) {
      throw error;
    }
  }

  private async ensureWorkspaceService(
    record: HostRecord,
    capabilities: RpcCapabilities,
    options: RpcRuntimeOpenOptions,
  ): Promise<void> {
    const workspaceKey = options.extensionServiceWorkspaceKey;
    if (!workspaceKey) return;
    const existing = record.workspaceServices.get(workspaceKey);
    if (existing) return existing.ready;

    const state: { ready: Promise<void>; lease?: PiHostLease; refCount: number } = {
      ready: Promise.resolve(),
      refCount: 0,
    };
    state.ready = (async () => {
      state.lease = await this.acquireRuntimeLease(record, capabilities, {
        runtimeId: `workspace-service:${workspaceKey}`,
        cwd: options.cwd,
        extensionPaths: options.extensionPaths,
        extensionServiceScope: 'workspace',
        extensionServiceWorkspaceKey: workspaceKey,
        agentDir: options.agentDir,
        projectConfigDir: options.projectConfigDir,
        deferResourceLoad: false,
        persistInitialState: false,
        inMemory: true,
        uiCapabilities: {
          kind: 'none',
          dialogs: false,
          contributions: false,
          interactionSchemas: [],
        },
      });
    })();
    record.workspaceServices.set(workspaceKey, state);
    try {
      await state.ready;
    } catch (error) {
      if (record.workspaceServices.get(workspaceKey) === state) {
        record.workspaceServices.delete(workspaceKey);
      }
      throw error;
    }
  }

  private retainWorkspaceService(record: HostRecord, workspaceKey: string): void {
    const state = record.workspaceServices.get(workspaceKey);
    if (!state?.lease) throw new Error(`Workspace Extension service failed to prepare: ${workspaceKey}`);
    state.refCount++;
  }

  private withWorkspaceServiceLifecycle(
    record: HostRecord,
    workspaceKey: string,
    lease: PiHostLease,
  ): PiHostLease {
    let releasePromise: Promise<void> | null = null;
    return {
      ...lease,
      release: () => {
        if (releasePromise) return releasePromise;
        releasePromise = lease.release().finally(() => this.releaseWorkspaceService(record, workspaceKey));
        return releasePromise;
      },
    };
  }

  private async releaseWorkspaceService(record: HostRecord, workspaceKey: string): Promise<void> {
    const state = record.workspaceServices.get(workspaceKey);
    if (!state) return;
    state.refCount = Math.max(0, state.refCount - 1);
    if (state.refCount > 0) return;
    if (record.workspaceServices.get(workspaceKey) === state) {
      record.workspaceServices.delete(workspaceKey);
    }
    await state.lease?.release();
  }

  private async acquireRuntimeLease(
    record: HostRecord,
    capabilities: RpcCapabilities,
    options: RpcRuntimeOpenOptions,
  ): Promise<PiHostLease> {
    const requestedRuntimeId = options.runtimeId;
    let runtimeRecord = requestedRuntimeId ? record.runtimes.get(requestedRuntimeId) : undefined;
    let startupEvents: RpcClientEvent[] = [];
    if (!runtimeRecord) {
      let pending = requestedRuntimeId ? record.pendingRuntimeOpens.get(requestedRuntimeId) : undefined;
      if (!pending) {
        pending = this.openRuntime(record, options);
        if (requestedRuntimeId) record.pendingRuntimeOpens.set(requestedRuntimeId, pending);
      }
      try {
        const opened = await pending;
        startupEvents = opened.startupEvents;
        runtimeRecord = record.runtimes.get(opened.handle.runtimeId)
          ?? { handle: opened.handle, refCount: 0 };
        record.runtimes.set(opened.handle.runtimeId, runtimeRecord);
      } finally {
        if (requestedRuntimeId && record.pendingRuntimeOpens.get(requestedRuntimeId) === pending) {
          record.pendingRuntimeOpens.delete(requestedRuntimeId);
        }
      }
    }
    runtimeRecord.refCount++;
    const runtime = runtimeRecord.handle;
    record.runtimeCount++;
    this.log('info', 'runtime.open', record, {
      runtimeId: runtime.runtimeId,
      sessionId: runtime.runtimeSummary.sessionId,
      workspaceRootPath: runtime.runtimeSummary.cwd,
    });

    let releasePromise: Promise<void> | null = null;
    return {
      client: record.client,
      runtime,
      capabilities,
      startupEvents,
      acquireRuntime: runtimeOptions => this.acquireRuntimeLease(record, capabilities, runtimeOptions),
      release: () => {
        if (releasePromise) return releasePromise;
        releasePromise = (async () => {
          try {
            runtimeRecord.refCount = Math.max(0, runtimeRecord.refCount - 1);
            record.runtimeCount = Math.max(0, record.runtimeCount - 1);
            if (runtimeRecord.refCount === 0) {
              record.runtimes.delete(runtime.runtimeId);
              await runtime.close();
              this.log('info', 'runtime.close', record, { runtimeId: runtime.runtimeId });
            }
          } finally {
            this.scheduleIdleStop(record);
          }
        })();
        return releasePromise;
      },
    };
  }

  private async openRuntime(
    record: HostRecord,
    options: RpcRuntimeOpenOptions,
  ): Promise<{ handle: PiRuntimeHandle; startupEvents: RpcClientEvent[] }> {
    const captureId = options.runtimeId;
    let startupEvents: RpcClientEvent[] = [];
    if (captureId) record.pendingStartupEvents.set(captureId, startupEvents);
    try {
      const handle = await record.client.openRuntime(options);
      return { handle, startupEvents: captureId ? record.pendingStartupEvents.get(captureId) ?? startupEvents : startupEvents };
    } catch (error) {
      if (record.runtimeCount === 0) await this.stopRecord(record, 'runtime-open-failed');
      throw error;
    } finally {
      if (captureId) record.pendingStartupEvents.delete(captureId);
    }
  }

  async dispose(): Promise<void> {
    const records = Array.from(this.hosts.values());
    this.hosts.clear();
    await Promise.allSettled(records.map((record) => this.stopRecord(record, 'manager-dispose')));
  }

  /**
   * Fence hosts that cached an older models/auth generation. Existing turns
   * may finish on their current record; all new acquisitions use a fresh host.
   */
  async invalidateAll(reason = 'configuration-changed'): Promise<void> {
    const records = Array.from(this.hosts.values());
    for (const record of records) {
      if (this.hosts.get(record.key) === record) this.hosts.delete(record.key);
      record.stale = true;
      this.log('info', 'host.invalidated', record, { reason });
      if (record.runtimeCount === 0) await this.stopRecord(record, reason);
    }
  }

  private createHost(
    key: string,
    options: RpcClientOptions,
    agentDir: string,
    projectConfigDir: string,
  ): HostRecord {
    const instanceId = randomUUID();
    const client = this.createClient({
      ...options,
      globalHost: { ...options.globalHost, enabled: true, agentDir, instanceId },
      env: {
        ...options.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_CODING_AGENT_PROJECT_DIR: projectConfigDir,
        PI_GLOBAL_HOST_PROCESS: '1',
      },
    });
    const record: HostRecord = {
      key,
      instanceId,
      client,
      ready: Promise.resolve(undefined as never),
      runtimeCount: 0,
      runtimes: new Map(),
      pendingRuntimeOpens: new Map(),
      pendingStartupEvents: new Map(),
      workspaceServices: new Map(),
    };
    this.log('info', 'host.start', record, { cwd: options.cwd, runtimePath: options.runtimePath });
    record.unsubscribeLifecycle = client.onClientEvent((event) => this.handleLifecycle(record, event));
    const startup = client.start()
      .then(() => client.getCapabilities())
      .then((capabilities) => {
        record.capabilities = capabilities;
        this.log('info', 'host.ready', record, {
          protocolVersion: capabilities.protocolVersion,
          packageVersion: capabilities.packageVersion,
        });
        return capabilities;
      });
    record.ready = this.withStartupTimeout(startup);
    return record;
  }

  private withStartupTimeout<T>(startup: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Pi shared host startup timed out after ${this.startupTimeoutMs}ms`));
      }, this.startupTimeoutMs);
    });
    return Promise.race([startup, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  private handleLifecycle(record: HostRecord, event: RpcClientEvent): void {
    const runtimeId = 'runtimeId' in event && typeof event.runtimeId === 'string' ? event.runtimeId : undefined;
    const startupEvents = runtimeId ? record.pendingStartupEvents.get(runtimeId) : undefined;
    if (startupEvents && startupEvents.length < 256) startupEvents.push(event);

    if (event.type === 'background_task_event') {
      const statusEvent = event.task.status === 'queued'
        ? 'task.queued'
        : event.task.status === 'running'
          ? 'task.started'
          : 'task.finished';
      this.log(event.task.status === 'failed' ? 'error' : 'info', statusEvent, record, {
        taskId: event.task.id,
        taskType: event.task.type,
        taskKey: event.task.key,
        taskStatus: event.task.status,
        taskPriority: event.task.priority,
        rerunRequested: event.task.rerunRequested,
        error: event.task.error,
      });
      return;
    }
    if (event.type !== 'process_exit' && event.type !== 'process_error' && event.type !== 'stdin_error') return;
    if (this.hosts.get(record.key) === record) this.hosts.delete(record.key);
    record.unsubscribeLifecycle?.();
    record.unsubscribeLifecycle = undefined;
    this.log('error', 'host.exit', record, {
      lifecycleEvent: event.type,
      message: event.message,
    });
  }

  private scheduleIdleStop(record: HostRecord): void {
    if (record.runtimeCount > 0) return;
    if (record.stale) {
      void this.stopRecord(record, 'stale-host-idle');
      return;
    }
    if (this.hosts.get(record.key) !== record) return;
    if (record.idleTimer) clearTimeout(record.idleTimer);
    record.idleTimer = setTimeout(() => {
      record.idleTimer = undefined;
      if (record.runtimeCount === 0) void this.stopRecord(record, 'idle-timeout');
    }, this.idleTimeoutMs);
    record.idleTimer.unref?.();
  }

  private async stopRecord(record: HostRecord, reason: string): Promise<void> {
    if (record.idleTimer) clearTimeout(record.idleTimer);
    record.idleTimer = undefined;
    if (this.hosts.get(record.key) === record) this.hosts.delete(record.key);
    record.unsubscribeLifecycle?.();
    record.unsubscribeLifecycle = undefined;
    record.workspaceServices.clear();
    await record.client.stop().catch(() => undefined);
    this.log('info', 'host.exit', record, { reason });
  }

  private log(
    level: 'info' | 'error',
    event: string,
    record: HostRecord,
    meta?: Record<string, unknown>,
  ): void {
    writeRuntimeLog(level, {
      scope: 'pi-rpc',
      event,
      meta: {
        hostKey: record.key,
        hostInstanceId: record.instanceId,
        runtimeCount: record.runtimeCount,
        ...meta,
      },
    });
  }
}

export const piHostManager = new PiHostManager();

/** Narrow public lifecycle operation; runtime acquisition stays module-internal. */
export function invalidateBackendRuntimes(reason = 'configuration-changed'): Promise<void> {
  return piHostManager.invalidateAll(reason);
}
