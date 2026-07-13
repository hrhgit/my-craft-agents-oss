import { useTranslation } from 'react-i18next'
import { AppWindow, CloudUpload, Columns2, Copy, FolderOpen, MailOpen, Pencil, RefreshCw, Send, Trash2 } from 'lucide-react'
import { useMenuComponents } from '@/components/ui/menu-context'
import { ShareMenuItems } from './SessionMenuParts'
import { getFileManagerName } from '@/lib/platform'
import type { SessionMeta } from '@/atoms/sessions'
import { hasMessagesMeta, hasUnreadMeta } from '@/utils/session'
import { MessagingSessionMenuItem } from '@/components/messaging/MessagingSessionMenuItem'
import { useSessionMenuActions } from '@/hooks/useSessionMenuActions'

export interface SessionMenuProps {
  item: SessionMeta
  hasRemoteWorkspaces?: boolean
  onRename: () => void
  onMarkUnread: () => void
  onOpenInNewWindow: () => void
  onSendToWorkspace?: () => void
  onDelete: () => void
}

export function SessionMenu({ item, hasRemoteWorkspaces, onRename, onMarkUnread, onOpenInNewWindow, onSendToWorkspace, onDelete }: SessionMenuProps) {
  const { t } = useTranslation()
  const actions = useSessionMenuActions({ item })
  const { MenuItem, Separator, Sub, SubTrigger, SubContent } = useMenuComponents()

  return (
    <>
      {!item.sharedUrl ? (
        <MenuItem onClick={actions.share}><CloudUpload className="h-3.5 w-3.5" /><span className="flex-1">{t('sessionMenu.share')}</span></MenuItem>
      ) : (
        <Sub>
          <SubTrigger className="pr-2"><CloudUpload className="h-3.5 w-3.5" /><span className="flex-1">{t('sessionMenu.shared')}</span></SubTrigger>
          <SubContent><ShareMenuItems onOpenInBrowser={actions.openSharedInBrowser} onCopyLink={actions.copySharedLink} onUpdateShare={actions.updateShare} onRevokeShare={actions.revokeShare} menu={{ MenuItem, Separator }} /></SubContent>
        </Sub>
      )}
      {hasRemoteWorkspaces && onSendToWorkspace && <MenuItem onClick={onSendToWorkspace}><Send className="h-3.5 w-3.5" /><span className="flex-1">{t('sessionMenu.sendToWorkspace')}</span></MenuItem>}
      <MessagingSessionMenuItem sessionId={item.id} />
      {!hasUnreadMeta(item) && hasMessagesMeta(item) && <MenuItem onClick={onMarkUnread}><MailOpen className="h-3.5 w-3.5" /><span className="flex-1">{t('sessionMenu.markAsUnread')}</span></MenuItem>}
      <Separator />
      <MenuItem onClick={onRename}><Pencil className="h-3.5 w-3.5" /><span className="flex-1">{t('common.rename')}</span></MenuItem>
      <MenuItem onClick={actions.refreshTitle}><RefreshCw className="h-3.5 w-3.5" /><span className="flex-1">{t('sessionMenu.regenerateTitle')}</span></MenuItem>
      <Separator />
      <MenuItem onClick={actions.openInNewPanel}><Columns2 className="h-3.5 w-3.5" /><span className="flex-1">{t('sessionMenu.openInNewPanel')}</span></MenuItem>
      <MenuItem onClick={onOpenInNewWindow}><AppWindow className="h-3.5 w-3.5" /><span className="flex-1">{t('sessionMenu.openInNewWindow')}</span></MenuItem>
      <MenuItem onClick={actions.showInFinder}><FolderOpen className="h-3.5 w-3.5" /><span className="flex-1">{t('sessionMenu.showInFileManager', { fileManager: getFileManagerName() })}</span></MenuItem>
      <MenuItem onClick={actions.copyPath}><Copy className="h-3.5 w-3.5" /><span className="flex-1">{t('sessionMenu.copyPath')}</span></MenuItem>
      <Separator />
      <MenuItem onClick={onDelete} variant="destructive"><Trash2 className="h-3.5 w-3.5" /><span className="flex-1">{t('common.delete')}</span></MenuItem>
    </>
  )
}
