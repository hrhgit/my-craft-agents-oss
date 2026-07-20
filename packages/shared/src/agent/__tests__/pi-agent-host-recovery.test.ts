import { describe, expect, it, mock } from 'bun:test';
import { PiAgent } from '../pi-agent.ts';
import type { PiHostLease } from '../backend/pi-host-manager.ts';
import type { BackendConfig } from '../backend/types.ts';

type RpcCapabilities = PiHostLease['capabilities'];

function createConfig(): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-host-recovery',
      name: 'Host Recovery',
      rootPath: '/tmp/mortise-host-recovery',
    } as BackendConfig['workspace'],
    session: {
      mortiseId: 'session-host-recovery',
      workspaceRootPath: '/tmp/mortise-host-recovery',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/mortise-host-recovery',
    } as NonNullable<BackendConfig['session']>,
    isHeadless: true,
  };
}

type RecoverablePiClient = {
  invokeExtensionCommandResult: (commandId: string, args?: string) => Promise<{ invoked: boolean }>;
  prompt: (message: string) => Promise<void>;
  getStderr: () => string;
  stop: () => Promise<void>;
  runtimeId?: string;
  respondToExtensionHostCapability?: (response: unknown) => void;
  reportExtensionHostCapabilityProgress?: (progress: unknown) => void;
};

type PiAgentRecoveryInternals = {
  rpcClient: RecoverablePiClient | null;
  rpcHostLease: { release: () => Promise<void> } | null;
  rpcClientReady: Promise<void> | null;
  rpcCapabilities: RpcCapabilities | null;
  rpcProcessFailureHandled: boolean;
  startRpcClient: () => Promise<void>;
  handleRpcClientLifecycleFailure: (event: {
    type: 'process_exit';
    code: number | null;
    signal: string | null;
    message: string;
    stderr: string;
  }) => void;
  handlePiClientEvent: (event: Record<string, unknown>) => void;
};

