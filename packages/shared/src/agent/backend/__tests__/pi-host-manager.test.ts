import { describe, expect, it, mock } from 'bun:test';
import type {
  PiRuntimeHandle,
  RpcCapabilities,
  RpcClient,
  RpcClientEventListener,
  RpcClientOptions,
  RpcRuntimeOpenOptions,
} from '@mortise/pi-coding-agent/internal/rpc';
import { PiHostManager, PiHostProtocolError, type PiHostAcquireOptions } from '../pi-host-manager.ts';

const MORTISE_AGENT_DIR = 'C:/Users/test/.mortise/agent';
const MORTISE_PROJECT_DIR = '.mortise';

function capabilities(protocolVersion = 3): RpcCapabilities {
  return {
    protocolVersion,
    packageVersion: 'test',
    commands: ['get_capabilities', 'open_runtime'],
    features: {
      hostHooksModule: true,
      toolExecutionMetadata: true,
      hostToolResults: 'content',
      extensionCommandResult: true,
      extensionHostCapabilities: true,
      extensionUiValidation: true,
      secondaryLlmQuery: true,
      childSessionListing: true,
      multiRuntime: protocolVersion >= 3,
    },
    hostHooks: {
      moduleEnv: 'PI_HOST_HOOKS_MODULE',
      exports: [],
    },
  };
}

function createFakeClient(protocolVersion = 3, startupEvent?: Parameters<RpcClientEventListener>[0]) {
  let listener: RpcClientEventListener | undefined;
  const close = mock(async () => undefined);
  const openRuntime = mock(async (options: RpcRuntimeOpenOptions) => {
    if (startupEvent) listener?.(startupEvent);
    const runtimeId = options.runtimeId ?? 'runtime-a';
    return {
      runtimeId,
      runtimeSummary: {
        runtimeId,
        cwd: options.cwd,
        sessionId: options.sessionId ?? runtimeId,
        isStreaming: false,
      },
      close,
    } as unknown as PiRuntimeHandle;
  });
  const stop = mock(async () => undefined);
  const client = {
    start: mock(async () => undefined),
    stop,
    getCapabilities: mock(async () => capabilities(protocolVersion)),
    openRuntime,
    onClientEvent: mock((nextListener: RpcClientEventListener) => {
      listener = nextListener;
      return () => {
        if (listener === nextListener) listener = undefined;
      };
    }),
  } as unknown as RpcClient;
  return {
    client,
    close,
    openRuntime,
    stop,
    emit: (event: Parameters<RpcClientEventListener>[0]) => listener?.(event),
  };
}

