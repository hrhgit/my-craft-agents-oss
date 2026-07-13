import { beforeEach, describe, expect, it, mock } from 'bun:test'

const workspaceRootPath = '/tmp/ws-rollback'
const workspace = {
  id: 'ws-1',
  name: 'Workspace',
  rootPath: workspaceRootPath,
}

let idCounter = 0
const storedById = new Map<string, any>()
const deletedIds: string[] = []
let appendFailure: Error | null = null
let appendedMessages: any[] = []

// Partial-mock baseline: import real modules via file paths (avoids recursive mock imports)
const actualSharedAgentModule = await import('../../../../../packages/shared/src/agent/index.ts')
const actualSharedAgentBackendModule = await import('../../../../../packages/shared/src/agent/backend/index.ts')
// 真实的 Craft metadata fields 和 pickSessionFields，避免 mock 字段列表与实际不同步
const actualSessionUtils = await import('../../../../../packages/shared/src/sessions/utils.ts')

mock.module('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    dock: { setIcon: () => {}, setBadge: () => {} },
    setBadgeCount: () => {},
  },
  nativeImage: {
    createFromPath: () => ({ isEmpty: () => true }),
    createFromDataURL: () => ({}),
  },
  Notification: class {
    static isSupported() { return false }
    on() {}
    show() {}
  },
  BrowserWindow: {
    getAllWindows: () => [],
    getFocusedWindow: () => null,
  },
}))

mock.module('@sentry/electron/main', () => ({
  captureException: () => {},
}))

mock.module('../logger', () => {
  const stubLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
  return {
    mainLog: stubLog,
    sessionLog: stubLog,
    handlerLog: stubLog,
    windowLog: stubLog,
    agentLog: stubLog,
    searchLog: stubLog,
    isDebugMode: false,
    getLogFilePath: () => '/tmp/main.log',
  }
})

mock.module('@craft-agent/shared/config', () => ({
  getWorkspaceByNameOrId: (id: string) => (id === workspace.id ? workspace : null),
  getWorkspaces: () => [workspace],
  loadConfigDefaults: () => ({
    workspaceDefaults: {
      permissionMode: 'ask',
      thinkingLevel: 'medium',
    },
  }),
  readPiGlobalProviders: () => ({}),
  readPiGlobalSettings: () => ({}),
  getToolIconsDir: () => '/tmp/tool-icons',
  getMiniModel: () => 'claude-haiku-4-5-20251001',
  getDefaultThinkingLevel: () => 'medium',
  ConfigWatcher: class ConfigWatcher {
    constructor(..._args: unknown[]) {}
    start() {}
    stop() {}
  },
  MODEL_REGISTRY: [],
  // Targeted stubs: prevent SyntaxError in tests that import these from the barrel
  DEFAULT_MODEL: 'claude-sonnet-4-20250514',
  DEFAULT_THEME: { mode: 'system' },
  getDefaultModelsForConnection: () => ({ default: 'claude-sonnet-4-20250514', mini: 'claude-haiku-4-5-20251001' }),
  getDefaultModelForConnection: () => 'claude-sonnet-4-20250514',
  setGitBashPath: () => {},
  clearGitBashPath: () => {},
  setActiveWorkspace: () => {},
  getSummarizationModel: () => 'claude-haiku-4-5-20251001',
  ensureConfigDir: () => {},
  ensureConfigDefaults: () => {},
  addWorkspace: async () => null,
  getAllSessionDrafts: () => [],
  getGitBashPath: () => null,
  // Handler-required stubs: prevent SyntaxError in handler modules loaded by registration test
  getPreferencesPath: () => '/tmp/preferences.json',
  getSessionDraft: () => null,
  setSessionDraft: async () => {},
  deleteSessionDraft: async () => {},
}))

mock.module('@craft-agent/shared/workspaces', () => ({
  loadWorkspaceConfig: () => ({
    defaults: {
      permissionMode: 'ask',
      thinkingLevel: 'medium',
      provider: undefined,
    },
  }),
}))

mock.module('@craft-agent/shared/agent', () => ({
  ...actualSharedAgentModule,
  setPermissionMode: () => {},
  getPermissionModeDiagnostics: () => ({ mode: 'ask', source: 'test' }),
  unregisterSessionScopedToolCallbacks: () => {},
  mergeSessionScopedToolCallbacks: () => {},
  hydratePreviousPermissionMode: () => {},
  initializeModeState: () => {},
  cleanupModeState: () => {},
  getPermissionMode: () => 'ask',
  registerSessionScopedToolCallbacks: () => {},
  cleanupSessionScopedTools: () => {},
  getSessionScopedTools: () => [],
  normalizeCanonicalBrowserToolName: (name: string) => name,
}))

