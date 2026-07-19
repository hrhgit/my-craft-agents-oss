import type { ProviderDriver, DriverTestConnectionArgs } from '../driver-types.ts';
import type { ModelDefinition } from '../../../../config/models.ts';
import { getAllPiModels, getPiModelsForAuthProvider, isDeprecatedClaudeOpus46Model } from '../../../../config/models-pi.ts';
import { getPiProviderBaseUrl } from '../../../../config/models-pi.ts';
import {
  normalizePiCustomEndpointBaseUrl,
  type PiGlobalProvider,
  type PiGlobalModel,
  type PiCustomApi,
} from '../../../../config/pi-global-config.ts';

// ── Copilot model types ────────────────────────────────────────────────
type RawCopilotModel = {
  id: string;
  name: string;
  supportedReasoningEfforts?: string[];
  policy?: { state: string };
  contextWindow?: number;
};

// ── Direct HTTP approach ─────────────────────────────────────────────

/** Headers that identify us as a VS Code Copilot client (same as Pi SDK). */
const COPILOT_HEADERS = {
  'User-Agent': 'GitHubCopilotChat/0.35.0',
  'Editor-Version': 'vscode/1.107.0',
  'Editor-Plugin-Version': 'copilot-chat/0.35.0',
  'Copilot-Integration-Id': 'vscode-chat',
} as const;

/** Extract API base URL from a Copilot API token's proxy-ep field. */
function getBaseUrlFromToken(token: string): string | null {
  const match = token.match(/proxy-ep=([^;]+)/);
  if (!match?.[1]) return null;
  const apiHost = match[1].replace(/^proxy\./, 'api.');
  return `https://${apiHost}`;
}

/**
 * Fetch models directly from the Copilot API via HTTP.
 *
 * 1. Exchange GitHub OAuth token → Copilot API token (via Pi SDK)
 * 2. Extract base URL from token's proxy-ep field
 * 3. GET /models to list available models with policy state
 *
 * No CLI subprocess, no PATH issues, no env contamination.
 */
async function listModelsViaHttp(
  githubToken: string,
  timeoutMs: number,
): Promise<RawCopilotModel[]> {
  const { refreshGitHubCopilotToken } = await import('@mortise/pi-ai/oauth');

  // Step 1: Exchange GitHub OAuth token → Copilot API token
  const creds = await refreshGitHubCopilotToken(githubToken);
  const copilotToken = creds.access;

  // Step 2: Extract base URL from token
  const baseUrl = getBaseUrlFromToken(copilotToken);
  if (!baseUrl) {
    throw new Error('Could not extract API base URL from Copilot token (missing proxy-ep)');
  }

  console.warn(`[listModelsViaHttp] token exchange OK, baseUrl=${baseUrl}`);

  // Step 3: GET /models
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${copilotToken}`,
        ...COPILOT_HEADERS,
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Copilot API ${res.status}: ${text.slice(0, 300)}`);
    }

    const data = await res.json() as Record<string, unknown>;
    // Handle both { models: [...] } and { data: [...] } response formats
    const models = (data.models || data.data || []) as Record<string, unknown>[];

    console.warn(`[listModelsViaHttp] GET /models returned ${models.length} models`);

    return models.map(m => ({
      id: m.id as string,
      name: (m.name || m.id) as string,
      supportedReasoningEfforts: (m.supportedReasoningEfforts || m.supported_reasoning_efforts) as string[] | undefined,
      policy: m.policy as { state: string } | undefined,
      contextWindow: ((m.capabilities as Record<string, unknown>)?.limits as Record<string, unknown>)?.max_context_window_tokens as number | undefined,
    }));
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error('Copilot models API timed out');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Model ID prefixes to exclude — legacy models that clutter the selector. */
const EXCLUDED_MODEL_PREFIXES = ['gpt-4', 'gpt-3.5'];

/** Filter raw models to only those explicitly enabled by policy, excluding legacy models. */
function filterEnabledModels(models: RawCopilotModel[]): RawCopilotModel[] {
  return models.filter(m =>
    m.policy?.state === 'enabled'
    && !EXCLUDED_MODEL_PREFIXES.some(prefix => m.id.startsWith(prefix))
    && !isDeprecatedClaudeOpus46Model(m.id),
  );
}

/** Convert raw Copilot models to our ModelDefinition format. */
function toModelDefinitions(models: RawCopilotModel[]): ModelDefinition[] {
  return models.map(m => ({
    id: m.id,
    name: m.name,
    shortName: m.name,
    description: '',
    provider: 'pi' as const,
    contextWindow: m.contextWindow || 200_000,
    supportsThinking: !!(m.supportedReasoningEfforts && m.supportedReasoningEfforts.length > 0),
  }));
}

