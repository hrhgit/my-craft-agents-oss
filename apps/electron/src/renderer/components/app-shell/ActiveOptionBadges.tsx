import { Info } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import type { PermissionMode } from '@mortise/shared/agent/modes'
import { ActiveTasksBar, type BackgroundTask } from './ActiveTasksBar'
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

export function ActiveOptionBadges({
  tasks = [],
  sessionId,
  sessionFolderPath,
  onKillTask,
  onInsertMessage,
  className,
}: ActiveOptionBadgesProps) {
  const { t } = useTranslation()
  if (!sessionId) return null
  return <div className={cn('mb-2 flex flex-wrap items-start justify-end gap-1.5 px-px pb-0.5 pt-px', className)}>
    <ActiveTasksBar
      tasks={tasks}
      sessionId={sessionId}
      onKillTask={onKillTask}
      onInsertMessage={onInsertMessage}
    />
    <SessionInfoPopover
      sessionId={sessionId}
      sessionFolderPath={sessionFolderPath}
      trigger={<button type="button" className="h-9 px-3 text-sm font-medium rounded-[8px] flex items-center gap-1.5 border border-border bg-background shadow-sm hover:bg-foreground/5 text-foreground"><Info className="h-4 w-4" /><span>{t('common.info')}</span></button>}
    />
  </div>
}
