import {
  RpcClient as PiRpcClient,
  type PiRuntimeHandle,
  type RpcCapabilities,
  type RpcClientEvent,
  type RpcClientOptions,
  type RpcRuntimeOpenOptions,
} from '@earendil-works/pi-coding-agent/rpc';
import { writeRuntimeLog } from '../../utils/runtime-log.ts';

const DEFAULT_IDLE_TIMEOUT_MS = 0;

export interface PiHostLease {
  client: PiRpcClient;
  runtime: PiRuntimeHandle;
  capabilities: RpcCapabilities;
  startupEvents: RpcClientEvent[];
  release(): Promise<void>;
}

export interface PiHostAcquireOptions {
  key: string;
  client: RpcClientOptions;
  runtime: RpcRuntimeOpenOptions;
}

interface HostRecord {
  key: string;
  client: PiRpcClient;
  ready: Promise<RpcCapabilities>;
  capabilities?: RpcCapabilities;
  runtimeCount: number;
  runtimes: Map<string, { handle: PiRuntimeHandle; refCount: number }>;
  pendingStartupEvents: Map<string, RpcClientEvent[]>;
  idleTimer?: ReturnType<typeof setTimeout>;
  unsubscribeLifecycle?: () => void;
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
  private readonly createClient: (options: RpcClientOptions) => PiRpcClient;

  constructor(options: {
    idleTimeoutMs?: number;
    createClient?: (options: RpcClientOptions) => PiRpcClient;
  } = {}) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.createClient = options.createClient ?? ((clientOptions) => new PiRpcClient(clientOptions));
  }

  async acquire(options: PiHostAcquireOptions): Promise<PiHostLease> {
    let record = this.hosts.get(options.key);
    if (!record) {
      record = this.createHost(options.key, options.client);
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
      if (this.hosts.get(options.key) === record) this.hosts.delete(options.key);
      throw error;
    }

    if (capabilities.protocolVersion < 3 || !capabilities.features.multiRuntime) {
      await this.stopRecord(record, 'protocol-incompatible');
      throw new PiHostProtocolError(
        `Pi RPC v3 multi-runtime support is required, received protocol ${capabilities.protocolVersion}`,
        capabilities.protocolVersion,
      );
    }

    const requestedRuntimeId = options.runtime.runtimeId;
    let runtimeRecord = requestedRuntimeId ? record.runtimes.get(requestedRuntimeId) : undefined;
    let startupEvents: RpcClientEvent[] = [];
    if (!runtimeRecord) {
      const captureId = requestedRuntimeId;
      if (captureId) record.pendingStartupEvents.set(captureId, startupEvents);
      let handle: PiRuntimeHandle;
      try {
        handle = await record.client.openRuntime(options.runtime);
      } finally {
        if (captureId) {
          startupEvents = record.pendingStartupEvents.get(captureId) ?? startupEvents;
          record.pendingStartupEvents.delete(captureId);
        }
      }
      runtimeRecord = { handle, refCount: 0 };
      record.runtimes.set(handle.runtimeId, runtimeRecord);
    }
    runtimeRecord.refCount++;
    const runtime = runtimeRecord.handle;
    record.runtimeCount++;
    this.log('info', 'runtime.open', record, {
      runtimeId: runtime.runtimeId,
      sessionId: runtime.runtimeSummary.sessionId,
      workspaceRootPath: runtime.runtimeSummary.cwd,
    });

    let released = false;
    return {
      client: record.client,
      runtime,
      capabilities,
      startupEvents,
      release: async () => {
        if (released) return;
        released = true;
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
      },
    };
  }

  async dispose(): Promise<void> {
    const records = Array.from(this.hosts.values());
    this.hosts.clear();
    await Promise.allSettled(records.map((record) => this.stopRecord(record, 'manager-dispose')));
  }

  private createHost(key: string, options: RpcClientOptions): HostRecord {
    const client = this.createClient({
      ...options,
      globalHost: { enabled: true },
      env: { ...options.env, PI_GLOBAL_HOST_PROCESS: '1' },
    });
    const record: HostRecord = {
      key,
      client,
      ready: Promise.resolve(undefined as never),
      runtimeCount: 0,
      runtimes: new Map(),
      pendingStartupEvents: new Map(),
    };
    this.log('info', 'host.start', record, { cwd: options.cwd, cliPath: options.cliPath });
    record.unsubscribeLifecycle = client.onClientEvent((event) => this.handleLifecycle(record, event));
    record.ready = client.start()
      .then(() => client.getCapabilities())
      .then((capabilities) => {
        record.capabilities = capabilities;
        this.log('info', 'host.ready', record, {
          protocolVersion: capabilities.protocolVersion,
          packageVersion: capabilities.packageVersion,
        });
        return capabilities;
      });
    return record;
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
    if (record.runtimeCount > 0 || this.hosts.get(record.key) !== record) return;
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
      meta: { hostKey: record.key, runtimeCount: record.runtimeCount, ...meta },
    });
  }
}

export const piHostManager = new PiHostManager();