describe('PiAgent GlobalHost recovery', () => {
  it('reconnects before invoking a command and never replays a prompt', async () => {
    const agent = new PiAgent(createConfig());
    const internals = agent as unknown as PiAgentRecoveryInternals;
    const invokeExtensionCommandResult = mock(async () => ({ invoked: true }));
    const prompt = mock(async () => undefined);
    const replacementClient: RecoverablePiClient = {
      invokeExtensionCommandResult,
      prompt,
      getStderr: () => '',
      stop: mock(async () => undefined),
    };
    const replacementCapabilities: RpcCapabilities = {
      protocolVersion: 3,
      packageVersion: 'test',
      commands: ['invoke_extension_command'],
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
        multiRuntime: true,
      },
      hostHooks: {
        moduleEnv: 'PI_HOST_HOOKS_MODULE',
        legacyModuleEnv: 'PI_FETCH_INTERCEPTOR_MODULE',
        exports: [],
      },
    };

    internals.rpcClient = {
      invokeExtensionCommandResult: mock(async () => {
        throw new Error('old host should not receive commands');
      }),
      prompt,
      getStderr: () => '',
      stop: mock(async () => undefined),
    };
    internals.rpcClientReady = Promise.resolve();
    internals.rpcCapabilities = replacementCapabilities;
    const releaseCrashedRuntime = mock(async () => undefined);
    internals.rpcHostLease = { release: releaseCrashedRuntime };
    internals.handleRpcClientLifecycleFailure({
      type: 'process_exit',
      code: 255,
      signal: null,
      message: 'Agent process exited (code=255 signal=null)',
      stderr: '',
    });
    const startRpcClient = mock(async () => {
      internals.rpcProcessFailureHandled = false;
      internals.rpcClient = replacementClient;
      internals.rpcClientReady = Promise.resolve();
      internals.rpcCapabilities = replacementCapabilities;
    });
    internals.startRpcClient = startRpcClient;

    await expect(agent.sendExtensionCommandInvoke('plan-mode', 'discussion')).resolves.toEqual({
      invoked: true,
      error: undefined,
      customMessages: undefined,
    });

    expect(startRpcClient).toHaveBeenCalledTimes(1);
    expect(releaseCrashedRuntime).toHaveBeenCalledTimes(1);
    expect(invokeExtensionCommandResult).toHaveBeenCalledWith('plan-mode', 'discussion', undefined);
    expect(prompt).not.toHaveBeenCalled();

    agent.destroy();
  });

  it('routes extension host capability requests through the Mortise host callback', async () => {
    const onHostCapabilityRequest = mock(async (_request, onProgress) => {
      onProgress({ version: 1, requestId: 'cap-1', sequence: 1, progress: { phase: 'picking' } });
      return { requestId: 'cap-1', status: 'success' as const, output: { paths: ['C:/picked.txt'] } };
    });
    const onHostCapabilityCancel = mock(() => undefined);
    const onHostCapabilityDeclaration = mock(() => undefined);
    const onHostCapabilityRuntimeReleased = mock(() => undefined);
    const agent = new PiAgent({
      ...createConfig(), onHostCapabilityRequest, onHostCapabilityDeclaration, onHostCapabilityCancel, onHostCapabilityRuntimeReleased,
    });
    const internals = agent as unknown as PiAgentRecoveryInternals;
    const respond = mock(() => undefined);
    const reportProgress = mock(() => undefined);
    internals.rpcClient = {
      invokeExtensionCommandResult: mock(async () => ({ invoked: true })),
      prompt: mock(async () => undefined),
      getStderr: () => '',
      stop: mock(async () => undefined),
      runtimeId: 'runtime-1',
      respondToExtensionHostCapability: respond,
      reportExtensionHostCapabilityProgress: reportProgress,
    };

    internals.handlePiClientEvent({
      type: 'extension_host_capability_declaration', version: 1,
      extensionId: 'files-extension', runtimeId: 'spoofed-runtime',
      declarations: [{ capability: 'files.pick', operations: ['open'] }],
    });
    expect(onHostCapabilityDeclaration).toHaveBeenCalledWith({
      version: 1, sessionId: 'session-host-recovery', runtimeId: 'runtime-1',
      extensionId: 'files-extension', declarations: [{ capability: 'files.pick', operations: ['open'] }],
    });

    internals.handlePiClientEvent({
      type: 'extension_host_capability_request', version: 1, id: 'cap-1',
      extensionId: 'files-extension', capability: 'files.pick', operation: 'open',
      input: { mode: 'file' }, runtimeId: 'spoofed-runtime',
    });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(onHostCapabilityRequest).toHaveBeenCalledWith({
      version: 1, requestId: 'cap-1', capability: 'files.pick',
      sessionId: 'session-host-recovery', runtimeId: 'runtime-1',
      extensionId: 'files-extension', operation: 'open', input: { mode: 'file' }, timeoutMs: undefined,
    }, expect.any(Function));
    expect(reportProgress).toHaveBeenCalledWith({
      type: 'extension_host_capability_progress', version: 1, id: 'cap-1',
      sequence: 1, progress: { phase: 'picking' },
      runtimeId: 'runtime-1', sessionId: 'session-host-recovery',
    });
    expect(respond).toHaveBeenCalledWith({
      type: 'extension_host_capability_response', version: 1, id: 'cap-1',
      status: 'success', output: { paths: ['C:/picked.txt'] },
      runtimeId: 'runtime-1', sessionId: 'session-host-recovery',
    });
    internals.handlePiClientEvent({
      type: 'extension_host_capability_cancel', version: 1, id: 'cap-1',
      extensionId: 'files-extension', runtimeId: 'runtime-1',
    });
    expect(onHostCapabilityCancel).toHaveBeenCalledWith('cap-1', 'runtime-1');

    await agent.disposeForRestart();
    expect(onHostCapabilityRuntimeReleased).toHaveBeenCalledWith('runtime-1');
  });

  it('keeps legacy capability declarations and cancellation on the Pi envelope runtime', () => {
    const onHostCapabilityCancel = mock(() => undefined);
    const onHostCapabilityDeclaration = mock(() => undefined);
    const agent = new PiAgent({ ...createConfig(), onHostCapabilityDeclaration, onHostCapabilityCancel });
    const internals = agent as unknown as PiAgentRecoveryInternals;
    internals.rpcClient = {
      invokeExtensionCommandResult: mock(async () => ({ invoked: true })),
      prompt: mock(async () => undefined),
      getStderr: () => '',
      stop: mock(async () => undefined),
    };

    internals.handlePiClientEvent({
      type: 'extension_host_capability_declaration', version: 1,
      extensionId: 'legacy-extension', runtimeId: 'default', declarations: [],
    });
    internals.handlePiClientEvent({
      type: 'extension_host_capability_cancel', version: 1,
      extensionId: 'legacy-extension', id: 'cap-legacy', runtimeId: 'default',
    });

    expect(onHostCapabilityDeclaration).toHaveBeenCalledWith(expect.objectContaining({ runtimeId: 'default' }));
    expect(onHostCapabilityCancel).toHaveBeenCalledWith('cap-legacy', 'default');
    agent.destroy();
  });
});
