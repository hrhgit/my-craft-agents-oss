import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'path'
import { RPC_CHANNELS } from '@mortise/shared/protocol'
import {
  getPreferencesPath,
  getSessionDraft,
  setSessionDraft,
  deleteSessionDraft,
  getAllSessionDrafts,
  getDefaultThinkingLevel,
  setDefaultThinkingLevel,
  getMidStreamBehavior,
  setMidStreamBehavior,
  getAgentSettingsSnapshot,
  updateMainAgentSettings,
  upsertSubagent,
  deleteSubagent,
} from '@mortise/shared/config'
import { normalizeThinkingLevel, THINKING_LEVEL_IDS } from '@mortise/shared/agent/thinking-levels'
import * as configStorage from '@mortise/shared/config/storage'

const VALID_THINKING_LEVELS_LIST = THINKING_LEVEL_IDS.map(id => `'${id}'`).join(', ')
import { getWorkspaceOrNull, getWorkspaceOrThrow, resolveWorkspaceId } from '@mortise/server-core/handlers'
import type { RpcServer } from '@mortise/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { requestClientOpenFileDialog } from '@mortise/server-core/transport'
import { applyExtensionConfigPatch } from './extension-config-patch'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.workspace.SETTINGS_GET,
  RPC_CHANNELS.workspace.SETTINGS_UPDATE,
  RPC_CHANNELS.preferences.READ,
  RPC_CHANNELS.preferences.WRITE,
  RPC_CHANNELS.drafts.GET,
  RPC_CHANNELS.drafts.SET,
  RPC_CHANNELS.drafts.DELETE,
  RPC_CHANNELS.drafts.GET_ALL,
  RPC_CHANNELS.input.GET_AUTO_CAPITALISATION,
  RPC_CHANNELS.input.SET_AUTO_CAPITALISATION,
  RPC_CHANNELS.input.GET_SEND_MESSAGE_KEY,
  RPC_CHANNELS.input.SET_SEND_MESSAGE_KEY,
  RPC_CHANNELS.input.GET_SPELL_CHECK,
  RPC_CHANNELS.input.SET_SPELL_CHECK,
  RPC_CHANNELS.power.GET_KEEP_AWAKE,
  RPC_CHANNELS.appearance.GET_RICH_TOOL_DESCRIPTIONS,
  RPC_CHANNELS.appearance.SET_RICH_TOOL_DESCRIPTIONS,
  RPC_CHANNELS.sessions.GET_MODEL,
  RPC_CHANNELS.sessions.SET_MODEL,
  RPC_CHANNELS.settings.GET_DEFAULT_THINKING_LEVEL,
  RPC_CHANNELS.settings.SET_DEFAULT_THINKING_LEVEL,
  RPC_CHANNELS.settings.GET_MID_STREAM_BEHAVIOR,
  RPC_CHANNELS.settings.SET_MID_STREAM_BEHAVIOR,
  RPC_CHANNELS.agentSettings.GET,
  RPC_CHANNELS.agentSettings.UPDATE_MAIN,
  RPC_CHANNELS.agentSettings.UPSERT_SUBAGENT,
  RPC_CHANNELS.agentSettings.DELETE_SUBAGENT,
  RPC_CHANNELS.tools.GET_BROWSER_TOOL_ENABLED,
  RPC_CHANNELS.tools.SET_BROWSER_TOOL_ENABLED,
  RPC_CHANNELS.tools.GET_DATA_SOURCES_ENABLED,
  RPC_CHANNELS.tools.SET_DATA_SOURCES_ENABLED,
  RPC_CHANNELS.piExtensions.GET_DELEGATE_PROMPT_AUTOMATION,
  RPC_CHANNELS.piExtensions.SET_DELEGATE_PROMPT_AUTOMATION,
  RPC_CHANNELS.piExtensions.GET_SETTINGS,
  RPC_CHANNELS.piExtensions.SET_SETTINGS,
  RPC_CHANNELS.piExtensions.UPDATE_SETTINGS,
  RPC_CHANNELS.piExtensions.GET_CATALOG,
  RPC_CHANNELS.piExtensions.PATCH_EXTENSION_CONFIG,
  RPC_CHANNELS.piExtensions.RELOAD,
  RPC_CHANNELS.piExtensions.GET_EXTENSION_STATES,
  RPC_CHANNELS.piExtensions.SET_EXTENSION_ENABLED,
  RPC_CHANNELS.settings.GET_NETWORK_PROXY,
  RPC_CHANNELS.dialog.OPEN_FOLDER,
] as const