/** Log a breakdown of models by policy state. */
function logModelBreakdown(tag: string, models: RawCopilotModel[]): void {
  const byState = new Map<string, string[]>();
  for (const m of models) {
    const state = m.policy?.state ?? 'no-policy';
    const list = byState.get(state) ?? [];
    list.push(m.id);
    byState.set(state, list);
  }
  const breakdown = [...byState.entries()].map(([s, ids]) => `${s}=${ids.length}(${ids.join(',')})`).join('; ');
  console.warn(`[fetchCopilotModels] ${tag}: total=${models.length} enabled=${filterEnabledModels(models).length} | ${breakdown}`);
}

/**
 * Fetch Copilot models with a 2-tier fallback chain:
 *
 * 1. **Direct HTTP API** – exchange the Pi SDK's GitHub OAuth token for
 *    a Copilot API token, then GET /models. Returns the live model list
 *    with policy state, so we show only enabled models. No CLI subprocess,
 *    no PATH issues, no env contamination.
 * 2. **Pi SDK static catalog** – hardcoded model registry shipped with
 *    the Pi SDK. Not filtered by the user's policy but always available
 *    as a last resort.
 */
async function fetchCopilotModels(
  piSdkGitHubToken: string,
  timeoutMs: number,
): Promise<ModelDefinition[]> {

  // ── Tier 1: Direct HTTP API ──────────────────────────────────────
  try {
    const raw = await listModelsViaHttp(piSdkGitHubToken, timeoutMs);
    if (raw.length > 0) {
      logModelBreakdown('tier1-httpApi', raw);
      const enabled = filterEnabledModels(raw);
      if (enabled.length > 0) {
        return toModelDefinitions(enabled);
      }
      // All models disabled by policy — unusual but possible.
      // Log it clearly and fall through to static catalog.
      console.warn(`[fetchCopilotModels] tier1-httpApi: ${raw.length} models returned but 0 enabled by policy`);
    }
  } catch (err) {
    console.warn(`[fetchCopilotModels] tier1-httpApi failed: ${(err as Error).message}`);
  }

  // ── Tier 2: Pi SDK static catalog (last resort) ──────────────────
  const staticModels = getPiModelsForAuthProvider('github-copilot');
  if (staticModels.length > 0) {
    console.warn(`[fetchCopilotModels] tier2-staticCatalog: falling back to ${staticModels.length} Pi SDK models`);
    return staticModels;
  }

  throw new Error('No Copilot models available from any source.');
}

/**
 * Lightweight direct HTTP test for Pi providers that expose an Anthropic-compatible
 * messages endpoint. Avoids spawning a full Pi subprocess (which can exceed the
 * 20s test timeout due to SDK initialization overhead).
 */
