#!/usr/bin/env node
/**
 * Pi Agent Server
 *
 * Out-of-process Pi agent server communicating via JSONL over stdio.
 * Wraps @earendil-works/pi-coding-agent SDK and communicates with the main
 * Electron process using a line-delimited JSON protocol.
 *
 * The main process spawns this as a child process. All Pi SDK interactions
 * (session creation, prompting, tool execution, permissions) happen here,
 * with events forwarded back to the main process for UI rendering.
 *
 * This design isolates the Pi SDK's ESM + heavy dependencies into a
 * separate process, avoiding bundling issues in the Electron main process.
 */

import { createInterface } from 'node:readline';
import { join, dirname } from 'node:path';
import { mkdirSync, readdirSync, statSync, existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Pi SDK
import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  SessionManager as PiSessionManager,
  AuthStorage as PiAuthStorage,
  ModelRegistry as PiModelRegistry,
  createReadToolDefinition,
  createBashToolDefinition,
  createEditToolDefinition,
  createWriteToolDefinition,
  createGrepToolDefinition,
  createFindToolDefinition,
  createLsToolDefinition,
  createHeadlessUIContext,
} from '@earendil-works/pi-coding-agent';
import type {
  AgentSession,
  AgentSessionEvent,
  AgentToolResult,
  AuthCredential,
  CreateAgentSessionOptions,
  EventBus,
  ExtensionUIContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';

// Pi AI types
import type { TextContent as PiTextContent } from '@earendil-works/pi-ai';

// Pre-register the Bedrock provider module so the Pi SDK doesn't attempt a
// dynamic import of "./amazon-bedrock.js" — which fails in the bundled output
// because bun collapses everything into a single file.
// pi-ai is deduped (single hoisted copy), so one registration covers both
// pi-ai and pi-agent-core module scopes.
import { setBedrockProviderModule } from '@earendil-works/pi-ai';
import { bedrockProviderModule } from '@earendil-works/pi-ai/bedrock-provider';
setBedrockProviderModule(bedrockProviderModule);

// Set PI_PACKAGE_DIR so Pi SDK's resource-loader.ts can resolve
// dist/core/package-manager.js at runtime. In bundled mode, getPackageDir()
// walks up from __dirname (pi-agent-server/dist/) and returns pi-agent-server/,
// where dist/core/ doesn't exist. Pointing to the actual Pi coding-agent
// package (which has a built dist/) fixes the runtime require() in
// getPackageManager(). Same class of issue as the Bedrock provider above.
try {
  const __require = createRequire(import.meta.url);
  const __piMainPath = __require.resolve('@earendil-works/pi-coding-agent');
  process.env.PI_PACKAGE_DIR = dirname(dirname(realpathSync(__piMainPath)));
} catch {
  // Fallback: require.resolve may fail due to exports field restrictions.
  // Walk up from this file to find node_modules/@earendil-works/pi-coding-agent
  // and resolve the symlink to get the real package directory.
  try {
    let __dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 10; i++) {
      const __candidate = join(__dir, 'node_modules', '@earendil-works', 'pi-coding-agent');
      if (existsSync(__candidate)) {
        const __real = realpathSync(__candidate);
        if (existsSync(join(__real, 'dist', 'core', 'package-manager.js'))) {
          process.env.PI_PACKAGE_DIR = __real;
        }
        break;
      }
      __dir = dirname(__dir);
    }
  } catch {
    // Fallback: PI_PACKAGE_DIR unset, getPackageDir() uses default logic
  }
}

// Model resolution (extracted for testability + custom-endpoint precedence)
import { resolvePiModel, isDeniedMiniModelId, isModelNotFoundError } from './model-resolution.ts';
import { pickProviderAppropriateMiniModel } from './pick-mini-model.ts';
import {
  buildCustomEndpointModelDef,
  normalizeCustomEndpointModelEntry,
  stripPiPrefix,
  type CustomEndpointModelEntry,
  type CustomEndpointModelOverrides,
} from './custom-endpoint-models.ts';

// Direct source imports from shared (bundled by bun build)
import { handleLargeResponse, estimateTokens, tokenLimitFor } from '../../shared/src/utils/large-response.ts';
import { getSessionPlansPath, getSessionPath } from '../../shared/src/sessions/storage.ts';
import { withTimeout, LLM_QUERY_TIMEOUT_MS } from '../../shared/src/agent/llm-tool.ts';
import type { LLMQueryRequest, LLMQueryResult } from '../../shared/src/agent/llm-tool.ts';
import { PI_TOOL_NAME_MAP, THINKING_TO_PI } from '../../shared/src/agent/backend/pi/constants.ts';
import { getDefaultSummarizationModel } from '../../shared/src/config/models.ts';
import { readPiGlobalAuth } from '../../shared/src/config/pi-global-config.ts';
import { createWebFetchTool } from './tools/web-fetch.ts';
import { resolveSearchProvider } from './tools/search/resolve-provider.ts';
import { createSearchTool } from './tools/search/create-search-tool.ts';
import { allowCraftMetadataProperties, stripCraftMetadata } from './craft-metadata-schema.ts';
import { listSpawnedChildSessions } from './child-session-listing.ts';
import { createCraftFetchInterceptor } from '../../shared/src/unified-network-interceptor.ts';

/**
 * Pi fetchInterceptor factory. Wraps whatever fetch Pi hands us (sidecar fetch
 * or global fetch) with the craft pipeline. createCraftFetchInterceptor is
 * idempotent, so when the legacy --require preload already patched
 * globalThis.fetch this returns it unchanged instead of double-processing.
 */
