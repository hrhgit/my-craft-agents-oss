import { useTranslation } from 'react-i18next'
import { Globe, Copy, RefreshCw, Link2Off } from 'lucide-react'
import type { MenuComponents } from '@/components/ui/menu-context'

export interface ShareMenuItemsProps {
  onOpenInBrowser: () => void
  onCopyLink: () => void | Promise<void>
  onUpdateShare: () => void | Promise<void>
  onRevokeShare: () => void | Promise<void>
  menu: Pick<MenuComponents, 'MenuItem' | 'Separator'>
}

export function ShareMenuItems({ onOpenInBrowser, onCopyLink, onUpdateShare, onRevokeShare, menu }: ShareMenuItemsProps) {
  const { t } = useTranslation()
  const { MenuItem, Separator } = menu
  return <>
    <MenuItem onClick={onOpenInBrowser}><Globe className="h-3.5 w-3.5" /><span className="flex-1">{t('sessionMenu.openInBrowser')}</span></MenuItem>
    <MenuItem onClick={onCopyLink}><Copy className="h-3.5 w-3.5" /><span className="flex-1">{t('sessionMenu.copyLink')}</span></MenuItem>
    <MenuItem onClick={onUpdateShare}><RefreshCw className="h-3.5 w-3.5" /><span className="flex-1">{t('sessionMenu.updateShare')}</span></MenuItem>
    <Separator />
    <MenuItem onClick={onRevokeShare} variant="destructive"><Link2Off className="h-3.5 w-3.5" /><span className="flex-1">{t('sessionMenu.stopSharing')}</span></MenuItem>
  </>
}