async function testAnthropicCompatible(
  apiKey: string,
  baseUrl: string,
  model: string,
  timeoutMs: number,
): Promise<{ success: boolean; error?: string }> {
  const normalizedBaseUrl = normalizePiCustomEndpointBaseUrl(baseUrl, 'anthropic-messages') ?? baseUrl.trim();
  const url = `${normalizedBaseUrl.replace(/\/+$/, '')}/v1/messages`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'Say ok' }],
      }),
    });

    if (res.ok) return { success: true };

    const text = await res.text().catch(() => '');
    return { success: false, error: `${res.status} ${text}`.slice(0, 500) };
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      return { success: false, error: 'Connection test timed out' };
    }
    return { success: false, error: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

// Custom endpoint/model data comes directly from Pi's provider registry.

/**
 * 从 PiGlobalProvider 构建 driver runtime 的 customEndpoint 字段。
 * 仅当 provider 显式声明了 api 时返回，否则返回 undefined（交由调用方回退）。
 */
function buildCustomEndpointFromPiProvider(
  provider: PiGlobalProvider,
): { api: string; supportsImages?: boolean } | undefined {
  if (!provider.api) return undefined;
  // 若 provider 下任一 model 声明了 image 输入，则视为支持图片
  const supportsImages = provider.models?.some(m => (m.input ?? []).includes('image'));
  return {
    api: provider.api,
    ...(supportsImages ? { supportsImages: true } : {}),
  };
}

/**
 * 将 pi 文件中的 PiGlobalModel[] 转换为 driver runtime 的 customModels 格式。
 *   - 仅当存在 contextWindow 或 supportsImages 覆盖时输出对象形式
 *   - 否则输出裸 id 字符串
 */
function piGlobalModelsToCustomModels(
  models: PiGlobalModel[] | undefined,
): Array<string | { id: string; contextWindow?: number; supportsImages?: boolean }> {
  if (!models || models.length === 0) return [];
  return models.map(m => {
    const supportsImages = (m.input ?? []).includes('image') || undefined;
    if (m.contextWindow || supportsImages !== undefined) {
      return {
        id: m.id,
        contextWindow: m.contextWindow ?? 200_000,
        ...(supportsImages !== undefined ? { supportsImages } : {}),
      };
    }
    return { id: m.id, contextWindow: 200_000 };
  });
}

/** 将 pi 文件中的 PiGlobalModel[] 转换为 ModelDefinition[]（用于 fetchModels 返回）。 */
function piGlobalModelsToModelDefinitions(
  models: PiGlobalModel[],
): ModelDefinition[] {
  return models.map(m => ({
    id: m.id,
    name: m.name ?? m.id,
    shortName: m.name ?? m.id,
    description: '',
    provider: 'pi' as const,
    contextWindow: m.contextWindow ?? 200_000,
    supportsThinking: !!m.reasoning,
    supportsImages: (m.input ?? []).includes('image') || undefined,
  }));
}

function normalizeRuntimeBaseUrl(
  baseUrl: string | undefined,
  api: string | undefined,
): string | undefined {
  if (!baseUrl?.trim()) return undefined;
  return normalizePiCustomEndpointBaseUrl(baseUrl, api as PiCustomApi | undefined) ?? baseUrl.trim();
}

export const piDriver: ProviderDriver = {
  provider: 'pi',
  buildRuntime: ({ context, providerOptions, resolvedPaths }) => {
    const inferredPiAuthProvider =
      providerOptions?.piAuthProvider
      || context.providerKey;
    const providerConfig = context.providerConfig;
    const customEndpoint = providerConfig
      ? buildCustomEndpointFromPiProvider(providerConfig)
      : undefined;
    const customModels = piGlobalModelsToCustomModels(providerConfig?.models);
    const rawBaseUrl = providerConfig?.baseUrl;
    const baseUrl = normalizeRuntimeBaseUrl(rawBaseUrl, customEndpoint?.api);

    return ({
    paths: {
      node: resolvedPaths.nodeRuntimePath,
      piCli: resolvedPaths.piCliPath,
    },
    piAuthProvider: inferredPiAuthProvider,
    baseUrl,
    customEndpoint,
    customModels,
  });
  },
  fetchModels: async ({ providerKey, providerConfig, credentials, timeoutMs }) => {
    // pi_compat 连接的 models 直接从 ~/.pi/agent/models.json 读取（用户手填，
    // 不走自动发现）。pi 文件中无对应 provider 时返回空列表。
    if (providerConfig.baseUrl) {
      const models = providerConfig.models?.length
        ? piGlobalModelsToModelDefinitions(providerConfig.models)
        : [];
      return { models };
    }

    // Copilot OAuth: fetch models directly from the Copilot API via HTTP.
    // Uses the GitHub OAuth token (our refreshToken) to exchange for a
    // Copilot API token, then queries GET /models for the live model list.
    const copilotGitHubToken = credentials.oauthRefreshToken || credentials.oauthAccessToken;
    if (providerKey === 'github-copilot' && copilotGitHubToken) {
      const models = await fetchCopilotModels(copilotGitHubToken, timeoutMs);
      return { models };
    }

    // All other Pi providers: use static Pi SDK model registry
    const models = providerKey
      ? getPiModelsForAuthProvider(providerKey)
      : getAllPiModels();

    if (models.length === 0) {
      throw new Error(
        `No Pi models found for provider: ${providerKey || 'all'}`,
      );
    }

    return { models };
  },
  testConnection: async (args: DriverTestConnectionArgs): Promise<{ success: boolean; error?: string } | null> => {
    const piAuthProvider = args.providerKey;
    if (!piAuthProvider) {
      // No provider hint — fall back to generic connection validation path
      return null;
    }

    // Resolve the model's API type from the Pi SDK registry.
    // For anthropic-messages providers, do a lightweight direct HTTP test
    // instead of spawning a full Pi subprocess (which can exceed the timeout).
    let modelApi: string | undefined;
    let modelBaseUrl: string | undefined;
    try {
      const { getModels } = await import('@mortise/pi-ai');
      const models = getModels(piAuthProvider as Parameters<typeof getModels>[0]);
      const requestedId = args.model.startsWith('pi/') ? args.model.slice(3) : args.model;
      const match = models.find(m => m.id === requestedId) || models[0];
      if (match) {
        modelApi = (match as { api?: string }).api;
        modelBaseUrl = (match as { baseUrl?: string }).baseUrl;
      }
    } catch { /* ignore — fall through to subprocess */ }

    if (modelApi !== 'anthropic-messages') {
      // Non-Anthropic API types need the full Pi SDK — let factory.ts handle it
      return null;
    }

    const baseUrl = normalizePiCustomEndpointBaseUrl(
      args.baseUrl?.trim() || modelBaseUrl || getPiProviderBaseUrl(piAuthProvider),
      'anthropic-messages',
    );
    if (!baseUrl) {
      return { success: false, error: 'Could not determine API endpoint for provider' };
    }

    // Strip Pi SDK's 'pi/' prefix — Anthropic-compatible endpoints only accept bare model IDs
    let bareModel = args.model.startsWith('pi/') ? args.model.slice(3) : args.model;
    // MiniMax CN API doesn't accept the 'MiniMax-' prefix on model names
    if (piAuthProvider === 'minimax-cn' && bareModel.startsWith('MiniMax-')) {
      bareModel = bareModel.slice('MiniMax-'.length);
    }
    return testAnthropicCompatible(args.apiKey, baseUrl, bareModel, args.timeoutMs);
  },
  validateStoredProvider: async () => ({ success: true }),
};
