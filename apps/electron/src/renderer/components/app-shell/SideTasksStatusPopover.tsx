import * as React from 'react'
import { useAtomValue } from 'jotai'
import { useTranslation } from 'react-i18next'
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  GitBranch,
  Loader2,
  RefreshCw,
} from 'lucide-react'
import { Spinner } from '@mortise/ui'
import type { PiChildSessionInfo } from '@mortise/shared/agent'
import { sessionMetaMapAtom } from '@/atoms/sessions'
import { PanelHeaderCenterButton } from '@/components/ui/PanelHeaderCenterButton'
import { HeaderIconButton } from '@/components/ui/HeaderIconButton'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useWorkspaceElectronApi } from '@/context/WorkspaceElectronApiContext'
import {
  applySideTaskSessionNames,
  partitionSideTasks,
  shouldRefreshSideTasks,
  shouldShowSideTasksTrigger,
  sideTaskSemanticPart,
  sideTaskTitle,
  type SideTaskSections,
} from './side-tasks-status-model'
import { createSingleFlightLoader } from './single-flight-loader'

interface SideTasksStatusPopoverProps {
  parentSessionId: string
  onOpenSession: (sessionId: string, title: string) => void
}

export function SideTasksStatusPopover({ parentSessionId, onOpenSession }: SideTasksStatusPopoverProps) {
  const { t } = useTranslation()
  const electronApi = useWorkspaceElectronApi()
  const sessionMetaMap = useAtomValue(sessionMetaMapAtom)
  const loader = React.useMemo(
    () => createSingleFlightLoader(
      sessionId => electronApi.listChildSessions(sessionId),
      { cacheTtlMs: 5_000 },
    ),
    [electronApi],
  )
  const [open, setOpen] = React.useState(false)
  const [tasks, setTasks] = React.useState<PiChildSessionInfo[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [loadedForSessionId, setLoadedForSessionId] = React.useState(parentSessionId)
  const requestGeneration = React.useRef(0)

  const refresh = React.useCallback(async (force = false) => {
    const generation = ++requestGeneration.current
    setLoading(true)
    try {
      const next = await loader.load(parentSessionId, { force })
      if (generation !== requestGeneration.current) return
      setTasks(next)
      setError(null)
      setLoadedForSessionId(parentSessionId)
      if (next.length === 0) setOpen(false)
    } catch (reason) {
      if (generation !== requestGeneration.current) return
      setError(reason instanceof Error ? reason.message : String(reason))
      setLoadedForSessionId(parentSessionId)
    } finally {
      if (generation === requestGeneration.current) setLoading(false)
    }
  }, [loader, parentSessionId])

  React.useEffect(() => {
    setOpen(false)
    setTasks([])
    setError(null)
    setLoading(true)
    void refresh()
    return () => {
      requestGeneration.current += 1
    }
  }, [parentSessionId, refresh])

  const hasCurrentResult = loadedForSessionId === parentSessionId
  const visibleTasks = React.useMemo(
    () => hasCurrentResult ? tasks : [],
    [hasCurrentResult, tasks],
  )
  const displayTasks = React.useMemo(
    () => applySideTaskSessionNames(
      visibleTasks,
      new Map(visibleTasks.map(task => [task.sessionId, sessionMetaMap.get(task.sessionId)?.name])),
    ),
    [sessionMetaMap, visibleTasks],
  )
  const visibleError = hasCurrentResult ? error : null
  const visibleLoading = !hasCurrentResult || loading
  const knownChildSessionIds = React.useMemo(
    () => new Set(displayTasks.map(task => task.sessionId)),
    [displayTasks],
  )

  React.useEffect(() => {
    if (typeof electronApi.onSessionEvent !== 'function') return
    return electronApi.onSessionEvent(event => {
      if (shouldRefreshSideTasks(event, parentSessionId, knownChildSessionIds)) void refresh(true)
    })
  }, [electronApi, knownChildSessionIds, parentSessionId, refresh])

  const runningSessionIds = React.useMemo(() => new Set(
    displayTasks
      .filter(task => sessionMetaMap.get(task.sessionId)?.isProcessing === true)
      .map(task => task.sessionId),
  ), [displayTasks, sessionMetaMap])
  const sections = React.useMemo(
    () => partitionSideTasks(displayTasks, runningSessionIds),
    [displayTasks, runningSessionIds],
  )
  const completedCount = sections.completed.length
  const runningCount = sections.running.length
  const semanticSessionId = sideTaskSemanticPart(parentSessionId)
  const summary = visibleLoading && visibleTasks.length === 0
    ? `${t('workbench.sideTasks')}: ${t('common.loading')}`
    : visibleError && visibleTasks.length === 0
      ? t('workbench.sideTasksLoadFailed')
      : t('workbench.sideTaskStatusSummary', { running: runningCount, completed: completedCount })
  const countBadge = visibleTasks.length > 99 ? '99+' : String(visibleTasks.length)

  const openTask = React.useCallback((task: PiChildSessionInfo) => {
    const title = sideTaskTitle(task, t('workbench.untitledSideTask'))
    setOpen(false)
    onOpenSession(task.sessionId, title)
  }, [onOpenSession, t])

  const handleOpenChange = React.useCallback((nextOpen: boolean) => {
    setOpen(nextOpen)
    if (nextOpen) void refresh(true)
  }, [refresh])

  if (!shouldShowSideTasksTrigger(visibleTasks.length, visibleLoading, visibleError)) return null

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild semanticId={`session.side-tasks.trigger.${semanticSessionId}`}>
        <PanelHeaderCenterButton
          aria-label={summary}
          aria-busy={visibleLoading}
          title={summary}
          icon={(
            <span className="relative flex size-4 items-center justify-center" aria-hidden="true">
              {visibleLoading
                ? <Loader2 className="size-4 animate-spin" />
                : visibleError
                  ? <AlertCircle className="size-4 text-destructive" />
                  : <GitBranch className="size-4" />}
              {visibleTasks.length > 0 && (
                <span className="absolute -right-2 -top-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-foreground px-1 text-[9px] font-semibold leading-none text-background">
                  {countBadge}
                </span>
              )}
            </span>
          )}
        />
      </PopoverTrigger>
      <PopoverContent
        semanticId={`session.side-tasks.popover.${semanticSessionId}`}
        role="dialog"
        aria-label={t('workbench.sideTasks')}
        align="end"
        side="bottom"
        sideOffset={8}
        className="w-[min(22rem,calc(100vw-2rem))] overflow-hidden p-0"
      >
        <SideTasksStatusContent
          parentSessionId={parentSessionId}
          sections={sections}
          loading={visibleLoading}
          error={visibleError}
          onRefresh={() => void refresh(true)}
          onOpenTask={openTask}
        />
      </PopoverContent>
    </Popover>
  )
}

