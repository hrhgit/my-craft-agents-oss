/**
 * Agent Factory
 *
 * Creates the appropriate AI agent based on configuration.
 * Supports PiAgent (Pi) using @mortise/pi-ai SDK.
 *
 * All agents implement AgentBackend directly.
 *
 * Pi Providers:
 * - Backends can be created from Pi provider configs
 * - providerType determines SDK selection and credential routing
 * - authType determines how credentials are retrieved
 */

import type {
  AgentBackend,
  BackendConfig,
  LlmAuthType,
  LlmProviderType,
  CoreBackendConfig,
  BackendHostRuntimeContext,
  ModelProvider,
} from './types.ts';
import { PiAgent } from '../pi-agent.ts';
import {
  hasPiGlobalProviderAuth,
  readPiGlobalProviders,
  readPiGlobalSettings,
  type PiGlobalProvider,
} from '../../config/pi-global-config.ts';
import { parseValidationError } from '../../config/llm-validation.ts';
import type { ModelFetchResult } from '../../config/model-fetcher.ts';
// Model resolution utilities
import { getModelProvider, DEFAULT_MODEL, normalizeDeprecatedModelId } from '../../config/models.ts';
import { homedir } from 'node:os';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { getCredentialManager } from '../../credentials/index.ts';
import type {
  BackendModelFetchCredentials,
  BackendProviderOptions,
  BackendResolutionContext,
  ProviderDriver,
  ResolvedBackendConfig,
  StoredProviderValidationResult,
} from './internal/driver-types.ts';
import { getDefaultProviderType } from './internal/driver-types.ts';
import {
  resolveBackendHostTooling as resolveHostToolingPaths,
  resolveBackendRuntimePaths,
} from './internal/runtime-resolver.ts';
import { piDriver } from './internal/drivers/pi.ts';

const DRIVER_REGISTRY: Record<ModelProvider, ProviderDriver> = {
  pi: piDriver,
};

function getProviderDriver(provider: ModelProvider): ProviderDriver {
  const driver = DRIVER_REGISTRY[provider];
  if (!driver) {
    throw new Error(`No backend driver registered for provider: ${provider}`);
  }
  return driver;
}

function resolveDriverRuntime(
  provider: ModelProvider,
  hostRuntime: BackendHostRuntimeContext,
) {
  const driver = getProviderDriver(provider);
  const resolvedPaths = resolveBackendRuntimePaths(hostRuntime);
  return { driver, resolvedPaths };
}

/**
 * Create the appropriate backend based on configuration.
 *
 * @param config - Backend configuration including provider selection
 * @returns An initialized AgentBackend instance
 * @throws Error if the requested provider is not yet implemented
 *
 * @example
 * ```typescript
 * // Create Pi backend (routes OpenAI / Copilot / Bedrock / etc. via Pi SDK)
 * const piBackend = createBackend({
 *   provider: 'pi',
 *   workspace: myWorkspace,
 * });
 * ```
 */
