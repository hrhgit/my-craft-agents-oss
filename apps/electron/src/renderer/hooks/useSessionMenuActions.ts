/**
 * useSessionMenuActions
 *
 * Single source of truth for session-menu side effects (share / refresh title /
 * copy path / show in finder / open in new panel / share-submenu actions).
 * Consumed by both `SessionMenu` (desktop dropdown / context menu) and
 * `CompactSessionMenu` (compact-mode drawer) so a new session action only has
 * to be wired through one place.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { navigate, routes } from '@/lib/navigate'
import type { SessionMeta } from '@/atoms/sessions'
import { useWorkspaceElectronApi } from '@/context/WorkspaceElectronApiContext'
import { waitForOperation } from '@/lib/operations'

export interface UseSessionMenuActionsOptions {
  item: SessionMeta
}

export interface SessionMenuActions {
  share: () => Promise<void>
  showInFinder: () => void
  copyPath: () => Promise<void>
  refreshTitle: () => Promise<void>
  openInNewPanel: () => void
  /** Open the session's published share URL in the system browser (no-op if not shared). */
  openSharedInBrowser: () => void
  /** Copy the session's published share URL to the clipboard (no-op if not shared). */
  copySharedLink: () => Promise<void>
  /** Re-publish the share to bump the snapshot. */
  updateShare: () => Promise<void>
  /** Revoke the share. */
  revokeShare: () => Promise<void>
}

// SOH (U+0001) — non-printable so it can't collide with label IDs (which
// validate to [a-z0-9-]) or values (which may themselves contain '::').
export function useSessionMenuActions({
  item,
}: UseSessionMenuActionsOptions): SessionMenuActions {
  const { t } = useTranslation()
  const electronApi = useWorkspaceElectronApi()
  const sessionId = item.id
  const sharedUrl = item.sharedUrl

  const share = React.useCallback(async () => {
    const operationId = crypto.randomUUID()
    await electronApi.sessionCommand(sessionId, { type: 'shareToViewer', operationId })
    const operation = await waitForOperation(electronApi, operationId)
    const session = operation.status === 'succeeded' ? await electronApi.getSessionMessages(sessionId) : null
    const url = session?.sharedUrl
    if (url) {
      await navigator.clipboard.writeText(url)
      toast.success(t('toast.linkCopied'), {
        description: url,
        action: {
          label: t('common.open'),
          onClick: () => electronApi.openUrl(url),
        },
      })
    } else {
      toast.error(t('toast.failedToShare'), { description: operation.error?.message || t('toast.unknownError') })
    }
  }, [electronApi, sessionId, t])

  const showInFinder = React.useCallback(() => {
    electronApi.sessionCommand(sessionId, { type: 'showInFinder' })
  }, [electronApi, sessionId])

  const copyPath = React.useCallback(async () => {
    const result = await electronApi.sessionCommand(sessionId, { type: 'copyPath' }) as { success: boolean; path?: string } | undefined
    if (result?.success && result.path) {
      await navigator.clipboard.writeText(result.path)
      toast.success(t('toast.pathCopied'))
    }
  }, [electronApi, sessionId, t])

  const refreshTitle = React.useCallback(async () => {
    const operationId = crypto.randomUUID()
    await electronApi.sessionCommand(sessionId, { type: 'refreshTitle', operationId })
    const operation = await waitForOperation(electronApi, operationId)
    const session = operation.status === 'succeeded' ? await electronApi.getSessionMessages(sessionId) : null
    if (session) {
      toast.success(t('toast.titleRefreshed'), { description: session.name })
    } else {
      toast.error(t('toast.failedToRefreshTitle'), { description: operation.error?.message || t('toast.unknownError') })
    }
  }, [electronApi, sessionId, t])

  const openInNewPanel = React.useCallback(() => {
    navigate(routes.view.allSessions(sessionId), { intent: 'open-new' })
  }, [sessionId])

  const openSharedInBrowser = React.useCallback(() => {
    if (!sharedUrl) return
    electronApi.openUrl(sharedUrl)
  }, [electronApi, sharedUrl])

  const copySharedLink = React.useCallback(async () => {
    if (!sharedUrl) return
    await navigator.clipboard.writeText(sharedUrl)
    toast.success(t('toast.linkCopied'))
  }, [sharedUrl, t])

  const updateShare = React.useCallback(async () => {
    const operationId = crypto.randomUUID()
    await electronApi.sessionCommand(sessionId, { type: 'updateShare', operationId })
    const operation = await waitForOperation(electronApi, operationId)
    if (operation.status === 'succeeded') {
      toast.success(t('chat.shareUpdated'))
    } else {
      toast.error(t('chat.failedToUpdateShare'), { description: operation.error?.message })
    }
  }, [electronApi, sessionId, t])

  const revokeShare = React.useCallback(async () => {
    const operationId = crypto.randomUUID()
    await electronApi.sessionCommand(sessionId, { type: 'revokeShare', operationId })
    const operation = await waitForOperation(electronApi, operationId)
    if (operation.status === 'succeeded') {
      toast.success(t('chat.sharingStopped'))
    } else {
      toast.error(t('chat.failedToStopSharing'), { description: operation.error?.message })
    }
  }, [electronApi, sessionId, t])

  return {
    share,
    showInFinder,
    copyPath,
    refreshTitle,
    openInNewPanel,
    openSharedInBrowser,
    copySharedLink,
    updateShare,
    revokeShare,
  }
}