export interface SideTasksStatusContentProps {
  parentSessionId: string
  sections: SideTaskSections
  loading: boolean
  error: string | null
  onRefresh: () => void
  onOpenTask: (task: PiChildSessionInfo) => void
}

export function SideTasksStatusContent({
  parentSessionId,
  sections,
  loading,
  error,
  onRefresh,
  onOpenTask,
}: SideTasksStatusContentProps) {
  const { t } = useTranslation()
  const semanticSessionId = sideTaskSemanticPart(parentSessionId)
  const tasks = [...sections.running, ...sections.completed]

  return (
    <section
      aria-label={t('workbench.sideTasks')}
      aria-busy={loading}
      data-mortise-semantic-id={`session.side-tasks.${semanticSessionId}`}
      className="flex min-h-0 flex-col bg-popover text-popover-foreground"
    >
      <header className="flex h-11 shrink-0 items-center justify-between border-b border-border/50 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <GitBranch className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="truncate text-xs font-semibold">{t('workbench.sideTaskCount', { count: tasks.length })}</span>
        </div>
        <HeaderIconButton
          icon={loading ? <Spinner className="text-[10px]" /> : <RefreshCw className="size-3.5" />}
          tooltip={t('workbench.refreshSideTasks')}
          aria-label={t('workbench.refreshSideTasks')}
          data-mortise-semantic-id={`session.side-tasks.refresh.${semanticSessionId}`}
          disabled={loading}
          onClick={onRefresh}
        />
      </header>

      <div className="max-h-[min(28rem,calc(100vh-8rem))] min-h-0 overflow-y-auto overscroll-contain">
        {loading && tasks.length === 0 ? (
          <div className="flex min-h-28 items-center justify-center gap-2 px-4 text-xs text-muted-foreground" role="status">
            <Spinner className="size-3.5" />
            <span>{t('common.loading')}</span>
          </div>
        ) : error && tasks.length === 0 ? (
          <SideTasksError message={error} />
        ) : tasks.length === 0 ? (
          <div className="flex min-h-28 flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground">
            <GitBranch className="size-5 opacity-55" aria-hidden="true" />
            <p className="text-xs">{t('workbench.noSideTasks')}</p>
          </div>
        ) : (
          <>
            {error && <SideTasksError message={error} compact />}
            <SideTaskGroup
              parentSessionId={parentSessionId}
              phase="running"
              tasks={sections.running}
              onOpenTask={onOpenTask}
            />
            <SideTaskGroup
              parentSessionId={parentSessionId}
              phase="completed"
              tasks={sections.completed}
              onOpenTask={onOpenTask}
            />
          </>
        )}
      </div>
    </section>
  )
}

