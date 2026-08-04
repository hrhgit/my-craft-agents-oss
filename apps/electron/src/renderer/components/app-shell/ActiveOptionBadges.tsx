import { cn } from '@/lib/utils'
import type { PermissionMode } from '@mortise/shared/agent/modes'
import { ActiveTasksBar, type BackgroundTask } from './ActiveTasksBar'

export interface ActiveOptionBadgesProps {
  permissionMode?: PermissionMode
  onPermissionModeChange?: (mode: PermissionMode) => void
  showPermissionModeBadge?: boolean
  tasks?: BackgroundTask[]
  sessionId?: string
  onKillTask?: (taskId: string) => void
  onInsertMessage?: (text: string) => void
  className?: string
}

export function ActiveOptionBadges({
  tasks = [],
  sessionId,
  onKillTask,
  onInsertMessage,
  className,
}: ActiveOptionBadgesProps) {
  if (!sessionId || tasks.length === 0) return null
  return <div className={cn('mb-2 flex flex-wrap items-start justify-end gap-1.5 px-px pb-0.5 pt-px', className)}>
    <ActiveTasksBar
      tasks={tasks}
      sessionId={sessionId}
      onKillTask={onKillTask}
      onInsertMessage={onInsertMessage}
    />
  </div>
}
