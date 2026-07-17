import * as React from 'react'
import { ExternalLink, GitBranch, MessageSquare, RefreshCw } from 'lucide-react'
import { Spinner } from '@craft-agent/ui'
import type { PiChildSessionInfo } from '@craft-agent/shared/agent'
import { useTranslation } from 'react-i18next'
import { HeaderIconButton } from '@/components/ui/HeaderIconButton'
import { useWorkspaceElectronApi } from '@/context/WorkspaceElectronApiContext'
import { createSingleFlightLoader, isSubagentRefreshEvent } from '@/components/extensions/subagent-session-loader'
import { sideTaskTitle } from './side-tasks-workbench-state'

interface SideTasksWorkbenchProps {
  parentSessionId: string
  onOpenSession?: (sessionId: string, title: string) => void
}

export function SideTasksWorkbench({ parentSessionId, onOpenSession }: SideTasksWorkbenchProps) {
  const { t } = useTranslation()
  const electronApi = useWorkspaceElectronApi()
  const loader = React.useMemo(
    () => createSingleFlightLoader(
      sessionId => electronApi.listChildSessions(sessionId),
      { cacheTtlMs: 5_000 },
    ),
    [electronApi],
  )
  const [tasks, setTasks] = React.useState<PiChildSessionInfo[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  const refresh = React.useCallback(async (force = false) => {
    setLoading(true)
    try {
      const next = await loader.load(parentSessionId, { force })
      setTasks(next)
      setError(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }, [loader, parentSessionId])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  React.useEffect(() => {
    if (typeof electronApi.onExtensionEvent !== 'function') return
    return electronApi.onExtensionEvent(event => {
      if (isSubagentRefreshEvent(event, parentSessionId)) void refresh(true)
    })
  }, [electronApi, parentSessionId, refresh])

  const openTask = React.useCallback((task: PiChildSessionInfo) => {
    const title = sideTaskTitle(task, t('workbench.untitledSideTask'))
    if (onOpenSession) {
      onOpenSession(task.sessionId, title)
      return
    }
    if (
      typeof electronApi.openChildSessionWindow === 'function'
      && electronApi.isChannelAvailable('window:openChildSessionWindow')
    ) {
      void electronApi.openChildSessionWindow(task.sessionId, { title })
    }
  }, [electronApi, onOpenSession, t])

  return (
    <section
      aria-label={t('workbench.sideTasks')}
      data-craft-semantic-id={`workspace.side-tasks.${encodeURIComponent(parentSessionId)}`}
      className="flex h-full min-h-0 flex-col bg-background"
    >
      <header className="flex h-10 shrink-0 items-center justify-between border-b border-border/40 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate text-xs font-medium text-muted-foreground">
            {t('workbench.sideTaskCount', { count: tasks.length })}
          </span>
        </div>
        <HeaderIconButton
          icon={loading ? <Spinner className="text-[10px]" /> : <RefreshCw className="size-3.5" />}
          tooltip={t('workbench.refreshSideTasks')}
          aria-label={t('workbench.refreshSideTasks')}
          disabled={loading}
          onClick={() => void refresh(true)}
        />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && tasks.length === 0 ? (
          <div className="flex h-24 items-center justify-center"><Spinner className="size-4" /></div>
        ) : error ? (
          <div role="alert" className="px-4 py-6 text-xs leading-5 text-destructive">
            {t('workbench.sideTasksLoadFailed')}: {error}
          </div>
        ) : tasks.length === 0 ? (
          <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground">
            <GitBranch className="size-5 opacity-55" />
            <p className="text-xs">{t('workbench.noSideTasks')}</p>
          </div>
        ) : (
          <div role="list" aria-label={t('workbench.sideTasks')}>
            {tasks.map(task => {
              const title = sideTaskTitle(task, t('workbench.untitledSideTask'))
              return (
                <button
                  key={task.sessionId}
                  type="button"
                  data-craft-semantic-id={`workspace.side-task.${encodeURIComponent(task.sessionId)}`}
                  onClick={() => openTask(task)}
                  className="group flex min-h-14 w-full min-w-0 items-center gap-2 border-b border-border/35 px-3 py-2 text-left outline-none transition-colors hover:bg-foreground/[0.035] focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                  aria-label={t('workbench.openSideTask', { title })}
                >
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-[5px] bg-foreground/[0.035]">
                    <MessageSquare className="size-3.5 text-muted-foreground" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium text-foreground">{title}</span>
                    <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                      {task.messageCount > 0
                        ? t('workbench.sideTaskMessages', { count: task.messageCount })
                        : formatSideTaskTimestamp(task.modified)}
                    </span>
                  </span>
                  <ExternalLink className="size-3.5 shrink-0 text-muted-foreground opacity-65 transition-opacity group-hover:opacity-100" />
                </button>
              )
            })}
          </div>
        )}
      </div>
    </section>
  )
}

function formatSideTaskTimestamp(value: string): string {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : value
}