function resolveCraftFetchInterceptor(): (baseFetch: typeof fetch) => typeof fetch {
  return (baseFetch) => createCraftFetchInterceptor(baseFetch);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ============================================================
// Types — JSONL Protocol
// ============================================================

/** Credential union used in init and token_update messages */
type PiCredential =
  | { type: 'api_key'; key: string }
  | { type: 'oauth'; access: string; refresh: string; expires: number }
  | { type: 'iam'; accessKeyId: string; secretAccessKey: string; region?: string; sessionToken?: string };

/** Custom endpoint protocol — determines which streaming adapter Pi SDK uses */
type CustomEndpointApi = 'openai-completions' | 'anthropic-messages';

/** Init message from main process — configures the Pi agent server */
interface InitMessage {
  type: 'init';
  apiKey: string;
  model: string;
  cwd: string;
  thinkingLevel: string;
  workspaceRootPath: string;
  sessionId: string;
  sessionPath: string;
  piSessionFile?: string;
  piSessionDir?: string;
  workingDirectory: string;
  plansFolderPath: string;
  miniModel?: string;
  agentDir?: string;
  providerType?: string;
  authType?: string;
  workspaceId?: string;
  baseUrl?: string;
  branchFromSdkSessionId?: string;
  branchFromSessionPath?: string;
  branchFromPiSessionFile?: string;
  branchFromSdkTurnId?: string;
  customEndpoint?: { api: CustomEndpointApi; supportsImages?: boolean };
  customModels?: Array<string | { id: string; contextWindow?: number; supportsImages?: boolean }>;
  piAuth?: { provider: string; credential: PiCredential };
  /**
   * 是否启用全局 pi 扩展加载。默认 true。
   * - true（或未传）：pi-agent-server 使用 ~/.pi/agent 作为 agentDir，加载全局扩展。
   * - false：主进程应同时传 agentDir 指向 session 临时目录，回退到隔离模式。
   */
  piExtensionsEnabled?: boolean;
  /**
   * 是否启用完全 Pi 透传（壳模式）。默认 true。
   * - true：使用 Pi 原生 system prompt，不应用 Craft 身份覆盖。
   * - false：回退到 Craft 独立身份模式（应用 applySystemPromptOverride）。
   */
  piShellFullPassthrough?: boolean;
}

interface RuntimeConfigUpdateMessage {
  type: 'update_runtime_config';
  id: string;
  model: string;
  providerType?: string;
  authType?: string;
  baseUrl?: string;
  customEndpoint?: { api: CustomEndpointApi; supportsImages?: boolean };
  customModels?: Array<string | { id: string; contextWindow?: number; supportsImages?: boolean }>;
}

/** Messages from main process (stdin) */
type InboundMessage =
  | InitMessage
  | { type: 'prompt'; id: string; message: string; systemPrompt: string; images?: Array<{ type: 'image'; data: string; mimeType: string }> }
  | { type: 'register_tools'; tools: ProxyToolDef[] }
  | { type: 'tool_execute_response'; requestId: string; result: { content: string; isError: boolean } }
  | { type: 'pre_tool_use_response'; requestId: string; action: 'allow' | 'block' | 'modify'; input?: Record<string, unknown>; reason?: string }
  | { type: 'abort' }
  | { type: 'mini_completion'; id: string; prompt: string }
  | { type: 'llm_query'; id: string; request: LLMQueryRequest }
  | { type: 'ensure_session_ready'; id: string }
  | { type: 'set_model'; model: string }
  | { type: 'set_thinking_level'; level: string }
  | { type: 'compact'; id: string; customInstructions?: string }
  | { type: 'set_auto_compaction'; id: string; enabled: boolean }
  | RuntimeConfigUpdateMessage
  | { type: 'steer'; message: string }
  | { type: 'token_update'; piAuth: { provider: string; credential: PiCredential } }
  // 扩展桥接：主进程调用扩展注册的命令
  | { type: 'extension_command_invoke'; commandId: string; args?: string }
  // 扩展桥接：主进程回复 remoteui:request（payload=null 表示取消）
  | { type: 'remoteui_response'; requestId: string; payload: unknown | null; reason?: 'cancelled' | 'no_remote' | 'disconnected' }
  | { type: 'spawn_child_session'; id: string; parentSessionId: string; options: SpawnChildSessionOptionsPayload }
  | { type: 'list_child_sessions'; id: string; parentSessionId: string }
  | { type: 'shutdown' };

/** Payload for spawn_child_session — matches pi's SpawnChildSessionOptions */
interface SpawnChildSessionOptionsPayload {
  prompt?: string;
  connection?: string;
  model?: string;
  enabledSources?: string[];
  permissionMode?: 'safe' | 'ask' | 'allow-all';
  thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  labels?: string[];
  name?: string;
  workingDirectory?: string;
  attachments?: Array<{ path: string; name?: string }>;
}

/** Proxy tool definition from main process */
interface ProxyToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Canonical tool metadata propagated on Pi tool start events */
interface ToolExecutionMetadata {
  intent?: string;
  displayName?: string;
  source: 'interceptor';
}

type EnrichedToolExecutionStartEvent = Extract<AgentSessionEvent, { type: 'tool_execution_start' }> & {
  toolMetadata?: ToolExecutionMetadata;
};

type OutboundAgentEvent = AgentSessionEvent | EnrichedToolExecutionStartEvent;

/** Messages to main process (stdout) */
interface OutboundReady { type: 'ready'; sessionId: string | null }
interface OutboundEvent { type: 'event'; event: OutboundAgentEvent }
interface OutboundPreToolUseReq {
  type: 'pre_tool_use_request';
  requestId: string;
  toolName: string;
  toolCallId?: string;
  input: Record<string, unknown>;
}
interface OutboundToolExecReq { type: 'tool_execute_request'; requestId: string; toolName: string; args: Record<string, unknown> }
interface OutboundSessionToolCompleted { type: 'session_tool_completed'; toolName: string; args: Record<string, unknown>; isError: boolean }
interface OutboundMiniResult { type: 'mini_completion_result'; id: string; text: string | null }
interface OutboundLlmQueryResult {
  type: 'llm_query_result';
  id: string;
  result: LLMQueryResult | null;
  errorMessage?: string;
  /**
   * When set, signals the main process that a generic `error` with the same code
   * was also emitted on the error channel (for centralized auth-refresh detection).
   */
  errorCode?: string;
}
interface OutboundEnsureSessionReadyResult { type: 'ensure_session_ready_result'; id: string; sessionId: string | null }
interface OutboundCompactResult {
  type: 'compact_result';
  id: string;
  success: boolean;
  result?: { summary: string; firstKeptEntryId: string; tokensBefore: number };
  errorMessage?: string;
}
interface OutboundSetAutoCompactionResult {
  type: 'set_auto_compaction_result';
  id: string;
  success: boolean;
  enabled: boolean;
  errorMessage?: string;
}
interface OutboundRuntimeConfigUpdateResult {
  type: 'update_runtime_config_result';
  id: string;
  success: boolean;
  updated: boolean;
  errorMessage?: string;
}
interface OutboundSessionIdUpdate { type: 'session_id_update'; sessionId: string }
interface OutboundSpawnChildSessionResult {
  type: 'spawn_child_session_result';
  id: string;
  success: boolean;
  sessionId?: string;
  sessionPath?: string;
  errorMessage?: string;
}
interface OutboundChildSessionInfo {
  type: 'child_session_info';
  sessionId: string;
  sessionPath: string;
  name?: string;
  cwd: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
  spawnConfig?: { connection?: string; model?: string; enabledSources?: string[]; permissionMode?: string; thinkingLevel?: string };
}
interface OutboundListChildSessionsResult {
  type: 'list_child_sessions_result';
  id: string;
  success: boolean;
  sessions: OutboundChildSessionInfo[];
  errorMessage?: string;
}
interface OutboundError { type: 'error'; message: string; code?: string }

// ============================================================
// 扩展桥接消息类型（ExtensionAPI → Craft 事件桥接层）
// ============================================================

/** 扩展通知（对应 ui.notify）*/
interface OutboundExtensionNotify {
  type: 'extension_notify';
  message: string;
  notificationType?: 'info' | 'warning' | 'error';
  source?: string;
}
/** 扩展 widget 更新（对应 ui.setWidget）*/
interface OutboundExtensionWidget {
  type: 'extension_widget';
  key: string;
  content: string[] | undefined;
  placement?: 'aboveEditor' | 'belowEditor';
  source?: string;
}
/** 扩展命令注册通知 */
interface OutboundExtensionCommandRegistered {
  type: 'extension_command_registered';
  name: string;
  description?: string;
  source: string;
}
/** RemoteUI 请求（扩展通过 pi.events.emit("remoteui:request") 发起）*/
interface OutboundRemoteUIRequest {
  type: 'remoteui_request';
  requestId: string;
  kind: 'select' | 'editor';
  title: string;
  message?: string;
  options?: Array<{ title: string; description?: string }>;
  allowMultiple?: boolean;
  allowFreeform?: boolean;
  allowComment?: boolean;
  prefill?: string;
  source: string;
}

type OutboundMessage =
  | OutboundReady
  | OutboundEvent
  | OutboundPreToolUseReq
  | OutboundToolExecReq
  | OutboundSessionToolCompleted
  | OutboundMiniResult
  | OutboundLlmQueryResult
  | OutboundEnsureSessionReadyResult
  | OutboundCompactResult
  | OutboundSetAutoCompactionResult
  | OutboundRuntimeConfigUpdateResult
  | OutboundSessionIdUpdate
  | OutboundSpawnChildSessionResult
  | OutboundListChildSessionsResult
  | OutboundError
  // 扩展桥接消息
  | OutboundExtensionNotify
  | OutboundExtensionWidget
  | OutboundExtensionCommandRegistered
  | OutboundRemoteUIRequest;

// ============================================================
// State
// ============================================================

let piSession: AgentSession | null = null;
let piModelRegistry: PiModelRegistry | null = null;
let moduleAuthStorage: PiAuthStorage | null = null;
let unsubscribeEvents: (() => void) | null = null;

// 扩展事件桥接：共享 EventBus，用于订阅 pi 扩展发出的 remoteui:request 等事件
let extensionEventBus: EventBus | null = null;
let unsubscribeExtensionEvents: (() => void) | null = null;

// Init config (set on 'init' message)
let initConfig: Extract<InboundMessage, { type: 'init' }> | null = null;

// Mutable state
let currentUserMessage = '';

// Pending promises for async handshakes
const pendingPreToolUse = new Map<string, { resolve: (response: { action: string; input?: Record<string, unknown>; reason?: string }) => void }>();
const pendingToolExecutions = new Map<string, { resolve: (result: { content: string; isError: boolean }) => void }>();

// Timeout for pending tool handshakes with the main process. If the parent
// process is alive but unresponsive, reject so the tool call surfaces an
// error instead of hanging forever (and leaking Map entries / memory).
const PRE_TOOL_USE_TIMEOUT_MS = 60_000;
const TOOL_EXECUTE_TIMEOUT_MS = 60_000;

// Pending session MCP tool calls for completion detection
const pendingSessionToolCalls = new Map<string, { toolName: string; arguments: Record<string, unknown> }>();

// Proxy tool definitions from main process
let proxyToolDefs: ProxyToolDef[] = [];

// Flag: proxy tools changed since last session creation — session needs recreation
let toolsChanged = false;

// ============================================================
// JSONL I/O
// ============================================================

function send(msg: OutboundMessage): void {
  const line = JSON.stringify(msg);
  process.stdout.write(line + '\n');
}

function debugLog(message: string): void {
  // Write debug messages to stderr so they don't interfere with JSONL protocol
  process.stderr.write(`[pi-server] ${message}\n`);
}

/** Find the most recent .jsonl session file in a directory. */
function findMostRecentSessionFile(sessionDir: string): string | null {
  if (!existsSync(sessionDir)) return null;
  let best: { path: string; mtime: number } | null = null;
  for (const entry of readdirSync(sessionDir)) {
    if (!entry.endsWith('.jsonl')) continue;
    const fullPath = join(sessionDir, entry);
    const mtime = statSync(fullPath).mtimeMs;
    if (!best || mtime > best.mtime) {
      best = { path: fullPath, mtime };
    }
  }
  return best?.path ?? null;
}

// ============================================================
// Pi Session Management
// ============================================================

function resolvedCwd(): string {
  const wd = initConfig?.cwd || initConfig?.workingDirectory || process.cwd();
  if (wd.startsWith('~/')) return join(homedir(), wd.slice(2));
  if (wd === '~') return homedir();
  return wd;
}

/**
 * 解析 pi 扩展开关。
 * 优先级：initConfig.piExtensionsEnabled > 环境变量 CRAFT_PI_EXTENSIONS_ENABLED > 默认 true。
 * 默认 true（加载全局扩展），为 false 时回退到隔离模式。
 */
function isPiExtensionsEnabled(): boolean {
  if (initConfig?.piExtensionsEnabled !== undefined) {
    return initConfig.piExtensionsEnabled !== false;
  }
  const envVal = process.env.CRAFT_PI_EXTENSIONS_ENABLED;
  if (envVal !== undefined) {
    return envVal !== 'false';
  }
  return true;
}

/**
 * 解析 pi 壳模式开关（完全 Pi 透传）。
 * 优先级：initConfig.piShellFullPassthrough > 默认 true。
 * 为 true 时使用 Pi 原生 system prompt，不应用 Craft 身份覆盖。
 */
function isPiShellFullPassthrough(): boolean {
  if (initConfig?.piShellFullPassthrough !== undefined) {
    return initConfig.piShellFullPassthrough !== false;
  }
  return true;
}

/**
 * 解析 agentDir：
 * - 显式传入 agentDir 时优先使用（向后兼容，主进程可强制指定隔离路径）
 * - piExtensionsEnabled = true（默认）：使用 ~/.pi/agent（加载全局扩展）
 * - piExtensionsEnabled = false：回退到 session 临时目录（隔离模式）
 */
function resolveAgentDir(): string | undefined {
  // 显式传入的 agentDir 优先（向后兼容）
  if (initConfig?.agentDir) {
    return initConfig.agentDir;
  }
  if (isPiExtensionsEnabled()) {
    // 默认：加载全局 pi 扩展
    return join(homedir(), '.pi', 'agent');
  }
  // 隔离模式：使用 session 临时目录
  if (initConfig?.sessionPath) {
    return join(initConfig.sessionPath, '.pi-agent');
  }
  return undefined;
}

/**
 * 创建桥接 ExtensionUIContext：将 ui.notify / ui.setWidget 等调用通过 JSONL
 * 转发到主进程，由主进程转 IPC 到 renderer 渲染。
 *
 * 实现委托给 Pi SDK 官方的 `createHeadlessUIContext`：它内置了 stub theme、
 * widget 工厂渲染、select/confirm/input/editor 安全降级，以及 TUI no-op 方法。
 * 此处仅提供 transport 适配——把 Pi 发出的事件复用模块作用域的 `send` 函数
 * （JSONL over stdio）转发到主进程。
 *
 * select/confirm/input/editor 的交互式对话框仍通过 remoteui:request 事件桥接
 * （见 extensionEventBus 订阅），headless context 仅提供安全降级返回值。
 */
function createBridgeUIContext(): ExtensionUIContext {
  return createHeadlessUIContext({
    send(event) {
      // 复用模块作用域的 send（JSONL over stdio）；Pi 发出的事件字段与
      // OutboundExtensionNotify/OutboundExtensionWidget 完全匹配。
      send(event as unknown as OutboundMessage);
    },
  });
}

// Helper: derive preferCustomEndpoint flag from init config
function shouldPreferCustomEndpoint(): boolean {
  return Boolean(initConfig?.customEndpoint && initConfig?.baseUrl?.trim());
}

/**
 * Expose the active Pi model API/provider/base URL to the interceptor process.
 * This gives the interceptor a robust routing hint (instead of brittle URL-only matching).
 */
function setInterceptorApiHints(model: { api?: string; provider?: string; baseUrl?: string } | undefined): void {
  if (!model) {
    delete process.env.CRAFT_PI_MODEL_API;
    delete process.env.CRAFT_PI_MODEL_PROVIDER;
    delete process.env.CRAFT_PI_MODEL_BASE_URL;
    return;
  }

  process.env.CRAFT_PI_MODEL_API = model.api || '';
  process.env.CRAFT_PI_MODEL_PROVIDER = model.provider || '';
  process.env.CRAFT_PI_MODEL_BASE_URL = model.baseUrl || '';

  debugLog(
    `[interceptor-hint] api=${process.env.CRAFT_PI_MODEL_API || '-'} provider=${process.env.CRAFT_PI_MODEL_PROVIDER || '-'} baseUrl=${process.env.CRAFT_PI_MODEL_BASE_URL || '-'}`,
  );
}

/**
 * Resolve the API key for custom endpoint auth.
 * Returns empty string for local endpoints (Ollama etc.) that don't need auth.
 */
function resolveCustomEndpointApiKey(): string {
  if (initConfig?.piAuth?.credential?.type === 'api_key') {
    return initConfig.piAuth.credential.key;
  }
  const key = initConfig?.apiKey || '';
  if (!key && initConfig?.baseUrl) {
    if (isLocalhostUrl(initConfig.baseUrl)) {
      // Local endpoints (Ollama, LM Studio) don't need auth.
      // Pi SDK requires a truthy apiKey to register models, so use a placeholder.
      return 'not-needed';
    }
    debugLog('[custom-endpoint] Warning: no API key found for non-localhost endpoint — requests will likely fail');
  }
  return key;
}

function isLocalhostUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    const normalizedHostname = hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname;
    return normalizedHostname === 'localhost' || normalizedHostname === '127.0.0.1' || normalizedHostname === '::1';
  } catch {
    return false;
  }
}