mock.module('@craft-agent/shared/agent/backend', () => ({
  ...actualSharedAgentBackendModule,
  resolveSessionProvider: () => null,
  createBackendFromProvider: () => {
    throw new Error('not used in this test')
  },
  resolveBackendContext: () => ({
    provider: 'pi',
    resolvedModel: 'pi/gpt-5',
    connection: { providerType: 'pi' as const },
  }),
  createBackendFromResolvedContext: () => {
    throw new Error('not used in this test')
  },
  cleanupSourceRuntimeArtifacts: async () => {},
  AGENT_PROVIDER: 'pi' as const,
  fetchBackendModels: async () => ({ models: [] }),
  initializeBackendHostRuntime: () => {},
  resolveBackendHostTooling: () => ({
    sourceCredentialManager: null,
    sourceServerBuilder: null,
    sourcePoolFactory: null,
    sourcePoolServerFactory: null,
  }),
  testBackendConnection: async () => ({ success: false, error: 'stub' }),
  validateStoredBackendConnection: async () => ({ success: false, error: 'stub' }),
}))

mock.module('@craft-agent/shared/sources', () => ({
  loadWorkspaceSources: () => [],
  loadAllSources: () => [],
  getSourcesBySlugs: () => [],
  isSourceUsable: () => true,
  getSourcesNeedingAuth: () => [],
  getSourceCredentialManager: () => ({
    getCredentialStatus: async () => ({ status: 'ready' }),
  }),
  getSourceServerBuilder: () => ({ buildServers: async () => ({ mcpServers: {}, apiServers: {} }) }),
  isApiOAuthProvider: () => false,
  SERVER_BUILD_ERRORS: {},
  TokenRefreshManager: class TokenRefreshManager {
    constructor(_mgr: unknown, _opts: unknown) {}
  },
  createTokenGetter: () => async () => null,
  // Targeted stubs: prevent SyntaxError in tests that import these from the barrel
  loadSource: () => null,
  API_OAUTH_PROVIDERS: [],
}))

mock.module('@craft-agent/shared/automations', () => ({
  AutomationSystem: class AutomationSystem {
    constructor(..._args: unknown[]) {}
    setInitialSessionMetadata() {}
    reloadConfig() { return { errors: [], automationCount: 0 } }
  },
  validateAutomationsConfig: () => ({ valid: true, errors: [], config: { automations: {} } }),
  validateAutomationsContent: () => ({ valid: true, errors: [], warnings: [] }),
  validateAutomations: () => ({ valid: true, errors: [], warnings: [] }),
  AUTOMATIONS_CONFIG_FILE: 'automations.json',
  AUTOMATIONS_HISTORY_FILE: 'automations.history.jsonl',
}))

mock.module('@craft-agent/shared/sessions', () => ({
  listSessions: () => [],
  loadSession: (_root: string, id: string) => storedById.get(id) ?? null,
  saveSession: async (session: any) => {
    // 兼容新格式（craftId）与旧格式（id）
    const key = session.craftId ?? session.id
    storedById.set(key, session)
  },
  createSession: async (_root: string, opts: any) => {
    const id = `child-${++idCounter}`
    const now = Date.now()
    const session = {
      // 新格式用 craftId，旧测试逻辑用 id。两者设为同值以兼容。
      id,
      craftId: id,
      name: opts?.name ?? null,
      messages: [],
      permissionMode: opts?.permissionMode ?? 'ask',
      workingDirectory: opts?.workingDirectory,
      hidden: !!opts?.hidden,
      createdAt: now,
      lastUsedAt: now,
      workspaceRootPath: workspaceRootPath,
    }
    storedById.set(id, session)
    return session
  },
  deleteSession: async (_root: string, id: string) => {
    deletedIds.push(id)
    storedById.delete(id)
  },
  updateSessionMetadata: async () => {},
  canUpdateSdkCwd: () => false,
  setPendingPlanExecution: async () => {},
  markCompactionComplete: async () => {},
  clearPendingPlanExecution: async () => {},
  getPendingPlanExecution: async () => null,
  getSessionAttachmentsPath: () => '/tmp/attachments',
  getSessionPath: (_root: string, id: string) => `${workspaceRootPath}/sessions/${id}`,
  getSessionFilePath: (_root: string, id: string) => `${workspaceRootPath}/${id}.jsonl`,
  findPiSessionProjectionById: async (_root: string, id: string) => {
    const source = storedById.get(id)
    if (!source) return null
    const entries = source.messages.map((message: any, index: number) => ({
      type: 'message',
      id: message.id,
      parentId: index > 0 ? source.messages[index - 1]!.id : null,
      timestamp: new Date(message.timestamp).toISOString(),
      message: {
        role: message.type,
        content: [{ type: 'text', text: message.content }],
        timestamp: message.timestamp,
      },
    }))
    return {
      header: {
        type: 'session',
        version: 3,
        id,
        timestamp: new Date(source.createdAt).toISOString(),
        cwd: workspaceRootPath,
        craft: { id },
      },
      path: `${workspaceRootPath}/${id}.jsonl`,
      cwd: workspaceRootPath,
      leafId: entries.at(-1)?.id ?? null,
      entries,
    }
  },
  projectTreeSessionProjectionAsStoredSession: (projection: any, options: { leafId?: string }) => {
    const source = storedById.get(projection.header.craft.id)
    const index = source?.messages.findIndex((message: any) => message.id === options.leafId) ?? -1
    return source && index >= 0 ? { ...source, messages: source.messages.slice(0, index + 1) } : null
  },
  appendStoredMessagesViaPiSessionManager: (_file: string, _dir: string, _cwd: string, messages: any[]) => {
    return new Map(messages.map(message => [message.id, `pi-${message.id}`]))
  },
  appendPiBranchMessagesViaSessionManager: (_file: string, _dir: string, _cwd: string, entries: any[]) => {
    if (appendFailure) throw appendFailure
    appendedMessages = entries
    return new Map(entries.map(entry => [entry.id, `pi-${entry.id}`]))
  },
  getOrCreateLatestSession: async () => null,
  sessionPersistenceQueue: { flush: async () => {} },
  // 使用真实实现，避免手工维护字段列表与 Craft metadata fields 不同步
  pickSessionFields: actualSessionUtils.pickSessionFields,
  validateSessionId: () => true,
}))

