import {
  AGENT_PROVIDER,
  createBackend,
  createBackendFromConnection,
  createBackendFromResolvedContext,
  resolveBackendContext,
  type BackendConfig,
  type BackendHostRuntimeContext,
  type CoreBackendConfig,
} from '../agent/backend/index.ts';

export class PiRuntimeClient {
  readonly provider = AGENT_PROVIDER;

  createBackend(config: Omit<BackendConfig, 'provider'>) {
    return createBackend({ ...config, provider: AGENT_PROVIDER });
  }

  createFromConnection(
    connectionSlug: string,
    baseConfig: Omit<BackendConfig, 'provider' | 'authType'>,
    hostRuntime?: BackendHostRuntimeContext,
  ) {
    return createBackendFromConnection(connectionSlug, baseConfig, hostRuntime);
  }

  resolveContext(args: Parameters<typeof resolveBackendContext>[0]) {
    return resolveBackendContext(args);
  }

  createFromResolvedContext(args: {
    context: ReturnType<typeof resolveBackendContext>;
    coreConfig: CoreBackendConfig;
    hostRuntime: BackendHostRuntimeContext;
  }) {
    return createBackendFromResolvedContext(args);
  }
}

export function createPiRuntimeClient(): PiRuntimeClient {
  return new PiRuntimeClient();
}