/** Model IDs currently registered under the custom-endpoint provider */
let customEndpointModelIds: Set<string> = new Set();

/**
 * Register (or re-register) the custom-endpoint provider with the given models.
 * Note: registerProvider replaces the entire provider, so we maintain a Set of all
 * known model IDs and always pass the full set.
 */
const customModelOverrides = new Map<string, CustomEndpointModelOverrides>();

function registerCustomEndpointModels(
  registry: PiModelRegistry,
  api: CustomEndpointApi,
  baseUrl: string,
  models: CustomEndpointModelEntry[],
): void {
  for (const m of models) {
    customEndpointModelIds.add(m.id);
    if (m.contextWindow || m.supportsImages !== undefined) {
      customModelOverrides.set(m.id, {
        ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
        ...(m.supportsImages !== undefined ? { supportsImages: m.supportsImages } : {}),
      });
    }
  }
  const allIds = [...customEndpointModelIds];
  registry.registerProvider('custom-endpoint', {
    baseUrl,
    apiKey: resolveCustomEndpointApiKey(),
    api,
    authHeader: true,
    models: allIds.map(id => buildCustomEndpointModelDef(
      id,
      { supportsImages: initConfig?.customEndpoint?.supportsImages === true },
      customModelOverrides.get(id),
    )),
  });
  debugLog(`Registered custom endpoint: ${baseUrl} with ${allIds.length} model(s) [${allIds.join(', ')}], api: ${api}`);
}

/**
 * Create an in-memory auth storage pre-loaded with the user's credentials
 * and a model registry backed by it. Used by both the main session and
 * ephemeral queryLlm sessions.
 */
function createAuthenticatedRegistry(): {
  authStorage: PiAuthStorage;
  modelRegistry: PiModelRegistry;
} {
  // Reuse module-level authStorage if already created (allows token_update to mutate it).
  // Only create a new one on first call or after re-init.
  if (!moduleAuthStorage) {
    moduleAuthStorage = PiAuthStorage.inMemory();
    // Task 6 后 ~/.pi/agent/auth.json 是 pi 凭证的唯一数据源（SoT）。
    // 子进程在创建 in-memory AuthStorage 后，主动从 auth.json 加载所有凭证，
    // 主进程不再需要为 pi 连接注入凭证（凭证由 auth.json 直接提供）。
    // 主进程传来的 piAuth（若有）会在下方覆盖 auth.json 中的同名凭证，用于 OAuth 刷新。
    const authFile = readPiGlobalAuth();
    if (authFile?.providers) {
      let loadedCount = 0;
      for (const [providerKey, cred] of Object.entries(authFile.providers)) {
        if (!cred || typeof cred !== 'object' || !cred.type) continue;
        moduleAuthStorage.set(providerKey, cred as unknown as AuthCredential);
        loadedCount++;
      }
      if (loadedCount > 0) {
        debugLog(`Loaded ${loadedCount} credential(s) from ~/.pi/agent/auth.json`);
      }
    }
  }
  const authStorage = moduleAuthStorage;
  if (initConfig?.piAuth) {
    const { provider, credential } = initConfig.piAuth;
    // Pi SDK 0.70.0's AuthCredential union (ApiKeyCredential | OAuthCredential) doesn't
    // include 'iam' as a first-class member, but the auth storage accepts it at runtime
    // — the Bedrock provider module reads AWS env directly; this `set` keeps Pi SDK's
    // internal provider-tracking consistent regardless of credential shape.
    authStorage.set(provider, credential as unknown as AuthCredential);
    debugLog(`Injected ${credential.type} credential for provider: ${provider}`);
  } else if (initConfig?.apiKey) {
    authStorage.set('anthropic', { type: 'api_key', key: initConfig.apiKey });
    debugLog('Injected API key into auth storage (legacy fallback)');
  }

  const modelRegistry = PiModelRegistry.inMemory(authStorage);

  // Register custom endpoint models dynamically via Pi SDK's registerProvider API.
  // This makes arbitrary OpenAI/Anthropic-compatible endpoints work through the Pi SDK
  // by creating synthetic Model<Api> objects that the SDK requires.
  const hasCustomEndpoint = !!initConfig?.baseUrl?.trim();
  if (hasCustomEndpoint && initConfig?.customEndpoint) {
    const { api } = initConfig.customEndpoint;
    const modelEntries: CustomEndpointModelEntry[] = (initConfig.customModels?.length
      ? initConfig.customModels
      : [initConfig.model || 'default']
    ).map(normalizeCustomEndpointModelEntry);
    customEndpointModelIds = new Set();  // Reset on fresh registry creation
    registerCustomEndpointModels(modelRegistry, api, initConfig.baseUrl!.trim(), modelEntries);
  } else if (hasCustomEndpoint && !initConfig?.customEndpoint) {
    debugLog('Custom endpoint without protocol config — models may not resolve. Set customEndpoint.api for proper routing.');
  }

  return { authStorage, modelRegistry };
}

