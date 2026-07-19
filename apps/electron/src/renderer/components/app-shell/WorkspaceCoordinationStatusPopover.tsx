import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  Clock3,
  FileClock,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react'
import type {
  WorkspaceCoordinationActivitySummaryV1,
  WorkspaceCoordinationStatusV1,
} from '@mortise/shared/protocol'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@mortise/ui'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useWorkspaceElectronApi } from '@/context/WorkspaceElectronApiContext'
import { HeaderIconButton } from '../ui/HeaderIconButton'
import { TopBarButton } from '../ui/TopBarButton'
import {
  shouldShowWorkspaceCoordinationStatus,
  workspaceCoordinationSemanticPart,
  workspaceCoordinationStatusCounts,
} from './workspace-coordination-status-model'

const STATUS_POLL_INTERVAL_MS = 2_000

export function WorkspaceCoordinationStatusPopover() {
  const { t } = useTranslation()
  const electronApi = useWorkspaceElectronApi()
  const [open, setOpen] = React.useState(false)
  const [status, setStatus] = React.useState<WorkspaceCoordinationStatusV1 | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const requestGeneration = React.useRef(0)
  const inFlight = React.useRef(false)

  const refresh = React.useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    const generation = ++requestGeneration.current
    try {
      const next = await electronApi.getWorkspaceCoordinationStatus()
      if (generation !== requestGeneration.current) return
      setStatus(next)
      setError(null)
    } catch (reason) {
      if (generation !== requestGeneration.current) return
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (generation === requestGeneration.current) setLoading(false)
      inFlight.current = false
    }
  }, [electronApi])

  React.useEffect(() => {
    setStatus(null)
    setError(null)
    setLoading(true)
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, STATUS_POLL_INTERVAL_MS)
    const unsubscribe = typeof electronApi.onReconnected === 'function'
      ? electronApi.onReconnected(() => { void refresh() })
      : undefined
    return () => {
      window.clearInterval(timer)
      requestGeneration.current += 1
      unsubscribe?.()
    }
  }, [electronApi, refresh])

  const counts = workspaceCoordinationStatusCounts(status)
  const summary = error
    ? t('workspace.coordinationLoadFailed')
    : loading && !status
      ? `${t('workspace.coordination')}: ${t('common.loading')}`
      : t('workspace.coordinationStatusSummary', {
          activities: counts.activities,
          conflicts: counts.conflicts,
        })

  if (!shouldShowWorkspaceCoordinationStatus(status, loading, error)) return null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <TopBarButton
              data-mortise-semantic-id="workspace.coordination.trigger"
              aria-label={summary}
              aria-busy={loading}
              isActive={open}
              className="relative"
            >
              {loading && !status
                ? <Loader2 className="size-4 animate-spin text-muted-foreground" />
                : error
                  ? <AlertCircle className="size-4 text-destructive" />
                  : counts.conflicts > 0
                    ? <AlertTriangle className="size-4 text-amber-500" />
                    : <ShieldCheck className="size-4 text-muted-foreground" />}
              {(counts.activities > 0 || counts.conflicts > 0) && (
                <span className="absolute -right-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-foreground px-0.5 text-[8px] font-semibold leading-none text-background">
                  {Math.min(99, counts.activities + counts.conflicts)}
                </span>
              )}
            </TopBarButton>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{summary}</TooltipContent>
      </Tooltip>
      <PopoverContent
        semanticId="workspace.coordination.popover"
        role="dialog"
        aria-label={t('workspace.coordination')}
        align="start"
        side="bottom"
        sideOffset={8}
        className="w-[min(24rem,calc(100vw-2rem))] overflow-hidden p-0"
      >
        <WorkspaceCoordinationStatusContent
          status={status}
          loading={loading}
          error={error}
          onRefresh={() => { void refresh() }}
        />
      </PopoverContent>
    </Popover>
  )
}

