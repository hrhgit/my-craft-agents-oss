/**
 * Channel map — maps ElectronAPI method names to IPC channels.
 *
 * Derived from preload/index.ts. This is the single source of truth for
 * the method→channel mapping used by buildClientApi().
 */

import { RPC_CHANNELS } from '../shared/types'
import type { ChannelMap } from './build-api'

const SEND_MESSAGE_RPC_TIMEOUT_MS = 300_000
const EXTENSION_RELOAD_RPC_TIMEOUT_MS = 120_000

function invoke(
  channel: string,
  transform?: (result: any) => any,
  largeArgIndex?: number,
  timeoutMs?: number,
  serializeByArgIndex?: number,
) {
  return {
    type: 'invoke' as const,
    channel,
    ...(transform && { transform }),
    ...(largeArgIndex !== undefined && { largeArgIndex }),
    ...(timeoutMs !== undefined && { timeoutMs }),
    ...(serializeByArgIndex !== undefined && { serializeByArgIndex }),
  }
}

function listener(channel: string) {
  return { type: 'listener' as const, channel }
}

export const CHANNEL_MAP = {
  // Session management
  getSessions: invoke(RPC_CHANNELS.sessions.GET),
  getUnreadSummary: invoke(RPC_CHANNELS.sessions.GET_UNREAD_SUMMARY),
  markAllSessionsRead: invoke(RPC_CHANNELS.sessions.MARK_ALL_READ),
  getSessionMessages: invoke(RPC_CHANNELS.sessions.GET_MESSAGES),
  getPiProjectionSnapshot: invoke(RPC_CHANNELS.sessions.GET_PI_PROJECTION_SNAPSHOT),
  createSession: invoke(RPC_CHANNELS.sessions.CREATE),
  createAndSendFirstTurn: invoke(
    RPC_CHANNELS.sessions.CREATE_AND_SEND_FIRST_TURN,
    undefined,
    0,
    SEND_MESSAGE_RPC_TIMEOUT_MS,
  ),
  discardFirstTurnAttachmentStaging: invoke(RPC_CHANNELS.sessions.DISCARD_FIRST_TURN_ATTACHMENT_STAGING),
  deleteSession: invoke(RPC_CHANNELS.sessions.DELETE),
  sendMessage: invoke(RPC_CHANNELS.sessions.SEND_MESSAGE, undefined, 2, SEND_MESSAGE_RPC_TIMEOUT_MS, 0),
  cancelProcessing: invoke(RPC_CHANNELS.sessions.CANCEL),
  killShell: invoke(RPC_CHANNELS.sessions.KILL_SHELL),
  getTaskOutput: invoke(RPC_CHANNELS.tasks.GET_OUTPUT),
  respondToPermission: invoke(RPC_CHANNELS.sessions.RESPOND_TO_PERMISSION),
  sessionCommand: invoke(RPC_CHANNELS.sessions.COMMAND),
  exportSession: invoke(RPC_CHANNELS.sessions.EXPORT),
  importSession: invoke(RPC_CHANNELS.sessions.IMPORT, undefined, 1),
  exportRemoteSessionTransfer: invoke(RPC_CHANNELS.sessions.EXPORT_REMOTE_TRANSFER),
  importRemoteSessionTransfer: invoke(RPC_CHANNELS.sessions.IMPORT_REMOTE_TRANSFER, undefined, 1),
  getPendingPlanExecution: invoke(RPC_CHANNELS.sessions.GET_PENDING_PLAN_EXECUTION),
  getSessionPermissionModeState: invoke(RPC_CHANNELS.sessions.GET_PERMISSION_MODE_STATE),

  // Event listeners
  onSessionEvent: listener(RPC_CHANNELS.sessions.EVENT),
  onPiProjectionEvent: listener(RPC_CHANNELS.sessions.PI_PROJECTION_EVENT),
  onUnreadSummaryChanged: listener(RPC_CHANNELS.sessions.UNREAD_SUMMARY_CHANGED),

  // Transport reliability
  onReconnected: listener('__transport:reconnected'),

  // Workspace management
  getWorkspaces: invoke(RPC_CHANNELS.workspaces.GET),
  createWorkspace: invoke(RPC_CHANNELS.workspaces.CREATE),
  checkWorkspaceSlug: invoke(RPC_CHANNELS.workspaces.CHECK_SLUG),
  updateWorkspaceRemoteServer: invoke(RPC_CHANNELS.workspaces.UPDATE_REMOTE),
  onWorkspaceRemoteServerUpdated: listener(RPC_CHANNELS.workspaces.REMOTE_UPDATED),
  getWorkspaceCoordinationStatus: invoke(RPC_CHANNELS.workspaceCoordination.GET_STATUS),
  testRemoteConnection: invoke(RPC_CHANNELS.remote.TEST_CONNECTION),

  // Server-level workspace operations (REMOTE_ELIGIBLE)
  getServerWorkspaces: invoke(RPC_CHANNELS.server.GET_WORKSPACES),
  createServerWorkspace: invoke(RPC_CHANNELS.server.CREATE_WORKSPACE),

  // Window management
  getWindowWorkspace: invoke(RPC_CHANNELS.window.GET_WORKSPACE),
  getWindowMode: invoke(RPC_CHANNELS.window.GET_MODE),
  openWorkspace: invoke(RPC_CHANNELS.window.OPEN_WORKSPACE),
  openSessionInNewWindow: invoke(RPC_CHANNELS.window.OPEN_SESSION_IN_NEW_WINDOW),
  openChildSessionWindow: invoke(RPC_CHANNELS.window.OPEN_CHILD_SESSION_WINDOW),
  switchWorkspace: invoke(RPC_CHANNELS.window.SWITCH_WORKSPACE),
  closeWindow: invoke(RPC_CHANNELS.window.CLOSE),
  confirmCloseWindow: invoke(RPC_CHANNELS.window.CONFIRM_CLOSE),
  cancelCloseWindow: invoke(RPC_CHANNELS.window.CANCEL_CLOSE),
  onCloseRequested: listener(RPC_CHANNELS.window.CLOSE_REQUESTED),
  setTrafficLightsVisible: invoke(RPC_CHANNELS.window.SET_TRAFFIC_LIGHTS),
  getAppLayout: invoke(RPC_CHANNELS.layout.GET),
  saveAppLayout: invoke(RPC_CHANNELS.layout.SAVE),
  detachLayoutTab: invoke(RPC_CHANNELS.layout.DETACH_TAB),
  detachLayoutGroup: invoke(RPC_CHANNELS.layout.DETACH_GROUP),
  redockLayoutWindow: invoke(RPC_CHANNELS.layout.REDOCK_WINDOW),
  onAppLayoutChanged: listener(RPC_CHANNELS.layout.CHANGED),

  // File operations
  readFile: invoke(RPC_CHANNELS.file.READ),
  readFileDataUrl: invoke(RPC_CHANNELS.file.READ_DATA_URL),
  readFilePreviewDataUrl: invoke(RPC_CHANNELS.file.READ_PREVIEW_DATA_URL),
  readFileBinary: invoke(RPC_CHANNELS.file.READ_BINARY),
  openFileDialog: invoke(RPC_CHANNELS.file.OPEN_DIALOG),
  readFileAttachment: invoke(RPC_CHANNELS.file.READ_ATTACHMENT),
  readUserAttachment: invoke(RPC_CHANNELS.file.READ_USER_ATTACHMENT),
  storeAttachment: invoke(RPC_CHANNELS.file.STORE_ATTACHMENT, undefined, 1),
  generateThumbnail: invoke(RPC_CHANNELS.file.GENERATE_THUMBNAIL),

  // Theme
  getSystemTheme: invoke(RPC_CHANNELS.theme.GET_SYSTEM_PREFERENCE),
  onSystemThemeChange: listener(RPC_CHANNELS.theme.SYSTEM_CHANGED),

  // System
  getVersions: invoke(RPC_CHANNELS.system.VERSIONS),
  getHomeDir: invoke(RPC_CHANNELS.system.HOME_DIR),
  isDebugMode: invoke(RPC_CHANNELS.system.IS_DEBUG_MODE),

  // Auto-update
  checkForUpdates: invoke(RPC_CHANNELS.update.CHECK),
  getUpdateInfo: invoke(RPC_CHANNELS.update.GET_INFO),
  installUpdate: invoke(RPC_CHANNELS.update.INSTALL),
  dismissUpdate: invoke(RPC_CHANNELS.update.DISMISS),
  getDismissedUpdateVersion: invoke(RPC_CHANNELS.update.GET_DISMISSED),
  onUpdateAvailable: listener(RPC_CHANNELS.update.AVAILABLE),
  onUpdateDownloadProgress: listener(RPC_CHANNELS.update.DOWNLOAD_PROGRESS),

  // Shell operations
  openUrl: invoke(RPC_CHANNELS.shell.OPEN_URL),
  openFile: invoke(RPC_CHANNELS.shell.OPEN_FILE),
  showInFolder: invoke(RPC_CHANNELS.shell.SHOW_IN_FOLDER),

  // Menu event listeners
  onMenuNewChat: listener(RPC_CHANNELS.menu.NEW_CHAT),
  onMenuOpenSettings: listener(RPC_CHANNELS.menu.OPEN_SETTINGS),
  onMenuKeyboardShortcuts: listener(RPC_CHANNELS.menu.KEYBOARD_SHORTCUTS),
  onMenuToggleFocusMode: listener(RPC_CHANNELS.menu.TOGGLE_FOCUS_MODE),
  onMenuToggleSidebar: listener(RPC_CHANNELS.menu.TOGGLE_SIDEBAR),

  // Deep link
  onDeepLinkNavigate: listener(RPC_CHANNELS.deeplink.NAVIGATE),

  // Auth
  showDeleteSessionConfirmation: invoke(RPC_CHANNELS.auth.SHOW_DELETE_SESSION_CONFIRMATION),
  getCredentialHealth: invoke(RPC_CHANNELS.credentials.HEALTH_CHECK),

  // Onboarding
  getAuthState: invoke(RPC_CHANNELS.onboarding.GET_AUTH_STATE),
  getSetupNeeds: invoke(RPC_CHANNELS.onboarding.GET_AUTH_STATE, r => r.setupNeeds),
  startWorkspaceMcpOAuth: invoke(RPC_CHANNELS.onboarding.START_MCP_OAUTH),
  deferSetup: invoke(RPC_CHANNELS.onboarding.DEFER_SETUP),

  // Server info (REMOTE_ELIGIBLE)
  getServerHomeDir: invoke(RPC_CHANNELS.server.HOME_DIR),

  // Server mode configuration
  getServerConfig: invoke(RPC_CHANNELS.settings.GET_SERVER_CONFIG),
  setServerConfig: invoke(RPC_CHANNELS.settings.SET_SERVER_CONFIG),
  getServerStatus: invoke(RPC_CHANNELS.settings.GET_SERVER_STATUS),

  // Settings - API Setup
  getDefaultThinkingLevel: invoke(RPC_CHANNELS.settings.GET_DEFAULT_THINKING_LEVEL),
  setDefaultThinkingLevel: invoke(RPC_CHANNELS.settings.SET_DEFAULT_THINKING_LEVEL),
  getMidStreamBehavior: invoke(RPC_CHANNELS.settings.GET_MID_STREAM_BEHAVIOR),
  setMidStreamBehavior: invoke(RPC_CHANNELS.settings.SET_MID_STREAM_BEHAVIOR),
  getNetworkProxySettings: invoke(RPC_CHANNELS.settings.GET_NETWORK_PROXY),
  setNetworkProxySettings: invoke(RPC_CHANNELS.settings.SET_NETWORK_PROXY),
  getDeveloperKitStatus: invoke(RPC_CHANNELS.settings.GET_DEVELOPER_KIT),
  discoverDeveloperKit: invoke(RPC_CHANNELS.settings.DISCOVER_DEVELOPER_KIT),
  setDeveloperKitPath: invoke(RPC_CHANNELS.settings.SET_DEVELOPER_KIT),

  // Agent settings
  getAgentSettings: invoke(RPC_CHANNELS.agentSettings.GET),
  updateMainAgentSettings: invoke(RPC_CHANNELS.agentSettings.UPDATE_MAIN),
  upsertSubagent: invoke(RPC_CHANNELS.agentSettings.UPSERT_SUBAGENT),
  deleteSubagent: invoke(RPC_CHANNELS.agentSettings.DELETE_SUBAGENT),

  // Pi provider discovery
  getPiApiKeyProviders: invoke(RPC_CHANNELS.pi.GET_API_KEY_PROVIDERS),
  getPiProviderBaseUrl: invoke(RPC_CHANNELS.pi.GET_PROVIDER_BASE_URL),
  getPiProviderModels: invoke(RPC_CHANNELS.pi.GET_PROVIDER_MODELS),

  // Pi global config (~/.pi/agent/) — pure Pi + custom provider mode
  getPiGlobalProviders: invoke(RPC_CHANNELS.pi.GET_GLOBAL_PROVIDERS),
  getPiGlobalSettings: invoke(RPC_CHANNELS.pi.GET_GLOBAL_SETTINGS),
  getPiGlobalProvider: invoke(RPC_CHANNELS.pi.GET_GLOBAL_PROVIDER),
  getPiGlobalProviderApiKey: invoke(RPC_CHANNELS.pi.GET_GLOBAL_PROVIDER_API_KEY),
  savePiGlobalProvider: invoke(RPC_CHANNELS.pi.SAVE_GLOBAL_PROVIDER),
  deletePiGlobalProvider: invoke(RPC_CHANNELS.pi.DELETE_GLOBAL_PROVIDER),
  setPiGlobalDefault: invoke(RPC_CHANNELS.pi.SET_GLOBAL_DEFAULT),
  fetchModelsForEndpoint: invoke(RPC_CHANNELS.pi.FETCH_MODELS_FOR_ENDPOINT),
  onPiGlobalChanged: listener(RPC_CHANNELS.pi.GLOBAL_CHANGED),

  // Session-specific model
  getSessionModel: invoke(RPC_CHANNELS.sessions.GET_MODEL),
  setSessionModel: invoke(RPC_CHANNELS.sessions.SET_MODEL),

  // Workspace Settings
  getWorkspaceSettings: invoke(RPC_CHANNELS.workspace.SETTINGS_GET),
  updateWorkspaceSetting: invoke(RPC_CHANNELS.workspace.SETTINGS_UPDATE),

  // Folder dialog
  openFolderDialog: invoke(RPC_CHANNELS.dialog.OPEN_FOLDER),

  // Filesystem search
  searchFiles: invoke(RPC_CHANNELS.fs.SEARCH),

  // Server filesystem browsing (remote mode)
  listServerDirectory: invoke(RPC_CHANNELS.fs.LIST_DIRECTORY),

  // Workspace-scoped file workbench
  listWorkspaceDirectory: invoke(RPC_CHANNELS.fs.LIST_WORKSPACE_DIRECTORY),
  searchWorkspaceFiles: invoke(RPC_CHANNELS.fs.SEARCH_WORKSPACE),
  readWorkspaceFilePreview: invoke(RPC_CHANNELS.fs.READ_WORKSPACE_PREVIEW),
  readWorkspaceFileDraft: invoke(RPC_CHANNELS.fs.READ_WORKSPACE_DRAFT),
  setWorkspaceFileDraft: invoke(RPC_CHANNELS.fs.SET_WORKSPACE_DRAFT),
  deleteWorkspaceFileDraft: invoke(RPC_CHANNELS.fs.DELETE_WORKSPACE_DRAFT),
  writeWorkspaceTextFile: invoke(RPC_CHANNELS.fs.WRITE_WORKSPACE_TEXT),
  createWorkspaceEntry: invoke(RPC_CHANNELS.fs.CREATE_WORKSPACE_ENTRY),
  renameWorkspaceEntry: invoke(RPC_CHANNELS.fs.RENAME_WORKSPACE_ENTRY),
  deleteWorkspaceEntry: invoke(RPC_CHANNELS.fs.DELETE_WORKSPACE_ENTRY),
  watchWorkspaceFiles: invoke(RPC_CHANNELS.fs.WATCH_WORKSPACE),
  unwatchWorkspaceFiles: invoke(RPC_CHANNELS.fs.UNWATCH_WORKSPACE),
  onWorkspaceFilesChanged: listener(RPC_CHANNELS.fs.WORKSPACE_CHANGED),

  // Debug logging
  debugLog: invoke(RPC_CHANNELS.debug.LOG),

  // User Preferences
  readPreferences: invoke(RPC_CHANNELS.preferences.READ),
  writePreferences: invoke(RPC_CHANNELS.preferences.WRITE),

  // Session Drafts
  getDraft: invoke(RPC_CHANNELS.drafts.GET),
  setDraft: invoke(RPC_CHANNELS.drafts.SET),
  deleteDraft: invoke(RPC_CHANNELS.drafts.DELETE),
  getAllDrafts: invoke(RPC_CHANNELS.drafts.GET_ALL),

  // Session Info Panel
  getSessionFiles: invoke(RPC_CHANNELS.sessions.GET_FILES),
  readSessionFile: invoke(RPC_CHANNELS.sessions.READ_FILE),
  writeSessionTextFile: invoke(RPC_CHANNELS.sessions.WRITE_FILE),
  watchSessionFiles: invoke(RPC_CHANNELS.sessions.WATCH_FILES),
  unwatchSessionFiles: invoke(RPC_CHANNELS.sessions.UNWATCH_FILES),
  onSessionFilesChanged: listener(RPC_CHANNELS.sessions.FILES_CHANGED),

  getWorkspacePermissionsConfig: invoke(RPC_CHANNELS.workspace.GET_PERMISSIONS),
  getDefaultPermissionsConfig: invoke(RPC_CHANNELS.permissions.GET_DEFAULTS),
  onDefaultPermissionsChanged: listener(RPC_CHANNELS.permissions.DEFAULTS_CHANGED),

  // Session content search
  searchSessionContent: invoke(RPC_CHANNELS.sessions.SEARCH_CONTENT),

  // Skills
  getSkills: invoke(RPC_CHANNELS.skills.GET),
  getSkillFiles: invoke(RPC_CHANNELS.skills.GET_FILES),
  deleteSkill: invoke(RPC_CHANNELS.skills.DELETE),
  openSkillInEditor: invoke(RPC_CHANNELS.skills.OPEN_EDITOR),
  openSkillInFinder: invoke(RPC_CHANNELS.skills.OPEN_FINDER),
  onSkillsChanged: listener(RPC_CHANNELS.skills.CHANGED),

  // Tool icon mappings
  getToolIconMappings: invoke(RPC_CHANNELS.toolIcons.GET_MAPPINGS),

  // Workspace images
  readWorkspaceImage: invoke(RPC_CHANNELS.workspace.READ_IMAGE),
  writeWorkspaceImage: invoke(RPC_CHANNELS.workspace.WRITE_IMAGE),

  // Theme
  getAppTheme: invoke(RPC_CHANNELS.theme.GET_APP),
  loadPresetThemes: invoke(RPC_CHANNELS.theme.GET_PRESETS),
  loadPresetTheme: invoke(RPC_CHANNELS.theme.LOAD_PRESET),
  getColorTheme: invoke(RPC_CHANNELS.theme.GET_COLOR_THEME),
  setColorTheme: invoke(RPC_CHANNELS.theme.SET_COLOR_THEME),
  getWorkspaceColorTheme: invoke(RPC_CHANNELS.theme.GET_WORKSPACE_COLOR_THEME),
  setWorkspaceColorTheme: invoke(RPC_CHANNELS.theme.SET_WORKSPACE_COLOR_THEME),
  getAllWorkspaceThemes: invoke(RPC_CHANNELS.theme.GET_ALL_WORKSPACE_THEMES),
  onAppThemeChange: listener(RPC_CHANNELS.theme.APP_CHANGED),
  broadcastThemePreferences: invoke(RPC_CHANNELS.theme.BROADCAST_PREFERENCES),
  onThemePreferencesChange: listener(RPC_CHANNELS.theme.PREFERENCES_CHANGED),
  broadcastWorkspaceThemeChange: invoke(RPC_CHANNELS.theme.BROADCAST_WORKSPACE_THEME),
  onWorkspaceThemeChange: listener(RPC_CHANNELS.theme.WORKSPACE_THEME_CHANGED),

  // Notifications
  showNotification: invoke(RPC_CHANNELS.notification.SHOW),
  getNotificationsEnabled: invoke(RPC_CHANNELS.notification.GET_ENABLED),
  setNotificationsEnabled: invoke(RPC_CHANNELS.notification.SET_ENABLED),

  // Input settings
  getAutoCapitalisation: invoke(RPC_CHANNELS.input.GET_AUTO_CAPITALISATION),
  setAutoCapitalisation: invoke(RPC_CHANNELS.input.SET_AUTO_CAPITALISATION),
  getSendMessageKey: invoke(RPC_CHANNELS.input.GET_SEND_MESSAGE_KEY),
  setSendMessageKey: invoke(RPC_CHANNELS.input.SET_SEND_MESSAGE_KEY),
  getSpellCheck: invoke(RPC_CHANNELS.input.GET_SPELL_CHECK),
  setSpellCheck: invoke(RPC_CHANNELS.input.SET_SPELL_CHECK),

  // Power settings
  getKeepAwakeWhileRunning: invoke(RPC_CHANNELS.power.GET_KEEP_AWAKE),
  setKeepAwakeWhileRunning: invoke(RPC_CHANNELS.power.SET_KEEP_AWAKE),

  // Appearance settings
  getRichToolDescriptions: invoke(RPC_CHANNELS.appearance.GET_RICH_TOOL_DESCRIPTIONS),
  setRichToolDescriptions: invoke(RPC_CHANNELS.appearance.SET_RICH_TOOL_DESCRIPTIONS),

  // Tools settings
  getBrowserToolEnabled: invoke(RPC_CHANNELS.tools.GET_BROWSER_TOOL_ENABLED),
  setBrowserToolEnabled: invoke(RPC_CHANNELS.tools.SET_BROWSER_TOOL_ENABLED),

  // Pi Extensions 集成开关（控制全局 pi 扩展加载与 automation 委托）
  getPiExtensionSettings: invoke(RPC_CHANNELS.piExtensions.GET_SETTINGS),
  setPiExtensionSettings: invoke(RPC_CHANNELS.piExtensions.SET_SETTINGS),
  updatePiExtensionSettings: invoke(RPC_CHANNELS.piExtensions.UPDATE_SETTINGS),
  getPiExtensionCatalog: invoke(RPC_CHANNELS.piExtensions.GET_CATALOG),
  patchPiExtensionConfig: invoke(RPC_CHANNELS.piExtensions.PATCH_EXTENSION_CONFIG),
  reloadPiExtensions: invoke(RPC_CHANNELS.piExtensions.RELOAD, undefined, undefined, EXTENSION_RELOAD_RPC_TIMEOUT_MS),
  getPiExtensionStates: invoke(RPC_CHANNELS.piExtensions.GET_EXTENSION_STATES),
  setPiExtensionEnabled: invoke(RPC_CHANNELS.piExtensions.SET_EXTENSION_ENABLED),

  // Pi 扩展事件桥接：监听 extension_* / remoteui_request 事件，回传 remoteui 响应
  onExtensionEvent: listener(RPC_CHANNELS.extensions.EVENT),
  sendRemoteUIResponse: invoke(RPC_CHANNELS.extensions.REMOTEUI_RESPONSE),
  invokeExtensionCommand: invoke(RPC_CHANNELS.extensions.COMMAND_INVOKE),
  getExtensionCommands: invoke(RPC_CHANNELS.extensions.GET_COMMANDS),

  // Pi session tree — list child sessions spawned via spawn_session tool
  listChildSessions: invoke(RPC_CHANNELS.sessions.LIST_CHILD_SESSIONS),

  // Badge
  refreshBadge: invoke(RPC_CHANNELS.badge.REFRESH),
  setDockIconWithBadge: invoke(RPC_CHANNELS.badge.SET_ICON),
  onBadgeDraw: listener(RPC_CHANNELS.badge.DRAW),
  onBadgeDrawWindows: listener(RPC_CHANNELS.badge.DRAW_WINDOWS),

  // Window focus
  getWindowFocusState: invoke(RPC_CHANNELS.window.GET_FOCUS_STATE),
  onWindowFocusChange: listener(RPC_CHANNELS.window.FOCUS_STATE),
  onNotificationNavigate: listener(RPC_CHANNELS.notification.NAVIGATE),

  // Git
  getGitBranch: invoke(RPC_CHANNELS.git.GET_BRANCH),
  checkGitBash: invoke(RPC_CHANNELS.gitbash.CHECK),
  browseForGitBash: invoke(RPC_CHANNELS.gitbash.BROWSE),
  setGitBashPath: invoke(RPC_CHANNELS.gitbash.SET_PATH),

  // Menu actions
  menuQuit: invoke(RPC_CHANNELS.menu.QUIT),
  menuNewWindow: invoke(RPC_CHANNELS.menu.NEW_WINDOW),
  menuMinimize: invoke(RPC_CHANNELS.menu.MINIMIZE),
  menuMaximize: invoke(RPC_CHANNELS.menu.MAXIMIZE),
  menuZoomIn: invoke(RPC_CHANNELS.menu.ZOOM_IN),
  menuZoomOut: invoke(RPC_CHANNELS.menu.ZOOM_OUT),
  menuZoomReset: invoke(RPC_CHANNELS.menu.ZOOM_RESET),
  menuToggleDevTools: invoke(RPC_CHANNELS.menu.TOGGLE_DEV_TOOLS),
  menuUndo: invoke(RPC_CHANNELS.menu.UNDO),
  menuRedo: invoke(RPC_CHANNELS.menu.REDO),
  menuCut: invoke(RPC_CHANNELS.menu.CUT),
  menuCopy: invoke(RPC_CHANNELS.menu.COPY),
  menuPaste: invoke(RPC_CHANNELS.menu.PASTE),
  menuSelectAll: invoke(RPC_CHANNELS.menu.SELECT_ALL),

  // Browser pane management
  'browserPane.create': invoke(RPC_CHANNELS.browserPane.CREATE),
  'browserPane.embed': invoke(RPC_CHANNELS.browserPane.EMBED),
  'browserPane.updateEmbedBounds': invoke(RPC_CHANNELS.browserPane.UPDATE_EMBED_BOUNDS),
  'browserPane.detach': invoke(RPC_CHANNELS.browserPane.DETACH),
  'browserPane.destroy': invoke(RPC_CHANNELS.browserPane.DESTROY),
  'browserPane.list': invoke(RPC_CHANNELS.browserPane.LIST),
  'browserPane.navigate': invoke(RPC_CHANNELS.browserPane.NAVIGATE),
  'browserPane.goBack': invoke(RPC_CHANNELS.browserPane.GO_BACK),
  'browserPane.goForward': invoke(RPC_CHANNELS.browserPane.GO_FORWARD),
  'browserPane.reload': invoke(RPC_CHANNELS.browserPane.RELOAD),
  'browserPane.stop': invoke(RPC_CHANNELS.browserPane.STOP),
  'browserPane.focus': invoke(RPC_CHANNELS.browserPane.FOCUS),
  'browserPane.onStateChanged': listener(RPC_CHANNELS.browserPane.STATE_CHANGED),
  'browserPane.onRemoved': listener(RPC_CHANNELS.browserPane.REMOVED),
  'browserPane.onInteracted': listener(RPC_CHANNELS.browserPane.INTERACTED),
  'browserPane.onHostDockNavigation': listener(RPC_CHANNELS.browserPane.HOST_DOCK_NAVIGATION),

  // LLM Connections

  // Automations
  getAutomations: invoke(RPC_CHANNELS.automations.GET),
  automationCommand: invoke(RPC_CHANNELS.automations.COMMAND),
  testAutomation: invoke(RPC_CHANNELS.automations.TEST),
  setAutomationEnabled: invoke(RPC_CHANNELS.automations.SET_ENABLED),
  duplicateAutomation: invoke(RPC_CHANNELS.automations.DUPLICATE),
  deleteAutomation: invoke(RPC_CHANNELS.automations.DELETE),
  getAutomationHistory: invoke(RPC_CHANNELS.automations.GET_HISTORY),
  getAutomationLastExecuted: invoke(RPC_CHANNELS.automations.GET_LAST_EXECUTED),
  replayAutomation: invoke(RPC_CHANNELS.automations.REPLAY),
  onAutomationsChanged: listener(RPC_CHANNELS.automations.CHANGED),

  // Resources (cross-workspace export/import)
  exportResources: invoke(RPC_CHANNELS.resources.EXPORT),
  importResources: invoke(RPC_CHANNELS.resources.IMPORT),

  // Messaging gateway
  getMessagingConfig: invoke(RPC_CHANNELS.messaging.GET_CONFIG),
  updateMessagingConfig: invoke(RPC_CHANNELS.messaging.UPDATE_CONFIG),
  testTelegramToken: invoke(RPC_CHANNELS.messaging.TEST_TELEGRAM),
  saveTelegramToken: invoke(RPC_CHANNELS.messaging.SAVE_TELEGRAM),
  testLarkCredentials: invoke(RPC_CHANNELS.messaging.TEST_LARK),
  saveLarkCredentials: invoke(RPC_CHANNELS.messaging.SAVE_LARK),
  disconnectMessagingPlatform: invoke(RPC_CHANNELS.messaging.DISCONNECT),
  forgetMessagingPlatform: invoke(RPC_CHANNELS.messaging.FORGET),
  getMessagingBindings: invoke(RPC_CHANNELS.messaging.GET_BINDINGS),
  generateMessagingPairingCode: invoke(RPC_CHANNELS.messaging.GENERATE_CODE),
  generateMessagingSupergroupCode: invoke(RPC_CHANNELS.messaging.GENERATE_SUPERGROUP_CODE),
  getMessagingSupergroup: invoke(RPC_CHANNELS.messaging.GET_SUPERGROUP),
  unbindMessagingSupergroup: invoke(RPC_CHANNELS.messaging.UNBIND_SUPERGROUP),
  unbindMessagingSession: invoke(RPC_CHANNELS.messaging.UNBIND),
  unbindMessagingBinding: invoke(RPC_CHANNELS.messaging.UNBIND_BINDING),
  onMessagingBindingChanged: listener(RPC_CHANNELS.messaging.BINDING_CHANGED),
  onMessagingPlatformStatus: listener(RPC_CHANNELS.messaging.PLATFORM_STATUS),
  startWhatsAppConnect: invoke(RPC_CHANNELS.messaging.WA_START_CONNECT),
  submitWhatsAppPhone: invoke(RPC_CHANNELS.messaging.WA_SUBMIT_PHONE),
  onWhatsAppEvent: listener(RPC_CHANNELS.messaging.WA_UI_EVENT),

  // Messaging access control (Phase 3)
  getMessagingPlatformOwners: invoke(RPC_CHANNELS.messaging.GET_PLATFORM_OWNERS),
  setMessagingPlatformOwners: invoke(RPC_CHANNELS.messaging.SET_PLATFORM_OWNERS),
  getMessagingPlatformAccessMode: invoke(RPC_CHANNELS.messaging.GET_PLATFORM_ACCESS_MODE),
  setMessagingPlatformAccessMode: invoke(RPC_CHANNELS.messaging.SET_PLATFORM_ACCESS_MODE),
  getMessagingPendingSenders: invoke(RPC_CHANNELS.messaging.GET_PENDING_SENDERS),
  dismissMessagingPendingSender: invoke(RPC_CHANNELS.messaging.DISMISS_PENDING_SENDER),
  allowMessagingPendingSender: invoke(RPC_CHANNELS.messaging.ALLOW_PENDING_SENDER),
  setMessagingBindingAccess: invoke(RPC_CHANNELS.messaging.SET_BINDING_ACCESS),
  onMessagingPendingChanged: listener(RPC_CHANNELS.messaging.PENDING_CHANGED),
} satisfies ChannelMap