async function ensureSession(): Promise<AgentSession> {
  if (piSession) return piSession;
  if (!initConfig) throw new Error('Cannot create session: init not received');

  const cwd = resolvedCwd();

  const { authStorage, modelRegistry } = createAuthenticatedRegistry();
  // Store at module scope for set_model handler
  piModelRegistry = modelRegistry;

  // Build tools: coding tools + web tools wrapped with permission hooks + proxy tools.
  // Search provider is selected based on the user's LLM connection:
  //   - OpenAI/OpenRouter → Responses API built-in web_search
  //   - ChatGPT Plus (openai-codex) → ChatGPT backend responses endpoint
  //   - Google → Gemini API with googleSearch grounding
  //   - Others → DuckDuckGo fallback
  //
  // IMPORTANT: resolve dynamically on each search call so token_update refreshes
  // are used without recreating the session.
  const searchProvider = {
    get name() {
      return resolveSearchProvider(initConfig?.piAuth).name;
    },
    async search(query: string, count: number) {
      return resolveSearchProvider(initConfig?.piAuth).search(query, count);
    },
  };
  const searchTool = createSearchTool(searchProvider);
  const webFetchTool = createWebFetchTool(() =>
    initConfig ? getSessionPath(initConfig.workspaceRootPath, initConfig.sessionId) : null
  );
  const webTools = [searchTool, webFetchTool];

  // Pi SDK 0.70.0 registration contract:
  //   - `customTools` accepts ToolDefinition[] — our hook-wrapped objects go here
  //   - `tools` is a string[] name allowlist — MUST include every tool we want active,
  //     otherwise Pi SDK defaults to the built-in [read, bash, edit, write] set and
  //     silently filters out everything else. Custom tool names with matching built-in
  //     names override the SDK's raw implementation inside _refreshToolRegistry, so
  //     our hooked versions take effect (permissions + large-response summarization).
  //   - Do NOT pass tool *objects* to `tools` — `allowedToolNames = new Set(options.tools)`
  //     then `.has(name)` returns false for every string lookup → zero tools active.
  const builtinDefs = [
    createReadToolDefinition(cwd),
    createBashToolDefinition(cwd),
    createEditToolDefinition(cwd),
    createWriteToolDefinition(cwd),
    createGrepToolDefinition(cwd),
    createFindToolDefinition(cwd),
    createLsToolDefinition(cwd),
  ];
  const proxyTools = buildProxyTools();
  const wrappedAll = wrapToolsWithHooks([...builtinDefs, ...webTools, ...proxyTools]);
  const toolAllowlist = wrappedAll.map(t => t.name);
  debugLog(`Session tools: ${builtinDefs.length} builtin + ${webTools.length} web + ${proxyTools.length} proxy = ${wrappedAll.length} total`);

  // Build session options
  const sessionOptions: CreateAgentSessionOptions = {
    cwd,
    authStorage,
    modelRegistry,
    customTools: wrappedAll,
    tools: toolAllowlist,
    // Route model traffic through the craft interceptor via Pi's typed
    // fetchInterceptor API. In packaged/subprocess runs the interceptor is
    // ALSO preloaded via --require (patching globalThis.fetch); passing it
    // here is idempotent (same pipeline) and covers in-process embedding
    // where no preload happens. The typed path is the long-term seam; the
    // preload is legacy and slated for removal.
    fetchInterceptor: resolveCraftFetchInterceptor(),
  };

  // 解析 agentDir：
  // - 显式传入时优先（向后兼容，主进程可强制指定隔离路径）
  // - piExtensionsEnabled = true（默认）：~/.pi/agent（加载全局扩展）
  // - piExtensionsEnabled = false：session 临时目录（隔离模式）
  const resolvedAgentDir = resolveAgentDir();
  if (resolvedAgentDir) {
    mkdirSync(resolvedAgentDir, { recursive: true });
    sessionOptions.agentDir = resolvedAgentDir;
  }

  // 扩展事件桥接：当启用全局扩展时，创建共享 EventBus 并通过 DefaultResourceLoader 注入。
  // EventBus 订阅扩展发出的 remoteui:request 事件（select/editor 对话框），转发给主进程。
  // ui.notify / ui.setWidget 通过 session.extensionRunner.setUIContext() 注入桥接
  // ExtensionUIContext（见下方 ensureSession 末尾），由 createBridgeUIContext() 实现。
  const extensionsEnabled = isPiExtensionsEnabled();
  if (extensionsEnabled && resolvedAgentDir) {
    // 清理上一次的订阅（session 重建场景）
    if (unsubscribeExtensionEvents) {
      unsubscribeExtensionEvents();
      unsubscribeExtensionEvents = null;
    }

    extensionEventBus = createEventBus();
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: resolvedAgentDir,
      eventBus: extensionEventBus,
    });
    await loader.reload();
    sessionOptions.resourceLoader = loader;

    // 桥接 remoteui:request → 主进程
    // pi 扩展通过 pi.events.emit("remoteui:request", { requestId, kind, ... }) 请求 UI 交互
    unsubscribeExtensionEvents = extensionEventBus.on('remoteui:request', (data: unknown) => {
      const req = data as {
        requestId: string;
        kind: 'select' | 'editor';
        title: string;
        message?: string;
        options?: Array<{ title: string; description?: string }>;
        allowMultiple?: boolean;
        allowFreeform?: boolean;
        allowComment?: boolean;
        prefill?: string;
        source: string;
      } | undefined;
      if (!req || !req.requestId || !req.kind) {
        debugLog(`[extension-bridge] 忽略格式错误的 remoteui:request: ${JSON.stringify(data).slice(0, 200)}`);
        return;
      }
      send({ type: 'remoteui_request', ...req });
    });

    debugLog(`[extension-bridge] EventBus 桥接已激活 (agentDir: ${resolvedAgentDir})`);
  }

  // Session resume: use the shared Pi-native session file when provided.
  // `sessionPath` remains Craft's sidecar folder for attachments/tool metadata.
  if (initConfig.sessionPath) {
    const sessionDir = initConfig.piSessionDir || join(initConfig.sessionPath, '.pi-sessions');
    mkdirSync(sessionDir, { recursive: true });

    if (initConfig.branchFromSessionPath) {
      // Branching: fork from the parent session's Pi session file.
      // Branches must not silently degrade to fresh sessions.
      const parentPiSessionDir = join(initConfig.branchFromSessionPath, '.pi-sessions');
      const parentPiSessionFile = initConfig.branchFromPiSessionFile || findMostRecentSessionFile(parentPiSessionDir);
      if (!parentPiSessionFile) {
        throw new Error(`Pi branch preflight failed: no parent Pi session file found (native=${initConfig.branchFromPiSessionFile || '<none>'}, legacyDir=${parentPiSessionDir})`);
      }

      debugLog(`Forking Pi session from parent: ${parentPiSessionFile}`);
      const forkedSessionManager = PiSessionManager.forkFrom(parentPiSessionFile, cwd, sessionDir);

      // Strict branch cutoff: move leaf to the selected parent entry if provided.
      // This is Pi's equivalent of Claude resumeSessionAt.
      if (initConfig.branchFromSdkTurnId) {
        const anchorId = initConfig.branchFromSdkTurnId;
        const anchorEntry = forkedSessionManager.getEntry(anchorId);
        if (!anchorEntry) {
          throw new Error(`Pi branch preflight failed: branch anchor not found: ${anchorId}`);
        }
        forkedSessionManager.branch(anchorId);
        debugLog(`Applied Pi branch cutoff at entry: ${anchorId}`);
      }

      sessionOptions.sessionManager = forkedSessionManager;
    } else if (initConfig.piSessionFile) {
      sessionOptions.sessionManager = PiSessionManager.open(initConfig.piSessionFile, sessionDir, cwd);
    } else {
      sessionOptions.sessionManager = PiSessionManager.continueRecent(cwd, sessionDir);
    }
  }

  // Set model if specified
  if (initConfig.model) {
    try {
      const piModel = resolvePiModel(modelRegistry, initConfig.model, initConfig.piAuth?.provider, shouldPreferCustomEndpoint());
      if (piModel) {
        // Verify resolved model's provider is compatible with the authenticated provider.
        // Without this, a model that resolves to a different provider (e.g. azure-openai-responses
        // when authed as github-copilot) would cause "No API key found" at runtime.
        const resolvedProvider = (piModel as any)?.provider;
        const isCompatible = !initConfig.piAuth ||
          resolvedProvider === initConfig.piAuth.provider ||
          resolvedProvider === 'custom-endpoint';
        if (isCompatible) {
          sessionOptions.model = piModel;
          setInterceptorApiHints(piModel as { api?: string; provider?: string; baseUrl?: string });
        } else {
          debugLog(`Model ${initConfig.model} resolved to incompatible provider ${resolvedProvider} (expected ${initConfig.piAuth!.provider}), skipping`);
          setInterceptorApiHints(undefined);
        }
      } else {
        setInterceptorApiHints(undefined);
      }
    } catch {
      debugLog(`Could not resolve Pi model: ${initConfig.model}`);
      setInterceptorApiHints(undefined);
    }
  } else {
    setInterceptorApiHints(undefined);
  }

  // Set thinking level
  const piThinkingLevel = THINKING_TO_PI[initConfig.thinkingLevel as keyof typeof THINKING_TO_PI];
  if (piThinkingLevel) {
    sessionOptions.thinkingLevel = piThinkingLevel;
  }

  // Create the session — tools flow through customTools + allowlist (see comment above).
  const { session, extensionsResult } = await createAgentSession(sessionOptions);
  piSession = session;

  toolsChanged = false;
  debugLog(`Created Pi session: ${session.sessionId} (${wrappedAll.length} tools)`);

  // 注入桥接 ExtensionUIContext：让扩展的 ui.notify / ui.setWidget 调用通过 JSONL 转发到主进程。
  // 必须使用 applyExtensionBindings() 而非 runner.setUIContext()，因为 Pi SDK 在首次 prompt() 时
  // 会通过 _applyExtensionBindings() 用 session._extensionUIContext 覆盖 runner 上的 uiContext。
  // applyExtensionBindings() 将桥接上下文存入 _extensionUIContext，确保覆盖后仍然生效，
  // 这样 session_start 钩子触发时 hasUI() 返回 true，扩展才会调用 ctx.ui.setWidget()。
  if (extensionsEnabled) {
    try {
      const bridgeUIContext = createBridgeUIContext();
      (session as any).applyExtensionBindings({ uiContext: bridgeUIContext });
      debugLog('[extension-bridge] 已注入桥接 ExtensionUIContext (notify + setWidget)');
    } catch (err) {
      debugLog(`[extension-bridge] applyExtensionBindings 注入失败: ${err}`);
    }
  }

  // 通知主进程已注册的扩展命令（用于 UI 命令面板等）
  if (extensionsResult?.extensions) {
    for (const ext of extensionsResult.extensions) {
      for (const [name, cmd] of ext.commands) {
        send({
          type: 'extension_command_registered',
          name,
          description: cmd.description,
          source: ext.path,
        });
      }
    }
    debugLog(`[extension-bridge] 已注册 ${extensionsResult.extensions.length} 个扩展`);
  }

  // Notify main process of session ID
  send({ type: 'session_id_update', sessionId: session.sessionId });

  return session;
}


// ============================================================
// Tool Wrapping (Permission Enforcement + Large Response Summarization)
// ============================================================

/**
 * Shared permission enforcement for both coding tools and proxy tools.
 * Checks mode-manager rules and, in Ask mode, prompts the user via the
 * pending-permissions handshake. Throws on deny or block.
 */
/**
 * Send pre_tool_use_request to main process and wait for response.
 * Returns the (potentially modified) input if approved, throws if blocked.
 * All permission checking, transforms, and source activation happen in the main process.
 */
