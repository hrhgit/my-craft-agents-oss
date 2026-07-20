import * as React from "react"
import { useTranslation, Trans } from "react-i18next"
import { useRef, useState, useEffect, useCallback, useMemo } from "react"
import { useAtomValue, useStore } from "jotai"
import {
  Archive,
  Settings,
  ChevronRight,
  ChevronDown,
  MoreHorizontal,
  RotateCw,
  Flag,
  ListFilter,
  Tag,
  X,
  Search,
  Plus,
  Trash2,
  Zap,
  MessageSquare,
  Calendar,
  Layers,
  ListTodo,
  Info,
  MailOpen,
  Cloud,
  CloudOff,
  Folder,
  FolderOpen,
  FolderPlus,
} from "lucide-react"
import { TopBar } from "./TopBar"
import { WorkspaceCoordinationStatusPopover } from "./WorkspaceCoordinationStatusPopover"
import { SquarePenRounded } from "../icons/SquarePenRounded"
import { cn } from "@/lib/utils"
import { isMac } from "@/lib/platform"
import { Button } from "@/components/ui/button"
import { HeaderIconButton } from "@/components/ui/HeaderIconButton"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipTrigger, TooltipContent, Spinner } from "@mortise/ui"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuSub,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
  StyledDropdownMenuSeparator,
  StyledDropdownMenuSubTrigger,
  StyledDropdownMenuSubContent,
} from "@/components/ui/styled-dropdown"
import {
  ContextMenu,
  ContextMenuTrigger,
  StyledContextMenuContent,
} from "@/components/ui/styled-context-menu"
import { ContextMenuProvider } from "@/components/ui/menu-context"
import { SidebarMenu } from "./SidebarMenu"
import { ScrollArea } from "@/components/ui/scroll-area"
import { FadingText } from "@/components/ui/fading-text"
import {
  Collapsible,
  CollapsibleTrigger,
  AnimatedCollapsibleContent,
  springTransition as collapsibleSpring,
} from "@/components/ui/collapsible"
import { SessionList, type ChatGroupingMode } from "./SessionList"
import { SessionMenu } from "./SessionMenu"
import { MainContentPanel } from "./MainContentPanel"
import { RootSurfaceContainer } from "./RootSurfaceContainer"
import { PageNavigationSurface } from "./PageNavigationSurface"
import type { ChatDisplayHandle } from "./ChatDisplay"
import { LeftSidebar, type LinkItem as LeftSidebarLinkItem } from "./LeftSidebar"
import { ExtensionContributionZone } from "@/components/extensions/ExtensionContributionZone"
import { useSessionSelectionStore } from "@/hooks/useSession"
import { createInitialState } from "@/hooks/useMultiSelect"
import { ensureSessionMessagesLoadedAtom, sessionAtomFamily } from "@/atoms/sessions"
import { AppShellProvider, type AppShellContextType } from "@/context/AppShellContext"
import { WorkspaceElectronApiProvider } from "@/context/WorkspaceElectronApiContext"
import { EscapeInterruptProvider, useEscapeInterrupt } from "@/context/EscapeInterruptContext"
import { useTheme } from "@/context/ThemeContext"
import { getResizeGradientStyle } from "@/hooks/useResizeGradient"
import { useAction, useActionLabel } from "@/actions"
import { useFocusZone } from "@/hooks/keyboard"
import { useFocusContext } from "@/context/FocusContext"
import { getSessionTitle } from "@/utils/session"
import { useSetAtom } from "jotai"
import type { Session, Workspace, FileAttachment, PermissionRequest, LoadedSkill, PermissionMode, AutomationFilter } from "../../../shared/types"
import { sessionMetaMapAtom, sendToWorkspaceAtom, type SessionMeta } from "@/atoms/sessions"
import { piProjectionIsProcessingAtomFamily } from "@/atoms/pi-projection"
import { skillsAtom } from "@/atoms/skills"
import { activeDockTabIdAtom, activeDockTabProtectionAtom, activeDockTabTypeAtom, emptyDockPageSessionRequestAtom, enterCompactDockDetailAtom, exitCompactDockDetailAtom, isEmptyDockPageTabId, panelStackAtom, panelCountAtom, focusedSessionIdAtom, focusNextPanelAtom, focusPrevPanelAtom, resetCompactDockViewIntentAtom, shouldReplaceActiveTabWithSession } from "@/atoms/panel-stack"
import { useContainerWidth } from "@/hooks/useContainerWidth"
import { resolveEntityColor } from "@mortise/shared/colors"
import * as storage from "@/lib/local-storage"
import { isDetailNavState } from "@/lib/nav-helpers"
import { toast } from "sonner"
import { navigate, routes } from "@/lib/navigate"
import {
  useNavigation,
  useNavigationState,
  isSessionsNavigation,
  isSettingsNavigation,
  isSkillsNavigation,
  isAutomationsNavigation,
  type NavigationState,
} from "@/contexts/NavigationContext"
import type { SettingsSubpage } from "../../../shared/types"
import { SkillsListPanel } from "./SkillsListPanel"
import { AutomationsListPanel } from "../automations/AutomationsListPanel"
import { type AutomationFilterKind, AUTOMATION_TYPE_TO_FILTER_KIND } from "../automations/types"
import { useAutomations } from "@/hooks/useAutomations"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { RenameDialog } from "@/components/ui/rename-dialog"
import { PanelHeader } from "./PanelHeader"
import { FabNewChat } from "./FabNewChat"
import { SendToWorkspaceDialog } from "./SendToWorkspaceDialog"
import { MessagingDialogHost } from "@/components/messaging/MessagingDialogHost"
import { useRemoteUIRequests } from "@/hooks/useRemoteUIRequests"
import { EditPopover, getEditConfig } from "@/components/ui/EditPopover"
import SettingsNavigator from "@/pages/settings/SettingsNavigator"
import {
  PANEL_GAP,
  PANEL_EDGE_INSET,
  PANEL_SASH_HALF_HIT_WIDTH,
  PANEL_SASH_HIT_WIDTH,
  PANEL_SASH_LINE_WIDTH,
  PANEL_STACK_VERTICAL_OVERFLOW,
  RADIUS_EDGE,
  RADIUS_INNER,
} from "./panel-constants"
import { hasOpenOverlay } from "@/lib/overlay-detection"
import { dispatchFocusInputEvent } from "./input/focus-input-events"
import { useWorkspaceNavigation } from "@/components/workspace/useWorkspaceNavigation"
import { UnifiedDockWorkspace } from "./UnifiedDockWorkspace"
import {
  mergeWorkspaceSessionSummaries,
  RECENT_WORKSPACE_SESSION_LIMIT,
  removeWorkspaceSessionSummary,
  toWorkspaceSessionSummary,
  updateWorkspaceSessionSummary,
  type WorkspaceSessionSummary,
} from "./workspace-sidebar-model"

/**
 * AppShellProps - Minimal props interface for AppShell component
 *
 * Data and callbacks come via contextValue (AppShellContextType).
 * Only UI-specific state is passed as separate props.
 *
 * Adding new features:
 * 1. Add to AppShellContextType in context/AppShellContext.tsx
 * 2. Update App.tsx to include in contextValue
 * 3. Use via useAppShellContext() hook in child components
 */
interface AppShellProps {
  /** All data and callbacks - passed directly to AppShellProvider */
  contextValue: AppShellContextType
  /** UI-specific props */
  defaultLayout?: number[]
  defaultCollapsed?: boolean
  menuNewChatTrigger?: number
  /** Focused mode - hides sidebars, shows only the chat content */
  isFocusedMode?: boolean
}

const SIDEBAR_DEFAULT_WIDTH = 260
const PAGE_NAVIGATION_WIDTH = 300
const SIDEBAR_MIN_WIDTH = 200
const SIDEBAR_MAX_WIDTH = 320

function clampSidebarWidth(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return SIDEBAR_DEFAULT_WIDTH
  return Math.min(Math.max(Math.round(value), SIDEBAR_MIN_WIDTH), SIDEBAR_MAX_WIDTH)
}

export function AppShell(props: AppShellProps) {
  return (
    <EscapeInterruptProvider>
      <AppShellContent {...props} />
    </EscapeInterruptProvider>
  )
}

/**
 * AppShellContent - Inner component that contains all the AppShell logic
 * Separated to allow useEscapeInterrupt hook to work (must be inside provider)
 */