describe('PiHostManager process-level sharing', () => {
  it('prepares one Workspace service runtime before opening Session runtimes on a host', async () => {
    const fake = createFakeClient();
    const manager = new PiHostManager({ createClient: () => fake.client });
    const runtime = (runtimeId: string): PiHostAcquireOptions => ({
      key: 'workspace-services',
      client: {},
      runtime: {
        runtimeId,
        cwd: 'E:/project',
        agentDir: MORTISE_AGENT_DIR,
        projectConfigDir: MORTISE_PROJECT_DIR,
        extensionPaths: ['E:/extensions/example.js'],
        extensionServiceScope: 'session',
        extensionServiceWorkspaceKey: 'workspace-a',
      },
    });

    const [first, second] = await Promise.all([
      manager.acquire(runtime('session-a')),
      manager.acquire(runtime('session-b')),
    ]);

    expect(fake.openRuntime).toHaveBeenCalledTimes(3);
    expect(fake.openRuntime.mock.calls[0]?.[0]).toMatchObject({
      runtimeId: 'workspace-service:workspace-a',
      extensionServiceScope: 'workspace',
      extensionServiceWorkspaceKey: 'workspace-a',
      inMemory: true,
    });
    expect(fake.openRuntime.mock.calls.slice(1).map(call => call[0].runtimeId).sort()).toEqual([
      'session-a',
      'session-b',
    ]);

    await first.release();
    expect(fake.close).toHaveBeenCalledTimes(1);
    await second.release();
    expect(fake.close).toHaveBeenCalledTimes(3);
    await manager.dispose();
    expect(fake.stop).toHaveBeenCalledTimes(1);
  });

  it('keeps the Workspace service alive while another Session runtime is still opening', async () => {
    const fake = createFakeClient();
    let releaseSecond!: () => void;
    const secondBlocked = new Promise<void>(resolve => { releaseSecond = resolve; });
    fake.openRuntime.mockImplementation(async (options: RpcRuntimeOpenOptions) => {
      if (options.runtimeId === 'session-b') await secondBlocked;
      const runtimeId = options.runtimeId ?? 'runtime-a';
      return {
        runtimeId,
        runtimeSummary: { runtimeId, cwd: options.cwd, sessionId: runtimeId, isStreaming: false },
        close: fake.close,
      } as unknown as PiRuntimeHandle;
    });
    const manager = new PiHostManager({ createClient: () => fake.client });
    const runtime = (runtimeId: string): PiHostAcquireOptions => ({
      key: 'workspace-service-pending-open',
      client: {},
      runtime: {
        runtimeId,
        cwd: 'E:/project',
        agentDir: MORTISE_AGENT_DIR,
        projectConfigDir: MORTISE_PROJECT_DIR,
        extensionServiceScope: 'session',
        extensionServiceWorkspaceKey: 'workspace-a',
      },
    });

    const first = await manager.acquire(runtime('session-a'));
    const secondPending = manager.acquire(runtime('session-b'));
    await Bun.sleep(0);
    await first.release();
    expect(fake.close).toHaveBeenCalledTimes(1);

    releaseSecond();
    const second = await secondPending;
    await second.release();
    expect(fake.close).toHaveBeenCalledTimes(3);
    await manager.dispose();
  });

  it('shares one runtime and closes it after the final lease', async () => {
    const fake = createFakeClient();
    const manager = new PiHostManager({
      idleTimeoutMs: 5,
      createClient: (_options: RpcClientOptions) => fake.client,
    });
    const options: PiHostAcquireOptions = {
      key: 'default',
      client: {},
      runtime: {
        runtimeId: 'runtime-a', cwd: 'E:/project', agentDir: MORTISE_AGENT_DIR, projectConfigDir: MORTISE_PROJECT_DIR,
        extensionPaths: ['E:/extensions/browser.js', 'E:/extensions/messaging.js'],
      },
    };

    const first = await manager.acquire(options);
    const second = await manager.acquire(options);
    expect(fake.openRuntime).toHaveBeenCalledTimes(1);
    expect(fake.openRuntime).toHaveBeenCalledWith(expect.objectContaining({
      projectConfigDir: MORTISE_PROJECT_DIR,
      extensionPaths: ['E:/extensions/browser.js', 'E:/extensions/messaging.js'],
    }));

    await first.release();
    expect(fake.close).not.toHaveBeenCalled();
    await second.release();
    expect(fake.close).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.stop).toHaveBeenCalledTimes(1);
  });

  it('single-flights concurrent opens for the same runtime identity', async () => {
    const fake = createFakeClient();
    const manager = new PiHostManager({ createClient: () => fake.client });
    const options: PiHostAcquireOptions = {
      key: 'concurrent-runtime',
      client: {},
      runtime: {
        runtimeId: 'runtime-a',
        cwd: 'E:/project',
        agentDir: MORTISE_AGENT_DIR,
        projectConfigDir: MORTISE_PROJECT_DIR,
      },
    };

    const [first, second] = await Promise.all([
      manager.acquire(options),
      manager.acquire(options),
    ]);

    expect(fake.openRuntime).toHaveBeenCalledTimes(1);
    expect(first.runtime).toBe(second.runtime);
    await Promise.all([first.release(), second.release()]);
    expect(fake.close).toHaveBeenCalledTimes(1);
    await manager.dispose();
  });

  it('rejects an RPC v2 host as an explicit compatibility failure', async () => {
    const fake = createFakeClient(2);
    const manager = new PiHostManager({ createClient: () => fake.client });

    await expect(manager.acquire({
      key: 'legacy',
      client: {},
      runtime: { runtimeId: 'runtime-a', cwd: 'E:/project', agentDir: MORTISE_AGENT_DIR, projectConfigDir: MORTISE_PROJECT_DIR },
    })).rejects.toBeInstanceOf(PiHostProtocolError);
    expect(fake.openRuntime).not.toHaveBeenCalled();
    expect(fake.stop).toHaveBeenCalledTimes(1);
  });

  it('captures runtime events emitted while a startup extension is opening', async () => {
    const startupEvent = {
      type: 'extension_ui_validation',
      runtimeId: 'runtime-a',
      extensionId: 'example',
      delta: { schemaVersion: 1, revision: 1, operation: 'upsert', definition: {} },
    } as Parameters<RpcClientEventListener>[0];
    const fake = createFakeClient(3, startupEvent);
    const manager = new PiHostManager({ createClient: () => fake.client });

    const lease = await manager.acquire({
      key: 'startup-events',
      client: {},
      runtime: { runtimeId: 'runtime-a', cwd: 'E:/project', agentDir: MORTISE_AGENT_DIR, projectConfigDir: MORTISE_PROJECT_DIR },
    });

    expect(lease.startupEvents).toEqual([startupEvent]);
    await lease.release();
    await manager.dispose();
  });

  it('creates a fresh host after the current host exits', async () => {
    const firstFake = createFakeClient();
    const secondFake = createFakeClient();
    const createClient = mock()
      .mockReturnValueOnce(firstFake.client)
      .mockReturnValueOnce(secondFake.client);
    const manager = new PiHostManager({ createClient });
    const options: PiHostAcquireOptions = {
      key: 'recoverable',
      client: {},
      runtime: { runtimeId: 'runtime-a', cwd: 'E:/project', agentDir: MORTISE_AGENT_DIR, projectConfigDir: MORTISE_PROJECT_DIR },
    };

    const firstLease = await manager.acquire(options);
    firstFake.emit({ type: 'process_exit', code: 1, signal: null, message: 'host terminated', stderr: '' });
    const secondLease = await manager.acquire(options);

    expect(createClient).toHaveBeenCalledTimes(2);
    expect(secondFake.openRuntime).toHaveBeenCalledTimes(1);

    await firstLease.release();
    await secondLease.release();
    await manager.dispose();
  });

  it('moves new acquisitions to a fresh host after configuration invalidation', async () => {
    const firstFake = createFakeClient();
    const secondFake = createFakeClient();
    const createClient = mock()
      .mockReturnValueOnce(firstFake.client)
      .mockReturnValueOnce(secondFake.client);
    const manager = new PiHostManager({ createClient });
    const options: PiHostAcquireOptions = {
      key: 'config-generation',
      client: {},
      runtime: { runtimeId: 'runtime-a', cwd: 'E:/project', agentDir: MORTISE_AGENT_DIR, projectConfigDir: MORTISE_PROJECT_DIR },
    };

    const oldLease = await manager.acquire(options);
    await manager.invalidateAll('provider-config-changed');
    const newLease = await manager.acquire(options);

    expect(createClient).toHaveBeenCalledTimes(2);
    const firstOptions = createClient.mock.calls[0]?.[0] as RpcClientOptions;
    const secondOptions = createClient.mock.calls[1]?.[0] as RpcClientOptions;
    expect(firstOptions.globalHost?.instanceId).toBeTruthy();
    expect(secondOptions.globalHost?.instanceId).toBeTruthy();
    expect(secondOptions.globalHost?.instanceId).not.toBe(firstOptions.globalHost?.instanceId);
    expect(firstFake.stop).not.toHaveBeenCalled();
    await oldLease.release();
    expect(firstFake.stop).toHaveBeenCalledTimes(1);
    await newLease.release();
    await manager.dispose();
  });

  it('stops an invalidated host after its last Session leaves only the Workspace service', async () => {
    const firstFake = createFakeClient();
    const secondFake = createFakeClient();
    const manager = new PiHostManager({
      createClient: mock().mockReturnValueOnce(firstFake.client).mockReturnValueOnce(secondFake.client),
    });
    const options: PiHostAcquireOptions = {
      key: 'workspace-service-generation',
      client: {},
      runtime: {
        runtimeId: 'session-a',
        cwd: 'E:/project',
        agentDir: MORTISE_AGENT_DIR,
        projectConfigDir: MORTISE_PROJECT_DIR,
        extensionServiceScope: 'session',
        extensionServiceWorkspaceKey: 'workspace-a',
      },
    };

    const oldLease = await manager.acquire(options);
    await manager.invalidateAll('provider-config-changed');
    expect(firstFake.stop).not.toHaveBeenCalled();

    await oldLease.release();
    expect(firstFake.stop).toHaveBeenCalledTimes(1);

    const newLease = await manager.acquire(options);
    expect(secondFake.openRuntime).toHaveBeenCalledTimes(2);
    await newLease.release();
    await manager.dispose();
  });

  it('pins Electron-like callers to the Mortise Agent root at the GlobalHost boundary', async () => {
    const fake = createFakeClient();
    const createClient = mock((_options: RpcClientOptions) => fake.client);
    const manager = new PiHostManager({ createClient });

    const lease = await manager.acquire({
      key: 'electron-without-agent-env',
      client: {
        envMode: 'replace',
        env: { PATH: 'C:/Windows/System32' },
        globalHost: { enabled: false, agentDir: 'C:/Users/test/.pi/agent' },
      },
      runtime: {
        runtimeId: 'runtime-a',
        cwd: 'E:/project',
        agentDir: MORTISE_AGENT_DIR,
        projectConfigDir: MORTISE_PROJECT_DIR,
      },
    });

    const clientOptions = createClient.mock.calls[0]?.[0] as RpcClientOptions;
    expect(clientOptions.env?.PI_CODING_AGENT_DIR).toBe(MORTISE_AGENT_DIR);
    expect(clientOptions.env?.PI_CODING_AGENT_PROJECT_DIR).toBe(MORTISE_PROJECT_DIR);
    expect(clientOptions.globalHost).toMatchObject({
      enabled: true,
      agentDir: MORTISE_AGENT_DIR,
    });
    expect(clientOptions.globalHost?.instanceId).toBeTruthy();

    await lease.release();
    await manager.dispose();
  });

  it('stops a shared host whose startup times out', async () => {
    const fake = createFakeClient();
    fake.client.start = mock(() => new Promise<void>(() => {}));
    const manager = new PiHostManager({
      startupTimeoutMs: 5,
      createClient: () => fake.client,
    });

    await expect(manager.acquire({
      key: 'stuck',
      client: {},
      runtime: { runtimeId: 'runtime-a', cwd: 'E:/project', agentDir: MORTISE_AGENT_DIR, projectConfigDir: MORTISE_PROJECT_DIR },
    })).rejects.toThrow('startup timed out');
    expect(fake.stop).toHaveBeenCalledTimes(1);
  });
});