async function requestPreToolUseApproval(
  sdkToolName: string,
  input: Record<string, unknown>,
  toolCallId?: string,
): Promise<Record<string, unknown>> {
  const requestId = `pi-ptu-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  send({
    type: 'pre_tool_use_request',
    requestId,
    toolName: sdkToolName,
    ...(toolCallId ? { toolCallId } : {}),
    input,
  });

  const response = await new Promise<{ action: string; input?: Record<string, unknown>; reason?: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pendingPreToolUse.delete(requestId)) {
        reject(new Error(`Pre-tool-use request timed out after ${PRE_TOOL_USE_TIMEOUT_MS / 1000}s`));
      }
    }, PRE_TOOL_USE_TIMEOUT_MS);
    pendingPreToolUse.set(requestId, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
    });
  });

  if (response.action === 'block') {
    throw new Error(response.reason || `Tool "${sdkToolName}" is not allowed`);
  }

  return response.action === 'modify' && response.input ? response.input : input;
}

function wrapToolsWithHooks(tools: ToolDefinition<any, any>[]): ToolDefinition<any, any>[] {
  return tools.map(tool => wrapSingleTool(tool));
}

function makeErrorResult(message: string): AgentToolResult<any> {
  return {
    content: [{ type: 'text', text: message }],
    details: { isError: true },
  };
}

function wrapSingleTool(tool: ToolDefinition<any, any>): ToolDefinition<any, any> {
  const originalExecute = tool.execute;
  const parameters = allowCraftMetadataProperties(tool.parameters);

  const wrappedExecute: ToolDefinition<any, any>['execute'] = async (
    toolCallId,
    params,
    signal,
    onUpdate,
    ctx,
  ) => {
    const sdkToolName = PI_TOOL_NAME_MAP[tool.name] || tool.name;
    let inputObj: Record<string, unknown> = { ...(params as Record<string, unknown>) };

    // Extract intent before main process strips metadata (used for summarization)
    const intent = typeof inputObj._intent === 'string' ? inputObj._intent : undefined;

    // Normalize Pi SDK parameter names: path → file_path
    if ((sdkToolName === 'Write' || sdkToolName === 'Edit' || sdkToolName === 'MultiEdit' || sdkToolName === 'NotebookEdit')
        && typeof inputObj.path === 'string' && !inputObj.file_path) {
      inputObj = { ...inputObj, file_path: inputObj.path };
    }

    // Send to main process for permission checking + transforms
    inputObj = await requestPreToolUseApproval(sdkToolName, inputObj, toolCallId);

    // Metadata is for Craft UI only. Keep a final defensive strip here so the
    // upstream Pi tool implementation always receives clean executable args,
    // even if a future pre-tool-use path returns `allow` without modification.
    inputObj = stripCraftMetadata(inputObj);

    // Execute original tool with (potentially modified) input
    const result = await originalExecute(toolCallId, inputObj, signal, onUpdate, ctx);

    // --- Post-execute: large response summarization ---

    const resultText = result.content
      .filter((c): c is PiTextContent => c.type === 'text')
      .map(c => c.text)
      .join('');

    // Source the active model's contextWindow each call so the threshold
    // tracks set_model mid-session, not the model that was active at session
    // creation. Falls back to the fixed default when the model isn't set yet.
    const modelContextWindow = piSession?.agent.state.model?.contextWindow;
    if (estimateTokens(resultText) > tokenLimitFor(modelContextWindow) && initConfig) {
      try {
        const sessionPath = getSessionPath(
          initConfig.workspaceRootPath,
          initConfig.sessionId,
        );

        const largeResult = await handleLargeResponse({
          text: resultText,
          sessionPath,
          context: {
            toolName: sdkToolName,
            input: inputObj,
            intent,
            userRequest: currentUserMessage,
          },
          summarize: runMiniCompletion,
          contextWindow: modelContextWindow,
        });

        if (largeResult) {
          return {
            content: [{ type: 'text', text: largeResult.message }],
            details: result.details,
          };
        }
      } catch (error) {
        debugLog(
          `Large response handling failed: ${errorMessage(error)}`,
        );
      }
    }

    return result;
  };

  return {
    ...tool,
    parameters,
    execute: wrappedExecute,
  };
}

// ============================================================
// Proxy Tools (tools executed in main process)
// ============================================================

function buildProxyTools(): ToolDefinition<any, any>[] {
  debugLog(`Building proxy tools from ${proxyToolDefs.length} definitions: ${proxyToolDefs.map(t => t.name).join(', ')}`);

  return proxyToolDefs.map<ToolDefinition<any, any>>(def => ({
    name: def.name,
    label: def.name
      .replace(/^mcp__.*?__/, '')
      .replace(/_/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2'),
    description: def.description,
    // Pi SDK omits tools without promptSnippet from the system prompt's
    // "Available tools" section, making them invisible to the LLM.
    // Derive a snippet from the description so proxy tools are listed.
    promptSnippet: def.description.length > 200
      ? def.description.slice(0, 197) + '...'
      : def.description,
    parameters: def.inputSchema,
    execute: async (
      toolCallId: string,
      params: any,
    ): Promise<AgentToolResult<any>> => {
      const inputObj = params as Record<string, unknown>;

      // Permission checking via main process
      const approvedInput = await requestPreToolUseApproval(def.name, inputObj, toolCallId);

      // Execute via main process
      const requestId = `proxy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      send({
        type: 'tool_execute_request',
        requestId,
        toolName: def.name,
        args: approvedInput,
      });

      const result = await new Promise<{ content: string; isError: boolean }>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pendingToolExecutions.delete(requestId)) {
            reject(new Error(`Tool execution request timed out after ${TOOL_EXECUTE_TIMEOUT_MS / 1000}s`));
          }
        }, TOOL_EXECUTE_TIMEOUT_MS);
        pendingToolExecutions.set(requestId, {
          resolve: (value) => { clearTimeout(timer); resolve(value); },
        });
      });

      return {
        content: [{ type: 'text', text: result.content }],
        details: result.isError ? { isError: true } : undefined,
      };
    },
  }));
}

// ============================================================
// LLM Query (ephemeral session for mini completions)
// ============================================================

async function queryLlm(request: LLMQueryRequest): Promise<LLMQueryResult> {
  if (!initConfig) throw new Error('Cannot run queryLlm: init not received');

  debugLog('[queryLlm] Starting');

  // Pick mini model. If the configured miniModel uses a different provider than
  // what the user authenticated with (e.g. gemini-2.5-pro when only anthropic
  // credentials exist), fall back to the default summarization model which uses
  // the same provider family.
  let model = request.model ?? initConfig.miniModel ?? getDefaultSummarizationModel();

  // Create authenticated registry upfront — used by both the provider guard and the ephemeral session.
  const { authStorage, modelRegistry } = createAuthenticatedRegistry();

  const piAuthProvider = initConfig.piAuth?.provider;

  // If piAuth is set, ensure the mini model uses the same provider.
  // Pi SDK will fail with "No API key found" if the model requires a different provider.
  // Exception: 'custom-endpoint' provider is always compatible because it has its own
  // API key configured via resolveCustomEndpointApiKey() and doesn't use authStorage.
  if (initConfig.piAuth) {
    const authProvider = initConfig.piAuth.provider;
    const bareModel = model.startsWith('pi/') ? model.slice(3) : model;
    const resolved = resolvePiModel(modelRegistry, bareModel, authProvider, shouldPreferCustomEndpoint());
    const resolvedProvider = (resolved as any)?.provider;
    const isCompatible = resolvedProvider === authProvider || resolvedProvider === 'custom-endpoint';
    if (!resolved || !isCompatible || isDeniedMiniModelId(model, piAuthProvider)) {
      // Anthropic: keep Haiku (the cheap/fast mini). For every other provider
      // Haiku is unresolvable, so walk PI_PREFERRED_DEFAULTS for a model that
      // actually works under the user's auth.
      const providerDefault = authProvider === 'anthropic'
        ? undefined
        : pickProviderAppropriateMiniModel(authProvider, modelRegistry, shouldPreferCustomEndpoint());
      const fallback = providerDefault ?? getDefaultSummarizationModel();
      debugLog(`[queryLlm] Model ${bareModel} incompatible with ${authProvider} (resolved: ${resolvedProvider}), falling back to ${fallback}`);
      model = fallback;
    }
  }

  const runQueryWithModel = async (modelId: string): Promise<string> => {
    debugLog(`[queryLlm] Using model: ${modelId}`);

    // Resolve model — fail fast if unresolvable so we don't let the Pi SDK
    // fall back to its own internal default (which may require a provider
    // the user hasn't authenticated with, surfacing as a misleading
    // "No API key found for <provider>" error).
    const piModel = resolvePiModel(modelRegistry, modelId, initConfig!.piAuth?.provider, shouldPreferCustomEndpoint());
    if (!piModel) {
      throw new Error(
        `Could not resolve mini model "${modelId}" for provider "${initConfig!.piAuth?.provider ?? '(unknown)'}"`,
      );
    }

    // Create minimal ephemeral session
    const ephemeralOptions: CreateAgentSessionOptions = {
      cwd: resolvedCwd(),
      authStorage,
      modelRegistry,
      tools: [],
      sessionManager: PiSessionManager.inMemory(),
      model: piModel,
      fetchInterceptor: resolveCraftFetchInterceptor(),
    };

    const { session: ephemeralSession } = await createAgentSession(ephemeralOptions);

    // Pi SDK ignores options.model for ephemeral sessions (same issue as options.tools).
    // Explicitly set the model after creation to ensure the mini model is used.
    try {
      await ephemeralSession.setModel(piModel);
    } catch {
      debugLog(`[queryLlm] Failed to set model on ephemeral session, proceeding with default`);
    }

    debugLog(`[queryLlm] Created ephemeral session: ${ephemeralSession.sessionId}`);

    // System prompt via Pi's public PromptOptions.systemPrompt (fork API);
    // passed at prompt() time below instead of monkey-patching session internals.
    const promptForSession =
      request.systemPrompt ?? 'Reply with ONLY the requested text. No explanation.';

    // Collect response text and errors from events
    let result = '';
    let lastError = '';
    let completionResolve: () => void;
    const completionPromise = new Promise<void>((resolve) => {
      completionResolve = resolve;
    });

    const unsub = ephemeralSession.subscribe((event: AgentSessionEvent) => {
      if (event.type === 'message_end') {
        // Only capture assistant messages — Pi SDK emits message_end for user messages too
        const msg = event.message as {
          role?: string;
          content?: string | Array<{ type: string; text?: string }>;
          stopReason?: string;
          errorMessage?: string;
        };
        if (msg.role !== 'assistant') return;

        // Capture API errors from message_end (e.g. auth failures, model errors)
        if (msg.stopReason === 'error' && msg.errorMessage) {
          lastError = msg.errorMessage;
          debugLog(`[queryLlm] API error in message_end: ${msg.errorMessage}`);
        }

        if (typeof msg.content === 'string') {
          result = msg.content;
        } else if (Array.isArray(msg.content)) {
          result = msg.content
            .filter((c) => c.type === 'text' && c.text)
            .map((c) => c.text!)
            .join('');
        }
      }
      if (event.type === 'agent_end') {
        completionResolve();
      }
    });

    try {
      await ephemeralSession.prompt(request.prompt, { systemPrompt: promptForSession });
      await withTimeout(
        completionPromise,
        LLM_QUERY_TIMEOUT_MS,
        `queryLlm timed out after ${LLM_QUERY_TIMEOUT_MS / 1000}s`
      );
      debugLog(`[queryLlm] Result length: ${result.trim().length}`);

      // If we got no text but captured an error, throw so callers see the real issue
      if (!result.trim() && lastError) {
        throw new Error(lastError);
      }

      return result.trim();
    } finally {
      unsub();
      ephemeralSession.dispose();
    }
  };

  const fallbackCandidates = [
    // Removed 'pi/gpt-5.1-codex-mini' (#596) — stale on several OpenAI catalogs.
    // The connection-configured miniModel is still tried via `initConfig.miniModel`.
    'pi/gpt-5-mini',
    initConfig.miniModel,
    getDefaultSummarizationModel(),
  ].filter((candidate): candidate is string => !!candidate && !isDeniedMiniModelId(candidate, piAuthProvider));

  const triedModels = new Set<string>();
  let currentModel = model;

  while (true) {
    triedModels.add(currentModel);
    try {
      const text = await runQueryWithModel(currentModel);
      return { text, model: currentModel };
    } catch (error) {
      const errorMsg = errorMessage(error);
      const shouldRetry = isModelNotFoundError(errorMsg);

      if (!shouldRetry) {
        throw error;
      }

      const retryModel = fallbackCandidates.find(candidate => {
        if (triedModels.has(candidate)) return false;
        try {
          const resolved = resolvePiModel(modelRegistry, candidate, initConfig!.piAuth?.provider, shouldPreferCustomEndpoint());
          if (!resolved) return false;
          if (initConfig!.piAuth) {
            const rp = (resolved as any).provider;
            if (rp !== initConfig!.piAuth.provider && rp !== 'custom-endpoint') {
              return false;
            }
          }
          return true;
        } catch {
          return false;
        }
      });

      if (!retryModel) {
        throw error;
      }

      debugLog(`[queryLlm] Model ${currentModel} not found, retrying with ${retryModel}`);
      currentModel = retryModel;
    }
  }
}

