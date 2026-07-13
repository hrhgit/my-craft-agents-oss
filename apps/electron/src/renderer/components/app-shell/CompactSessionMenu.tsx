import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { motion } from 'motion/react'
import { AppWindow, ChevronDown, CloudUpload, Columns2, Copy, FolderOpen, MailOpen, MessageSquare, Pencil, RefreshCw, Send, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Drawer, DrawerTrigger, DrawerContent, DrawerHeader, DrawerTitle } from '@/components/ui/drawer'
import type { SessionMeta } from '@/atoms/sessions'
import { hasMessagesMeta, hasUnreadMeta } from '@/utils/session'
import { getFileManagerName } from '@/lib/platform'
import { useMessagingConnect, type MessagingPlatform } from '@/components/messaging/MessagingSessionMenuItem'
import { useSessionMenuActions } from '@/hooks/useSessionMenuActions'

export interface CompactSessionMenuProps {
  title?: string
  badge?: React.ReactNode
  isTitleBusy?: boolean
  item: SessionMeta
  hasRemoteWorkspaces?: boolean
  onRename: () => void
  onMarkUnread: () => void
  onOpenInNewWindow: () => void
  onSendToWorkspace?: () => void
  onDelete: () => void
  open?: boolean
  onOpenChange?: (open: boolean) => void
  trigger?: React.ReactNode | null
}

export function CompactSessionMenu({ title, badge, isTitleBusy, item, hasRemoteWorkspaces, onRename, onMarkUnread, onOpenInNewWindow, onSendToWorkspace, onDelete, open: controlledOpen, onOpenChange, trigger }: CompactSessionMenuProps) {
  const { t } = useTranslation()
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false)
  const open = controlledOpen ?? uncontrolledOpen
  const setOpen = React.useCallback((next: boolean) => { if (controlledOpen === undefined) setUncontrolledOpen(next); onOpenChange?.(next) }, [controlledOpen, onOpenChange])
  const actions = useSessionMenuActions({ item })
  const connectMessaging = useMessagingConnect({ sessionId: item.id })
  const closeAfter = React.useCallback((fn?: () => void | Promise<void>) => fn ? () => { void fn(); setOpen(false) } : undefined, [setOpen])
  React.useEffect(() => { setOpen(false) }, [item.id, setOpen])

  const triggerNode = trigger === null ? null : trigger !== undefined ? <DrawerTrigger asChild>{trigger}</DrawerTrigger> : (
    <DrawerTrigger asChild><button type="button" className="flex items-center gap-1 px-2 py-1 rounded-md titlebar-no-drag min-w-0 hover:bg-foreground/[0.03]" aria-label={title}>
      <motion.div initial={false} animate={{ opacity: title ? 1 : 0 }} className="flex items-center gap-1 min-w-0"><h1 className={cn('text-sm font-semibold truncate', isTitleBusy && 'animate-shimmer-text')}>{title}</h1>{badge}</motion.div><ChevronDown className="h-3.5 w-3.5 text-foreground/50" />
    </button></DrawerTrigger>
  )

  return <Drawer open={open} onOpenChange={setOpen}>{triggerNode}<DrawerContent className="max-h-[85vh]">
    <DrawerHeader><DrawerTitle>{title}</DrawerTitle></DrawerHeader>
    <div className="flex flex-col px-2 pb-4">
      {!item.sharedUrl ? <Row icon={<CloudUpload />} label={t('sessionMenu.share')} onTap={closeAfter(actions.share)} /> : <><Row icon={<CloudUpload />} label={t('sessionMenu.openInBrowser')} onTap={closeAfter(actions.openSharedInBrowser)} /><Row icon={<Copy />} label={t('sessionMenu.copyLink')} onTap={closeAfter(actions.copySharedLink)} /></>}
      {hasRemoteWorkspaces && <Row icon={<Send />} label={t('sessionMenu.sendToWorkspace')} onTap={closeAfter(onSendToWorkspace)} />}
      <Row icon={<MessageSquare />} label={t('sessionMenu.connectMessaging')} onTap={() => { setOpen(false); void connectMessaging('telegram' as MessagingPlatform) }} />
      {!hasUnreadMeta(item) && hasMessagesMeta(item) && <Row icon={<MailOpen />} label={t('sessionMenu.markAsUnread')} onTap={closeAfter(onMarkUnread)} />}
      <Separator />
      <Row icon={<Pencil />} label={t('common.rename')} onTap={closeAfter(onRename)} /><Row icon={<RefreshCw />} label={t('sessionMenu.regenerateTitle')} onTap={closeAfter(actions.refreshTitle)} />
      <Separator />
      <Row icon={<Columns2 />} label={t('sessionMenu.openInNewPanel')} onTap={closeAfter(actions.openInNewPanel)} /><Row icon={<AppWindow />} label={t('sessionMenu.openInNewWindow')} onTap={closeAfter(onOpenInNewWindow)} /><Row icon={<FolderOpen />} label={t('sessionMenu.showInFileManager', { fileManager: getFileManagerName() })} onTap={closeAfter(actions.showInFinder)} /><Row icon={<Copy />} label={t('sessionMenu.copyPath')} onTap={closeAfter(actions.copyPath)} />
      <Separator /><Row icon={<Trash2 />} label={t('common.delete')} onTap={closeAfter(onDelete)} destructive />
    </div>
  </DrawerContent></Drawer>
}

function Row({ icon, label, onTap, destructive }: { icon: React.ReactNode; label: React.ReactNode; onTap?: () => void; destructive?: boolean }) {
  if (!onTap) return null
  return <button type="button" onClick={onTap} className={cn('flex items-center gap-3 w-full px-3 py-3 rounded-[8px] text-left hover:bg-foreground/5', destructive && 'text-destructive hover:bg-destructive/10')}><span className="h-5 w-5 [&>svg]:h-4 [&>svg]:w-4">{icon}</span><span className="flex-1 text-sm truncate">{label}</span></button>
}
function Separator() { return <div className="my-1 mx-3 h-px bg-foreground/[0.06]" /> }
