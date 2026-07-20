/**
 * AppShellContext
 *
 * Provides session and workspace data to tab panels without prop drilling.
 * This context is used by ChatTabPanel and other components that need
 * access to the current session, workspace, and callback functions.
 */

import * as React from 'react'
import { createContext, useContext, useCallback } from 'react'
import { useAtomValue } from 'jotai'
import type { ChatDisplayHandle } from '@/components/app-shell/ChatDisplay'
import type {
  Session,
  Workspace,
  FileAttachment,
  PermissionRequest,
  PermissionMode,
  LoadedSkill,
  NewChatActionParams,
  PiGlobalProviderForDisplay,
  PiGlobalSettings,
  TestAutomationResult,
} from '../../shared/types'
import type { SessionOptions, SessionOptionUpdates } from '../hooks/useSessionOptions'
import type {
  CreateAndSendFirstTurnRequest,
  CreateAndSendFirstTurnResult,
  MidStreamSendIntent,
} from '@mortise/shared/protocol'
import { defaultSessionOptions } from '../hooks/useSessionOptions'
import { sessionAtomFamily } from '../atoms/sessions'
import type {
  RemoteUICancelReason,
} from '@/components/extensions/RemoteUIModal'
import type { ExtensionUIRequest, ExtensionUIResponse } from '@/hooks/useRemoteUIRequests'
import type { WorkspaceSelectHandler } from '@/components/workspace/useWorkspaceNavigation'
import type { WorkspaceNavigationModel } from '@/components/workspace/useWorkspaceNavigation'
import type { WorkspaceTransitionState } from '@/lib/workspace-transition'

export interface AppShellContextType {
  // Data
  // NOTE: sessions is NOT included here - use sessionMetaMapAtom for listing
  // and useSession(id) hook for individual sessions. This prevents closures
  // from retaining the full messages array and causing memory leaks.
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  /** Explicit renderer transition boundary for workspace-owned layout state. */
  workspaceTransition: WorkspaceTransitionState | null
  /** True after the active workspace session list has loaded authoritatively. */
  sessionsLoaded: boolean
  /** Workspace slug for SDK skill qualification (derived from workspace path) */
  activeWorkspaceSlug: string | null
  /** Pi providers and global provider/model defaults. */
  piProviders: PiGlobalProviderForDisplay[]
  piGlobalSettings: PiGlobalSettings
  refreshPiGlobalConfig: () => Promise<void>
  pendingPermissions: Map<string, PermissionRequest[]>
  /** Get draft input text for a session - reads from ref without triggering re-renders */
  getDraft: (sessionId: string) => string
  /** Get persisted attachment refs (path + name) for a session's draft - no file IO */
  getDraftAttachmentRefs: (sessionId: string) => import('@mortise/shared/config').DraftAttachmentRef[]
  /** Hydrate persisted attachment refs into full FileAttachment objects (async, reads files) */
  hydrateDraftAttachments: (sessionId: string) => Promise<FileAttachment[]>
  /** All skills for this workspace - provided by AppShell component (for @mentions) */
  skills?: LoadedSkill[]
  /** Working directory of the active session — needed for project-level skill resolution */
  activeSessionWorkingDirectory?: string
  /** Enabled permission modes for Shift+Tab cycling */
  enabledModes?: PermissionMode[]

  /** Pi extension input currently replacing the composer for its owning session. */
  remoteUIRequest?: ExtensionUIRequest | null
  respondRemoteUI?: (payload: ExtensionUIResponse, reason?: RemoteUICancelReason) => void

  // Unified session options map
  /** All session-scoped options in one map. Use useSessionOptionsFor() hook for easy access. */
  sessionOptions: Map<string, SessionOptions>

  // Session callbacks
  onCreateSession: (workspaceId: string, options?: import('../../shared/types').CreateSessionOptions) => Promise<Session>
  onCreateAndSendFirstTurn: (
    input: Omit<CreateAndSendFirstTurnRequest, 'storedAttachments' | 'attachmentStagingId'>,
  ) => Promise<CreateAndSendFirstTurnResult>
  onSendMessage: (sessionId: string, message: string, attachments?: FileAttachment[], skillSlugs?: string[], badges?: import('@mortise/core').ContentBadge[], midStreamSendIntent?: MidStreamSendIntent) => Promise<boolean>
  onRenameSession: (sessionId: string, name: string) => void
  onMarkSessionRead: (sessionId: string) => void
  onMarkSessionUnread: (sessionId: string) => void
  /** Track which session user is viewing (for unread state machine) */
  onSetActiveViewingSession: (sessionId: string) => void
  onDeleteSession: (sessionId: string, skipConfirmation?: boolean) => Promise<boolean>

  // Permission handling
  onRespondToPermission?: (
    sessionId: string,
    requestId: string,
    allowed: boolean,
    alwaysAllow: boolean,
    options?: import('../../shared/types').PermissionResponseOptions
  ) => void

  // File/URL handlers - these can open in tabs or external apps
  onOpenFile: (path: string) => void
  onOpenUrl: (url: string) => void

  // Workspace
  onSelectWorkspace: WorkspaceSelectHandler
  workspaceNavigation?: WorkspaceNavigationModel
  onRefreshWorkspaces?: () => void | Promise<void>

  // App actions
  onOpenSettings: () => void
  onOpenKeyboardShortcuts: () => void
  onOpenStoredUserPreferences: () => void