async function runMiniCompletion(prompt: string): Promise<string | null> {
  try {
    const result = await queryLlm({ prompt });
    const text = result.text || null;
    debugLog(`[runMiniCompletion] Result: ${text ? `"${text.slice(0, 200)}"` : 'null'}`);
    return text;
  } catch (error) {
    debugLog(`[runMiniCompletion] Failed: ${errorMessage(error)}`);
    return null;
  }
}

// ============================================================
// Event Handling
// ============================================================

function extractToolExecutionMetadata(args: Record<string, unknown> | undefined): ToolExecutionMetadata | undefined {
  if (!args) return undefined;

  const intent = typeof args._intent === 'string' ? args._intent : undefined;
  const displayName = typeof args._displayName === 'string' ? args._displayName : undefined;

  if (!intent && !displayName) return undefined;

  return {
    intent,
    displayName,
    source: 'interceptor',
  };
}

function handleSessionEvent(event: AgentSessionEvent): void {
  let forwardedEvent: OutboundAgentEvent = event;

  // Log API errors for debugging and attach provider-native turn anchor for branch cutoffs.
  if (event.type === 'message_end') {
    const msg = event.message as { role?: string; stopReason?: string; errorMessage?: string } | undefined;
    if (msg?.stopReason === 'error') {
      debugLog(`API error in message_end: ${msg.errorMessage || 'unknown'}`);
    }

    if (msg?.role === 'assistant' && piSession) {
      // CRITICAL: do NOT read `getLeafId()` here.
      //
      // The Pi SDK fires `message_end` synchronously BEFORE calling
      // `appendMessage(event.message)` (see `agent-session.js:_processAgentEvent`).
      // At this moment the assistant entry does not yet exist in the
      // SessionManager — `leafId` still points at the *previous* leaf, which for
      // a plain text turn is the user message that triggered the response.
      // Recording that wrong anchor and using it for `branch()` makes the next
      // turn a sibling of the assistant message, dropping the assistant reply
      // from the LLM's view of history (craft-agents-oss#782).
      //
      // Instead, attach the SDK's message id to the forwarded event so the main
      // process can correlate this turn, then queue a microtask to read the
      // correct leaf AFTER `appendMessage` has run. The microtask drains before
      // any subsequent SDK event is dispatched, so the follow-up
      // `pi_turn_anchor` event is delivered to the main process in the right
      // order (after this `message_end`, before the next event).
      const sdkMessageId = (msg as { id?: string }).id;
      // Forward the active model's contextWindow so the main-process event
      // adapter can compute usage percent even for models not in craft's local
      // MODEL_REGISTRY (custom-endpoint, pi-prefixed, OpenRouter, etc.).
      // Sourced here (not at session creation) so set_model mid-session is tracked.
      const modelContextWindow = piSession?.agent?.state?.model?.contextWindow;
      const enrich: Record<string, unknown> = {};
      if (sdkMessageId) enrich.sdkMessageId = sdkMessageId;
      if (typeof modelContextWindow === 'number') enrich.modelContextWindow = modelContextWindow;
      if (Object.keys(enrich).length > 0) {
        forwardedEvent = {
          ...(event as Record<string, unknown>),
          ...enrich,
        } as unknown as OutboundAgentEvent;
      }

      if (sdkMessageId) {
        const sessionManagerSnapshot = piSession.sessionManager;
        queueMicrotask(() => {
          // Defensive: session may have been disposed between the message_end
          // emit and the microtask drain.
          if (!piSession || piSession.sessionManager !== sessionManagerSnapshot) {
            return;
          }
          const sdkTurnAnchor = sessionManagerSnapshot.getLeafId();
          if (!sdkTurnAnchor) return;
			send({
				type: 'event',
				event: {
					type: 'pi_turn_anchor',
					sdkMessageId,
					sdkTurnAnchor,
				} as unknown as OutboundAgentEvent,
			});
		});
	}
    }

    if (msg?.role === 'user') {
      queueMicrotask(() => {
        send({
          type: 'event',
          event: {
            type: 'pi_user_message_persisted',
          } as unknown as OutboundAgentEvent,
        });
      });
    }
  }

  // Detect session MCP tool completions + enrich tool starts with canonical metadata
  if (event.type === 'tool_execution_start') {
    const toolName = event.toolName;
    if (toolName.startsWith('session__') || toolName.startsWith('mcp__session__')) {
      const mcpToolName = toolName.replace(/^(mcp__session__|session__)/, '');
      pendingSessionToolCalls.set(event.toolCallId, {
        toolName: mcpToolName,
        arguments: (event.args ?? {}) as Record<string, unknown>,
      });
    }

    const toolMetadata = extractToolExecutionMetadata((event.args ?? {}) as Record<string, unknown>);
    if (toolMetadata) {
      forwardedEvent = {
        ...event,
        toolMetadata,
      };
    }
  }

  if (event.type === 'tool_execution_end') {
    const pending = pendingSessionToolCalls.get(event.toolCallId);
    if (pending) {
      pendingSessionToolCalls.delete(event.toolCallId);
      send({
        type: 'session_tool_completed',
        toolName: pending.toolName,
        args: pending.arguments,
        isError: !!event.isError,
      });
    }
  }

  // Forward all events to main process
  send({ type: 'event', event: forwardedEvent });
}

// ============================================================
// Command Handlers
// ============================================================

async function handleInit(msg: Extract<InboundMessage, { type: 'init' }>): Promise<void> {
  // Clean up any existing session from a previous init
  if (piSession) {
    if (unsubscribeEvents) {
      unsubscribeEvents();
      unsubscribeEvents = null;
    }
    if (unsubscribeExtensionEvents) {
      unsubscribeExtensionEvents();
      unsubscribeExtensionEvents = null;
    }
    extensionEventBus = null;
    piSession.dispose();
    piSession = null;
    moduleAuthStorage = null; // Reset so createAuthenticatedRegistry() creates fresh storage
    debugLog('Cleaned up existing session for re-init');
  }

  initConfig = msg;

  // Azure OpenAI requires a tenant-specific endpoint URL.
  // The Pi SDK (via Vercel AI SDK) reads AZURE_OPENAI_BASE_URL from env.
  if (msg.piAuth?.provider === 'azure-openai-responses' && msg.baseUrl) {
    process.env.AZURE_OPENAI_BASE_URL = msg.baseUrl;
    debugLog(`Set AZURE_OPENAI_BASE_URL=${msg.baseUrl}`);
  }

  send({
    type: 'ready',
    sessionId: null,
  });
}

/**
 * Wait for any in-flight compaction to finish before sending a prompt or
 * starting another compaction. Prevents a race in the Pi SDK where concurrent
 * _runAutoCompaction calls crash on a shared AbortController
 * (see craft-agents-oss#464). Default timeout matches the RPC compact timeout
 * in PiAgent.requestCompact (300 s), since GPT compactions can legitimately
 * take 60–120 s.
 */