function SideTasksError({ message, compact = false }: { message: string; compact?: boolean }) {
  const { t } = useTranslation()
  return (
    <div role="alert" className={compact ? 'border-b border-border/40 px-3 py-2' : 'px-4 py-5'}>
      <div className="flex items-start gap-2 text-xs leading-5 text-destructive">
        <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <p className="min-w-0 break-words">
          <span className="font-medium">{t('workbench.sideTasksLoadFailed')}</span>
          {message && <span className="block text-destructive/80">{message}</span>}
        </p>
      </div>
    </div>
  )
}

function SideTaskGroup({
  parentSessionId,
  phase,
  tasks,
  onOpenTask,
}: {
  parentSessionId: string
  phase: 'running' | 'completed'
  tasks: PiChildSessionInfo[]
  onOpenTask: (task: PiChildSessionInfo) => void
}) {
  const { t } = useTranslation()
  if (tasks.length === 0) return null
  const label = phase === 'running'
    ? t('workbench.sideTasksRunning')
    : t('workbench.sideTasksCompleted')
  const semanticSessionId = sideTaskSemanticPart(parentSessionId)

  return (
    <section
      aria-label={label}
      data-mortise-semantic-id={`session.side-tasks.${phase}.${semanticSessionId}`}
      className="border-b border-border/40 last:border-b-0"
    >
      <div className="flex h-8 items-center gap-2 bg-muted/25 px-3 text-[11px] font-medium text-muted-foreground">
        {phase === 'running'
          ? <Loader2 className="size-3 animate-spin" aria-hidden="true" />
          : <CheckCircle2 className="size-3" aria-hidden="true" />}
        <span>{label}</span>
        <span className="ml-auto tabular-nums">{tasks.length}</span>
      </div>
      <ul role="list" aria-label={label}>
        {tasks.map(task => {
          const title = sideTaskTitle(task, t('workbench.untitledSideTask'))
          const statusLabel = phase === 'running'
            ? t('workbench.sideTasksRunning')
            : t('workbench.sideTasksCompleted')
          return (
            <li key={task.sessionId}>
              <button
                type="button"
                data-mortise-semantic-id={`session.side-task.${sideTaskSemanticPart(task.sessionId)}`}
                aria-label={`${t('workbench.openSideTask', { title })}, ${statusLabel}`}
                aria-busy={phase === 'running'}
                onClick={() => onOpenTask(task)}
                className="group flex min-h-13 w-full min-w-0 items-center gap-2.5 border-t border-border/30 px-3 py-2 text-left outline-none transition-colors first:border-t-0 hover:bg-foreground/[0.035] focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <span className="flex size-7 shrink-0 items-center justify-center rounded-[5px] bg-foreground/[0.04]" aria-hidden="true">
                  {phase === 'running'
                    ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
                    : <CheckCircle2 className="size-3.5 text-muted-foreground" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium text-foreground">{title}</span>
                  <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                    {task.messageCount > 0
                      ? t('workbench.sideTaskMessages', { count: task.messageCount })
                      : formatSideTaskTimestamp(task.modified)}
                  </span>
                </span>
                <ExternalLink className="size-3.5 shrink-0 text-muted-foreground opacity-60 transition-opacity group-hover:opacity-100" aria-hidden="true" />
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function formatSideTaskTimestamp(value: string): string {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : value
}