const { SessionManager } = await import('@craft-agent/server-core/sessions')

describe('Pi projection branch creation', () => {
  beforeEach(() => {
    idCounter = 0
    storedById.clear()
    deletedIds.length = 0
    appendFailure = null
    appendedMessages = []

    storedById.set('source-1', {
      id: 'source-1',
      workspaceRootPath,
      provider: undefined,
      model: 'claude-sonnet-4-20250514',
      sdkSessionId: 'sdk-parent',
      messages: [
        { id: 'm1', type: 'user', content: 'hello', timestamp: Date.now() - 10 },
        { id: 'm2', type: 'assistant', content: 'hi', timestamp: Date.now() - 5 },
      ],
      createdAt: Date.now() - 20,
      lastUsedAt: Date.now() - 5,
    })
  })

  it('deletes the new child when Pi canonical append fails', async () => {
    const manager = new SessionManager()
    appendFailure = new Error('append boom')

    await expect(
      manager.createSession('ws-1', {
        branchFromSessionId: 'source-1',
        branchFromMessageId: 'm1',
      } as any)
    ).rejects.toThrow('Could not create branch: append boom')

    expect(deletedIds).toEqual(['child-1'])
    expect(storedById.has('child-1')).toBe(false)
    expect((manager as any).sessions.has('child-1')).toBe(false)
  })

  it('branches from Pi projection without requiring a parent SDK id or backend preflight', async () => {
    const source = storedById.get('source-1')
    source.sdkSessionId = undefined
    storedById.set('source-1', source)

    const manager = new SessionManager()
    let preflightCalled = false
    ;(manager as any).getOrCreateAgent = async () => {
      preflightCalled = true
      throw new Error('must not run')
    }

    const child = await manager.createSession('ws-1', {
      branchFromSessionId: 'source-1',
      branchFromMessageId: 'm1',
    } as any)

    expect(child.id).toBe('child-1')
    expect(preflightCalled).toBe(false)
    expect(appendedMessages.map(entry => entry.id)).toEqual(['m1'])
    expect(deletedIds).toEqual([])
    expect(storedById.get('child-1')?.branchFromMessageId).toBe('m1')
  })

  it('remaps copied annotations to the child Pi message identity', async () => {
    const source = storedById.get('source-1')
    source.messages[1].annotations = [{
      id: 'ann-1',
      schemaVersion: 1,
      createdAt: 1,
      body: [{ type: 'highlight' }],
      target: {
        source: { sessionId: 'source-1', messageId: 'm2' },
        selectors: [{ type: 'text-quote', exact: 'hi' }],
      },
    }]
    storedById.set('source-1', source)

    const manager = new SessionManager()
    await manager.createSession('ws-1', {
      branchFromSessionId: 'source-1',
      branchFromMessageId: 'm2',
    } as any)

    const child = storedById.get('child-1')
    expect(child.messages.map((message: any) => message.id)).toEqual(['pi-m1', 'pi-m2'])
    expect(child.messages[1].annotations[0].target.source).toEqual({
      sessionId: 'child-1',
      messageId: 'pi-m2',
    })
  })

  it('rejects an unknown projection target before creating a child', async () => {
    const manager = new SessionManager()

    await expect(
      manager.createSession('ws-1', {
        branchFromSessionId: 'source-1',
        branchFromMessageId: 'missing',
      } as any)
    ).rejects.toThrow('message missing not found')

    expect(idCounter).toBe(0)
    expect(deletedIds).toEqual([])
  })
})