export function registerSettingsHandlers(server: RpcServer, deps: HandlerDeps): void {
  server.handle(RPC_CHANNELS.agentSettings.GET, async () => {
    const runtimeProfile = await deps.sessionManager.getAgentRuntimeProfile()
    return getAgentSettingsSnapshot(runtimeProfile)
  })

  server.handle(RPC_CHANNELS.agentSettings.UPDATE_MAIN, async (
    _ctx,
    update: import('@mortise/shared/config').MainAgentSettingsUpdate,
  ) => {
    const runtimeProfile = await deps.sessionManager.getAgentRuntimeProfile()
    updateMainAgentSettings(update)
    await deps.sessionManager.reloadProviderRuntime()
    return getAgentSettingsSnapshot(runtimeProfile)
  })

  server.handle(RPC_CHANNELS.agentSettings.UPSERT_SUBAGENT, async (
    _ctx,
    update: import('@mortise/shared/config').SubagentUpsert,
  ) => {
    const agent = upsertSubagent(update)
    return { success: true, agent }
  })

  server.handle(RPC_CHANNELS.agentSettings.DELETE_SUBAGENT, async (_ctx, id: string) => {
    deleteSubagent(id)
    return { success: true }
  })

  // ============================================================
  // Settings - Default Thinking Level (App-Level)
  // ============================================================

  server.handle(RPC_CHANNELS.settings.GET_DEFAULT_THINKING_LEVEL, async () => {
    return getDefaultThinkingLevel()
  })

  server.handle(RPC_CHANNELS.settings.SET_DEFAULT_THINKING_LEVEL, async (_ctx, level: string) => {
    const normalized = normalizeThinkingLevel(level)
    if (!normalized) {
      throw new Error(`Invalid thinking level: ${level}. Valid values: ${VALID_THINKING_LEVELS_LIST}`)
    }
    const success = await setDefaultThinkingLevel(normalized)
    if (!success) {
      throw new Error('Failed to persist default thinking level')
    }
    return { success: true }
  })

  server.handle(RPC_CHANNELS.settings.GET_MID_STREAM_BEHAVIOR, async () => {
    return getMidStreamBehavior()
  })

  server.handle(RPC_CHANNELS.settings.SET_MID_STREAM_BEHAVIOR, async (_ctx, behavior: string) => {
    if (behavior !== 'steer' && behavior !== 'queue') {
      throw new Error(`Invalid mid-stream behavior: ${behavior}. Valid values: 'steer', 'queue'`)
    }
    if (!setMidStreamBehavior(behavior)) {
      throw new Error('Failed to persist mid-stream behavior')
    }
    return { success: true }
  })

  // ============================================================
  // Settings - Model (Session-Specific)
  // ============================================================

  // Get session-specific model
  server.handle(RPC_CHANNELS.sessions.GET_MODEL, async (ctx, sessionId: string, workspaceId: string): Promise<string | null> => {
    const wid = resolveWorkspaceId(ctx.workspaceId, workspaceId)
    const session = await deps.sessionManager.getSession(sessionId)
    if (wid && session && session.workspaceId !== wid) {
      throw new Error(`Session workspace mismatch: session ${sessionId} belongs to workspace ${session.workspaceId}, but caller is authenticated to ${wid}`)
    }
    return session?.model ?? null
  })

  // Set session-specific provider/model overrides.
  server.handle(RPC_CHANNELS.sessions.SET_MODEL, async (ctx, sessionId: string, workspaceId: string, model: string | null, provider?: string) => {
    const wid = resolveWorkspaceId(ctx.workspaceId, workspaceId)!
    if (wid) {
      const session = await deps.sessionManager.getSession(sessionId)
      if (session && session.workspaceId !== wid) {
        throw new Error(`Session workspace mismatch: session ${sessionId} belongs to workspace ${session.workspaceId}, but caller is authenticated to ${wid}`)
      }
    }
    await deps.sessionManager.updateSessionModel(sessionId, wid, model, provider)
    deps.platform.logger.info(`Session ${sessionId} model updated to: ${model}${provider ? ` (provider: ${provider})` : ''}`)
  })

  // Open native folder dialog for selecting working directory (routed to client)
  server.handle(RPC_CHANNELS.dialog.OPEN_FOLDER, async (ctx) => {
    const result = await requestClientOpenFileDialog(server, ctx.clientId, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select Working Directory',
    })
    return result.canceled ? null : result.filePaths[0]
  })

  // ============================================================
  // Workspace Settings (per-workspace configuration)
  // ============================================================

  // Get settings that are genuinely scoped to a workspace.
  server.handle(RPC_CHANNELS.workspace.SETTINGS_GET, async (ctx, workspaceId: string) => {
    const wid = resolveWorkspaceId(ctx.workspaceId, workspaceId)
    if (!wid) return null
    const workspace = getWorkspaceOrNull(wid, deps.platform.logger, 'WORKSPACE_SETTINGS_GET')
    if (!workspace) return null

    // Load workspace config
    const { loadWorkspaceConfig } = await import('@mortise/shared/workspaces')
    const config = loadWorkspaceConfig(workspace.rootPath)

    return {
      name: config?.name,
      permissionMode: config?.defaults?.permissionMode,
      cyclablePermissionModes: config?.defaults?.cyclablePermissionModes,
      workingDirectory: workspace.rootPath,
      localMcpEnabled: config?.localMcpServers?.enabled ?? true,
      enabledSourceSlugs: config?.defaults?.enabledSourceSlugs ?? [],
    }
  })

  // Update a workspace setting
  server.handle(RPC_CHANNELS.workspace.SETTINGS_UPDATE, async (ctx, workspaceId: string, key: string, value: unknown) => {
    const wid = resolveWorkspaceId(ctx.workspaceId, workspaceId)!
    const workspace = getWorkspaceOrThrow(wid)
    const normalizedValue = value

    // Validate key is a known workspace setting
    const validKeys = ['name', 'enabledSourceSlugs', 'permissionMode', 'cyclablePermissionModes', 'localMcpEnabled']
    if (!validKeys.includes(key)) {
      throw new Error(`Invalid workspace setting key: ${key}. Valid keys: ${validKeys.join(', ')}`)
    }

    const { loadWorkspaceConfig, saveWorkspaceConfig } = await import('@mortise/shared/workspaces')
    const config = loadWorkspaceConfig(workspace.rootPath)
    if (!config) {
      throw new Error(`Failed to load workspace config: ${wid}`)
    }

    // Handle 'name' specially - it's a top-level config property, not in defaults
    if (key === 'name') {
      config.name = String(normalizedValue).trim()
    } else if (key === 'localMcpEnabled') {
      // Store in localMcpServers.enabled (top-level, not in defaults)
      config.localMcpServers = config.localMcpServers || { enabled: true }
      config.localMcpServers.enabled = Boolean(normalizedValue)
    } else {
      // Update the setting in defaults
      config.defaults = config.defaults || {}
      ;(config.defaults as Record<string, unknown>)[key] = normalizedValue
    }

    // Save the config
    saveWorkspaceConfig(workspace.rootPath, config)
    deps.platform.logger.info(`Workspace setting updated: ${key} = ${JSON.stringify(normalizedValue)}`)
  })

  // ============================================================
  // User Preferences
  // ============================================================

  // Read user preferences file
  server.handle(RPC_CHANNELS.preferences.READ, async () => {
    const path = getPreferencesPath()
    if (!existsSync(path)) {
      return { content: '{}', exists: false, path }
    }
    return { content: readFileSync(path, 'utf-8'), exists: true, path }
  })

  // Write user preferences file (validates JSON before saving)
  server.handle(RPC_CHANNELS.preferences.WRITE, async (_, content: string) => {
    try {
      JSON.parse(content) // Validate JSON
      const path = getPreferencesPath()
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content, 'utf-8')
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // ============================================================
  // Session Drafts (persisted input text)
  // ============================================================

  // Get draft for a session (text + attachment refs)
  server.handle(RPC_CHANNELS.drafts.GET, async (_ctx, sessionId: string) => {
    return getSessionDraft(sessionId)
  })

  // Set draft for a session (empty drafts are cleared)
  server.handle(RPC_CHANNELS.drafts.SET, async (_ctx, sessionId: string, draft: import('@mortise/shared/config').SessionDraft) => {
    setSessionDraft(sessionId, draft)
  })

  // Delete draft for a session
  server.handle(RPC_CHANNELS.drafts.DELETE, async (_ctx, sessionId: string) => {
    deleteSessionDraft(sessionId)
  })

  // Get all drafts (for loading on app start)
  server.handle(RPC_CHANNELS.drafts.GET_ALL, async () => {
    return getAllSessionDrafts()
  })

  // ============================================================
  // Input Settings
  // ============================================================

  // Get auto-capitalisation setting
  server.handle(RPC_CHANNELS.input.GET_AUTO_CAPITALISATION, async () => {
    return configStorage.getAutoCapitalisation()
  })

  // Set auto-capitalisation setting
  server.handle(RPC_CHANNELS.input.SET_AUTO_CAPITALISATION, async (_ctx, enabled: boolean) => {
    configStorage.setAutoCapitalisation(enabled)
  })

  // Get send message key setting
  server.handle(RPC_CHANNELS.input.GET_SEND_MESSAGE_KEY, async () => {
    return configStorage.getSendMessageKey()
  })

  // Set send message key setting
  server.handle(RPC_CHANNELS.input.SET_SEND_MESSAGE_KEY, async (_ctx, key: 'enter' | 'cmd-enter') => {
    configStorage.setSendMessageKey(key)
  })

  // Get spell check setting
  server.handle(RPC_CHANNELS.input.GET_SPELL_CHECK, async () => {
    return configStorage.getSpellCheck()
  })

  // Set spell check setting
  server.handle(RPC_CHANNELS.input.SET_SPELL_CHECK, async (_ctx, enabled: boolean) => {
    configStorage.setSpellCheck(enabled)
  })

  // ============================================================
  // Power Settings
  // ============================================================

  // Get keep awake while running setting
  server.handle(RPC_CHANNELS.power.GET_KEEP_AWAKE, async () => {
    return configStorage.getKeepAwakeWhileRunning()
  })

  // ============================================================
  // Appearance Settings
  // ============================================================

  // Get rich tool descriptions setting
  server.handle(RPC_CHANNELS.appearance.GET_RICH_TOOL_DESCRIPTIONS, async () => {
    return configStorage.getRichToolDescriptions()
  })

  // Set rich tool descriptions setting
  server.handle(RPC_CHANNELS.appearance.SET_RICH_TOOL_DESCRIPTIONS, async (_ctx, enabled: boolean) => {
    configStorage.setRichToolDescriptions(enabled)
  })

  // ============================================================
  // Tools Settings
  // ============================================================

  server.handle(RPC_CHANNELS.tools.GET_BROWSER_TOOL_ENABLED, async () => {
    return configStorage.getBrowserToolEnabled()
  })

  server.handle(RPC_CHANNELS.tools.SET_BROWSER_TOOL_ENABLED, async (_ctx, enabled: boolean) => {
    await configStorage.setBrowserToolEnabled(enabled)
  })

  server.handle(RPC_CHANNELS.tools.GET_DATA_SOURCES_ENABLED, async () => {
    return configStorage.getDataSourcesEnabled()
  })

  server.handle(RPC_CHANNELS.tools.SET_DATA_SOURCES_ENABLED, async (_ctx, enabled: boolean) => {
    configStorage.setDataSourcesEnabled(enabled)
    await deps.sessionManager.refreshDataSourcesRuntime?.()
  })

  // ============================================================
  // Pi Extensions 集成开关（控制全局 pi 扩展加载与 automation 委托）
  // ============================================================

  server.handle(RPC_CHANNELS.piExtensions.GET_DELEGATE_PROMPT_AUTOMATION, async () => {
    return configStorage.getPiExtensionsDelegatePromptAutomation()
  })

  server.handle(RPC_CHANNELS.piExtensions.SET_DELEGATE_PROMPT_AUTOMATION, async (_ctx, delegate: boolean) => {
    await configStorage.setPiExtensionsDelegatePromptAutomation(delegate)
  })

  server.handle(RPC_CHANNELS.piExtensions.GET_SETTINGS, async () => {
    return configStorage.getPiExtensionSettings()
  })

  server.handle(RPC_CHANNELS.piExtensions.SET_SETTINGS, async (_ctx, settings: import('@mortise/shared/config').StoredPiExtensionSettings) => {
    return await configStorage.setPiExtensionSettings(settings)
  })

  server.handle(RPC_CHANNELS.piExtensions.UPDATE_SETTINGS, async (_ctx, patch: import('@mortise/shared/config').StoredPiExtensionSettings) => {
    return await configStorage.updatePiExtensionSettings(patch)
  })

  server.handle(RPC_CHANNELS.piExtensions.GET_CATALOG, async () => {
    const { getPiExtensionCatalog } = await import('@mortise/shared/config/pi-global-config')
    return await getPiExtensionCatalog()
  })

  server.handle(RPC_CHANNELS.piExtensions.PATCH_EXTENSION_CONFIG, async (_ctx, patch: import('@mortise/shared/config').PiExtensionConfigPatch) => {
    const { getPiExtensionCatalog, patchPiExtensionConfig } = await import('@mortise/shared/config/pi-global-config')
    const catalog = await getPiExtensionCatalog()
    const extension = catalog.extensions.find((entry) => entry.id === patch.extensionId)
    if (!extension) throw new Error(`Unknown extension: ${patch.extensionId}`)
    return await applyExtensionConfigPatch(
      extension,
      patch,
      patchPiExtensionConfig,
      (interruptRunning) => deps.sessionManager.requestExtensionReload(interruptRunning),
    )
  })

  server.handle(RPC_CHANNELS.piExtensions.RELOAD, async (
    _ctx,
    payload?: boolean | { interruptRunning?: boolean },
  ) => {
    const interruptRunning = typeof payload === 'boolean'
      ? payload
      : payload?.interruptRunning === true
    return await deps.sessionManager.requestExtensionReload(interruptRunning)
  })

  // 逐扩展启停：读写 Pi settings.json 的 extensionConfig.<name>.enabled
  server.handle(RPC_CHANNELS.piExtensions.GET_EXTENSION_STATES, async () => {
    const { getPiExtensionCatalog } = await import('@mortise/shared/config/pi-global-config')
    const { extensions } = await getPiExtensionCatalog()
    const states: Record<string, boolean> = {}
    for (const extension of extensions) {
      states[extension.id] = extension.enabled
    }
    return states
  })

  server.handle(RPC_CHANNELS.piExtensions.SET_EXTENSION_ENABLED, async (_ctx, payload: { name: string; enabled: boolean }) => {
    const { writePiExtensionEnabled } = await import('@mortise/shared/config/pi-global-config')
    await writePiExtensionEnabled(payload.name, payload.enabled)
    return await deps.sessionManager.requestExtensionReload(false)
  })

  // ============================================================
  // Network Proxy Settings
  // ============================================================

  // Get network proxy settings
  server.handle(RPC_CHANNELS.settings.GET_NETWORK_PROXY, async () => {
    return configStorage.getNetworkProxySettings()
  })
}
