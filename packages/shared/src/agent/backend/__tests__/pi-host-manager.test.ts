import { describe, expect, it, mock } from 'bun:test';
import type {
  PiRuntimeHandle,
  RpcCapabilities,
  RpcClient,
  RpcClientEventListener,
  RpcClientOptions,
  RpcRuntimeOpenOptions,
} from '@earendil-works/pi-coding-agent';
import { PiHostManager, PiHostProtocolError, type PiHostAcquireOptions } from '../pi-host-manager.ts';

function capabilities(protocolVersion = 3): RpcCapabilities {
  return {
    protocolVersion,
    packageVersion: 'test',
    commands: ['get_capabilities', 'open_runtime'],
    features: {
      hostHooksModule: true,
      legacyFetchInterceptorModule: true,
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
      legacyModuleEnv: 'PI_FETCH_INTERCEPTOR_MODULE',
      exports: [],
    },
  };
}

function createFakeClient(protocolVersion = 3, startupEvent?: Parameters<RpcClientEventListener>[0]) {
  let listener: RpcClientEventListener | undefined;
  const close = mock(async () => undefined);
  const runtime = {
    runtimeId: 'runtime-a',
    runtimeSummary: {
      runtimeId: 'runtime-a',
      cwd: 'E:/project',
      sessionId: 'session-a',
      isStreaming: false,
    },
    close,
  } as unknown as PiRuntimeHandle;
  const openRuntime = mock(async (_options: RpcRuntimeOpenOptions) => {
    if (startupEvent) listener?.(startupEvent);
    return runtime;
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
        runtimeId: 'runtime-a', cwd: 'E:/project', extensionTarget: 'craft',
        extensionPaths: ['E:/extensions/browser.js', 'E:/extensions/messaging.js'],
      },
    };

    const first = await manager.acquire(options);
    const second = await manager.acquire(options);
    expect(fake.openRuntime).toHaveBeenCalledTimes(1);
    expect(fake.openRuntime).toHaveBeenCalledWith(expect.objectContaining({
      extensionPaths: ['E:/extensions/browser.js', 'E:/extensions/messaging.js'],
    }));

    await first.release();
    expect(fake.close).not.toHaveBeenCalled();
    await second.release();
    expect(fake.close).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.stop).toHaveBeenCalledTimes(1);
  });

  it('rejects an RPC v2 host so callers can use the legacy fallback', async () => {
    const fake = createFakeClient(2);
    const manager = new PiHostManager({ createClient: () => fake.client });

    await expect(manager.acquire({
      key: 'legacy',
      client: {},
      runtime: { runtimeId: 'runtime-a', cwd: 'E:/project', extensionTarget: 'craft' },
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
      runtime: { runtimeId: 'runtime-a', cwd: 'E:/project', extensionTarget: 'craft' },
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
      runtime: { runtimeId: 'runtime-a', cwd: 'E:/project', extensionTarget: 'craft' },
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
});