  // Unified session options callback
  onSessionOptionsChange: (sessionId: string, updates: SessionOptionUpdates) => void

  // Input draft callback
  onInputChange: (sessionId: string, value: string) => void

  // Attachment draft callback — persists attachment refs per session
  onAttachmentsChange: (sessionId: string, attachments: FileAttachment[]) => void

  // Open a new chat with optional agent, name, and pre-filled input
  openNewChat?: (params?: NewChatActionParams) => Promise<void>

  // Optional trailing action rendered in page headers.
  panelHeaderTrailingAction?: React.ReactNode

  // Leading action button for panel header (e.g., back button in compact mode)
  leadingAction?: React.ReactNode

  /** Whether this panel is the focused panel (for multi-panel visual differentiation) */
  isFocusedPanel?: boolean

  /** Whether the shell is currently in compact/narrow mode */
  isCompactMode?: boolean

  // Session list search state (for ChatDisplay highlighting)
  /** Current search query from session list - used to highlight matches in ChatDisplay */
  sessionListSearchQuery?: string
  /** Whether search mode is active (prevents focus stealing to chat input even with empty query) */
  isSearchModeActive?: boolean
  /** Callback to update session list search query */
  setSessionListSearchQuery?: (query: string) => void
  /** Ref to ChatDisplay for navigation between matches */
  chatDisplayRef?: React.RefObject<ChatDisplayHandle>
  /** Callback when ChatDisplay match info changes (for immediate UI updates) */
  onChatMatchInfoChange?: (info: { sessionId: string | null; count: number; index: number; isHighlighting: boolean }) => void

  // Automation management
  /** Test an automation by ID — executes its actions and returns results */
  onTestAutomation?: (automationId: string) => void
  /** Toggle an automation's enabled state by ID */
  onToggleAutomation?: (automationId: string) => void
  /** Duplicate an automation by ID — clones config with " Copy" suffix */
  onDuplicateAutomation?: (automationId: string) => void
  /** Delete an automation by ID — removes from automations config */
  onDeleteAutomation?: (automationId: string) => void
  /** Map of automationId → last test result */
  automationTestResults?: Record<string, import('../components/automations/types').TestResult>
  /** Fetch execution history for an automation by ID */
  getAutomationHistory?: (automationId: string) => Promise<import('../components/automations/types').ExecutionEntry[]>
  /** Replay (re-execute) webhook actions for a failed automation */
  onReplayAutomation?: (automationId: string, event: string) => void
}

const AppShellContext = createContext<AppShellContextType | null>(null)

export function AppShellProvider({
  children,
  value,
}: {
  children: React.ReactNode
  value: AppShellContextType
}) {
  return <AppShellContext.Provider value={value}>{children}</AppShellContext.Provider>
}

/** Returns context or null if outside provider (safe for optional consumers like playground) */
export function useOptionalAppShellContext(): AppShellContextType | null {
  return useContext(AppShellContext)
}

export function useAppShellContext(): AppShellContextType {
  const context = useContext(AppShellContext)
  if (!context) {
    throw new Error('useAppShellContext must be used within an AppShellProvider')
  }
  return context
}

/**
 * Get a specific session by ID using per-session atoms
 * This hook only re-renders when the specific session changes,
 * not when other sessions change (solves streaming isolation)
 */
export function useSession(sessionId: string): Session | null {
  // Use per-session atom for isolated updates
  return useAtomValue(sessionAtomFamily(sessionId))
}

/**
 * Get the active workspace
 */
export function useActiveWorkspace(): Workspace | null {
  const { workspaces, activeWorkspaceId } = useAppShellContext()
  if (!activeWorkspaceId) return null
  return workspaces.find((w) => w.id === activeWorkspaceId) || null
}

/**
 * Get pending permission for a session (first in queue)
 */
export function usePendingPermission(sessionId: string): PermissionRequest | undefined {
  const { pendingPermissions } = useAppShellContext()
  return pendingPermissions.get(sessionId)?.[0]
}

/**
 * Hook to get and update session options for a specific session.
 * This is the primary way components should access session options.
 *
 * Usage:
 *   const { options, setPermissionMode } = useSessionOptionsFor(sessionId)
 *   setPermissionMode('safe')
 */
export function useSessionOptionsFor(sessionId: string): {
  options: SessionOptions
  setOption: <K extends keyof SessionOptions>(key: K, value: SessionOptions[K]) => void
  setOptions: (updates: SessionOptionUpdates) => void
  setPermissionMode: (mode: PermissionMode) => void
  isSafeModeActive: () => boolean
} {
  const { sessionOptions, onSessionOptionsChange } = useAppShellContext()

  const options = sessionOptions.get(sessionId) ?? defaultSessionOptions

  const setOption = useCallback(<K extends keyof SessionOptions>(
    key: K,
    value: SessionOptions[K]
  ) => {
    onSessionOptionsChange(sessionId, { [key]: value })
  }, [sessionId, onSessionOptionsChange])

  const setOptions = useCallback((updates: SessionOptionUpdates) => {
    onSessionOptionsChange(sessionId, updates)
  }, [sessionId, onSessionOptionsChange])

  const setPermissionMode = useCallback((mode: PermissionMode) => {
    setOption('permissionMode', mode)
  }, [setOption])

  const isSafeModeActive = useCallback(() => {
    return options.permissionMode === 'safe'
  }, [options.permissionMode])

  return {
    options,
    setOption,
    setOptions,
    setPermissionMode,
    isSafeModeActive,
  }
}
