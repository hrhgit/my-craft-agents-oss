import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { AnnotationV1, ExtensionCommandResult, PlanArtifactV1 } from '@craft-agent/core'
import { AlertTriangle, Check, Circle, CircleDot, FileText, GitBranch, ListChecks, Maximize2, MessageSquareText, Play, RefreshCw } from 'lucide-react'
import { cn } from '../../lib/utils'
import { Markdown } from '../markdown'
import { DocumentFormattedMarkdownOverlay } from '../overlay'
import { formatCompletionClock, formatRequestDuration } from './turn-utils'

type PlanTab = 'plan' | 'review' | 'checklist'
type PlanAction = (artifactId: string) => Promise<ExtensionCommandResult>

export interface PlanArtifactCardProps {
  artifact: PlanArtifactV1
  content: string
  onOpenFile?: (path: string) => void
  onOpenUrl?: (url: string) => void
  onExecute?: PlanAction
  onExecuteWithCompact?: PlanAction
  onRefine?: PlanAction
  sessionId?: string
  messageId?: string
  annotations?: AnnotationV1[]
  onAddAnnotation?: (messageId: string, annotation: AnnotationV1) => void
  onRemoveAnnotation?: (messageId: string, annotationId: string) => void
  onUpdateAnnotation?: (messageId: string, annotationId: string, patch: Partial<AnnotationV1>) => void
  onBranch?: () => void
  completedAt?: number
  durationMs?: number
}

const STATE_LABELS: Record<PlanArtifactV1['state'], string> = {
  reviewing: 'Reviewing',
  ready: 'Ready',
  superseded: 'Superseded',
  executing: 'Executing',
  completed: 'Completed',
  failed: 'Failed',
}

