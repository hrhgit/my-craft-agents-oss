/**
 * ChatPage
 *
 * Displays a single session's chat with a consistent PanelHeader.
 * Extracted from MainContentPanel for consistency with other pages.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useAtomValue, useSetAtom } from 'jotai'
import { AlertCircle, Globe, Copy, RefreshCw, Link2Off, Info } from 'lucide-react'
import { ChatDisplay, type ChatDisplayHandle } from '@/components/app-shell/ChatDisplay'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { SessionMenu } from '@/components/app-shell/SessionMenu'
import { CompactSessionMenu } from '@/components/app-shell/CompactSessionMenu'
import { useExtensionStatus } from '@/hooks/useExtensionStatus'
import { SessionInfoPopover } from '@/components/app-shell/SessionInfoPopover'
import { SideTasksStatusPopover } from '@/components/app-shell/SideTasksStatusPopover'
import { RenameDialog } from '@/components/ui/rename-dialog'
import { toast } from 'sonner'
import { PanelHeaderCenterButton } from '@/components/ui/PanelHeaderCenterButton'
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { StyledDropdownMenuContent, StyledDropdownMenuItem, StyledDropdownMenuSeparator } from '@/components/ui/styled-dropdown'
import { useAppShellContext, useSessionOptionsFor, useSession as useSessionData } from '@/context/AppShellContext'
import { rendererPerf } from '@/lib/perf'
import { navigate, routes } from '@/lib/navigate'
import { coerceInputText } from '@/lib/input-text'
import { deriveSessionMessagesLoadState, formatSessionLoadFailure } from '@/lib/session-load'
import { waitForOperation } from '@/lib/operations'
import { ensureSessionMessagesLoadedAtom, sessionMetaMapAtom } from '@/atoms/sessions'
import { piProjectionAtomFamily } from '@/atoms/pi-projection'
import { getSessionTitle } from '@/utils/session'
import { MORTISE_DOCS_URL } from '@mortise/shared/branding'
import { useWorkspaceElectronApi, useWorkspaceRoute } from '@/context/WorkspaceElectronApiContext'
import { createFocusedHandleBinding, createFocusedMatchReporter } from './chat-search-focus-binding'

export interface ChatPageProps {
  sessionId: string
}

const ChatPage = React.memo(function ChatPage({ sessionId }: ChatPageProps) {
  const { t } = useTranslation()
  const electronApi = useWorkspaceElectronApi()
  const workspaceRoute = useWorkspaceRoute()
  // 监听 yourself / repo-memory 扩展的 extension_notify 完成通知并显示 toast
  useExtensionStatus(sessionId)
  // Diagnostic: mark when component runs
  React.useLayoutEffect(() => {
    rendererPerf.markSessionSwitch(sessionId, 'panel.mounted')
  }, [sessionId])

  const {
    activeWorkspaceId,
    piProviders,
    piGlobalSettings,
    onSendMessage,
    onOpenFile,
    onOpenUrl,
    onMarkSessionRead,
    onMarkSessionUnread,
    onSetActiveViewingSession,
    getDraft,
    hydrateDraftAttachments,
    onInputChange,
    onAttachmentsChange,
    skills,
    onRenameSession,
    onDeleteSession,
    panelHeaderTrailingAction,
    leadingAction,
    isCompactMode,
    sessionListSearchQuery,
    isSearchModeActive,
    chatDisplayRef,
    onChatMatchInfoChange,
    isFocusedPanel,
  } = useAppShellContext()
  const ownsChatSearch = isFocusedPanel !== false
  const focusedChatDisplayRef = React.useMemo(
    () => createFocusedHandleBinding(chatDisplayRef, ownsChatSearch),
    [chatDisplayRef, ownsChatSearch],
  )
  const focusedMatchInfoReporter = React.useMemo(
    () => createFocusedMatchReporter(onChatMatchInfoChange, ownsChatSearch),
    [onChatMatchInfoChange, ownsChatSearch],
  )

  // Use the unified session options hook for clean access
  const {
    options: sessionOpts,
    setOption,
  } = useSessionOptionsFor(sessionId)

  // Use per-session atom for isolated updates
  const session = useSessionData(sessionId)
  const piProjection = useAtomValue(piProjectionAtomFamily(sessionId))

  // Check if session exists in metadata (for loading state detection)
  const sessionMetaMap = useAtomValue(sessionMetaMapAtom)
  const sessionMeta = sessionMetaMap.get(sessionId)

  // Load Mortise-owned overlays (annotations, attachment paths, badges). Pi
  // projection loading is independent and owns transcript readiness.
  const ensureMessagesLoaded = useSetAtom(ensureSessionMessagesLoadedAtom)

  React.useEffect(() => {
    let cancelled = false

    const request = workspaceRoute
      ? {
          sessionId,
          api: electronApi,
          cacheKey: `${workspaceRoute.workspaceId}::${workspaceRoute.locationId ?? ''}::${sessionId}`,
        }
      : sessionId
    ensureMessagesLoaded(request)
      .then((loadedSession) => {
        if (!cancelled && !loadedSession) {
          console.warn(`[ChatPage] Session overlay is not available for ${sessionId}`)
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          console.error(`[ChatPage] Failed to load session overlay for ${sessionId}: ${formatSessionLoadFailure(error)}`)
        }
      })

    return () => {
      cancelled = true
    }
  }, [electronApi, ensureMessagesLoaded, sessionId, workspaceRoute])

  const messageLoadState = React.useMemo(() => deriveSessionMessagesLoadState({
    session,
    sessionMeta,
    projectionSyncState: piProjection.syncState,
    projectionEntityCount: piProjection.entityIds.length,
  }), [session, sessionMeta, piProjection.syncState, piProjection.entityIds.length])

  // Perf: Mark when session data is available
  const sessionLoadedMarkedRef = React.useRef<string | null>(null)
  React.useLayoutEffect(() => {
    if (session && sessionLoadedMarkedRef.current !== sessionId) {
      sessionLoadedMarkedRef.current = sessionId
      rendererPerf.markSessionSwitch(sessionId, 'session.loaded')
    }
  }, [sessionId, session])

  // Track which session user is viewing (for unread state machine).
  // This tells main process user is looking at this session, so:
  // 1. If not processing → clear hasUnread immediately
  // 2. If processing → when it completes, main process will clear hasUnread
  // The main process handles all the logic; we just report viewing state.
  //
  // Deliberately NOT gated on OS window focus: a session open in the focused
  // panel counts as being viewed even while the window is in the background,
  // so it must never be marked unread when its turn completes. Only sessions
  // outside the focused panel (background tabs, other windows, closed) may
  // carry the unread "completed" dot in the sidebar.
  React.useEffect(() => {
    if (session && isFocusedPanel !== false) {
      onSetActiveViewingSession(session.id)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id, isFocusedPanel, onSetActiveViewingSession])

  // Track draft value for this session
  const [inputValue, setInputValue] = React.useState(() => coerceInputText(getDraft(sessionId)))
  const inputValueRef = React.useRef(inputValue)
  inputValueRef.current = inputValue

  // Re-sync from parent when session changes
  React.useEffect(() => {
    setInputValue(coerceInputText(getDraft(sessionId)))
  }, [getDraft, sessionId])

  // Sync when draft is set externally (e.g., from notifications or shortcuts)
  // PERFORMANCE NOTE: This bounded polling (max 10 attempts × 50ms = 500ms)
  // handles external draft injection. Drafts use a ref for typing performance,
  // so they're not directly reactive. This polling only runs on session switch,
  // not continuously. Alternative: Add a Jotai atom for draft changes.
  React.useEffect(() => {
    let attempts = 0
    const maxAttempts = 10
    const interval = setInterval(() => {
      const currentDraft = coerceInputText(getDraft(sessionId))
      if (currentDraft !== inputValueRef.current && currentDraft !== '') {
        setInputValue(currentDraft)
        clearInterval(interval)
      }
      attempts++
      if (attempts >= maxAttempts) {
        clearInterval(interval)
      }
    }, 50)

    return () => clearInterval(interval)
  }, [sessionId, getDraft])

  // Listen for restore-input events (queued messages restored to input on abort)
  React.useEffect(() => {
    const handler = (e: Event) => {
      const { sessionId: targetId, text } = (e as CustomEvent).detail ?? {}
      if (targetId === sessionId) {
        const nextText = coerceInputText(text)
        setInputValue(nextText)
        inputValueRef.current = nextText
      }
    }
    window.addEventListener('mortise:restore-input', handler)
    return () => window.removeEventListener('mortise:restore-input', handler)
  }, [sessionId])

  const handleInputChange = React.useCallback((value: string) => {
    const nextText = coerceInputText(value)
    setInputValue(nextText)
    inputValueRef.current = nextText
    onInputChange(sessionId, nextText)
  }, [sessionId, onInputChange])

  // Attachments draft state — hydrated async from persisted refs on session switch.
  // `[]` is the safe default while hydration is in flight; FreeFormInput seeds its
  // local state from this prop and swaps in the restored list when ready.
  const [attachmentsValue, setAttachmentsValue] = React.useState<import('../../shared/types').FileAttachment[]>([])

  React.useEffect(() => {
    let cancelled = false
    setAttachmentsValue([])
    hydrateDraftAttachments(sessionId).then((atts) => {
      if (!cancelled) setAttachmentsValue(atts)
    })
    return () => { cancelled = true }
  }, [sessionId, hydrateDraftAttachments])

  const handleAttachmentsChange = React.useCallback((attachments: import('../../shared/types').FileAttachment[]) => {
    setAttachmentsValue(attachments)
    onAttachmentsChange(sessionId, attachments)
  }, [sessionId, onAttachmentsChange])

  // Session model change handler - persists the provider/model pair directly.
  const handleModelChange = React.useCallback((model: string, provider?: string) => {
    if (activeWorkspaceId) {
      electronApi.setSessionModel(sessionId, activeWorkspaceId, model, provider)
    }
  }, [sessionId, activeWorkspaceId, electronApi])

  const handleProviderChange = React.useCallback(async (provider: string) => {
    try {
      await electronApi.sessionCommand(sessionId, { type: 'setProvider', provider })
    } catch (error) {
      console.error('Failed to change provider:', error)
    }
  }, [sessionId, electronApi])

  const providerUnavailable = React.useMemo(() =>
    !!session?.provider && !piProviders.some(entry => entry.key === session.provider),
    [session?.provider, piProviders]
  )

  // Effective model for this session (session-specific or global fallback)
  const effectiveModel = React.useMemo(() => {
    if (session?.model) return session.model

    if (providerUnavailable) return ''
    return piGlobalSettings.defaultModel ?? ''
  }, [session?.model, providerUnavailable, piGlobalSettings.defaultModel])

  const handleOpenFile = React.useCallback(
    async (path: string) => {
      // Workspace paths are intentionally client-redacted. Absolute paths that
      // came from an explicit OS attachment remain usable; Agent-produced
      // relative paths stay relative and are handled by the workspace surface.
      const resolved = path

      // Smart fallback for missing files in AI output:
      // if the exact path doesn't exist, search nearby for same basename
      // (e.g. markdown/linkify.test.ts -> markdown/__tests__/linkify.test.ts).
      if (resolved.startsWith('/')) {
        const lastSlash = resolved.lastIndexOf('/')
        if (lastSlash > 0 && lastSlash < resolved.length - 1) {
          const parentDir = resolved.slice(0, lastSlash)
          const fileName = resolved.slice(lastSlash + 1)
          try {
            const matches = await electronApi.searchFiles(parentDir, fileName)
            const files = matches.filter((m) => m.type === 'file' && m.name === fileName)
            const exact = files.find((m) => m.path === resolved)
            if (exact) {
              onOpenFile(exact.path)
              return
            }

            if (files.length === 1) {
              onOpenFile(files[0].path)
              toast.info(t('chat.openedClosestMatch', { path: files[0].relativePath }))
              return
            }
          } catch {
            // Search fallback is best-effort; proceed with original resolved path.
          }
        }
      }

      onOpenFile(resolved)
    },
    [onOpenFile, electronApi, t]
  )

  const handleOpenUrl = React.useCallback(
    (url: string) => {
      onOpenUrl(url)
    },
    [onOpenUrl]
  )

  // Perf: Mark when data is ready
  const dataReadyMarkedRef = React.useRef<string | null>(null)
  React.useLayoutEffect(() => {
    if (messageLoadState.messagesReady && session && dataReadyMarkedRef.current !== sessionId) {
      dataReadyMarkedRef.current = sessionId
      rendererPerf.markSessionSwitch(sessionId, 'data.ready')
    }
  }, [sessionId, messageLoadState.messagesReady, session])

  // Perf: Mark render complete after paint
  React.useEffect(() => {
    if (session) {
      const rafId = requestAnimationFrame(() => {
        rendererPerf.endSessionSwitch(sessionId)
      })
      return () => cancelAnimationFrame(rafId)
    }
  }, [sessionId, session])

  // Get display title for header - use getSessionTitle for consistent fallback logic with SessionList
  // Priority: name > first user message > preview > "New chat"
  const displayTitle = session ? getSessionTitle(session) : (sessionMeta ? getSessionTitle(sessionMeta) : t('chat.session'))
  const sharedUrl = session?.sharedUrl || sessionMeta?.sharedUrl || null
  const hasMessages = piProjection.entityIds.length > 0
    || (session?.messageCount ?? sessionMeta?.messageCount ?? 0) > 0
    || !!(session?.lastFinalMessageId || sessionMeta?.lastFinalMessageId)
  const hasUnreadMessages = sessionMeta
    ? !!(sessionMeta.lastFinalMessageId && sessionMeta.lastFinalMessageId !== sessionMeta.lastReadMessageId)
    : false
  // Use isAsyncOperationOngoing for shimmer effect (sharing, updating share, revoking, title regeneration)
  const isAsyncOperationOngoing = session?.isAsyncOperationOngoing || sessionMeta?.isAsyncOperationOngoing || false

  // Rename dialog state
  const [renameDialogOpen, setRenameDialogOpen] = React.useState(false)
  const [renameName, setRenameName] = React.useState('')

  // Session action handlers
  const handleRename = React.useCallback(() => {
    setRenameName(displayTitle)
    setRenameDialogOpen(true)
  }, [displayTitle])

  const handleRenameSubmit = React.useCallback(() => {
    if (renameName.trim() && renameName.trim() !== displayTitle) {
      onRenameSession(sessionId, renameName.trim())
    }
    setRenameDialogOpen(false)
  }, [sessionId, renameName, displayTitle, onRenameSession])

  const handleMarkUnread = React.useCallback(() => {
    onMarkSessionUnread(sessionId)
  }, [sessionId, onMarkSessionUnread])

  const handleDelete = React.useCallback(async () => {
    await onDeleteSession(sessionId)
  }, [sessionId, onDeleteSession])

  const handleOpenInNewWindow = React.useCallback(async () => {
    const route = routes.view.allSessions(sessionId)
    const separator = route.includes('?') ? '&' : '?'
    const url = `mortise://${route}${separator}window=focused`
    try {
      await electronApi.openUrl(url)
    } catch (error) {
      console.error('[ChatPage] openUrl failed:', error)
    }
  }, [sessionId, electronApi])

  // Share action handlers
  const handleShare = React.useCallback(async () => {
    const operationId = crypto.randomUUID()
    await electronApi.sessionCommand(sessionId, { type: 'shareToViewer', operationId })
    const operation = await waitForOperation(electronApi, operationId)
    const current = operation.status === 'succeeded' ? await electronApi.getSessionMessages(sessionId) : null
    const url = current?.sharedUrl
    if (url) {
      await navigator.clipboard.writeText(url)
      toast.success(t('toast.linkCopied'), {
        description: url,
        action: { label: t('sendToWorkspace.open'), onClick: () => electronApi.openUrl(url) },
      })
    } else {
      toast.error(t('toast.failedToShare'), { description: operation.error?.message || t('toast.unknownError') })
    }
  }, [sessionId, electronApi, t])

  const handleOpenInBrowser = React.useCallback(() => {
    if (sharedUrl) electronApi.openUrl(sharedUrl)
  }, [sharedUrl, electronApi])

  const handleCopyLink = React.useCallback(async () => {
    if (sharedUrl) {
      await navigator.clipboard.writeText(sharedUrl)
      toast.success(t('toast.linkCopied'))
    }
  }, [sharedUrl, t])

  const handleUpdateShare = React.useCallback(async () => {
    const operationId = crypto.randomUUID()
    await electronApi.sessionCommand(sessionId, { type: 'updateShare', operationId })
    const operation = await waitForOperation(electronApi, operationId)
    if (operation.status === 'succeeded') {
      toast.success(t('chat.shareUpdated'))
    } else {
      toast.error(t('chat.failedToUpdateShare'), { description: operation.error?.message })
    }
  }, [sessionId, electronApi, t])

  const handleRevokeShare = React.useCallback(async () => {
    const operationId = crypto.randomUUID()
    await electronApi.sessionCommand(sessionId, { type: 'revokeShare', operationId })
    const operation = await waitForOperation(electronApi, operationId)
    if (operation.status === 'succeeded') {
      toast.success(t('chat.sharingStopped'))
    } else {
      toast.error(t('chat.failedToStopSharing'), { description: operation.error?.message })
    }
  }, [sessionId, electronApi, t])

  // Share button with dropdown menu rendered in PanelHeader actions slot
  const shareButton = React.useMemo(() => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <PanelHeaderCenterButton
          aria-label={sharedUrl ? 'Shared session options' : 'Share session'}
          icon={sharedUrl
            ? <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M11.2383 10.2871C11.6481 10.0391 12.1486 10.0082 12.5811 10.1943L12.7617 10.2871L13.0088 10.4414C14.2231 11.227 15.1393 12.2124 15.8701 13.502C16.1424 13.9824 15.9736 14.5929 15.4932 14.8652C15.0127 15.1375 14.4022 14.9688 14.1299 14.4883C13.8006 13.9073 13.4303 13.417 13 12.9883V21C13 21.5523 12.5523 22 12 22C11.4477 22 11 21.5523 11 21V12.9883C10.5697 13.417 10.1994 13.9073 9.87012 14.4883C9.59781 14.9688 8.98732 15.1375 8.50684 14.8652C8.02643 14.5929 7.8576 13.9824 8.12988 13.502C8.90947 12.1264 9.90002 11.0972 11.2383 10.2871ZM11.5 3C14.2848 3 16.6594 4.75164 17.585 7.21289C20.1294 7.90815 22 10.235 22 13C22 16.3137 19.3137 19 16 19H15V16.9961C15.5021 16.9966 16.0115 16.8707 16.4795 16.6055C17.9209 15.7885 18.4272 13.9571 17.6104 12.5156C16.6661 10.8495 15.4355 9.56805 13.7969 8.57617C12.692 7.90745 11.308 7.90743 10.2031 8.57617C8.56453 9.56806 7.3339 10.8495 6.38965 12.5156C5.57277 13.957 6.07915 15.7885 7.52051 16.6055C7.98851 16.8707 8.49794 16.9966 9 16.9961V19H7C4.23858 19 2 16.7614 2 14C2 11.9489 3.23498 10.1861 5.00195 9.41504C5.04745 5.86435 7.93852 3 11.5 3Z" />
              </svg>
            : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M8 8.53809C6.74209 8.60866 5.94798 8.80911 5.37868 9.37841C4.5 10.2571 4.5 11.6713 4.5 14.4997V15.4997C4.5 18.3282 4.5 19.7424 5.37868 20.6211C6.25736 21.4997 7.67157 21.4997 10.5 21.4997H13.5C16.3284 21.4997 17.7426 21.4997 18.6213 20.6211C19.5 19.7424 19.5 18.3282 19.5 15.4997V14.4997C19.5 11.6713 19.5 10.2571 18.6213 9.37841C18.052 8.80911 17.2579 8.60866 16 8.53809M12 14V3.5M9.5 5.5C9.99903 4.50411 10.6483 3.78875 11.5606 3.24093C11.7612 3.12053 11.8614 3.06033 12 3.06033C12.1386 3.06033 12.2388 3.12053 12.4394 3.24093C13.3517 3.78875 14.001 4.50411 14.5 5.5" />
              </svg>
          }
          className={sharedUrl ? 'text-accent' : undefined}
        />
      </DropdownMenuTrigger>
      <StyledDropdownMenuContent align="end" sideOffset={8}>
        {sharedUrl ? (
          <>
            <StyledDropdownMenuItem onClick={handleOpenInBrowser}>
              <Globe className="h-3.5 w-3.5" />
              <span className="flex-1">{t('sessionMenu.openInBrowser')}</span>
            </StyledDropdownMenuItem>
            <StyledDropdownMenuItem onClick={handleCopyLink}>
              <Copy className="h-3.5 w-3.5" />
              <span className="flex-1">{t('sessionMenu.copyLink')}</span>
            </StyledDropdownMenuItem>
            <StyledDropdownMenuItem onClick={handleUpdateShare}>
              <RefreshCw className="h-3.5 w-3.5" />
              <span className="flex-1">{t('sessionMenu.updateShare')}</span>
            </StyledDropdownMenuItem>
            <StyledDropdownMenuSeparator />
            <StyledDropdownMenuItem onClick={handleRevokeShare} variant="destructive">
              <Link2Off className="h-3.5 w-3.5" />
              <span className="flex-1">{t('sessionMenu.stopSharing')}</span>
            </StyledDropdownMenuItem>
            <StyledDropdownMenuSeparator />
            <StyledDropdownMenuItem onClick={() => electronApi.openUrl(MORTISE_DOCS_URL)}>
              <Info className="h-3.5 w-3.5" />
              <span className="flex-1">{t('chat.learnMore')}</span>
            </StyledDropdownMenuItem>
          </>
        ) : (
          <>
            <StyledDropdownMenuItem onClick={handleShare}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <path d="M8 8.53809C6.74209 8.60866 5.94798 8.80911 5.37868 9.37841C4.5 10.2571 4.5 11.6713 4.5 14.4997V15.4997C4.5 18.3282 4.5 19.7424 5.37868 20.6211C6.25736 21.4997 7.67157 21.4997 10.5 21.4997H13.5C16.3284 21.4997 17.7426 21.4997 18.6213 20.6211C19.5 19.7424 19.5 18.3282 19.5 15.4997V14.4997C19.5 11.6713 19.5 10.2571 18.6213 9.37841C18.052 8.80911 17.2579 8.60866 16 8.53809M12 14V3.5M9.5 5.5C9.99903 4.50411 10.6483 3.78875 11.5606 3.24093C11.7612 3.12053 11.8614 3.06033 12 3.06033C12.1386 3.06033 12.2388 3.12053 12.4394 3.24093C13.3517 3.78875 14.001 4.50411 14.5 5.5" />
              </svg>
              <span className="flex-1">{t('chat.shareOnline')}</span>
            </StyledDropdownMenuItem>
            <StyledDropdownMenuSeparator />
            <StyledDropdownMenuItem onClick={() => electronApi.openUrl(MORTISE_DOCS_URL)}>
              <Info className="h-3.5 w-3.5" />
              <span className="flex-1">{t('chat.learnMore')}</span>
            </StyledDropdownMenuItem>
          </>
        )}
      </StyledDropdownMenuContent>
    </DropdownMenu>
  ), [sharedUrl, handleShare, handleOpenInBrowser, handleCopyLink, handleUpdateShare, handleRevokeShare, electronApi, t])

  const compactInfoButton = React.useMemo(() => {
    if (!isCompactMode || !sessionMeta) return undefined

    return (
      <SessionInfoPopover
        sessionId={sessionId}
        sessionFolderPath={session?.sessionFolderPath}
        presentation="drawer"
        trigger={(
          <PanelHeaderCenterButton
            icon={<Info className="h-4 w-4" />}
            aria-label={t("chat.sessionInfo")}
          />
        )}
      />
    )
  }, [isCompactMode, sessionId, session?.sessionFolderPath, sessionMeta, t])

  const headerActions = isCompactMode ? compactInfoButton : shareButton
  const sideTasksStatusButton = React.useMemo(() => (
    <SideTasksStatusPopover
      parentSessionId={sessionId}
    />
  ), [sessionId])

  // Build title menu content for chat sessions using shared SessionMenu.
  // Desktop uses Radix DropdownMenu via PanelHeader; compact mode uses a
  // vaul Drawer (CompactSessionMenu) so submenus aren't clipped by the
  // panel container query on narrow viewports.
  const titleMenu = React.useMemo(() => (sessionMeta && !isCompactMode) ? (
    <SessionMenu
      item={sessionMeta}
      onRename={handleRename}
      onMarkUnread={handleMarkUnread}
      onOpenInNewWindow={handleOpenInNewWindow}
      onDelete={handleDelete}
    />
  ) : null, [
    sessionMeta,
    isCompactMode,
    handleRename,
    handleMarkUnread,
    handleOpenInNewWindow,
    handleDelete,
  ])

  const compactTitleMenu = React.useMemo(() => (sessionMeta && isCompactMode) ? (
    <CompactSessionMenu
      title={displayTitle}
      isTitleBusy={isAsyncOperationOngoing}
      item={sessionMeta}
      onRename={handleRename}
      onMarkUnread={handleMarkUnread}
      onOpenInNewWindow={handleOpenInNewWindow}
      onDelete={handleDelete}
    />
  ) : null, [
    sessionMeta,
    isCompactMode,
    displayTitle,
    isAsyncOperationOngoing,
    handleRename,
    handleMarkUnread,
    handleOpenInNewWindow,
    handleDelete,
  ])

  // Handle missing session - loading or deleted
  if (!session) {
    if (sessionMeta) {
      // Session exists in metadata but not loaded yet - show loading state
      const skeletonSession = {
        id: sessionMeta.id,
        workspaceId: sessionMeta.workspaceId,
        workspaceName: '',
        name: sessionMeta.name,
        preview: sessionMeta.preview,
        lastMessageAt: sessionMeta.lastMessageAt || 0,
        messages: [],
        isProcessing: sessionMeta.isProcessing || false,
      }

      return (
        <>
          <div className="h-full flex flex-col" data-e2e-chat-session-id={sessionId}>
            <PanelHeader  title={displayTitle} titleMenu={titleMenu} compactTitleMenu={compactTitleMenu} leadingAction={leadingAction} centerButton={sideTasksStatusButton} actions={headerActions} trailingAction={panelHeaderTrailingAction} isTitleBusy={isAsyncOperationOngoing} />
            <div className="flex-1 flex flex-col min-h-0">
              <ChatDisplay
                ref={focusedChatDisplayRef}
                session={skeletonSession}
                onSendMessage={async () => false}
                onOpenFile={handleOpenFile}
                onOpenUrl={handleOpenUrl}
                currentModel={effectiveModel}
                onModelChange={handleModelChange}
                onProviderChange={handleProviderChange}
                thinkingLevel={sessionOpts.thinkingLevel}
                onThinkingLevelChange={(level) => setOption('thinkingLevel', level)}
                inputValue={inputValue}
                onInputChange={handleInputChange}
                attachmentsValue={attachmentsValue}
                onAttachmentsChange={handleAttachmentsChange}
                skills={skills}
                workspaceId={activeWorkspaceId || undefined}
                messagesLoading={messageLoadState.messagesLoading}
                searchQuery={sessionListSearchQuery}
                isSearchModeActive={isSearchModeActive}
                onMatchInfoChange={focusedMatchInfoReporter}
                providerUnavailable={providerUnavailable}
                compactMode={!!isCompactMode}
                enableCompactModelPicker={!!isCompactMode}
              />
            </div>
          </div>
          <RenameDialog
            open={renameDialogOpen}
            onOpenChange={setRenameDialogOpen}
            title={t('chat.renameSession')}
            value={renameName}
            onValueChange={setRenameName}
            onSubmit={handleRenameSubmit}
            placeholder={t('chat.enterSessionName')}
          />
        </>
      )
    }

    // Session truly doesn't exist
    return (
      <div className="h-full flex flex-col" data-e2e-chat-session-id={sessionId}>
        <PanelHeader  title={t('chat.session')} leadingAction={leadingAction} trailingAction={panelHeaderTrailingAction} />
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-muted-foreground">
          <AlertCircle className="h-10 w-10" />
          <p className="text-sm">{t('chat.sessionNoLongerExists')}</p>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="h-full flex flex-col" data-e2e-chat-session-id={sessionId}>
        <PanelHeader  title={displayTitle} titleMenu={titleMenu} compactTitleMenu={compactTitleMenu} leadingAction={leadingAction} centerButton={sideTasksStatusButton} actions={headerActions} trailingAction={panelHeaderTrailingAction} isTitleBusy={isAsyncOperationOngoing} />
        <div className="flex-1 flex flex-col min-h-0">
          <ChatDisplay
            ref={focusedChatDisplayRef}
            session={session}
            onSendMessage={attempt => session
              ? onSendMessage(
                session.id,
                attempt.message,
                attempt.attachments,
                attempt.skillSlugs,
                undefined,
                attempt.midStreamSendIntent,
                attempt.attemptId,
              )
              : Promise.resolve(false)}
            onRetrySettlement={() => electronApi
              .sessionCommand(sessionId, { type: 'retrySettlement', operationId: crypto.randomUUID() })
              .then(() => undefined)}
            onRetryAcceptedMessage={() => electronApi
              .sessionCommand(sessionId, { type: 'retryAcceptedMessage', operationId: crypto.randomUUID() })
              .then(() => undefined)}
            onOpenFile={handleOpenFile}
            onOpenUrl={handleOpenUrl}
            currentModel={effectiveModel}
            onModelChange={handleModelChange}
            onProviderChange={handleProviderChange}
            thinkingLevel={sessionOpts.thinkingLevel}
            onThinkingLevelChange={(level) => setOption('thinkingLevel', level)}
            inputValue={inputValue}
            onInputChange={handleInputChange}
            attachmentsValue={attachmentsValue}
            onAttachmentsChange={handleAttachmentsChange}
            skills={skills}
            workspaceId={activeWorkspaceId || undefined}
            sessionFolderPath={session?.sessionFolderPath}
            messagesLoading={messageLoadState.messagesLoading}
            searchQuery={sessionListSearchQuery}
            isSearchModeActive={isSearchModeActive}
            onMatchInfoChange={focusedMatchInfoReporter}
            providerUnavailable={providerUnavailable}
            compactMode={!!isCompactMode}
            enableCompactModelPicker={!!isCompactMode}
          />
        </div>
      </div>
      <RenameDialog
        open={renameDialogOpen}
        onOpenChange={setRenameDialogOpen}
        title={t('chat.renameSession')}
        value={renameName}
        onValueChange={setRenameName}
        onSubmit={handleRenameSubmit}
        placeholder={t('chat.enterSessionName')}
      />
    </>
  )
})

export default ChatPage