export function WorkspaceCoordinationStatusContent({
  status,
  loading,
  error,
  onRefresh,
}: {
  status: WorkspaceCoordinationStatusV1 | null
  loading: boolean
  error: string | null
  onRefresh: () => void
}) {
  const { t } = useTranslation()
  const activityMap = new Map(status?.activities.map(activity => [activity.activityId, activity]) ?? [])

  return (
    <section
      aria-label={t('workspace.coordination')}
      aria-busy={loading}
      data-mortise-semantic-id="workspace.coordination.status"
      className="flex min-h-0 flex-col bg-popover text-popover-foreground"
    >
      <header className="flex h-11 shrink-0 items-center justify-between border-b border-border/50 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <ShieldCheck className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="truncate text-xs font-semibold">{t('workspace.coordination')}</span>
        </div>
        <HeaderIconButton
          icon={loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          tooltip={t('workspace.refreshCoordination')}
          aria-label={t('workspace.refreshCoordination')}
          data-mortise-semantic-id="workspace.coordination.refresh"
          disabled={loading}
          onClick={onRefresh}
        />
      </header>

      <div className="max-h-[min(30rem,calc(100vh-8rem))] min-h-0 overflow-y-auto overscroll-contain">
        {loading && !status ? (
          <div className="flex min-h-28 items-center justify-center gap-2 px-4 text-xs text-muted-foreground" role="status">
            <Loader2 className="size-3.5 animate-spin" />
            <span>{t('common.loading')}</span>
          </div>
        ) : error && !status ? (
          <CoordinationError message={error} />
        ) : status ? (
          <>
            {error && <CoordinationError message={error} compact />}
            <CoordinationConflicts status={status} activityMap={activityMap} />
            <CoordinationActivities activities={status.activities} />
            <CoordinationRecentChanges status={status} />
          </>
        ) : null}
      </div>
    </section>
  )
}

function CoordinationError({ message, compact = false }: { message: string; compact?: boolean }) {
  const { t } = useTranslation()
  return (
    <div role="alert" className={compact ? 'border-b border-border/40 px-3 py-2' : 'px-4 py-5'}>
      <div className="flex items-start gap-2 text-xs leading-5 text-destructive">
        <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <p className="min-w-0 break-words">
          <span className="font-medium">{t('workspace.coordinationLoadFailed')}</span>
          {message && <span className="block text-destructive/80">{message}</span>}
        </p>
      </div>
    </div>
  )
}

function CoordinationConflicts({
  status,
  activityMap,
}: {
  status: WorkspaceCoordinationStatusV1
  activityMap: ReadonlyMap<string, WorkspaceCoordinationActivitySummaryV1>
}) {
  const { t } = useTranslation()
  if (status.conflicts.length === 0) return null
  return (
    <section
      aria-label={t('workspace.coordinationConflicts')}
      data-mortise-semantic-id="workspace.coordination.conflicts"
      className="border-b border-border/40"
    >
      <StatusSectionHeader icon={<AlertTriangle className="size-3" />} label={t('workspace.coordinationConflicts')} count={status.conflicts.length} />
      <ul role="list">
        {status.conflicts.map(conflict => (
          <li
            key={conflict.conflictId}
            data-mortise-semantic-id={`workspace.coordination.conflict.${workspaceCoordinationSemanticPart(conflict.conflictId)}`}
            className="border-t border-border/30 px-3 py-2 first:border-t-0"
          >
            <div className="flex items-center gap-2 text-xs font-medium">
              <span className="min-w-0 flex-1 truncate">{conflict.resource}</span>
              <span className={conflict.severity === 'blocking' ? 'text-destructive' : 'text-amber-600 dark:text-amber-400'}>
                {t(`workspace.coordinationSeverity.${conflict.severity}`)}
              </span>
            </div>
            <p className="mt-1 truncate text-[11px] text-muted-foreground">
              {conflict.activityIds.map(id => activityMap.get(id)?.actorLabel ?? id).join(' · ')}
            </p>
          </li>
        ))}
      </ul>
    </section>
  )
}

function CoordinationActivities({ activities }: { activities: WorkspaceCoordinationActivitySummaryV1[] }) {
  const { t } = useTranslation()
  if (activities.length === 0) return null
  return (
    <section
      aria-label={t('workspace.coordinationActiveWork')}
      data-mortise-semantic-id="workspace.coordination.activities"
      className="border-b border-border/40"
    >
      <StatusSectionHeader icon={<Activity className="size-3" />} label={t('workspace.coordinationActiveWork')} count={activities.length} />
      <ul role="list">
        {activities.map(activity => (
          <li
            key={activity.activityId}
            data-mortise-semantic-id={`workspace.coordination.activity.${workspaceCoordinationSemanticPart(activity.activityId)}`}
            className="border-t border-border/30 px-3 py-2 first:border-t-0"
          >
            <div className="flex items-center gap-2 text-xs font-medium">
              <span className="min-w-0 flex-1 truncate">{activity.intent || activity.actorLabel}</span>
              <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
            </div>
            <p className="mt-1 truncate text-[11px] text-muted-foreground">
              {activity.actorLabel}
              {activity.claims.length > 0 ? ` · ${activity.claims.map(claim => claim.resource).join(', ')}` : ''}
            </p>
          </li>
        ))}
      </ul>
    </section>
  )
}

function CoordinationRecentChanges({ status }: { status: WorkspaceCoordinationStatusV1 }) {
  const { t } = useTranslation()
  if (status.recentChanges.length === 0) return null
  return (
    <section
      aria-label={t('workspace.coordinationRecentChanges')}
      data-mortise-semantic-id="workspace.coordination.recent-changes"
    >
      <StatusSectionHeader icon={<FileClock className="size-3" />} label={t('workspace.coordinationRecentChanges')} count={status.recentChanges.length} />
      <ul role="list">
        {status.recentChanges.slice(0, 8).map(change => (
          <li
            key={change.changeId}
            data-mortise-semantic-id={`workspace.coordination.change.${workspaceCoordinationSemanticPart(change.changeId)}`}
            className="border-t border-border/30 px-3 py-2 first:border-t-0"
          >
            <div className="flex items-center gap-2 text-xs font-medium">
              <span className="min-w-0 flex-1 truncate">{change.resource}</span>
              <span className="flex shrink-0 items-center gap-1 text-[10px] font-normal text-muted-foreground">
                <Clock3 className="size-3" aria-hidden="true" />
                {new Date(change.occurredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
            <p className="mt-1 truncate text-[11px] text-muted-foreground">
              {change.actorLabel}{change.summary ? ` · ${change.summary}` : ''}
            </p>
          </li>
        ))}
      </ul>
    </section>
  )
}

function StatusSectionHeader({ icon, label, count }: { icon: React.ReactNode; label: string; count: number }) {
  return (
    <div className="flex h-8 items-center gap-2 bg-muted/25 px-3 text-[11px] font-medium text-muted-foreground">
      {icon}
      <span>{label}</span>
      <span className="ml-auto tabular-nums">{count}</span>
    </div>
  )
}
