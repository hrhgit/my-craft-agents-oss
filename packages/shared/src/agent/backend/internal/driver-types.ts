import type {
  ModelProvider,
  BackendConfig,
  BackendHostRuntimeContext,
  CoreBackendConfig,
  LlmAuthType,
  LlmProviderType,
} from '../types.ts';
import type { PiGlobalProvider } from '../../../config/pi-global-config.ts';
import type { ModelFetchResult } from '../../../config/model-fetcher.ts';
import type { CredentialManager } from '../../../credentials/manager.ts';
import type { ResolvedBackendRuntimePaths } from './runtime-resolver.ts';

export interface BackendRuntimePaths {
  copilotCli?: string;
  sessionServer?: string;
  node?: string;
  bridgeServer?: string;
  piCli?: string;
}

export interface BackendRuntimePayload extends Record<string, unknown> {
  paths?: BackendRuntimePaths;
  piAuthProvider?: string;
  /** Custom base URL from the Pi provider (e.g. Azure OpenAI endpoint). */
  baseUrl?: string;
  /** Custom endpoint protocol config (api type for routing). */
  customEndpoint?: { api: string; supportsImages?: boolean };
  /** Models registered for a custom endpoint. Strings default to 128K context; objects allow overrides. */
  customModels?: Array<string | { id: string; contextWindow?: number; supportsImages?: boolean }>;
}

export interface BackendResolutionContext {
  providerKey?: string;
  providerConfig: PiGlobalProvider | null;
  provider: ModelProvider;
  authType?: LlmAuthType;
  resolvedModel: string;
  capabilities: {
    needsHttpPoolServer: boolean;
  };
}

export interface BackendProviderOptions {
  piAuthProvider?: string;
}

export interface BackendModelFetchCredentials {
  apiKey?: string;
  oauthAccessToken?: string;
  oauthRefreshToken?: string;
  oauthIdToken?: string;
}

export interface DriverHostRuntimeArgs {
  hostRuntime: BackendHostRuntimeContext;
  resolvedPaths: ResolvedBackendRuntimePaths;
}

export interface DriverBuildArgs {
  context: BackendResolutionContext;
  coreConfig: CoreBackendConfig;
  hostRuntime: BackendHostRuntimeContext;
  resolvedPaths: ResolvedBackendRuntimePaths;
  providerOptions?: BackendProviderOptions;
}

export interface DriverFetchModelsArgs extends DriverHostRuntimeArgs {
  providerKey: string;
  providerConfig: PiGlobalProvider;
  credentials: BackendModelFetchCredentials;
  timeoutMs: number;
}

export interface StoredProviderValidationResult {
  success: boolean;
  error?: string;
  shouldRefreshModels?: boolean;
}

export interface DriverValidateStoredProviderArgs extends DriverHostRuntimeArgs {
  providerKey: string;
  providerConfig: PiGlobalProvider;
  credentialManager: CredentialManager;
}

export interface DriverTestConnectionArgs extends DriverHostRuntimeArgs {
  provider: ModelProvider;
  apiKey: string;
  model: string;
  baseUrl?: string;
  providerKey?: string;
  providerConfig?: PiGlobalProvider;
  timeoutMs: number;
}

export interface ProviderDriver {
  provider: ModelProvider;
  initializeHostRuntime?: (args: DriverHostRuntimeArgs) => void;
  fetchModels?: (args: DriverFetchModelsArgs) => Promise<ModelFetchResult>;
  validateStoredProvider?: (args: DriverValidateStoredProviderArgs) => Promise<StoredProviderValidationResult>;
  testConnection?: (args: DriverTestConnectionArgs) => Promise<{ success: boolean; error?: string } | null>;
  prepareRuntime?: (args: DriverBuildArgs) => void;
  buildRuntime: (args: DriverBuildArgs) => BackendRuntimePayload;
}

/**
 * Internal resolved config consumed by concrete backend implementations.
 */
export interface ResolvedBackendConfig extends BackendConfig {
  runtime?: BackendRuntimePayload;
}

export function getBackendRuntime(config: BackendConfig): BackendRuntimePayload {
  return (config.runtime ?? {}) as BackendRuntimePayload;
}

export function getDefaultProviderType(provider: ModelProvider): LlmProviderType {
  switch (provider) {
    case 'pi':
      return 'pi';
  }
}

/* Pi-only driver provider standard. */