function Checklist({ artifact }: { artifact: PlanArtifactV1 }) {
  if (artifact.checklist.length === 0) {
    return <p className="text-xs text-muted-foreground">No structured execution steps.</p>
  }
  return (
    <ol className="space-y-2">
      {artifact.checklist.map((item, index) => {
        const done = item.status === 'completed'
        const active = item.status === 'in_progress'
        return (
          <li key={item.id} className="grid grid-cols-[20px_minmax(0,1fr)] gap-2 text-[13px] leading-5">
            <span className={cn('mt-0.5 flex h-5 w-5 items-center justify-center', done && 'text-emerald-600', active && 'text-sky-600', !done && !active && 'text-muted-foreground')}>
              {done ? <Check className="h-4 w-4" /> : active ? <CircleDot className="h-4 w-4" /> : <Circle className="h-3.5 w-3.5" />}
            </span>
            <div className="min-w-0">
              <p className={cn('break-words', done && 'text-muted-foreground line-through')}>{index + 1}. {item.title}</p>
              {item.error && <p className="mt-0.5 break-words text-xs text-destructive">{item.error}</p>}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

export function PlanArtifactCard({
  artifact,
  content,
  onOpenFile,
  onOpenUrl,
  onExecute,
  onExecuteWithCompact,
  onRefine,
  sessionId,
  messageId,
  annotations,
  onAddAnnotation,
  onRemoveAnnotation,
  onUpdateAnnotation,
  onBranch,
  completedAt,
  durationMs,
}: PlanArtifactCardProps) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = React.useState<PlanTab>('plan')
  const [pendingAction, setPendingAction] = React.useState<'execute' | 'compact' | 'refine' | null>(null)
  const [actionError, setActionError] = React.useState<string | null>(null)
  const [isFullscreen, setIsFullscreen] = React.useState(false)
  const isReady = artifact.state === 'ready'
  const reviewWarning = artifact.review.status === 'error'
    || artifact.review.status === 'failed'
    || artifact.review.verdict === 'fail'
  const completed = artifact.checklist.filter(item => item.status === 'completed').length
  const hasCompletionTiming = completedAt !== undefined && durationMs !== undefined
    && Number.isFinite(completedAt) && Number.isFinite(durationMs) && durationMs >= 0

  const runAction = React.useCallback(async (
    action: 'execute' | 'compact' | 'refine',
    handler: PlanAction | undefined,
  ) => {
    if (!handler || pendingAction) return
    setPendingAction(action)
    setActionError(null)
    try {
      const result = await handler(artifact.artifactId)
      if (!result.invoked) setActionError(result.error ?? 'The plan command was rejected.')
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setPendingAction(null)
    }
  }, [artifact.artifactId, pendingAction])

  const reviewPanel = (
    <div className="space-y-3">
      {reviewWarning && (
        <div className="flex gap-2 border border-amber-500/35 bg-amber-500/8 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0">
            <p className="font-medium">Review found risks. Manual execution is still available.</p>
            {(artifact.review.error || artifact.error) && <p className="mt-1 break-words opacity-90">{artifact.review.error || artifact.error}</p>}
          </div>
        </div>
      )}
      {artifact.review.body ? (
        <Markdown mode="minimal" onUrlClick={onOpenUrl} onFileClick={onOpenFile}>{artifact.review.body}</Markdown>
      ) : (
        <p className="text-xs leading-5 text-muted-foreground">
          {artifact.review.status === 'running' || artifact.review.status === 'pending'
            ? 'Architecture review is in progress.'
            : artifact.review.error || 'No review text is available.'}
        </p>
      )}
    </div>
  )

  return (
    <section className="overflow-hidden rounded-lg border border-border/70 bg-card shadow-sm" data-plan-artifact-id={artifact.artifactId}>
      <header className="flex min-h-11 flex-wrap items-center justify-between gap-2 border-b border-border/60 bg-muted/20 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <FileText className="h-4 w-4 shrink-0 text-sky-600" />
          <span className="text-sm font-semibold">Plan</span>
          <span className="text-xs text-muted-foreground">Revision {artifact.revision}</span>
        </div>
        <div className="flex items-center gap-2 text-xs">
          {artifact.checklist.length > 0 && <span className="text-muted-foreground">{completed}/{artifact.checklist.length}</span>}
          <span className={cn(
            'border px-2 py-0.5 font-medium',
            artifact.state === 'ready' && 'border-emerald-500/35 bg-emerald-500/8 text-emerald-700 dark:text-emerald-300',
            artifact.state === 'executing' && 'border-sky-500/35 bg-sky-500/8 text-sky-700 dark:text-sky-300',
            artifact.state === 'superseded' && 'border-border text-muted-foreground',
            artifact.state === 'completed' && 'border-emerald-500/35 text-emerald-700 dark:text-emerald-300',
            (artifact.state === 'reviewing' || artifact.state === 'failed') && 'border-amber-500/35 text-amber-700 dark:text-amber-300',
          )}>{STATE_LABELS[artifact.state]}</span>
        </div>
      </header>

      <div className="lg:hidden">
        <div className="grid grid-cols-3 border-b border-border/60 bg-muted/10 p-1" role="tablist" aria-label="Plan card sections">
          {([
            ['plan', FileText, 'Plan'],
            ['review', MessageSquareText, t('plan.artifact.review')],
            ['checklist', ListChecks, t('plan.artifact.steps')],
          ] as const).map(([tab, Icon, label]) => (
            <button key={tab} type="button" role="tab" aria-selected={activeTab === tab} onClick={() => setActiveTab(tab)} className={cn('flex h-8 items-center justify-center gap-1.5 text-xs text-muted-foreground transition-colors', activeTab === tab && 'bg-background text-foreground shadow-sm')}>
              <Icon className="h-3.5 w-3.5" />{label}
            </button>
          ))}
        </div>
        <div className="max-h-[560px] overflow-y-auto px-4 py-3">
          {activeTab === 'plan' && <Markdown mode="minimal" onUrlClick={onOpenUrl} onFileClick={onOpenFile}>{content}</Markdown>}
          {activeTab === 'review' && reviewPanel}
          {activeTab === 'checklist' && <Checklist artifact={artifact} />}
        </div>
      </div>

      <div className="hidden min-h-[240px] grid-cols-[minmax(0,3fr)_minmax(260px,2fr)] lg:grid">
        <div className="max-h-[620px] min-w-0 overflow-y-auto border-r border-border/60 px-5 py-4">
          <Markdown mode="minimal" onUrlClick={onOpenUrl} onFileClick={onOpenFile}>{content}</Markdown>
        </div>
        <aside className="max-h-[620px] min-w-0 overflow-y-auto px-4 py-4">
          <div className="mb-4 flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground"><MessageSquareText className="h-3.5 w-3.5" />{t('plan.artifact.review')}</div>
          {reviewPanel}
          <div className="my-4 border-t border-border/60" />
          <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground"><ListChecks className="h-3.5 w-3.5" />{t('plan.artifact.executionSteps')}</div>
          <Checklist artifact={artifact} />
        </aside>
      </div>

      {(isReady || onRefine || onBranch || messageId || hasCompletionTiming) && (
        <footer className="border-t border-border/60 bg-muted/15 px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            {isReady && onExecute && (
              <button type="button" disabled={pendingAction !== null} onClick={() => void runAction('execute', onExecute)} className="inline-flex h-8 items-center gap-1.5 bg-foreground px-3 text-xs font-medium text-background transition-opacity disabled:opacity-50">
                {pendingAction === 'execute' ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}{t('plan.artifact.execute')}
              </button>
            )}
            {isReady && onExecuteWithCompact && (
              <button type="button" disabled={pendingAction !== null} onClick={() => void runAction('compact', onExecuteWithCompact)} className="inline-flex h-8 items-center gap-1.5 border border-border bg-background px-3 text-xs font-medium transition-colors hover:bg-muted disabled:opacity-50">
                {pendingAction === 'compact' ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <ListChecks className="h-3.5 w-3.5" />}{t('plan.artifact.compactExecute')}
              </button>
            )}
            {onRefine && artifact.state !== 'executing' && artifact.state !== 'completed' && (
              <button type="button" disabled={pendingAction !== null} onClick={() => void runAction('refine', onRefine)} className="inline-flex h-8 items-center gap-1.5 px-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50">
                <MessageSquareText className="h-3.5 w-3.5" />{t('plan.artifact.refine')}
              </button>
            )}
            <span className="min-w-2 flex-1" />
            {hasCompletionTiming && (
              <span className="shrink-0 tabular-nums text-xs text-muted-foreground/70" data-response-completion-time={completedAt}>
                {formatCompletionClock(completedAt!)} {t('turnCard.elapsed')} {formatRequestDuration(durationMs!)}
              </span>
            )}
            {messageId && (
              <button type="button" onClick={() => setIsFullscreen(true)} className="inline-flex h-8 items-center gap-1.5 px-2 text-xs text-muted-foreground transition-colors hover:text-foreground">
                <Maximize2 className="h-3.5 w-3.5" />{t('plan.artifact.readAnnotate')}
              </button>
            )}
            {onBranch && (
              <button type="button" onClick={onBranch} className="inline-flex h-8 items-center gap-1.5 px-2 text-xs text-muted-foreground transition-colors hover:text-foreground">
                <GitBranch className="h-3.5 w-3.5" />{t('plan.artifact.branch')}
              </button>
            )}
          </div>
          {isReady && <p className="mt-2 text-[11px] text-muted-foreground">{t('plan.artifact.allowAllNotice')}</p>}
          {actionError && <p role="alert" className="mt-2 break-words text-xs text-destructive">{actionError}</p>}
        </footer>
      )}
      <DocumentFormattedMarkdownOverlay
        content={content}
        isOpen={isFullscreen}
        onClose={() => setIsFullscreen(false)}
        variant="plan"
        onOpenUrl={onOpenUrl}
        onOpenFile={onOpenFile}
        sessionId={sessionId}
        messageId={messageId}
        annotations={annotations}
        onAddAnnotation={onAddAnnotation}
        onRemoveAnnotation={onRemoveAnnotation}
        onUpdateAnnotation={onUpdateAnnotation}
        isStreaming={false}
      />
    </section>
  )
}
