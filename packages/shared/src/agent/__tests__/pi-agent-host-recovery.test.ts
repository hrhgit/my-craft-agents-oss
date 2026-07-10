import { describe, expect, it, mock } from 'bun:test';
import type { RpcCapabilities } from '@earendil-works/pi-coding-agent';
import { PiAgent } from '../pi-agent.ts';
import type { BackendConfig } from '../backend/types.ts';

function createConfig(): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-host-recovery',
      name: 'Host Recovery',
      rootPath: '/tmp/craft-agent-host-recovery',
    } as BackendConfig['workspace'],
    session: {
      craftId: 'session-host-recovery',
      workspaceRootPath: '/tmp/craft-agent-host-recovery',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/craft-agent-host-recovery',
    } as NonNullable<BackendConfig['session']>,
    isHeadless: true,
  };
}

type RecoverablePiClient = {
  invokeExtensionCommandResult: (commandId: string, args?: string) => Promise<{ invoked: boolean }>;
  prompt: (message: string) => Promise<void>;
  getStderr: () => string;
  stop: () => Promise<void>;
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
    expect(invokeExtensionCommandResult).toHaveBeenCalledWith('plan-mode', 'discussion');
    expect(prompt).not.toHaveBeenCalled();

    agent.destroy();
  });
});