export function createBackend(config: BackendConfig): AgentBackend {
  switch (config.provider) {
    case 'pi':
      return new PiAgent(config);

    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}

/**
 * Create backend from a pre-resolved context and provider-agnostic core config.
 * Provider-specific runtime resolution happens via internal driver registry.
 */
export function createBackendFromResolvedContext(args: {
  context: ResolvedBackendContext;
  coreConfig: CoreBackendConfig;
  hostRuntime: BackendHostRuntimeContext;
  providerOptions?: BackendProviderOptions;
}): AgentBackend {
  const { context, coreConfig, hostRuntime, providerOptions } = args;
  const { driver, resolvedPaths } = resolveDriverRuntime(context.provider, hostRuntime);

  const buildArgs = {
    context,
    coreConfig,
    hostRuntime,
    resolvedPaths,
    providerOptions,
  };

  driver.prepareRuntime?.(buildArgs);
  const runtime = driver.buildRuntime(buildArgs);

  const config: ResolvedBackendConfig = {
    ...coreConfig,
    provider: context.provider,
    providerType: context.providerConfig?.baseUrl ? 'pi_compat' : getDefaultProviderType(context.provider),
    authType: context.authType || getDefaultAuthType(context.provider),
    model: context.resolvedModel,
    providerKey: context.providerKey,
    runtime,
  };

  return createBackend(config);
}

/**
 * Initialize backend host runtime wiring once at app startup.
 * Keeps runtime/bootstrap details (Pi interceptor bundle, subprocess paths)
 * behind backend internals.
 */
export function initializeBackendHostRuntime(args: {
  hostRuntime: BackendHostRuntimeContext;
}): void {
  const { hostRuntime } = args;

  for (const provider of ['pi'] as ModelProvider[]) {
    const { driver, resolvedPaths } = resolveDriverRuntime(provider, hostRuntime);
    driver.initializeHostRuntime?.({ hostRuntime, resolvedPaths });
  }
}

/**
 * Resolve backend-managed host tooling paths (e.g. ripgrep) from generic host runtime metadata.
 */
export function resolveBackendHostTooling(args: {
  hostRuntime: BackendHostRuntimeContext;
}): {
  ripgrepPath?: string;
} {
  return resolveHostToolingPaths(args.hostRuntime);
}

// ============================================================
// LLM Connection Support
// ============================================================

/**
 * Current agent provider — all LlmProviderType values route to the Pi backend.
 *
 * Kept as a single named export (rather than inlined) so future multi-provider
 * routing can revive this exit point without touching every call site.
 *
 * The `_providerTypeExhaustiveCheck` record below is a compile-time
 * exhaustiveness guard: if `LlmProviderType` gains new members (e.g.
 * 'bedrock', 'vertex'), this assertion will fail and force a revisit of the
 * routing decision, preventing silent fallback to Pi.
 */
// Exhaustiveness check: if LlmProviderType gains new members,
// this assertion will fail and force a revisit of the routing decision.
const _providerTypeExhaustiveCheck: Record<LlmProviderType, ModelProvider> = {
  pi: 'pi',
  pi_compat: 'pi',
};
export const AGENT_PROVIDER: ModelProvider = 'pi';

/**
 * Get Pi provider for a session.
 * Resolution order: session provider > Pi global default.
 *
 * @param sessionConnection - Connection slug from session (may be undefined)
 * @returns The resolved Pi provider or null if not found
 */
export function resolveSessionProvider(
  sessionProvider?: string,
): { key: string; provider: PiGlobalProvider } | null {
  const providers = readPiGlobalProviders();
  const globalDefault = readPiGlobalSettings().defaultProvider;
  for (const key of [sessionProvider, globalDefault]) {
    if (key && providers[key]) return { key, provider: providers[key] };
  }
  const first = Object.entries(providers)[0];
  return first ? { key: first[0], provider: first[1] } : null;
}

/**
 * Backend resolution result used by session/ipc orchestration.
 */
export type ResolvedBackendContext = BackendResolutionContext;

/**
 * Resolve connection + provider/auth/model/capabilities in one call.
 * This keeps main-process orchestration free from provider-specific branching.
 */
export function resolveBackendContext(args: {
  sessionProvider?: string;
  managedModel?: string;
}): ResolvedBackendContext {
  const resolved = resolveSessionProvider(args.sessionProvider);
  const provider = AGENT_PROVIDER;
  const resolvedModel = resolveModelForProvider(provider, args.managedModel, resolved?.provider ?? null);

  return {
    providerKey: resolved?.key,
    providerConfig: resolved?.provider ?? null,
    provider,
    authType: resolved?.provider && hasPiGlobalProviderAuth(resolved.key) ? 'api_key' : undefined,
    resolvedModel,
    capabilities: { needsHttpPoolServer: false },
  };
}

/**
 * Resolve provider hint for setup-time connection tests.
 * Keeps provider-specific hint mapping out of Electron main IPC handlers.
 */
/**
 * Provider-agnostic model discovery for model refresh flows.
 * Dispatches to provider drivers and keeps provider-specific SDK usage internal.
 */
export async function fetchBackendModels(args: {
  providerKey: string;
  providerConfig: PiGlobalProvider;
  credentials: BackendModelFetchCredentials;
  hostRuntime: BackendHostRuntimeContext;
  timeoutMs?: number;
}): Promise<ModelFetchResult> {
  const provider = AGENT_PROVIDER;
  const { driver, resolvedPaths } = resolveDriverRuntime(provider, args.hostRuntime);
  const timeoutMs = args.timeoutMs ?? 30_000;

  driver.initializeHostRuntime?.({
    hostRuntime: args.hostRuntime,
    resolvedPaths,
  });

  if (!driver.fetchModels) {
    throw new Error(`Model discovery not implemented for provider: ${provider}`);
  }

  return driver.fetchModels({
    providerKey: args.providerKey,
    providerConfig: args.providerConfig,
    credentials: args.credentials,
    hostRuntime: args.hostRuntime,
    resolvedPaths,
    timeoutMs,
  });
}

/**
 * Provider-agnostic stored-connection validation.
 * Moves provider/auth branching out of Electron main IPC handlers.
 */
export async function validateStoredBackendProvider(args: {
  providerKey: string;
  hostRuntime: BackendHostRuntimeContext;
}): Promise<StoredProviderValidationResult> {
  try {
    const providerConfig = readPiGlobalProviders()[args.providerKey];
    if (!providerConfig) {
      return { success: false, error: 'Provider not found' };
    }
    if (!hasPiGlobalProviderAuth(args.providerKey) && providerConfig.authHeader === true) {
      return { success: false, error: 'No credentials configured' };
    }

    const provider = AGENT_PROVIDER;
    const { driver, resolvedPaths } = resolveDriverRuntime(provider, args.hostRuntime);

    driver.initializeHostRuntime?.({
      hostRuntime: args.hostRuntime,
      resolvedPaths,
    });

    if (!driver.validateStoredProvider) {
      return { success: true };
    }

    return driver.validateStoredProvider({
      providerKey: args.providerKey,
      providerConfig,
      credentialManager: getCredentialManager(),
      hostRuntime: args.hostRuntime,
      resolvedPaths,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, error: parseValidationError(msg) };
  }
}

/**
 * Create backend from an Pi provider slug.
 *
 * @param providerKey - The Pi provider slug
 * @param baseConfig - Base backend config (workspace, session, etc.)
 * @returns An initialized AgentBackend instance
 * @throws Error if connection not found or has invalid provider-auth combination
 */
export function createBackendFromProvider(
  providerKey: string,
  baseConfig: Omit<BackendConfig, 'provider' | 'authType'>,
  hostRuntime?: BackendHostRuntimeContext,
  providerOptions?: BackendProviderOptions,
): AgentBackend {
  const providerConfig = readPiGlobalProviders()[providerKey];
  if (!providerConfig) throw new Error(`Provider not found: ${providerKey}`);

  const context: ResolvedBackendContext = {
    providerKey,
    providerConfig,
    provider: AGENT_PROVIDER,
    authType: hasPiGlobalProviderAuth(providerKey) ? 'api_key' : undefined,
    resolvedModel: resolveModelForProvider(
      AGENT_PROVIDER,
      baseConfig.model,
      providerConfig
    ),
    capabilities: { needsHttpPoolServer: false },
  };

  if (hostRuntime) {
    return createBackendFromResolvedContext({
      context,
      coreConfig: baseConfig,
      hostRuntime,
      providerOptions,
    });
  }

  const config: BackendConfig = {
    ...baseConfig,
    provider: AGENT_PROVIDER,
    providerType: providerConfig.baseUrl ? 'pi_compat' : 'pi',
    authType: context.authType,
    providerKey: providerKey,
    model: context.resolvedModel,
  };
  return createBackend(config);
}

// ============================================================
// Auth Type Resolution
// ============================================================

/**
 * Get the default auth type for a provider when none is explicitly specified.
 *
 * - anthropic: 'api_key' (legacy alias routed to Pi)
 * - pi: 'api_key'
 */
export function getDefaultAuthType(provider: ModelProvider): LlmAuthType | undefined {
  switch (provider) {
    case 'pi':        return 'api_key';
    default:          return undefined;
  }
}

// ============================================================
// Model Resolution
// ============================================================

/**
 * Resolve the model ID for a given provider, validating against the provider's model list.
 *
 * Pi falls back to an empty model string when no provider/default model is set,
 * allowing the Pi backend to select its configured default.
 *
 * @param provider - The agent provider
 * @param managedModel - The model stored on the session (user's choice)
 * @param connection - The Pi provider config (has defaultModel and models[])
 * @returns Resolved model ID string
 */
export function resolveModelForProvider(
  provider: ModelProvider,
  managedModel: string | undefined,
  providerConfig: PiGlobalProvider | null,
): string {
  // Cross-provider guard: if the model belongs to a different provider, fall back
  // to the provider's default. This prevents e.g. sending a Claude model to Pi.
  if (managedModel) {
    managedModel = normalizeDeprecatedModelId(managedModel);
    const modelProvider = getModelProvider(managedModel);
    if (modelProvider && modelProvider !== provider) {
      managedModel = undefined; // Clear — will fall through to provider default
    }
  }

  const settings = readPiGlobalSettings();
  let providerDefault = settings.defaultModel
    ? normalizeDeprecatedModelId(settings.defaultModel)
    : providerConfig?.models?.[0]?.id;

  if (provider === 'pi' && providerConfig?.models?.length) {
    const modelIds = providerConfig.models.map(model => model.id);
    if (managedModel && !modelIds.includes(managedModel)) {
      managedModel = undefined;
    }
    if (providerDefault && !modelIds.includes(providerDefault)) {
      providerDefault = modelIds[0];
    }
  }

  switch (provider) {
    case 'pi':
      return managedModel || providerDefault || '';
    default:
      return managedModel || providerDefault || DEFAULT_MODEL;
  }
}

// ============================================================
// Runtime Artifact Helpers
// ============================================================

/**
 * Remove backend runtime artifacts for disabled sources.
 * Currently removes bridge credential cache files in source directories.
 */
export async function cleanupSourceRuntimeArtifacts(
  workspaceRootPath: string,
  disabledSourceSlugs: string[],
): Promise<void> {
  for (const sourceSlug of disabledSourceSlugs) {
    const cachePath = join(workspaceRootPath, 'sources', sourceSlug, '.credential-cache.json');
    await rm(cachePath, { force: true });
  }
}

// ============================================================
// Provider-Agnostic Connection Testing
// ============================================================

export async function testBackendConnection(args: {
  provider: ModelProvider | 'anthropic';
  apiKey: string;
  model: string;
  baseUrl?: string;
  hostRuntime: BackendHostRuntimeContext;
  timeoutMs?: number;
  allowEmptyApiKey?: boolean;
  providerKey?: string;
  providerConfig?: PiGlobalProvider;
}): Promise<{ success: boolean; error?: string }> {
  const trimmedKey = args.apiKey.trim();
  if (!trimmedKey && !args.allowEmptyApiKey) {
    return { success: false, error: 'API key is required' };
  }

  const runtimeProvider: ModelProvider = args.provider === 'anthropic' ? 'pi' : args.provider;
  const tempSlug = `__test-${Date.now()}`;
  const cm = getCredentialManager();
  if (trimmedKey) {
    await cm.setProviderApiKey(tempSlug, trimmedKey);
  }

  try {
    const testModel = args.model;
    const providerType = args.providerConfig?.baseUrl ? 'pi_compat' : getDefaultProviderType(runtimeProvider);
    const piAuthProvider = args.providerKey ?? (args.provider === 'anthropic' ? 'anthropic' : undefined);
    const now = Date.now();
    const authType: LlmAuthType = (
      providerType === 'pi_compat'
    )
      ? 'api_key_with_endpoint'
      : 'api_key';

    const providerConfig: PiGlobalProvider = args.providerConfig ?? {
      ...(args.baseUrl?.trim() ? { baseUrl: args.baseUrl.trim() } : {}),
      models: [{ id: testModel }],
    };

    const context: ResolvedBackendContext = {
      providerKey: piAuthProvider ?? tempSlug,
      providerConfig,
      provider: runtimeProvider,
      authType,
      resolvedModel: testModel,
      capabilities: { needsHttpPoolServer: false },
    };

    const { driver, resolvedPaths } = resolveDriverRuntime(runtimeProvider, args.hostRuntime);
    if (driver.testConnection) {
      const driverResult = await driver.testConnection({
        provider: runtimeProvider,
        apiKey: trimmedKey,
        model: testModel,
        baseUrl: args.baseUrl,
        providerKey: piAuthProvider,
        providerConfig,
        hostRuntime: args.hostRuntime,
        resolvedPaths,
        timeoutMs: args.timeoutMs ?? 20000,
      });
      // null = driver declined to handle; fall through to generic subprocess test
      if (driverResult !== null) return driverResult;
    }

    const cwd = homedir();
    const agent = createBackendFromResolvedContext({
      context,
      coreConfig: {
        workspace: { id: '__test', name: 'Connection Test', slug: '__test', rootPath: cwd, createdAt: 0 },
        session: { mortiseId: `test-${now}`, workspaceRootPath: cwd, createdAt: 0, lastUsedAt: 0 },
        isHeadless: true,
        miniModel: testModel,
        envOverrides: undefined,
      },
      hostRuntime: args.hostRuntime,
      providerOptions: {
        piAuthProvider,
      },
    });

    const readAgentStderr = (): string => {
      const maybe = agent as unknown as { getRecentStderr?: () => string };
      return typeof maybe.getRecentStderr === 'function' ? maybe.getRecentStderr() : '';
    };
    const withStderrContext = (message: string): string => {
      const stderr = readAgentStderr();
      if (!stderr) return `${message} (subprocess produced no stderr output)`;
      return `${message}\n--- subprocess stderr (last ~8KB) ---\n${stderr}`;
    };

    try {
      const timeoutMs = args.timeoutMs ?? 20000;
      const text = await Promise.race([
        agent.runMiniCompletion('Say ok'),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(withStderrContext(`Connection test timed out after ${timeoutMs}ms`))),
            timeoutMs
          )
        ),
      ]);

      return text
        ? { success: true }
        : { success: false, error: 'No response from provider. Check your API key.' };
    } catch (error) {
      const base = error instanceof Error ? error.message : String(error);
      // Avoid double-appending if the timeout branch already included stderr context.
      const enriched = base.includes('subprocess stderr') ? base : withStderrContext(base);
      return { success: false, error: enriched };
    } finally {
      agent.destroy();
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await cm.deleteProviderApiKey(tempSlug).catch(() => {});
  }
}