function AppShellContent({
  contextValue,
  defaultLayout = [20, 32, 48],
  defaultCollapsed = false,
  menuNewChatTrigger,
  isFocusedMode = false,
}: AppShellProps) {
  // Destructure commonly used values from context
  // Note: sessions is NOT destructured here - we use sessionMetaMapAtom instead
  // to prevent closures from retaining the full messages array
  const {
    workspaces,
    activeWorkspaceId,
    workspaceTransition,
    sessionsLoaded,
    sessionOptions,
    onSelectWorkspace,
    onRefreshWorkspaces,
    onDeleteSession,
    onMarkSessionRead,
    onMarkSessionUnread,
    onRenameSession,
    onOpenSettings,
    onOpenKeyboardShortcuts,
    onOpenStoredUserPreferences,
    onSendMessage,
    openNewChat,
    pendingPermissions,
  } = contextValue

  const { t } = useTranslation()

  // Get hotkey labels from centralized action registry
  const newChatHotkey = useActionLabel('app.newChat').hotkey

  const [isSidebarVisible, setIsSidebarVisible] = React.useState(() => {
    return storage.get(storage.KEYS.sidebarVisible, !defaultCollapsed)
  })
  const [sidebarWidth, setSidebarWidth] = React.useState(() => {
    return clampSidebarWidth(storage.get(storage.KEYS.sidebarWidth, SIDEBAR_DEFAULT_WIDTH))
  })
  const [canvasLayoutToggleRequest, setCanvasLayoutToggleRequest] = React.useState(0)
  const [isCanvasLayoutFocused, setIsCanvasLayoutFocused] = React.useState(false)
  const enterCompactDockDetail = useSetAtom(enterCompactDockDetailAtom)
  const exitCompactDockDetail = useSetAtom(exitCompactDockDetailAtom)
  const resetCompactDockViewIntent = useSetAtom(resetCompactDockViewIntentAtom)

  // Focus mode hides the primary sidebar (CMD+. toggle).
  // Seed from either focused window param or persisted preference, then keep it toggleable.
  const [isFocusMode, setIsFocusMode] = React.useState(() => {
    return isFocusedMode || storage.get(storage.KEYS.focusModeEnabled, false)
  })

  // Auto-compact mode: shell width below mobile threshold hides the primary
  // sidebar and switches to single-surface mode. Works in both webui and
  // desktop (narrow window or small screen).
  const shellRef = useRef<HTMLDivElement>(null)
  const shellWidth = useContainerWidth(shellRef)
  const MOBILE_THRESHOLD = 768
  const isAutoCompact = shellWidth > 0 && shellWidth < MOBILE_THRESHOLD
  const togglePanelLayout = React.useCallback(() => {
    if (isAutoCompact) enterCompactDockDetail()
    setCanvasLayoutToggleRequest(value => value + 1)
  }, [enterCompactDockDetail, isAutoCompact])

  const compactIntentWorkspace = useRef(activeWorkspaceId)
  React.useEffect(() => {
    if (compactIntentWorkspace.current === activeWorkspaceId) return
    compactIntentWorkspace.current = activeWorkspaceId
    resetCompactDockViewIntent()
  }, [activeWorkspaceId, resetCompactDockViewIntent])

  const isPrimarySidebarHidden = isFocusMode || isAutoCompact

  const [isResizing, setIsResizing] = React.useState<'sidebar' | null>(null)
  const [sidebarHandleY, setSidebarHandleY] = React.useState<number | null>(null)
  const resizeHandleRef = React.useRef<HTMLDivElement>(null)
  const { state: session, setState: setSession } = useSessionSelectionStore()
  const { resolvedMode, isDark, setMode } = useTheme()
  const { canGoBack, canGoForward, goBack, goForward, navigateToSession } = useNavigation()

  // Double-Esc interrupt feature: first Esc shows warning, second Esc interrupts
  const { handleEscapePress } = useEscapeInterrupt()

  // Visible root-page or focused workspace navigation state.
  const navState = useNavigationState()

  const store = useStore()
  const requestEmptyDockPageSession = useSetAtom(emptyDockPageSessionRequestAtom)
  const panelStack = useAtomValue(panelStackAtom)
  const panelCount = useAtomValue(panelCountAtom)
  const focusedSessionId = useAtomValue(focusedSessionIdAtom)

  // Replace only an actively selected session tab. Every other tab type keeps
  // its content and receives the requested session in a new tab.
  const navigateToSessionInPanel = useCallback((sessionId: string) => {
    enterCompactDockDetail()
    const activeTabId = store.get(activeDockTabIdAtom)
    if (isEmptyDockPageTabId(activeTabId)) {
      requestEmptyDockPageSession({ tabId: activeTabId, sessionId })
      return
    }
    if (shouldReplaceActiveTabWithSession(
      store.get(activeDockTabTypeAtom),
      store.get(activeDockTabProtectionAtom),
    )) {
      navigateToSession(sessionId)
      return
    }
    navigate(routes.view.allSessions(sessionId), { newPanel: true })
  }, [enterCompactDockDetail, requestEmptyDockPageSession, store, navigateToSession])

  const sessionsContext = React.useMemo(() => {
    if (isSessionsNavigation(navState)) {
      return {
        filter: navState.filter,
        sessionId: navState.details?.type === 'session' ? navState.details.sessionId : null,
      }
    }
    return null
  }, [navState])

  const sessionFilter = sessionsContext?.filter ?? null

  // Derive automation filter from navigation state (only when in automations navigator)
  const automationFilter: AutomationFilter | null = isAutomationsNavigation(navState) ? navState.filter ?? null : null

  // Search state for session list
  const [searchActive, setSearchActive] = React.useState(false)
  const [searchQuery, setSearchQuery] = React.useState('')

  const chatGroupingMode: ChatGroupingMode = 'date'

  // Ref for ChatDisplay navigation (exposed via forwardRef)
  const chatDisplayRef = React.useRef<ChatDisplayHandle>(null)
  // Track match count and index from ChatDisplay (for SessionList navigation UI)
  const [chatMatchInfo, setChatMatchInfo] = React.useState<{ sessionId: string | null; count: number; index: number; isHighlighting?: boolean }>({ sessionId: null, count: 0, index: 0 })

  // Callback for immediate match info updates from ChatDisplay
  // Memo guard prevents render feedback loops from identical updates
  const handleChatMatchInfoChange = React.useCallback((info: { sessionId: string | null; count: number; index: number; isHighlighting: boolean }) => {
    setChatMatchInfo(prev => {
      if (prev.sessionId === info.sessionId && prev.count === info.count && prev.index === info.index && prev.isHighlighting === info.isHighlighting) {
        return prev
      }
      return info
    })
  }, [])

  // Reset match info when search is deactivated
  React.useEffect(() => {
    if (!searchActive || !searchQuery) {
      setChatMatchInfo({ sessionId: null, count: 0, index: 0 })
    }
  }, [searchActive, searchQuery])

  // Reset search only when navigator or filter changes (not when selecting sessions)
  const navFilterKey = React.useMemo(() => {
    if (isSessionsNavigation(navState)) {
      const filter = navState.filter
      return `chats:${filter.kind}`
    }
    return navState.navigator
  }, [navState])

  React.useEffect(() => {
    setSearchActive(false)
    setSearchQuery('')
  }, [navFilterKey])

  // Cmd+F to activate search
  useAction('app.search', () => setSearchActive(true))

  // Unified sidebar keyboard navigation state
  // Load expanded folders from localStorage (default: all collapsed)
  const [expandedFolders, setExpandedFolders] = React.useState<Set<string>>(() => {
    const saved = storage.get<string[]>(storage.KEYS.expandedFolders, [])
    return new Set(saved)
  })
  const [focusedSidebarItemId, setFocusedSidebarItemId] = React.useState<string | null>(null)
  const sidebarItemRefs = React.useRef<Map<string, HTMLElement>>(new Map())
  const [collapsedWorkspaceIds, setCollapsedWorkspaceIds] = React.useState<Set<string>>(() => {
    return new Set(storage.get<string[]>(storage.KEYS.collapsedWorkspaceSections, []))
  })
  const [workspaceSessionSummaries, setWorkspaceSessionSummaries] = React.useState<Record<string, WorkspaceSessionSummary[]>>({})
  const [workspaceSessionLimits, setWorkspaceSessionLimits] = React.useState<Record<string, number>>({})
  const [sidebarRenameTarget, setSidebarRenameTarget] = React.useState<{
    workspaceId: string
    session: WorkspaceSessionSummary
  } | null>(null)
  const [sidebarRenameName, setSidebarRenameName] = React.useState('')
  const toggleWorkspaceExpanded = React.useCallback((workspaceId: string) => {
    setCollapsedWorkspaceIds(prev => {
      const next = new Set(prev)
      if (next.has(workspaceId)) next.delete(workspaceId)
      else next.add(workspaceId)
      return next
    })
  }, [])
  const showMoreWorkspaceSessions = React.useCallback((workspaceId: string) => {
    setWorkspaceSessionLimits(previous => ({
      ...previous,
      [workspaceId]: (previous[workspaceId] ?? RECENT_WORKSPACE_SESSION_LIMIT) + 15,
    }))
  }, [])
  // Skills state (workspace-scoped)
  const [skills, setSkills] = React.useState<LoadedSkill[]>([])
  // Sync skills to atom for NavigationContext auto-selection
  const setSkillsAtom = useSetAtom(skillsAtom)
  React.useEffect(() => {
    setSkillsAtom(skills)
  }, [skills, setSkillsAtom])
  // Automations — state, handlers, loading, subscriptions
  const activeWorkspace = workspaces.find(w => w.id === activeWorkspaceId)

  // Send to Workspace dialog state (driven by sendToWorkspaceAtom set from SessionMenu/BatchSessionMenu)
  const sendToWorkspaceIds = useAtomValue(sendToWorkspaceAtom)
  const setSendToWorkspaceIds = useSetAtom(sendToWorkspaceAtom)
  const handleTransferComplete = useCallback((targetWorkspaceId: string, _newSessionIds: string[]) => {
    onSelectWorkspace(targetWorkspaceId)
  }, [onSelectWorkspace])
  const {
    automations, automationTestResults,
    automationPendingDelete, pendingDeleteAutomation, setAutomationPendingDelete,
    handleTestAutomation, handleToggleAutomation, handleDuplicateAutomation, handleDeleteAutomation, confirmDeleteAutomation,
    getAutomationHistory, handleReplayAutomation,
  } = useAutomations(activeWorkspaceId)

  // Enabled permission modes for Shift+Tab cycling (min 2 modes)
  const [enabledModes, setEnabledModes] = React.useState<PermissionMode[]>(['safe', 'ask', 'allow-all'])

  // Load workspace settings for cyclable permission modes.
  React.useEffect(() => {
    if (!activeWorkspaceId) return
    let cancelled = false
    window.electronAPI.getWorkspaceSettings(activeWorkspaceId).then((settings) => {
      if (!cancelled && settings) {
        // Load cyclablePermissionModes from workspace settings
        if (settings.cyclablePermissionModes && settings.cyclablePermissionModes.length >= 2) {
          setEnabledModes(settings.cyclablePermissionModes)
        }
      }
    }).catch((err) => {
      if (!cancelled) console.error('[Chat] Failed to load workspace settings:', err)
    })
    return () => { cancelled = true }
  }, [activeWorkspaceId])

  // Reset UI state when workspace changes
  // This prevents stale search queries, focused items, and filter state from persisting
  const previousWorkspaceRef = React.useRef<string | null>(null)
  React.useEffect(() => {
    if (!activeWorkspaceId) return

    const previousWorkspaceId = previousWorkspaceRef.current

    // Clear transient UI state only on workspace SWITCH (not initial mount)
    if (previousWorkspaceId !== null && previousWorkspaceId !== activeWorkspaceId) {
      // Clear search state
      setSearchActive(false)
      setSearchQuery('')

      // Clear focused sidebar item
      setFocusedSidebarItemId(null)
    }

    // Load workspace-scoped state on BOTH initial mount AND workspace switch
    // This fixes CMD+R losing filters - previously only ran on workspace switch
    if (previousWorkspaceId !== activeWorkspaceId) {
      const newExpandedFolders = storage.get<string[]>(storage.KEYS.expandedFolders, [], activeWorkspaceId)
      setExpandedFolders(new Set(newExpandedFolders))

    }

    previousWorkspaceRef.current = activeWorkspaceId
  }, [activeWorkspaceId])

  // Subscribe to live skill updates (when skills are added/removed dynamically)
  React.useEffect(() => {
    const cleanup = window.electronAPI.onSkillsChanged((workspaceId, updatedSkills) => {
      if (workspaceId !== activeWorkspaceId) return
      setSkills(updatedSkills || [])
    })
    return cleanup
  }, [activeWorkspaceId])

  // Ensure session messages are loaded when selected
  const ensureMessagesLoaded = useSetAtom(ensureSessionMessagesLoadedAtom)

  // Handle selecting a skill from the list
  const handleSkillSelect = React.useCallback((skill: LoadedSkill) => {
    if (!activeWorkspaceId) return
    enterCompactDockDetail()
    navigate(routes.view.skills(skill.slug))
  }, [activeWorkspaceId, enterCompactDockDetail, navigate])

  // Handle selecting an automation from the list
  const handleAutomationSelect = React.useCallback((automationId: string) => {
    enterCompactDockDetail()
    // Preserve current automation filter when selecting an automation
    const type = isAutomationsNavigation(navState) ? navState.filter?.automationType : undefined
    navigate(routes.view.automations({ automationId, type }))
  }, [enterCompactDockDetail, navState, navigate])

  // Focus zone management
  const { focusZone, focusNextZone, focusPreviousZone } = useFocusContext()

  // Register focus zones
  const { zoneRef: sidebarRef, isFocused: sidebarFocused } = useFocusZone({ zoneId: 'sidebar' })

  // Global keyboard shortcuts using centralized action registry
  // Actions are defined in @/actions/definitions.ts

  // Zone navigation - explicit keyboard intent, always move DOM focus
  useAction('nav.focusSidebar', () => focusZone('sidebar', { intent: 'keyboard' }))
  useAction('nav.focusNavigator', () => focusZone('navigator', { intent: 'keyboard' }))
  useAction('nav.focusChat', () => focusZone('chat', { intent: 'keyboard' }))

  // Tab navigation between zones
  useAction('nav.nextZone', () => {
    focusNextZone()
  }, { enabled: () => !document.querySelector('[role="dialog"]') })

  // Shift+Tab cycles permission mode through enabled modes (textarea handles its own, this handles when focus is elsewhere)
  // In multi-panel, targets the focused panel's session
  const effectiveSessionId = focusedSessionId ?? session.selected
  const effectiveSessionIsProcessing = useAtomValue(
    piProjectionIsProcessingAtomFamily(effectiveSessionId ?? ''),
  )
  // Pi extension dialogs are visible only for the active session. Requests for
  // other sessions remain queued until that session becomes active.
  const {
    currentRequest: remoteUIRequest,
    respond: respondRemoteUI,
  } = useRemoteUIRequests(effectiveSessionId)

  // Focus chat input for the target session only (multi-panel safe).
  const focusChatInputForSession = useCallback((targetSessionId?: string | null) => {
    if (!targetSessionId) return
    dispatchFocusInputEvent({ sessionId: targetSessionId })
  }, [])

  useAction('chat.cyclePermissionMode', () => {
    if (effectiveSessionId) {
      const currentOptions = contextValue.sessionOptions.get(effectiveSessionId)
      const currentMode = currentOptions?.permissionMode ?? 'ask'
      // Cycle through enabled permission modes
      const modes = enabledModes.length >= 2 ? enabledModes : ['safe', 'ask', 'allow-all'] as PermissionMode[]
      const currentIndex = modes.indexOf(currentMode)
      // If current mode not in enabled list, jump to first enabled mode
      const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % modes.length
      const nextMode = modes[nextIndex]
      contextValue.onSessionOptionsChange(effectiveSessionId, { permissionMode: nextMode })
    }
  })

  const handleToggleSidebar = useCallback(() => {
    if (isFocusMode) {
      setIsFocusMode(false)
      return
    }
    setIsSidebarVisible(v => !v)
  }, [isFocusMode])

  // Sidebar toggle (CMD+B)
  useAction('view.toggleSidebar', handleToggleSidebar)

  // Focus mode toggle (CMD+.) - hides both sidebars
  useAction('view.toggleFocusMode', () => setIsFocusMode(v => !v))

  // Panel focus navigation (CMD+SHIFT+[ / ])
  const focusNextPanel = useSetAtom(focusNextPanelAtom)
  const focusPrevPanel = useSetAtom(focusPrevPanelAtom)
  useAction('panel.focusNext', focusNextPanel, { enabled: () => panelCount > 1 })
  useAction('panel.focusPrev', focusPrevPanel, { enabled: () => panelCount > 1 })

  // New chat
  useAction('app.newChat', () => handleNewChat())
  useAction('app.newChatInPanel', () => handleNewChat(true))

  // Settings
  useAction('app.settings', onOpenSettings)

  // Keyboard shortcuts
  useAction('app.keyboardShortcuts', onOpenKeyboardShortcuts)

  // New window
  useAction('app.newWindow', () => window.electronAPI.menuNewWindow())

  // Quit (note: also handled by native menu on macOS)
  useAction('app.quit', () => window.electronAPI.menuQuit())

  // History navigation
  useAction('nav.goBack', goBack)
  useAction('nav.goForward', goForward)

  // History navigation (arrow key alternatives)
  useAction('nav.goBackAlt', goBack)
  useAction('nav.goForwardAlt', goForward)

  // Search match navigation (CMD+G next, CMD+SHIFT+G prev)
  useAction('chat.nextSearchMatch', () => chatDisplayRef.current?.goToNextMatch(), {
    enabled: () => searchActive && (chatMatchInfo.count ?? 0) > 0
  })
  useAction('chat.prevSearchMatch', () => chatDisplayRef.current?.goToPrevMatch(), {
    enabled: () => searchActive && (chatMatchInfo.count ?? 0) > 0
  })

  // ESC to stop processing - requires double-press within 1 second
  // First press shows warning overlay, second press interrupts
  // In multi-panel, targets the focused panel's session
  useAction('chat.stopProcessing', () => {
    if (effectiveSessionId && effectiveSessionIsProcessing) {
      // handleEscapePress returns true on second press (within timeout)
      const shouldInterrupt = handleEscapePress()
      if (shouldInterrupt) {
        window.electronAPI.cancelProcessing(effectiveSessionId, false).catch(err => {
          console.error('[AppShell] Failed to cancel processing:', err)
        })
      }
    }
  }, {
    // Only active when no overlay is open and session is processing
    // Overlays (dialogs, menus, popovers, etc.) should handle their own Escape
    enabled: () => {
      if (hasOpenOverlay()) return false
      if (!effectiveSessionId) return false
      return effectiveSessionIsProcessing
    }
  }, [effectiveSessionId, effectiveSessionIsProcessing, handleEscapePress])

  // Theme toggle (CMD+SHIFT+A)
  useAction('app.toggleTheme', () => setMode(resolvedMode === 'dark' ? 'light' : 'dark'))

  // Global paste listener for file attachments
  // Fires when Cmd+V is pressed anywhere in the app (not just textarea)
  React.useEffect(() => {
    const handleGlobalPaste = (e: ClipboardEvent) => {
      // Skip if a dialog or menu is open
      if (document.querySelector('[role="dialog"], [role="menu"]')) {
        return
      }

      // Skip if there are no files in the clipboard
      const files = e.clipboardData?.files
      if (!files || files.length === 0) return

      // Skip if the active element is an input/textarea/contenteditable (let it handle paste directly)
      const activeElement = document.activeElement as HTMLElement | null
      if (
        activeElement?.tagName === 'TEXTAREA' ||
        activeElement?.tagName === 'INPUT' ||
        activeElement?.isContentEditable
      ) {
        return
      }

      // Prevent default paste behavior
      e.preventDefault()

      // Dispatch custom event for FreeFormInput to handle (target focused session only)
      const filesArray = Array.from(files)
      const targetSessionId = focusedSessionId ?? session.selected
      if (!targetSessionId) return
      window.dispatchEvent(new CustomEvent('mortise:paste-files', {
        detail: { files: filesArray, sessionId: targetSessionId }
      }))
    }

    document.addEventListener('paste', handleGlobalPaste)
    return () => document.removeEventListener('paste', handleGlobalPaste)
  }, [focusedSessionId, session.selected])

  // Resize effect for the primary workspace sidebar.
  React.useEffect(() => {
    if (!isResizing) return

    const handleMouseMove = (e: MouseEvent) => {
      if (isResizing === 'sidebar') {
        const newWidth = clampSidebarWidth(e.clientX)
        setSidebarWidth(newWidth)
        if (resizeHandleRef.current) {
          const rect = resizeHandleRef.current.getBoundingClientRect()
          setSidebarHandleY(e.clientY - rect.top)
        }
      }
    }

    const handleMouseUp = () => {
      if (isResizing === 'sidebar') {
        storage.set(storage.KEYS.sidebarWidth, sidebarWidth)
        setSidebarHandleY(null)
      }
      setIsResizing(null)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [
    isResizing,
    sidebarWidth,
  ])

  // Use session metadata from Jotai atom (lightweight, no messages)
  // This prevents closures from retaining full message arrays
  const sessionMetaMap = useAtomValue(sessionMetaMapAtom)
  const hasPendingPrompt = React.useCallback((sessionId: string) => {
    return (pendingPermissions.get(sessionId)?.length ?? 0) > 0
  }, [pendingPermissions])

  // Workspace-level unread and processing indicators for the desktop tree and compact menu.
  const [workspaceUnreadMap, setWorkspaceUnreadMap] = useState<Record<string, boolean>>({})
  const [workspaceProcessingMap, setWorkspaceProcessingMap] = useState<Record<string, boolean>>({})

  const workspaceNavigation = useWorkspaceNavigation({
    workspaces,
    activeWorkspaceId,
    workspaceUnreadMap,
    workspaceProcessingMap,
    onSelectWorkspace,
    onRefreshWorkspaces,
  })
  const refreshWorkspaceRemoteHealth = workspaceNavigation.refreshRemoteHealth

  React.useEffect(() => {
    storage.set(storage.KEYS.collapsedWorkspaceSections, [...collapsedWorkspaceIds])
  }, [collapsedWorkspaceIds])

  React.useEffect(() => {
    refreshWorkspaceRemoteHealth()
  }, [refreshWorkspaceRemoteHealth])

  // Skills are scoped to the workspace root under complete-unification semantics.
  // Keep the legacy variable name for downstream DTO compatibility.
  const activeSessionWorkingDirectory = activeWorkspace?.rootPath
  React.useEffect(() => {
    if (!activeWorkspaceId) return
    let cancelled = false
    setSkills([])
    window.electronAPI.getSkills(activeWorkspaceId).then((loaded) => {
      if (!cancelled) setSkills(loaded || [])
    }).catch(err => {
      if (!cancelled) console.error('[Chat] Failed to load skills:', err)
    })
    return () => { cancelled = true }
  }, [activeWorkspaceId, activeWorkspace?.rootPath])

  // Filter session metadata by active workspace
  // Also exclude hidden sessions (mini-agent sessions) from all counts and lists
  // For remote workspaces, sessions have the remote workspace ID (not the local one),
  // so we match against both the local and remote workspace IDs.
  const remoteWorkspaceId = activeWorkspace?.remoteServer?.remoteWorkspaceId
  const workspaceSessionMetas = useMemo(() => {
    const metas = Array.from(sessionMetaMap.values())
    if (!activeWorkspaceId) return metas.filter(s => !s.hidden)
    return metas.filter(s =>
      !s.hidden && (s.workspaceId === activeWorkspaceId || (remoteWorkspaceId && s.workspaceId === remoteWorkspaceId))
    )
  }, [sessionMetaMap, activeWorkspaceId, remoteWorkspaceId])

  const activeSessionMetas = workspaceSessionMetas

  React.useEffect(() => {
    if (!activeWorkspaceId || !sessionsLoaded) return
    const summaries = workspaceSessionMetas
      .map(toWorkspaceSessionSummary)
      .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0))
    setWorkspaceSessionSummaries(previous => mergeWorkspaceSessionSummaries(previous, activeWorkspaceId, summaries, true))
  }, [activeWorkspaceId, sessionsLoaded, workspaceSessionMetas])

  React.useEffect(() => {
    storage.remove(storage.KEYS.workspaceSessionSummaryCache)
  }, [])

  React.useEffect(() => {
    if (typeof window.electronAPI.invokeWorkspaceApi !== 'function') return
    let cancelled = false

    void Promise.all(workspaces.map(async workspace => {
      if (workspace.id === activeWorkspaceId) return null
      try {
        const sessions = await window.electronAPI.invokeWorkspaceApi(
          {
            serverId: workspace.remoteServer?.url ?? 'local',
            workspaceId: workspace.id,
          },
          'getSessions',
        ) as Session[]
        const allowedWorkspaceIds = new Set([
          workspace.id,
          workspace.remoteServer?.remoteWorkspaceId,
        ].filter((id): id is string => Boolean(id)))
        return [workspace.id, sessions
          .filter(session => !session.hidden && allowedWorkspaceIds.has(session.workspaceId))
          .map(toWorkspaceSessionSummary)
          .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0))] as const
      } catch (error) {
        console.warn(`[AppShell] Failed to load recent sessions for workspace ${workspace.id}:`, error)
        return null
      }
    })).then(entries => {
      if (cancelled) return
      setWorkspaceSessionSummaries(previous => {
        const currentWorkspaceIds = new Set(workspaces.map(workspace => workspace.id))
        const next = Object.fromEntries(Object.entries(previous).filter(([workspaceId]) => currentWorkspaceIds.has(workspaceId)))
        for (const entry of entries) {
          if (entry) next[entry[0]] = entry[1]
        }
        return next
      })
    })

    return () => { cancelled = true }
  }, [activeWorkspaceId, workspaces])

  const refreshWorkspaceUnreadMap = useCallback(async () => {
    try {
      const summary = await window.electronAPI.getUnreadSummary()
      const next: Record<string, boolean> = {}
      const nextProcessing: Record<string, boolean> = {}

      for (const workspace of workspaces) {
        next[workspace.id] = !!summary.hasUnreadByWorkspace[workspace.id]
        nextProcessing[workspace.id] = !!summary.hasProcessingByWorkspace?.[workspace.id]
        const remoteWorkspaceId = workspace.remoteServer?.remoteWorkspaceId
        if (remoteWorkspaceId && summary.hasProcessingByWorkspace?.[remoteWorkspaceId]) {
          nextProcessing[workspace.id] = true
        }
      }

      setWorkspaceUnreadMap(next)
      setWorkspaceProcessingMap(nextProcessing)
    } catch (error) {
      console.error('[AppShell] Failed to refresh workspace unread indicators:', error)
    }
  }, [workspaces])

  // Initial + workspace-list refresh
  useEffect(() => {
    void refreshWorkspaceUnreadMap()
  }, [refreshWorkspaceUnreadMap])

  // Keep active workspace unread indicator in sync with live metadata updates
  useEffect(() => {
    if (!activeWorkspaceId) return
    const activeHasUnread = activeSessionMetas.some((session) => !!session.hasUnread)
    setWorkspaceUnreadMap((prev) => ({ ...prev, [activeWorkspaceId]: activeHasUnread }))
  }, [activeWorkspaceId, activeSessionMetas])

  // Keep cross-workspace indicators in sync with global unread updates from main process
  useEffect(() => {
    const cleanup = window.electronAPI.onUnreadSummaryChanged((summary) => {
      const next: Record<string, boolean> = {}
      const nextProcessing: Record<string, boolean> = {}
      for (const workspace of workspaces) {
        next[workspace.id] = !!summary.hasUnreadByWorkspace[workspace.id]
        nextProcessing[workspace.id] = !!summary.hasProcessingByWorkspace?.[workspace.id]
        const remoteWorkspaceId = workspace.remoteServer?.remoteWorkspaceId
        if (remoteWorkspaceId && summary.hasProcessingByWorkspace?.[remoteWorkspaceId]) {
          nextProcessing[workspace.id] = true
        }
      }
      setWorkspaceUnreadMap(next)
      setWorkspaceProcessingMap(nextProcessing)
    })

    return cleanup
  }, [workspaces])

  const filteredSessionMetas = sessionFilter ? activeSessionMetas : []

  // Ensure session messages are loaded when selected
  React.useEffect(() => {
    if (session.selected) {
      ensureMessagesLoaded(session.selected)
    }
  }, [session.selected, ensureMessagesLoaded])

  // Wrap delete handler to clear selection when deleting the currently selected session
  // This prevents stale state during re-renders that could cause crashes
  const handleDeleteSession = useCallback(async (sessionId: string, skipConfirmation?: boolean): Promise<boolean> => {
    // Clear selection first if this is the selected session
    if (session.selected === sessionId) {
      setSession(createInitialState())
    }
    return onDeleteSession(sessionId, skipConfirmation)
  }, [session.selected, setSession, onDeleteSession])

  const handleSidebarSessionDelete = useCallback(async (
    workspaceId: string,
    summary: WorkspaceSessionSummary,
  ): Promise<boolean> => {
    const workspace = workspaces.find(candidate => candidate.id === workspaceId)
    if (!workspace) return false

    try {
      let deleted = false
      if (workspaceId === activeWorkspaceId) {
        deleted = await handleDeleteSession(summary.id)
      } else {
        const isEmpty = !summary.lastFinalMessageId && !summary.name
        if (!isEmpty) {
          const confirmed = await window.electronAPI.showDeleteSessionConfirmation(summary.name || 'Untitled')
          if (!confirmed) return false
        }
        await window.electronAPI.invokeWorkspaceApi(
          { serverId: workspace.remoteServer?.url ?? 'local', workspaceId },
          'deleteSession',
          summary.id,
        )
        deleted = true
      }

      if (deleted) {
        setWorkspaceSessionSummaries(previous => removeWorkspaceSessionSummary(previous, workspaceId, summary.id))
      }
      return deleted
    } catch (error) {
      console.error(`[AppShell] Failed to delete sidebar session ${summary.id}:`, error)
      toast.error(t('common.error'), {
        description: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }, [activeWorkspaceId, handleDeleteSession, t, workspaces])

  const handleSidebarSessionMarkUnread = useCallback((
    workspaceId: string,
    summary: WorkspaceSessionSummary,
  ) => {
    const workspace = workspaces.find(candidate => candidate.id === workspaceId)
    if (!workspace) return

    setWorkspaceSessionSummaries(previous => updateWorkspaceSessionSummary(
      previous,
      workspaceId,
      summary.id,
      { hasUnread: true },
    ))

    if (workspaceId === activeWorkspaceId) {
      onMarkSessionUnread(summary.id)
      return
    }

    void window.electronAPI.invokeWorkspaceApi(
      { serverId: workspace.remoteServer?.url ?? 'local', workspaceId },
      'sessionCommand',
      summary.id,
      { type: 'markUnread' },
    ).catch(error => {
      console.error(`[AppShell] Failed to mark sidebar session ${summary.id} unread:`, error)
      toast.error(t('common.error'), {
        description: error instanceof Error ? error.message : String(error),
      })
    })
  }, [activeWorkspaceId, onMarkSessionUnread, t, workspaces])

  const openSidebarSessionRename = useCallback((workspaceId: string, summary: WorkspaceSessionSummary) => {
    setSidebarRenameTarget({ workspaceId, session: summary })
    setSidebarRenameName(getSessionTitle(summary))
  }, [])

  const submitSidebarSessionRename = useCallback(() => {
    if (!sidebarRenameTarget) return
    const name = sidebarRenameName.trim()
    if (!name) return

    const { workspaceId, session: summary } = sidebarRenameTarget
    const workspace = workspaces.find(candidate => candidate.id === workspaceId)
    if (!workspace) return

    setWorkspaceSessionSummaries(previous => updateWorkspaceSessionSummary(
      previous,
      workspaceId,
      summary.id,
      { name },
    ))
    setSidebarRenameTarget(null)

    if (workspaceId === activeWorkspaceId) {
      onRenameSession(summary.id, name)
      return
    }

    void window.electronAPI.invokeWorkspaceApi(
      { serverId: workspace.remoteServer?.url ?? 'local', workspaceId },
      'sessionCommand',
      summary.id,
      { type: 'rename', name },
    ).catch(error => {
      console.error(`[AppShell] Failed to rename sidebar session ${summary.id}:`, error)
      toast.error(t('common.error'), {
        description: error instanceof Error ? error.message : String(error),
      })
    })
  }, [activeWorkspaceId, onRenameSession, sidebarRenameName, sidebarRenameTarget, t, workspaces])

  // Extend context value with local overrides.
  const appShellContextValue = React.useMemo<AppShellContextType>(() => ({
    ...contextValue,
    onDeleteSession: handleDeleteSession,
    skills,
    activeSessionWorkingDirectory,
    enabledModes,
    remoteUIRequest,
    respondRemoteUI,
    panelHeaderTrailingAction: null,
    isCompactMode: isAutoCompact,
    // Search state for ChatDisplay highlighting
    sessionListSearchQuery: searchActive ? searchQuery : undefined,
    isSearchModeActive: searchActive,
    chatDisplayRef,
    onChatMatchInfoChange: handleChatMatchInfoChange,
    onTestAutomation: handleTestAutomation,
    onToggleAutomation: handleToggleAutomation,
    onDuplicateAutomation: handleDuplicateAutomation,
    onDeleteAutomation: handleDeleteAutomation,
    automationTestResults,
    getAutomationHistory,
    onReplayAutomation: handleReplayAutomation,
    workspaceNavigation,
  }), [contextValue, handleDeleteSession, skills, activeSessionWorkingDirectory, enabledModes, remoteUIRequest, respondRemoteUI, isAutoCompact, searchActive, searchQuery, handleChatMatchInfoChange, handleTestAutomation, handleToggleAutomation, handleDuplicateAutomation, handleDeleteAutomation, automationTestResults, getAutomationHistory, handleReplayAutomation, workspaceNavigation])

  // Persist expanded folders to localStorage (workspace-scoped)
  React.useEffect(() => {
    if (!activeWorkspaceId) return
    storage.set(storage.KEYS.expandedFolders, [...expandedFolders], activeWorkspaceId)
  }, [expandedFolders, activeWorkspaceId])

  // Persist sidebar visibility to localStorage
  React.useEffect(() => {
    storage.set(storage.KEYS.sidebarVisible, isSidebarVisible)
  }, [isSidebarVisible])

  // Persist focus mode state to localStorage
  React.useEffect(() => {
    storage.set(storage.KEYS.focusModeEnabled, isFocusMode)
  }, [isFocusMode])

  // Listen for focus mode toggle from menu (View → Focus Mode)
  React.useEffect(() => {
    const cleanup = window.electronAPI.onMenuToggleFocusMode?.(() => {
      setIsFocusMode(v => !v)
    })
    return cleanup
  }, [])

  // Listen for sidebar toggle from menu (View → Toggle Sidebar)
  React.useEffect(() => {
    const cleanup = window.electronAPI.onMenuToggleSidebar?.(() => {
      handleToggleSidebar()
    })
    return cleanup
  }, [handleToggleSidebar])

  const handleAllSessionsClick = useCallback(() => {
    exitCompactDockDetail()
    navigate(routes.view.allSessions())
  }, [exitCompactDockDetail])

  // Handler for skills view
  const handleSkillsClick = useCallback(() => {
    exitCompactDockDetail()
    navigate(routes.view.skills())
  }, [exitCompactDockDetail])

  // Handlers for automations view
  const handleAutomationsClick = useCallback(() => {
    if (automations[0]) enterCompactDockDetail()
    else exitCompactDockDetail()
    navigate(routes.view.automations(automations[0] ? { automationId: automations[0].id } : undefined))
  }, [automations, enterCompactDockDetail, exitCompactDockDetail])

  // Handler for settings view. With no arg → bare `settings` route (navigator-only
  // in compact mode, App fallback on desktop). With an arg → `settings/<subpage>`.
  const handleSettingsClick = useCallback((subpage?: SettingsSubpage) => {
    if (subpage) enterCompactDockDetail()
    else exitCompactDockDetail()
    navigate(routes.view.settings(subpage))
  }, [enterCompactDockDetail, exitCompactDockDetail])

  // ============================================================================
  // EDIT POPOVER STATE
  // ============================================================================
  // State to control which EditPopover is open (triggered from context menus).
  // We use controlled popovers instead of deep links so the user can type
  // their request in the popover UI before opening a new chat window.
  const [editPopoverOpen, setEditPopoverOpen] = useState<'add-skill' | 'automation-config' | null>(null)

  // Stores the Y position of the last right-clicked sidebar item so the EditPopover
  // appears near it rather than at a fixed location. Updated synchronously before
  // the setTimeout that opens the popover, ensuring the ref is set before render.
  const editPopoverAnchorY = useRef<number>(120)
  // Tracks which label was right-clicked when opening label EditPopovers,
  // so the agent knows the target for commands like "make this red" or "add below this"

  // Stores the trigger element (button) so we can keep it highlighted while the
  // EditPopover is open (after Radix removes data-state="open" on context menu close).
  const editPopoverTriggerRef = useRef<Element | null>(null)

  // Captures the bounding rect of the currently-open context menu trigger (the button).
  // Radix sets data-state="open" on the button (via ContextMenuTrigger asChild)
  // while the menu is visible, so we can locate it in the DOM at click time.
  const captureContextMenuPosition = useCallback(() => {
    const trigger = document.querySelector('.group\\/section > [data-state="open"]')
    if (trigger) {
      const rect = trigger.getBoundingClientRect()
      editPopoverAnchorY.current = rect.top
      editPopoverTriggerRef.current = trigger
    }
  }, [])

  // Sync data-edit-active attribute on the trigger element with EditPopover open state.
  // This keeps the sidebar item visually highlighted while the popover is shown,
  // since Radix's data-state="open" disappears when the context menu closes.
  useEffect(() => {
    const el = editPopoverTriggerRef.current
    if (!el) return
    if (editPopoverOpen) {
      el.setAttribute('data-edit-active', 'true')
    } else {
      el.removeAttribute('data-edit-active')
      editPopoverTriggerRef.current = null
    }
  }, [editPopoverOpen])

  // Handler for "Add Skill" context menu action
  // Opens the EditPopover for adding a new skill
  const openAddSkill = useCallback(() => {
    captureContextMenuPosition()
    setTimeout(() => setEditPopoverOpen('add-skill'), 50)
  }, [captureContextMenuPosition])

  // Handler for "Add Automation" context menu action
  // Opens the EditPopover for adding a new automation
  const openAddAutomation = useCallback(() => {
    captureContextMenuPosition()
    setTimeout(() => setEditPopoverOpen('automation-config'), 50)
  }, [captureContextMenuPosition])

  // Create a new chat and select it
  const handleNewChat = useCallback((newPanel: boolean = false) => {
    if (!activeWorkspace) return

    // Exit search mode and switch to All Sessions
    setSearchActive(false)
    setSearchQuery('')

    // Delegate to NavigationContext which handles session creation
    navigate(
      routes.action.newSession(),
      newPanel ? { newPanel: true, targetLaneId: 'main' } : undefined
    )

    // Focus the chat input after navigation completes
    setTimeout(() => focusZone('chat', { intent: 'programmatic' }), 50)
  }, [activeWorkspace, focusZone, navigate])

  // Create a new workspace-owned dedicated browser window and focus it.
  const handleNewBrowserWindow = useCallback(async () => {
    if (!activeWorkspace) return
    try {
      const instanceId = await window.electronAPI.browserPane.create({
        show: true,
        workspaceId: activeWorkspace.id,
      })
      await window.electronAPI.browserPane.focus(instanceId)
    } catch (error) {
      console.error('[Chat] Failed to create browser window:', error)
      toast.error(t('toast.failedToCreateBrowser'))
    }
  }, [activeWorkspace])

  // Respond to menu bar "New Chat" trigger
  const menuTriggerRef = useRef(menuNewChatTrigger)
  useEffect(() => {
    // Skip initial render
    if (menuTriggerRef.current === menuNewChatTrigger) return
    menuTriggerRef.current = menuNewChatTrigger
    handleNewChat()
  }, [menuNewChatTrigger, handleNewChat])

  // Unified sidebar items: nav buttons only (agents system removed)
  type SidebarItem = {
    id: string
    type: 'nav'
    action?: () => void
  }

  const selectedSidebarSessionId = focusedSessionId
    ?? (isSessionsNavigation(navState) && navState.details?.type === 'session'
      ? navState.details.sessionId
      : null)
  const hasRemoteWorkspaces = workspaces.some(workspace => Boolean(workspace.remoteServer))

  const workspaceSidebarItems = React.useMemo<LeftSidebarLinkItem[]>(() => [
    ...workspaceNavigation.items.map((item) => {
      const sessions = workspaceSessionSummaries[item.workspace.id] ?? []
      const workspaceId = item.workspace.id
      const sessionLimit = workspaceSessionLimits[workspaceId] ?? RECENT_WORKSPACE_SESSION_LIMIT
      const recentSessions = sessions.slice(0, sessionLimit)
      const nestedItems: LeftSidebarLinkItem[] = recentSessions.map(summary => ({
        id: `session:${workspaceId}:${summary.id}`,
        title: getSessionTitle(summary),
        variant: item.isActive && selectedSidebarSessionId === summary.id ? 'default' : 'ghost',
        tone: 'session',
        compact: true,
        onClick: () => {
          if (item.isActive) navigateToSessionInPanel(summary.id)
          else void workspaceNavigation.selectSession(workspaceId, summary.id)
        },
        accessory: (
          <>
            {summary.isProcessing && <Spinner className="text-[9px]" />}
            {summary.hasUnread && (
              <span
                className="h-1.5 w-1.5 rounded-full bg-accent"
                aria-label={t('sidebar.groupByUnread')}
              />
            )}
          </>
        ),
        menuContent: (
          <WorkspaceElectronApiProvider
            route={{ serverId: item.workspace.remoteServer?.url ?? 'local', workspaceId }}
          >
            <SessionMenu
              item={summary}
              hasRemoteWorkspaces={hasRemoteWorkspaces}
              onRename={() => openSidebarSessionRename(workspaceId, summary)}
              onMarkUnread={() => handleSidebarSessionMarkUnread(workspaceId, summary)}
              onOpenInNewWindow={() => window.electronAPI.openSessionInNewWindow(workspaceId, summary.id)}
              onSendToWorkspace={item.isActive && hasRemoteWorkspaces
                ? () => setSendToWorkspaceIds([summary.id])
                : undefined}
              onDelete={() => { void handleSidebarSessionDelete(workspaceId, summary) }}
            />
          </WorkspaceElectronApiProvider>
        ),
      }))
      if (sessions.length > sessionLimit) {
        nestedItems.push({
          id: `workspace:${workspaceId}:more`,
          title: t('common.more'),
          icon: MoreHorizontal,
          variant: 'ghost',
          compact: true,
          onClick: () => showMoreWorkspaceSessions(workspaceId),
        })
      }

      return {
        id: `workspace:${workspaceId}`,
        title: item.workspace.name,
        label: sessions.length > 0 ? String(sessions.length) : undefined,
        icon: collapsedWorkspaceIds.has(workspaceId) ? Folder : FolderOpen,
        variant: item.isActive && isSessionsNavigation(navState) && !selectedSidebarSessionId ? 'default' as const : 'ghost' as const,
        tone: 'workspace' as const,
        compact: true,
        expandable: true,
        expanded: !collapsedWorkspaceIds.has(workspaceId),
        onToggle: () => toggleWorkspaceExpanded(workspaceId),
        items: nestedItems,
        onClick: () => {
          if (item.isActive) handleAllSessionsClick()
          else void workspaceNavigation.selectWorkspace(workspaceId)
        },
        accessory: (
          <>
            {item.isProcessing && <Spinner className="text-[9px]" />}
            {item.workspace.remoteServer && (
              <span title={item.isDisconnected ? item.disconnectLabel : item.workspace.remoteServer.url}>
                {item.isDisconnected
                  ? <CloudOff className="h-3 w-3 text-destructive" />
                  : <Cloud className={cn('h-3 w-3', item.isChecking && 'animate-pulse')} />}
              </span>
            )}
            {item.hasUnread && <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-label={t('sidebar.groupByUnread')} />}
          </>
        ),
        contextMenu: item.isActive ? undefined : {
          type: 'workspace' as const,
          isActiveWorkspace: false,
          onOpenWorkspaceInNewWindow: () => { void workspaceNavigation.openWorkspaceInNewWindow(workspaceId) },
          onRemoveWorkspace: () => { void workspaceNavigation.removeWorkspace(item.workspace) },
        },
      }
    }),
  ], [collapsedWorkspaceIds, handleAllSessionsClick, handleSidebarSessionDelete, handleSidebarSessionMarkUnread, hasRemoteWorkspaces, navState, navigateToSessionInPanel, openSidebarSessionRename, selectedSidebarSessionId, setSendToWorkspaceIds, showMoreWorkspaceSessions, t, toggleWorkspaceExpanded, workspaceNavigation, workspaceSessionLimits, workspaceSessionSummaries])

  const bottomSidebarItems = React.useMemo<LeftSidebarLinkItem[]>(() => [
    {
      id: 'nav:skills',
      title: t('sidebar.skills'),
      label: String(skills.length),
      icon: Zap,
      variant: isSkillsNavigation(navState) ? 'default' as const : 'ghost' as const,
      onClick: handleSkillsClick,
      contextMenu: { type: 'skills' as const, onAddSkill: openAddSkill },
    },
    {
      id: 'nav:automations',
      title: t('sidebar.automations'),
      label: String(automations.length),
      icon: ListTodo,
      variant: isAutomationsNavigation(navState) ? 'default' as const : 'ghost' as const,
      onClick: handleAutomationsClick,
      contextMenu: { type: 'automations' as const, onAddAutomation: openAddAutomation },
    },
    {
      id: 'nav:settings',
      title: t('sidebar.settings'),
      icon: Settings,
      variant: isSettingsNavigation(navState) ? 'default' as const : 'ghost' as const,
      onClick: () => handleSettingsClick(),
    },
  ], [automations.length, handleAutomationsClick, handleSettingsClick, handleSkillsClick, navState, openAddAutomation, openAddSkill, skills.length, t])

  const unifiedSidebarItems = React.useMemo((): SidebarItem[] => {
    const result: SidebarItem[] = []

    for (const workspace of workspaceNavigation.items) {
      const workspaceId = workspace.workspace.id
      result.push({
        id: `workspace:${workspaceId}`,
        type: 'nav',
        action: () => { void workspaceNavigation.selectWorkspace(workspaceId) },
      })
      if (!collapsedWorkspaceIds.has(workspaceId)) {
        const sessions = workspaceSessionSummaries[workspaceId] ?? []
        const sessionLimit = workspaceSessionLimits[workspaceId] ?? RECENT_WORKSPACE_SESSION_LIMIT
        for (const summary of sessions.slice(0, sessionLimit)) {
          result.push({
            id: `session:${workspaceId}:${summary.id}`,
            type: 'nav',
            action: () => {
              if (workspace.isActive) navigateToSessionInPanel(summary.id)
              else void workspaceNavigation.selectSession(workspaceId, summary.id)
            },
          })
        }
        if (sessions.length > sessionLimit) {
          result.push({ id: `workspace:${workspaceId}:more`, type: 'nav', action: () => showMoreWorkspaceSessions(workspaceId) })
        }
      }
    }
    result.push({ id: 'nav:skills', type: 'nav', action: handleSkillsClick })
    result.push({ id: 'nav:automations', type: 'nav', action: handleAutomationsClick })
    result.push({ id: 'nav:settings', type: 'nav', action: () => handleSettingsClick() })
    return result
  }, [collapsedWorkspaceIds, handleAutomationsClick, handleSettingsClick, handleSkillsClick, navigateToSessionInPanel, showMoreWorkspaceSessions, workspaceNavigation, workspaceSessionLimits, workspaceSessionSummaries])

  // Toggle folder expanded state
  const handleToggleFolder = React.useCallback((path: string) => {
    setExpandedFolders(prev => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }, [])

  // Get props for any sidebar item (unified roving tabindex pattern)
  const getSidebarItemProps = React.useCallback((id: string) => ({
    tabIndex: focusedSidebarItemId === id ? 0 : -1,
    'data-focused': focusedSidebarItemId === id,
    ref: (el: HTMLElement | null) => {
      if (el) {
        sidebarItemRefs.current.set(id, el)
      } else {
        sidebarItemRefs.current.delete(id)
      }
    },
  }), [focusedSidebarItemId])

  // Unified sidebar keyboard navigation
  const handleSidebarKeyDown = React.useCallback((e: React.KeyboardEvent) => {
    if (!sidebarFocused || unifiedSidebarItems.length === 0) return

    const currentIndex = unifiedSidebarItems.findIndex(item => item.id === focusedSidebarItemId)
    const currentItem = currentIndex >= 0 ? unifiedSidebarItems[currentIndex] : null

    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault()
        const nextIndex = currentIndex < unifiedSidebarItems.length - 1 ? currentIndex + 1 : 0
        const nextItem = unifiedSidebarItems[nextIndex]
        setFocusedSidebarItemId(nextItem.id)
        sidebarItemRefs.current.get(nextItem.id)?.focus()
        break
      }
      case 'ArrowUp': {
        e.preventDefault()
        const prevIndex = currentIndex > 0 ? currentIndex - 1 : unifiedSidebarItems.length - 1
        const prevItem = unifiedSidebarItems[prevIndex]
        setFocusedSidebarItemId(prevItem.id)
        sidebarItemRefs.current.get(prevItem.id)?.focus()
        break
      }
      case 'ArrowLeft': {
        e.preventDefault()
        // At boundary - do nothing (Left doesn't change zones from sidebar)
        break
      }
      case 'ArrowRight': {
        e.preventDefault()
        focusZone(isAutoCompact ? 'navigator' : 'chat', { intent: 'keyboard' })
        break
      }
      case 'Enter':
      case ' ': {
        e.preventDefault()
        if (currentItem?.type === 'nav' && currentItem.action) {
          currentItem.action()
        }
        break
      }
      case 'Home': {
        e.preventDefault()
        if (unifiedSidebarItems.length > 0) {
          const firstItem = unifiedSidebarItems[0]
          setFocusedSidebarItemId(firstItem.id)
          sidebarItemRefs.current.get(firstItem.id)?.focus()
        }
        break
      }
      case 'End': {
        e.preventDefault()
        if (unifiedSidebarItems.length > 0) {
          const lastItem = unifiedSidebarItems[unifiedSidebarItems.length - 1]
          setFocusedSidebarItemId(lastItem.id)
          sidebarItemRefs.current.get(lastItem.id)?.focus()
        }
        break
      }
    }
  }, [sidebarFocused, unifiedSidebarItems, focusedSidebarItemId, focusZone, isAutoCompact])

  // Focus sidebar item when sidebar zone gains focus
  React.useEffect(() => {
    if (sidebarFocused && unifiedSidebarItems.length > 0) {
      // Set focused item if not already set
      const itemId = focusedSidebarItemId || unifiedSidebarItems[0].id
      if (!focusedSidebarItemId) {
        setFocusedSidebarItemId(itemId)
      }
      // Actually focus the DOM element
      requestAnimationFrame(() => {
        sidebarItemRefs.current.get(itemId)?.focus()
      })
    }
  }, [sidebarFocused, focusedSidebarItemId, unifiedSidebarItems])

  // Get title based on navigation state
  const listTitle = React.useMemo(() => {
    // Skills navigator
    if (isSkillsNavigation(navState)) {
      return t("sidebar.allSkills")
    }

    // Automations navigator
    if (isAutomationsNavigation(navState)) {
      if (!automationFilter) return t("sidebar.allAutomations")
      switch (automationFilter.automationType) {
        case 'scheduled': return t("sidebar.scheduled")
        case 'event': return t("sidebar.eventBased")
        case 'agentic': return t("sidebar.agentic")
        default: return t("sidebar.allAutomations")
      }
    }

    // Settings navigator
    if (isSettingsNavigation(navState)) return t("sidebar.settings")

    return t("sidebar.allSessions")
  }, [navState, t, automationFilter])
  return (
    <AppShellProvider value={appShellContextValue}>
        {/* === TOP BAR === */}
        <TopBar
          workspaceNavigation={workspaceNavigation}
          activeSessionId={effectiveSessionId}
          onNewChat={() => handleNewChat()}
          onNewWindow={() => window.electronAPI.menuNewWindow()}
          onOpenSettings={onOpenSettings}
          onOpenSettingsSubpage={handleSettingsClick}
          onOpenKeyboardShortcuts={onOpenKeyboardShortcuts}
          onOpenStoredUserPreferences={onOpenStoredUserPreferences}
          onBack={goBack}
          onForward={goForward}
          canGoBack={canGoBack}
          canGoForward={canGoForward}
          onToggleSidebar={handleToggleSidebar}
          onToggleFocusMode={() => setIsFocusMode(prev => !prev)}
          onAddSessionPanel={() => handleNewChat(true)}
          onAddBrowserPanel={() => { void handleNewBrowserWindow() }}
          onTogglePanelLayout={togglePanelLayout}
          isCanvasLayoutFocused={isCanvasLayoutFocused}
          isWorkspaceCanvasActive={isSessionsNavigation(navState)}
          leftExtensionSlot={activeWorkspace ? (
            <WorkspaceElectronApiProvider
              route={{ serverId: activeWorkspace.remoteServer?.url ?? 'local', workspaceId: activeWorkspace.id }}
            >
              <div className="flex min-w-0 items-center gap-1">
                <WorkspaceCoordinationStatusPopover />
                {isSessionsNavigation(navState) && effectiveSessionId && (
                  <ExtensionContributionZone sessionId={effectiveSessionId} surface="window.topLeft" />
                )}
              </div>
            </WorkspaceElectronApiProvider>
          ) : undefined}
          rightExtensionSlot={isSessionsNavigation(navState) && effectiveSessionId ? <ExtensionContributionZone sessionId={effectiveSessionId} surface="window.topRight" /> : undefined}
          isCompact={isAutoCompact}
        />

      {/* === OUTER LAYOUT: Unified Panel Stack | Right Sidebar === */}
      <div
        ref={shellRef}
        className="flex items-stretch relative"
        style={{
          height: '100%',
          paddingRight: isAutoCompact ? 0 : PANEL_EDGE_INSET,
          paddingBottom: isAutoCompact ? 0 : PANEL_EDGE_INSET,
          paddingLeft: 0,
          gap: PANEL_GAP,
        }}
      >
        <RootSurfaceContainer
          sidebarSlot={
            <div
              ref={sidebarRef}
              style={{ width: sidebarWidth }}
              className="h-full font-sans relative"
              data-focus-zone="sidebar"
              tabIndex={sidebarFocused ? 0 : -1}
              onKeyDown={handleSidebarKeyDown}
            >
            <div className="flex h-full flex-col select-none bg-foreground/[0.012]">
              {/* Sidebar Top Section */}
              <div className="flex-1 flex flex-col min-h-0">
                {/* New Session Button - Gmail-style, with context menu for "Open in New Window" */}
                <div className="px-2 pb-2 shrink-0">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div>
                        <ContextMenu modal={true}>
                          <ContextMenuTrigger asChild>
                            <Button
                              semanticId="app.new-session"
                              variant="ghost"
                              onClick={(e) => handleNewChat(e.metaKey || e.ctrlKey)}
                              className="h-8 w-full justify-start gap-2 px-2 text-[13px] font-medium rounded-[6px] bg-foreground/[0.045] hover:bg-foreground/[0.075]"
                              data-tutorial="new-chat-button"
                            >
                              <SquarePenRounded className="h-3.5 w-3.5 shrink-0" />
                              {t("session.newSession")}
                            </Button>
                          </ContextMenuTrigger>
                          <StyledContextMenuContent>
                            <ContextMenuProvider>
                              <SidebarMenu type="newSession" />
                            </ContextMenuProvider>
                          </StyledContextMenuContent>
                        </ContextMenu>
                      </div>
                    </TooltipTrigger>
                    <TooltipContent side="right">{newChatHotkey}</TooltipContent>
                  </Tooltip>
                </div>
                {/* Workspace-first navigation. Sessions stay directly under their owning workspace. */}
                <div className="flex-1 overflow-y-auto min-h-0 mask-fade-bottom pb-4">
                {effectiveSessionId && <ExtensionContributionZone className="px-2 py-1" sessionId={effectiveSessionId} surface="sidebar.header" />}
                {effectiveSessionId && <ExtensionContributionZone className="px-2 py-1" sessionId={effectiveSessionId} surface="navigation.item" />}
                <div className="flex h-7 items-center px-4 pt-1 text-[11px] font-medium text-muted-foreground/70">
                  <span className="min-w-0 flex-1 truncate">{t('workspace.workspaces')}</span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        data-mortise-semantic-id="workspace.add"
                        aria-label={t('workspace.addWorkspace')}
                        onClick={workspaceNavigation.openCreation}
                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[5px] text-muted-foreground outline-none hover:bg-foreground/[0.05] hover:text-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                      >
                        <FolderPlus className="h-3.5 w-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="right">{t('workspace.addWorkspace')}</TooltipContent>
                  </Tooltip>
                </div>
                <LeftSidebar
                  isCollapsed={false}
                  getItemProps={getSidebarItemProps}
                  focusedItemId={focusedSidebarItemId}
                  links={workspaceSidebarItems}
                />
                {effectiveSessionId && <ExtensionContributionZone className="px-2 py-1" sessionId={effectiveSessionId} surface="sidebar.section" />}
                {effectiveSessionId && <ExtensionContributionZone className="px-2 py-1" sessionId={effectiveSessionId} surface="sidebar.footer" />}
                </div>
                <div className="shrink-0 border-t border-foreground/[0.055] py-1.5">
                  <LeftSidebar
                    isCollapsed={false}
                    getItemProps={getSidebarItemProps}
                    focusedItemId={focusedSidebarItemId}
                    links={bottomSidebarItems}
                  />
                </div>
              </div>

            </div>
          </div>
          }
          sidebarWidth={isPrimarySidebarHidden ? 0 : (isSidebarVisible ? sidebarWidth : 0)}
          contentSlot={(
            <PageNavigationSurface
              navigationLabel={listTitle}
              navigation={
            <div
              style={{ width: isAutoCompact ? '100%' : PAGE_NAVIGATION_WIDTH }}
              className="h-full flex flex-col min-w-0 relative z-panel"
            >
            <PanelHeader
              title={listTitle}
              compensateForStoplight={isPrimarySidebarHidden || !isSidebarVisible}
              badge={automationFilter?.automationType === 'scheduled' ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="text-muted-foreground/50 cursor-default flex items-center titlebar-no-drag">
                      <Info className="h-3 w-3" />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-[220px]">
                    Scheduling requires your machine to be running. It can be locked, but must be powered on.
                  </TooltipContent>
                </Tooltip>
              ) : undefined}
              actions={
                <>
                  {/* New chat button (only for sessions mode) */}
                  {isAutoCompact && isSessionsNavigation(navState) && (
                    <HeaderIconButton
                      icon={<SquarePenRounded className="h-3.5 w-3.5" />}
                      tooltip={t("menu.newChat")}
                      aria-label={t("menu.newChat")}
                      onClick={(event) => handleNewChat(event.metaKey || event.ctrlKey)}
                    />
                  )}
                  {/* Add Skill button (only for skills mode) */}
                  {isSkillsNavigation(navState) && activeWorkspace && (
                    <EditPopover
                      trigger={
                        <HeaderIconButton
                          icon={<Plus className="h-4 w-4" />}
                          tooltip={t("sidebarMenu.addSkill")}
                          data-tutorial="add-skill-button"
                        />
                      }
                      {...getEditConfig('add-skill', activeWorkspace.rootPath)}
                    />
                  )}
                  {/* Add Automation button (only for automations mode) */}
                  {isAutomationsNavigation(navState) && activeWorkspace && (
                    <EditPopover
                      trigger={
                        <HeaderIconButton
                          icon={<Plus className="h-4 w-4" />}
                          tooltip={t("sidebarMenu.addAutomation")}
                        />
                      }
                      {...getEditConfig('automation-config', activeWorkspace.rootPath)}
                    />
                  )}
                </>
              }
            />
            {/* Content depends on the active navigation state. */}
            {isSkillsNavigation(navState) && activeWorkspaceId && (
              /* Skills List */
              <SkillsListPanel
                skills={skills}
                workspaceId={activeWorkspaceId}
                workspaceRootPath={activeWorkspace?.rootPath}
                onSkillClick={handleSkillSelect}
                selectedSkillSlug={isSkillsNavigation(navState) && navState.details?.type === 'skill' ? navState.details.skillSlug : null}
              />
            )}
            {isAutomationsNavigation(navState) && (
              /* Automations List - filtered by type if automationFilter is active */
              <AutomationsListPanel
                automations={automations}
                automationFilter={automationFilter ? { kind: AUTOMATION_TYPE_TO_FILTER_KIND[automationFilter.automationType] ?? 'all' } : undefined}
                onAutomationClick={handleAutomationSelect}
                onTestAutomation={handleTestAutomation}
                onToggleAutomation={handleToggleAutomation}
                onDuplicateAutomation={handleDuplicateAutomation}
                onDeleteAutomation={handleDeleteAutomation}
                selectedAutomationId={isAutomationsNavigation(navState) && navState.details ? navState.details.automationId : null}
                workspaceRootPath={activeWorkspace?.rootPath}
              />
            )}
            {isSettingsNavigation(navState) && (
              /* Settings Navigator */
              <SettingsNavigator
                selectedSubpage={navState.subpage ?? (isAutoCompact ? null : 'app')}
                onSelectSubpage={(subpage) => handleSettingsClick(subpage)}
              />
            )}
            {isAutoCompact && isSessionsNavigation(navState) && (
              /* Compact navigation keeps the legacy list interaction; desktop
                 conversations now live entirely in the workspace-first sidebar. */
              <>
                {/* SessionList: Scrollable list of session cards */}
                {/* Key on sidebarMode forces full remount when switching views, skipping animations */}
                <SessionList
                  key={sessionFilter?.kind}
                  items={searchActive ? workspaceSessionMetas : filteredSessionMetas}
                  onDelete={handleDeleteSession}
                  onMarkUnread={onMarkSessionUnread}
                  onRename={onRenameSession}
                  onFocusChatInput={(targetSessionId) => {
                    focusChatInputForSession(targetSessionId ?? focusedSessionId ?? session.selected)
                  }}
                  onSessionSelect={(selectedMeta) => {
                    navigateToSessionInPanel(selectedMeta.id)
                  }}
                  onOpenInNewWindow={(selectedMeta) => {
                    if (activeWorkspaceId) {
                      window.electronAPI.openSessionInNewWindow(activeWorkspaceId, selectedMeta.id)
                    }
                  }}
                  sessionOptions={sessionOptions}
                  searchActive={searchActive}
                  searchQuery={searchQuery}
                  onSearchChange={setSearchQuery}
                  onSearchClose={() => {
                    setSearchActive(false)
                    setSearchQuery('')
                  }}
                  groupingMode={chatGroupingMode}
                  workspaceId={activeWorkspaceId ?? undefined}
                  focusedSessionId={panelCount === 0 ? null : panelCount > 1 ? focusedSessionId : undefined}
                  onNavigateToSession={navigateToSessionInPanel}
                  hasPendingPrompt={hasPendingPrompt}
                  activeChatMatchInfo={chatMatchInfo}
                />
              </>
            )}
            {/* Mobile/compact-only FAB for starting a new chat — only on the
                session list itself, not when a chat is open (it would overlap
                the chat input). */}
            {isAutoCompact && isSessionsNavigation(navState) && !navState.details && (
              <FabNewChat onClick={() => handleNewChat()} />
            )}
            </div>
              }
              content={isSessionsNavigation(navState) ? (
                <UnifiedDockWorkspace
                  key={activeWorkspaceId ?? 'no-workspace'}
                  activeWorkspaceId={activeWorkspaceId}
                  workspaceTransition={workspaceTransition}
                  serverId={activeWorkspace?.remoteServer?.url ?? 'local'}
                  sessionId={effectiveSessionId}
                  isLeadingChromeHidden={isPrimarySidebarHidden}
                  canvasLayoutToggleRequest={canvasLayoutToggleRequest}
                  onCanvasLayoutFocusChange={setIsCanvasLayoutFocused}
                />
              ) : (
                <MainContentPanel
                  navStateOverride={navState}
                  isLeadingChromeHidden={isPrimarySidebarHidden}
                />
              )}
              isCompact={isAutoCompact}
              routeHasDetail={isDetailNavState(navState)}
              routeKey={JSON.stringify(navState)}
              navigationWidth={PAGE_NAVIGATION_WIDTH}
              showNavigationOnDesktop={!isSessionsNavigation(navState)}
            />
          )}
          isCompact={isAutoCompact}
          isResizing={!!isResizing}
        />

        {/* Sidebar Resize Handle (absolute, hidden in focused mode) */}
        {!isPrimarySidebarHidden && (
        <div
          ref={resizeHandleRef}
          onMouseDown={(e) => { e.preventDefault(); setIsResizing('sidebar') }}
          onMouseMove={(e) => {
            if (resizeHandleRef.current) {
              const rect = resizeHandleRef.current.getBoundingClientRect()
              setSidebarHandleY(e.clientY - rect.top)
            }
          }}
          onMouseLeave={() => { if (!isResizing) setSidebarHandleY(null) }}
          className="absolute cursor-col-resize z-panel flex justify-center"
          style={{
            width: PANEL_SASH_HIT_WIDTH,
            top: PANEL_STACK_VERTICAL_OVERFLOW,
            bottom: PANEL_STACK_VERTICAL_OVERFLOW,
            left: isSidebarVisible
              ? sidebarWidth + (PANEL_GAP / 2) - PANEL_SASH_HALF_HIT_WIDTH
              : -PANEL_GAP,
            transition: isResizing === 'sidebar' ? undefined : 'left 0.15s ease-out',
          }}
        >
          <div
            className="h-full"
            style={{
              ...getResizeGradientStyle(sidebarHandleY, resizeHandleRef.current?.clientHeight ?? null),
              width: PANEL_SASH_LINE_WIDTH,
            }}
          />
        </div>
        )}

      </div>

      {/* ============================================================================
       * CONTEXT MENU TRIGGERED EDIT POPOVERS
       * ============================================================================
       * These EditPopovers are opened programmatically from sidebar context menus.
       * They use controlled state (editPopoverOpen) and invisible anchors for positioning.
       * The anchor Y position is captured from the right-clicked item (editPopoverAnchorY ref)
       * so the popover appears near the triggering item rather than at a fixed location.
       * modal={true} prevents auto-close when focus shifts after context menu closes.
       */}
      {activeWorkspace && (
        <>
          {/* Add Skill EditPopover */}
          <EditPopover
            open={editPopoverOpen === 'add-skill'}
            onOpenChange={(isOpen) => setEditPopoverOpen(isOpen ? 'add-skill' : null)}
            modal={true}
            trigger={
              <div
                className="fixed w-0 h-0 pointer-events-none"
                style={{ left: sidebarWidth + 20, top: editPopoverAnchorY.current }}
                aria-hidden="true"
              />
            }
            side="bottom"
            align="start"
            {...getEditConfig('add-skill', activeWorkspace.rootPath)}
          />
          {/* Add Automation EditPopover - triggered from "Add Automation" context menu in automations */}
          <EditPopover
            open={editPopoverOpen === 'automation-config'}
            onOpenChange={(isOpen) => setEditPopoverOpen(isOpen ? 'automation-config' : null)}
            modal={true}
            trigger={
              <div
                className="fixed w-0 h-0 pointer-events-none"
                style={{ left: sidebarWidth + 20, top: editPopoverAnchorY.current }}
                aria-hidden="true"
              />
            }
            side="bottom"
            align="start"
            {...getEditConfig('automation-config', activeWorkspace.rootPath)}
          />
        </>
      )}

      {workspaceNavigation.overlay}

      <RenameDialog
        open={sidebarRenameTarget !== null}
        onOpenChange={(open) => { if (!open) setSidebarRenameTarget(null) }}
        title={t('chat.renameSession')}
        value={sidebarRenameName}
        onValueChange={setSidebarRenameName}
        onSubmit={submitSidebarSessionRename}
        placeholder={t('chat.enterSessionName')}
      />

      {/* Delete automation confirmation dialog */}
      <Dialog open={!!automationPendingDelete} onOpenChange={(open) => { if (!open) setAutomationPendingDelete(null) }}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t("dialog.deleteAutomation.title")}</DialogTitle>
            <DialogDescription>
              <Trans
                i18nKey="dialog.deleteAutomation.description"
                values={{ name: pendingDeleteAutomation?.name }}
                components={{ strong: <strong /> }}
              />
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAutomationPendingDelete(null)}>{t("common.cancel")}</Button>
            <Button variant="destructive" onClick={confirmDeleteAutomation}>{t("common.delete")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Send to Workspace dialog (driven by sendToWorkspaceAtom) */}
      <SendToWorkspaceDialog
        open={sendToWorkspaceIds.length > 0}
        onOpenChange={(open) => { if (!open) setSendToWorkspaceIds([]) }}
        sessionIds={sendToWorkspaceIds}
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        onTransferComplete={handleTransferComplete}
      />

      {/* Messaging dialogs (pairing-code + WA connect) — driven by messagingDialogAtom.
          Mounted here so they survive context-menu / dropdown close. */}
      <MessagingDialogHost />

    </AppShellProvider>
  )
}