async function waitForCompaction(session: { isCompacting: boolean }, timeoutMs = 300_000): Promise<void> {
  if (!session.isCompacting) return;
  debugLog('Waiting for in-flight compaction to finish before prompt...');
  const start = Date.now();
  while (session.isCompacting) {
    if (Date.now() - start > timeoutMs) {
      debugLog(`Compaction wait timed out after ${Math.floor(timeoutMs / 1000)}s, proceeding anyway`);
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (Date.now() - start < timeoutMs) {
    debugLog('Compaction finished, proceeding with prompt');
  }
}

async function handlePrompt(msg: Extract<InboundMessage, { type: 'prompt' }>): Promise<void> {
  currentUserMessage = msg.message;

  try {
    // If proxy tools changed since last session creation, dispose and recreate.
    // This avoids calling _buildRuntime() for dynamic tool updates — instead
    // we create a fresh session via continueRecent() with all tools known upfront.
    if (toolsChanged && piSession) {
      debugLog('Recreating session due to tool changes');
      if (unsubscribeEvents) {
        unsubscribeEvents();
        unsubscribeEvents = null;
      }
      piSession.dispose();
      piSession = null;
    }

    const session = await ensureSession();

    // Wire up event handler
    if (unsubscribeEvents) {
      unsubscribeEvents();
    }
    unsubscribeEvents = session.subscribe(handleSessionEvent);

    // Wait for any in-flight auto-compaction to avoid race (craft-agents-oss#464)
    await waitForCompaction(session);

    // Fire prompt — use followUp when session is already streaming so the
    // message is queued instead of throwing "Agent is already processing".
    // systemPrompt: Pi's public PromptOptions.systemPrompt (fork API) replaces
    // the old three-field monkey-patch; it survives the SDK's per-turn reset
    // and refreshSystemPrompt() rebuilds natively.
    await session.prompt(msg.message, {
      images: msg.images && msg.images.length > 0 ? msg.images : undefined,
      streamingBehavior: 'followUp',
      ...(msg.systemPrompt ? { systemPrompt: msg.systemPrompt } : {}),
    });
  } catch (error) {
    const errorMsg = errorMessage(error);

    // No wrapper-side overflow recovery here. The Pi SDK's _checkCompaction
    // already runs `_runAutoCompaction("overflow", true)` on overflow and
    // calls agent.continue() to retry once. Running our own session.compact()
    // in parallel raced against the SDK and is the documented cause of the
    // AbortController crash in `_runAutoCompaction` (see
    // plans/fix-pi-gpt-compaction.md). PiEventAdapter holds the Craft event
    // queue open across the SDK's recovery flow so the recovered turn
    // reaches the UI.

    debugLog(`Prompt failed: ${errorMsg}`);
    send({ type: 'error', message: errorMsg, code: 'prompt_error' });
    // Send synthetic agent_end so the main process event queue unblocks.
    // willRetry: false — this is the terminal error path, no retry follows.
    send({ type: 'event', event: { type: 'agent_end', messages: [], willRetry: false } });
  }
}

function handleRegisterTools(msg: Extract<InboundMessage, { type: 'register_tools' }>): void {
  // Merge: replace existing tools by name, add new ones
  const incoming = new Map(msg.tools.map(t => [t.name, t]));
  proxyToolDefs = [
    ...proxyToolDefs.filter(t => !incoming.has(t.name)),
    ...msg.tools,
  ];
  debugLog(`Registered ${msg.tools.length} proxy tools (total: ${proxyToolDefs.length}): ${msg.tools.map(t => t.name).join(', ')}`);

  // If session exists, mark for recreation on next prompt.
  // Don't dispose mid-generation — the flag is checked in handlePrompt().
  if (piSession) {
    toolsChanged = true;
    debugLog('Proxy tools changed — session will be recreated on next prompt');
  }
}

function handleToolExecuteResponse(msg: Extract<InboundMessage, { type: 'tool_execute_response' }>): void {
  const pending = pendingToolExecutions.get(msg.requestId);
  if (pending) {
    pendingToolExecutions.delete(msg.requestId);
    pending.resolve(msg.result);
  } else {
    debugLog(`No pending tool execution for requestId: ${msg.requestId}`);
  }
}

function handlePreToolUseResponse(msg: Extract<InboundMessage, { type: 'pre_tool_use_response' }>): void {
  const pending = pendingPreToolUse.get(msg.requestId);
  if (pending) {
    pendingPreToolUse.delete(msg.requestId);
    pending.resolve({ action: msg.action, input: msg.input, reason: msg.reason });
  } else {
    debugLog(`No pending pre_tool_use for requestId: ${msg.requestId}`);
  }
}

async function handleAbort(): Promise<void> {
  if (piSession) {
    try {
      await piSession.abort();
    } catch (error) {
      debugLog(`Abort failed: ${errorMessage(error)}`);
    }
  }

  // Reject all pending pre-tool-use requests
  for (const [, pending] of pendingPreToolUse) {
    pending.resolve({ action: 'block', reason: 'Aborted' });
  }
  pendingPreToolUse.clear();
}

/**
 * Wrap a message handler with standardized error handling.
 * Catches errors, logs them via debugLog, and sends an error result.
 *
 * By default sends `{ type: resultType, id: msg.id, success: false, errorMessage, ...extraErrorFields }`.
 * Pass `onError` to override the error send (e.g. for `type: 'error'` with a code).
 */
function wrapHandler<TMsg extends { id: string }>(
  tag: string,
  resultType: string,
  msg: TMsg,
  fn: () => Promise<void> | void,
  options?: {
    extraErrorFields?: Record<string, unknown>;
    onError?: (errorMsg: string) => void;
  },
): Promise<void> {
  return Promise.resolve()
    .then(() => fn())
    .catch((error) => {
      const errorMsg = error instanceof Error ? error.message : String(error);
      debugLog(`[${tag}] Failed: ${errorMsg}`);
      if (options?.onError) {
        options.onError(errorMsg);
        return;
      }
      send({
        type: resultType,
        id: msg.id,
        success: false,
        errorMessage: errorMsg,
        ...(options?.extraErrorFields ?? {}),
      } as OutboundMessage);
    });
}

/**
 * Wrap a handler with error logging only (no error result sent).
 * Catches errors and logs them via debugLog.
 */
function withErrorLog(tag: string, fn: () => Promise<void> | void): Promise<void> {
  return Promise.resolve()
    .then(() => fn())
    .catch((error) => {
      const errorMsg = error instanceof Error ? error.message : String(error);
      debugLog(`[${tag}] Failed: ${errorMsg}`);
    });
}

async function handleMiniCompletion(msg: Extract<InboundMessage, { type: 'mini_completion' }>): Promise<void> {
  // Call queryLlm directly (not runMiniCompletion) so auth errors propagate
  // as 'error' messages instead of being swallowed and returned as null.
  // runMiniCompletion is kept for the summarize callback where null is acceptable.
  await wrapHandler('handleMiniCompletion', 'mini_completion_result', msg, async () => {
    const result = await queryLlm({ prompt: msg.prompt });
    send({ type: 'mini_completion_result', id: msg.id, text: result.text || null });
  }, { onError: (e) => send({ type: 'error', message: e, code: 'mini_completion_error' }) });
}

// INVARIANT: the full LLMQueryRequest shape must pass through this RPC unchanged.
// Adding a field to LLMQueryRequest? Nothing to do here — we pass `msg.request`
// to queryLlm() verbatim. But verify queryLlm() actually honors the new field;
// request-propagation + request-honoring are independent (see #596).
async function handleLlmQuery(msg: Extract<InboundMessage, { type: 'llm_query' }>): Promise<void> {
  await wrapHandler('handleLlmQuery', 'llm_query_result', msg, async () => {
    const result = await queryLlm(msg.request);
    send({ type: 'llm_query_result', id: msg.id, result });
  }, {
    // Dual-emit: the generic `error` channel drives main-process OAuth
    // auth-refresh detection (centralized in PiAgent), while the targeted
    // `llm_query_result` rejects the pending promise for this specific call.
    onError: (e) => {
      send({ type: 'error', message: e, code: 'llm_query_error' });
      send({ type: 'llm_query_result', id: msg.id, result: null, errorMessage: e, errorCode: 'llm_query_error' });
    },
  });
}

async function handleEnsureSessionReady(msg: Extract<InboundMessage, { type: 'ensure_session_ready' }>): Promise<void> {
  const session = await ensureSession();
  send({
    type: 'ensure_session_ready_result',
    id: msg.id,
    sessionId: session.sessionId || null,
  });
}

async function handleCompact(msg: Extract<InboundMessage, { type: 'compact' }>): Promise<void> {
  await wrapHandler('compact', 'compact_result', msg, async () => {
    const session = await ensureSession();
    // Serialize manual /compact behind any in-flight auto-compaction. Public
    // session.compact() calls agent.abort() and uses its own controller; if
    // it runs while _runAutoCompaction is suspended, agent state churns and
    // the SDK's race surface widens. Wait for the auto-compaction to drain
    // before starting a manual one. waitForCompaction has its own timeout
    // fallback so we don't deadlock on a stuck subprocess.
    await waitForCompaction(session);
    const result = await session.compact(msg.customInstructions);
    send({
      type: 'compact_result',
      id: msg.id,
      success: true,
      result: {
        summary: result.summary,
        firstKeptEntryId: result.firstKeptEntryId,
        tokensBefore: result.tokensBefore,
      },
    });
  });
}

async function handleSetAutoCompaction(msg: Extract<InboundMessage, { type: 'set_auto_compaction' }>): Promise<void> {
  await wrapHandler('set_auto_compaction', 'set_auto_compaction_result', msg, async () => {
    const session = await ensureSession();
    session.setAutoCompactionEnabled(msg.enabled);
    send({
      type: 'set_auto_compaction_result',
      id: msg.id,
      success: true,
      enabled: session.autoCompactionEnabled,
    });
  }, { extraErrorFields: { enabled: msg.enabled } });
}

async function handleUpdateRuntimeConfig(msg: RuntimeConfigUpdateMessage): Promise<void> {
  await wrapHandler('runtime_config', 'update_runtime_config_result', msg, async () => {
    if (!initConfig) {
      throw new Error('Runtime config update received before init');
    }

    initConfig = {
      ...initConfig,
      model: msg.model,
      providerType: msg.providerType ?? initConfig.providerType,
      authType: msg.authType ?? initConfig.authType,
      baseUrl: msg.baseUrl,
      customEndpoint: msg.customEndpoint,
      customModels: msg.customModels,
    };

    if (piModelRegistry && initConfig.baseUrl?.trim() && initConfig.customEndpoint) {
      const modelEntries: CustomEndpointModelEntry[] = (initConfig.customModels?.length
        ? initConfig.customModels
        : [initConfig.model || 'default']
      ).map(normalizeCustomEndpointModelEntry);

      customEndpointModelIds = new Set();
      customModelOverrides.clear();
      registerCustomEndpointModels(piModelRegistry, initConfig.customEndpoint.api, initConfig.baseUrl.trim(), modelEntries);
    }

    if (piSession && piModelRegistry) {
      let piModel = resolvePiModel(piModelRegistry, msg.model, initConfig.piAuth?.provider, shouldPreferCustomEndpoint());
      if (!piModel && initConfig.baseUrl?.trim() && initConfig.customEndpoint) {
        const bareId = stripPiPrefix(msg.model);
        registerCustomEndpointModels(piModelRegistry, initConfig.customEndpoint.api, initConfig.baseUrl.trim(), [{ id: bareId }]);
        piModel = piModelRegistry.find('custom-endpoint', bareId) ?? undefined;
        debugLog(`[runtime_config] Dynamically registered custom endpoint model: ${bareId}`);
      }

      if (!piModel) {
        throw new Error(`Could not resolve model after runtime update: ${msg.model}`);
      }

      await piSession.setModel(piModel);
      setInterceptorApiHints(piModel as { api?: string; provider?: string; baseUrl?: string });
      debugLog(`[runtime_config] Updated runtime config and active model: ${piModel.provider}/${piModel.id}`);
    } else {
      debugLog('[runtime_config] Stored update; no active session/model registry yet');
    }

    send({ type: 'update_runtime_config_result', id: msg.id, success: true, updated: true });
  }, { extraErrorFields: { updated: false } });
}

async function handleSetModel(msg: Extract<InboundMessage, { type: 'set_model' }>): Promise<void> {
  debugLog(`[set_model] Received: ${msg.model}`);
  if (!piSession || !piModelRegistry) {
    debugLog(`[set_model] No active session or model registry, ignoring`);
    return;
  }
  let piModel = resolvePiModel(piModelRegistry, msg.model, initConfig?.piAuth?.provider, shouldPreferCustomEndpoint());

  // For custom endpoints, dynamically register unknown models so mid-session switching works.
  // Uses registerCustomEndpointModels which accumulates into the existing model set
  // (registerProvider replaces, so we track all IDs and re-register the full set).
  if (!piModel && initConfig?.baseUrl?.trim() && initConfig?.customEndpoint) {
    const bareId = stripPiPrefix(msg.model);
    registerCustomEndpointModels(piModelRegistry, initConfig.customEndpoint.api, initConfig.baseUrl!.trim(), [{ id: bareId }]);
    piModel = piModelRegistry.find('custom-endpoint', bareId) ?? undefined;
    debugLog(`[set_model] Dynamically registered custom endpoint model: ${bareId}`);
  }

  if (!piModel) {
    debugLog(`[set_model] Could not resolve model: ${msg.model}`);
    setInterceptorApiHints(undefined);
    return;
  }
  const session = piSession;
  await withErrorLog('set_model', async () => {
    await session.setModel(piModel);
    setInterceptorApiHints(piModel as { api?: string; provider?: string; baseUrl?: string });
    debugLog(`[set_model] Model changed to: ${msg.model} (resolved: ${piModel.provider}/${piModel.id})`);
  });
}

async function handleSetThinkingLevel(msg: Extract<InboundMessage, { type: 'set_thinking_level' }>): Promise<void> {
  debugLog(`[set_thinking_level] Received: ${msg.level}`);

  if (!piSession) {
    debugLog('[set_thinking_level] No active session, ignoring');
    return;
  }

  const piLevel = THINKING_TO_PI[msg.level as keyof typeof THINKING_TO_PI];
  if (!piLevel) {
    debugLog(`[set_thinking_level] No Pi mapping for level: ${msg.level}`);
    return;
  }

  const session = piSession;
  await withErrorLog('set_thinking_level', () => {
    session.setThinkingLevel(piLevel);
    debugLog(`[set_thinking_level] Thinking level changed to: ${msg.level} (mapped: ${piLevel})`);
  });
}

async function handleExtensionCommandInvoke(
  msg: Extract<InboundMessage, { type: 'extension_command_invoke' }>,
): Promise<void> {
  if (!piSession) {
    debugLog(`[extension-bridge] command ignored — no active session (${msg.commandId})`);
    return;
  }

  const runner = (piSession as any).extensionRunner;
  if (!runner || typeof runner.getCommand !== 'function' || typeof runner.createCommandContext !== 'function') {
    debugLog(`[extension-bridge] command ignored — extension runner is unavailable (${msg.commandId})`);
    return;
  }

  const command = runner.getCommand(msg.commandId);
  if (!command || typeof command.handler !== 'function') {
    debugLog(`[extension-bridge] command not found: ${msg.commandId}`);
    return;
  }

  try {
    const ctx = runner.createCommandContext();
    await command.handler(msg.args ?? '', ctx);
    debugLog(`[extension-bridge] command executed: ${msg.commandId}`);
  } catch (error) {
    debugLog(`[extension-bridge] command failed (${msg.commandId}): ${errorMessage(error)}`);
  }
}

/**
 * Handle spawn_child_session: delegate to pi's SessionManager.spawnChildSession()
 * to create a child session branch in pi's session tree.
 */
async function handleSpawnChildSession(
  msg: Extract<InboundMessage, { type: 'spawn_child_session' }>,
): Promise<void> {
  await wrapHandler('spawn_child_session', 'spawn_child_session_result', msg, async () => {
    const session = await ensureSession();
    const sessionManager = session.sessionManager as unknown as {
      spawnChildSession(
        parentSessionId: string,
        options: SpawnChildSessionOptionsPayload,
      ): Promise<{ sessionId: string; sessionPath: string }>;
    };

    const result = await sessionManager.spawnChildSession(
      msg.parentSessionId,
      msg.options,
    );

    send({
      type: 'spawn_child_session_result',
      id: msg.id,
      success: true,
      sessionId: result.sessionId,
      sessionPath: result.sessionPath,
    });
  });
}

/**
 * Handle list_child_sessions: query pi's session tree for child sessions
 * spawned from the given parent session ID (filtered by spawnedFrom field).
 */
async function handleListChildSessions(
  msg: Extract<InboundMessage, { type: 'list_child_sessions' }>,
): Promise<void> {
  await wrapHandler('list_child_sessions', 'list_child_sessions_result', msg, async () => {
    await ensureSession();
    const childSessions: OutboundChildSessionInfo[] = listSpawnedChildSessions(msg.parentSessionId)
      .map((session) => ({
        type: 'child_session_info',
        sessionId: session.sessionId,
        sessionPath: session.sessionPath,
        name: session.name,
        cwd: session.cwd,
        created: session.created,
        modified: session.modified,
        messageCount: session.messageCount,
        firstMessage: session.firstMessage,
        spawnConfig: session.spawnConfig,
      }));

    send({
      type: 'list_child_sessions_result',
      id: msg.id,
      success: true,
      sessions: childSessions,
    });
  }, { extraErrorFields: { sessions: [] } });
}

function handleShutdown(): void {
  debugLog('Shutdown requested');

  // Unsubscribe events
  if (unsubscribeEvents) {
    unsubscribeEvents();
    unsubscribeEvents = null;
  }

  // 清理扩展事件桥接订阅
  if (unsubscribeExtensionEvents) {
    unsubscribeExtensionEvents();
    unsubscribeExtensionEvents = null;
  }
  extensionEventBus = null;

  // Dispose session
  if (piSession) {
    piSession.dispose();
    piSession = null;
  }

  // Reject pending promises
  for (const [, pending] of pendingPreToolUse) {
    pending.resolve({ action: 'block', reason: 'Server shutting down' });
  }
  pendingPreToolUse.clear();

  for (const [, pending] of pendingToolExecutions) {
    pending.resolve({ content: 'Server shutting down', isError: true });
  }
  pendingToolExecutions.clear();

  process.exit(0);
}

// ============================================================
// Main JSONL Reader Loop
// ============================================================

async function processMessage(msg: InboundMessage): Promise<void> {
  switch (msg.type) {
    case 'init':
      await handleInit(msg);
      break;

    case 'prompt':
      await handlePrompt(msg);
      break;

    case 'register_tools':
      handleRegisterTools(msg);
      break;

    case 'tool_execute_response':
      handleToolExecuteResponse(msg);
      break;

    case 'pre_tool_use_response':
      handlePreToolUseResponse(msg);
      break;

    case 'abort':
      await handleAbort();
      break;

    case 'mini_completion':
      await handleMiniCompletion(msg);
      break;

    case 'llm_query':
      await handleLlmQuery(msg);
      break;

    case 'ensure_session_ready':
      await handleEnsureSessionReady(msg);
      break;

    case 'set_model':
      await handleSetModel(msg);
      break;

    case 'set_thinking_level':
      await handleSetThinkingLevel(msg);
      break;

    case 'compact':
      await handleCompact(msg);
      break;

    case 'set_auto_compaction':
      await handleSetAutoCompaction(msg);
      break;

    case 'update_runtime_config':
      await handleUpdateRuntimeConfig(msg);
      break;

    case 'steer':
      if (piSession) {
        debugLog(`Steering with: "${msg.message.slice(0, 100)}"`);
        await piSession.steer(msg.message);
      } else {
        debugLog('Steer ignored — no active session');
      }
      break;

    case 'token_update':
      if (moduleAuthStorage) {
        const { provider, credential } = msg.piAuth;
        // See ambient comment at the initial `authStorage.set` call — same shape reason.
        moduleAuthStorage.set(provider, credential as unknown as AuthCredential);
        if (initConfig) {
          initConfig.piAuth = msg.piAuth;
        }
        debugLog(`Updated ${credential.type} credential for provider: ${provider}`);
      } else {
        debugLog('token_update received but no authStorage initialized');
      }
      break;

    case 'remoteui_response': {
      // 主进程回复 remoteui:request — 在 EventBus 上发射 remoteui:response 或 remoteui:cancel
      if (!extensionEventBus) {
        debugLog('[extension-bridge] remoteui_response 收到但无活跃 EventBus');
        break;
      }
      if (msg.payload === null) {
        // 取消：发射 remoteui:cancel
        extensionEventBus.emit('remoteui:cancel', { requestId: msg.requestId });
        debugLog(`[extension-bridge] 已发射 remoteui:cancel (requestId: ${msg.requestId}, reason: ${msg.reason ?? 'cancelled'})`);
      } else {
        extensionEventBus.emit('remoteui:response', {
          requestId: msg.requestId,
          payload: msg.payload,
          reason: msg.reason,
        });
        debugLog(`[extension-bridge] 已发射 remoteui:response (requestId: ${msg.requestId})`);
      }
      break;
    }

    case 'extension_command_invoke':
      await handleExtensionCommandInvoke(msg);
      break;

    case 'spawn_child_session':
      await handleSpawnChildSession(msg);
      break;

    case 'list_child_sessions':
      await handleListChildSessions(msg);
      break;

    case 'shutdown':
      handleShutdown();
      break;

    default:
      debugLog(`Unknown message type: ${(msg as any).type}`);
  }
}

function main(): void {
  debugLog('Pi agent server starting');

  const rl = createInterface({ input: process.stdin });

  rl.on('line', (line: string) => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line) as InboundMessage;
      processMessage(msg).catch((error) => {
        const errorMsg = errorMessage(error);
        debugLog(`Error processing message: ${errorMsg}`);
        send({ type: 'error', message: errorMsg });
      });
    } catch (parseError) {
      debugLog(`Failed to parse JSONL: ${parseError}`);
    }
  });

  rl.on('close', () => {
    debugLog('stdin closed, shutting down');
    handleShutdown();
  });

  // Handle unexpected errors — process state is unreliable after these,
  // so we attempt to report and then exit immediately.
  // send() is wrapped in try/catch because stdout itself may be broken
  // (e.g. EFAULT from a closed pipe), and we must not let the error
  // report trigger another uncaughtException (which would loop).
  process.on('uncaughtException', (error) => {
    debugLog(`Uncaught exception: ${error.message}`);
    try {
      send({ type: 'error', message: `Uncaught exception: ${error.message}`, code: 'uncaught' });
    } catch {
      // stdout may be broken — swallow to avoid re-triggering
    }
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    const msg = errorMessage(reason);
    debugLog(`Unhandled rejection: ${msg}`);
    try {
      send({ type: 'error', message: `Unhandled rejection: ${msg}`, code: 'unhandled_rejection' });
    } catch {
      // stdout may be broken — swallow to avoid re-triggering
    }
    process.exit(1);
  });
}

main();
