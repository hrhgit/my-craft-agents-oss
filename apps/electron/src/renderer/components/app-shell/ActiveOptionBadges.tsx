import { Info } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import type { PermissionMode } from '@craft-agent/shared/agent/modes'
import type { BackgroundTask } from './ActiveTasksBar'
import { SessionInfoPopover } from './SessionInfoPopover'

export interface ActiveOptionBadgesProps {
  permissionMode?: PermissionMode
  onPermissionModeChange?: (mode: PermissionMode) => void
  showPermissionModeBadge?: boolean
  tasks?: BackgroundTask[]
  sessionId?: string
  sessionFolderPath?: string
  onKillTask?: (taskId: string) => void
  onInsertMessage?: (text: string) => void
  className?: string
}

export function ActiveOptionBadges({ sessionId, sessionFolderPath, className }: ActiveOptionBadgesProps) {
  const { t } = useTranslation()
  if (!sessionId) return null
  return <div className={cn('flex items-start justify-end mb-2 px-px pt-px pb-0.5', className)}>
    <SessionInfoPopover
      sessionId={sessionId}
      sessionFolderPath={sessionFolderPath}
      trigger={<button type="button" className="h-[30px] px-3 text-xs font-medium rounded-[8px] flex items-center gap-1.5 shadow-minimal hover:bg-foreground/5 bg-[color-mix(in_srgb,var(--background)_97%,var(--foreground)_3%)] text-foreground/80"><Info className="h-3.5 w-3.5" /><span>{t('common.info')}</span></button>}
    />
  </div>
}
