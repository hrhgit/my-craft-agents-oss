import * as React from 'react'
import { Activity, AlertCircle, Check, ChevronRight, Circle, Clock, Info, Loader2, MoreHorizontal, Settings, Sparkles, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ExtensionUIIconName, ExtensionUINode, ExtensionUISurface } from '@mortise/shared/protocol'
import { cn } from '@/lib/utils'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@mortise/ui/tooltip'
import { useExtensionContributions } from './useExtensionContributions'
import { Markdown } from '@/components/markdown'
import { SandboxAppHost } from './SandboxAppHost'
import { selectMountableOverflow } from './extension-contribution-store'

const icons = { activity: Activity, 'alert-circle': AlertCircle, check: Check, 'chevron-right': ChevronRight, circle: Circle, clock: Clock, info: Info, loader: Loader2, settings: Settings, sparkles: Sparkles, x: X }

export interface ExtensionContributionZoneProps {
  sessionId: string
  surface: ExtensionUISurface
  className?: string
  target?: { turnId?: string; messageId?: string; toolCallId?: string; artifactId?: string }
  /** Request a runtime snapshot on mount. Disable for passive list decorations. */
  hydrateRuntime?: boolean
}

export function ExtensionContributionZone({ sessionId, surface, className, target, hydrateRuntime = true }: ExtensionContributionZoneProps) {
  const layout = useExtensionContributions(sessionId, surface, target, hydrateRuntime)
  const [overflowOpen, setOverflowOpen] = React.useState(false)
  const compact = isCompactSurface(surface)
  const mountableOverflow = selectMountableOverflow(layout)
  if (layout.visible.length === 0 && mountableOverflow.length === 0) return null
  return (
    <div
      className={cn('flex min-w-0 gap-1', compact ? 'relative max-h-8 w-full flex-row items-center' : 'flex-col', className)}
      data-extension-surface={surface}
      role={surface === 'composer.status' || surface === 'conversation.status' ? 'status' : undefined}
      aria-live={surface === 'composer.status' || surface === 'conversation.status' ? 'polite' : undefined}
    >
      {layout.visible.map(item => (
        <div key={`${item.runtimeId}:${item.extensionId}:${item.contribution.id}`} className={cn('min-w-0', compact && 'max-w-[120px] overflow-hidden')} data-extension-id={item.extensionId}>
          <ExtensionNode node={item.contribution.content} sessionId={sessionId} extensionId={item.extensionId} runtimeId={item.runtimeId} />
        </div>
      ))}
      {mountableOverflow.length > 0 && (
        <details className={cn('text-xs text-muted-foreground', compact && 'relative shrink-0')} open={overflowOpen} onToggle={(event) => setOverflowOpen(event.currentTarget.open)}>
          <summary
            className="inline-flex h-7 cursor-pointer list-none items-center gap-1 rounded px-2 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title="More extension items"
            aria-label={`More extension items (${mountableOverflow.length})`}
          >
            <MoreHorizontal className="size-4" />
            <span>{mountableOverflow.length}</span>
          </summary>
          <div className={cn('flex flex-col gap-1', compact ? 'absolute right-0 top-full z-popover mt-1 max-h-72 w-72 overflow-auto rounded border bg-popover p-2 shadow-strong' : 'mt-1 border-l pl-2')}>
            {overflowOpen && mountableOverflow.map(item => <ExtensionNode key={`${item.runtimeId}:${item.extensionId}:${item.contribution.id}`} node={item.contribution.content} sessionId={sessionId} extensionId={item.extensionId} runtimeId={item.runtimeId} />)}
          </div>
        </details>
      )}
    </div>
  )
}

function isCompactSurface(surface: ExtensionUISurface): boolean {
  return surface === 'composer.toolbar' || surface === 'composer.status' || surface === 'window.topLeft' || surface === 'window.topRight'
    || surface === 'navigation.item' || surface === 'session.badge'
}

export function ExtensionReplaceZone({ sessionId, surface, target, className, children }: ExtensionContributionZoneProps & { children: React.ReactNode }) {
  const layout = useExtensionContributions(sessionId, surface, target)
  if (layout.visible.length === 0) return <>{children}</>
  const winner = layout.visible[0]
  if (winner?.contribution.content.type === 'sandbox-app') {
    return <SandboxReplaceContribution item={winner} sessionId={sessionId} className={className}>{children}</SandboxReplaceContribution>
  }
  return <ContributionLayout layout={layout} sessionId={sessionId} surface={surface} className={className} />
}

function SandboxReplaceContribution({ item, sessionId, className, children }: {
  item: ReturnType<typeof useExtensionContributions>['visible'][number]
  sessionId: string
  className?: string
  children: React.ReactNode
}) {
  const [status, setStatus] = React.useState<'loading' | 'ready' | 'error'>('loading')
  const handleStatusChange = React.useCallback((next: 'loading' | 'ready' | 'error') => setStatus(next), [])
  const node = item.contribution.content
  if (node.type !== 'sandbox-app') return <>{children}</>
  return (
    <div className={cn('relative min-w-0', className)} data-extension-surface={item.contribution.surface}>
      {status !== 'ready' && children}
      <div className={cn(status !== 'ready' && 'absolute inset-0', status === 'loading' && 'invisible pointer-events-none')}>
        <SandboxAppHost node={node} sessionId={sessionId} extensionId={item.extensionId} runtimeId={item.runtimeId} onStatusChange={handleStatusChange} />
      </div>
    </div>
  )
}

function ContributionLayout({ layout, sessionId, surface, className }: { layout: ReturnType<typeof useExtensionContributions>; sessionId: string; surface: ExtensionUISurface; className?: string }) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)} data-extension-surface={surface}>
      {layout.visible.map(item => <div key={`${item.runtimeId}:${item.extensionId}:${item.contribution.id}`} className="min-w-0" data-extension-id={item.extensionId}><ExtensionNode node={item.contribution.content} sessionId={sessionId} extensionId={item.extensionId} runtimeId={item.runtimeId} /></div>)}
    </div>
  )
}

function ExtensionIcon({ name, label }: { name: ExtensionUIIconName; label?: string }) {
  const Icon = icons[name]
  return (
    <Icon
      className={cn('size-4 shrink-0', name === 'loader' && 'animate-spin')}
      {...(label ? { 'aria-label': label } : { 'aria-hidden': true })}
    />
  )
}

export function ExtensionContributionContent({
  node,
  sessionId,
  extensionId,
  runtimeId,
  className,
}: {
  node: ExtensionUINode
  sessionId: string
  extensionId: string
  runtimeId: string
  className?: string
}) {
  return (
    <div className={cn('min-h-0 min-w-0', className)}>
      <ExtensionNode node={node} sessionId={sessionId} extensionId={extensionId} runtimeId={runtimeId} />
    </div>
  )
}

function ExtensionNode({ node, sessionId, extensionId, runtimeId }: { node: ExtensionUINode; sessionId: string; extensionId: string; runtimeId: string }) {
  if (node.type === 'text') return <span className={cn('break-words text-sm', node.tone === 'muted' && 'text-muted-foreground', node.tone === 'success' && 'text-emerald-600', node.tone === 'warning' && 'text-amber-600', node.tone === 'danger' && 'text-destructive')}>{node.text}</span>
  if (node.type === 'markdown') return <div className="max-w-none break-words"><Markdown>{node.markdown}</Markdown></div>
  if (node.type === 'icon') return <ExtensionIcon name={node.name} label={node.label} />
  if (node.type === 'badge') return (
    <span className={cn(
      'inline-flex h-6 max-w-full items-center rounded border px-2 text-xs',
      (!node.tone || node.tone === 'default') && 'border-border bg-muted/50 text-foreground',
      node.tone === 'info' && 'border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300',
      node.tone === 'success' && 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
      node.tone === 'warning' && 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300',
      node.tone === 'danger' && 'border-destructive/25 bg-destructive/10 text-destructive',
    )}><span className="truncate">{node.label}</span></span>
  )
  if (node.type === 'divider') return <hr className="border-border" />
  if (node.type === 'step-progress') return <StepProgress node={node} sessionId={sessionId} extensionId={extensionId} />
  if (node.type === 'button') {
    const accessibleLabel = node.disabled && node.disabledReason
      ? `${node.label}. ${node.disabledReason}`
      : node.label
    const button = <button
      type="button"
      disabled={node.disabled}
      className={cn(
        'inline-flex min-h-8 max-w-full cursor-pointer items-center justify-center gap-1.5 rounded-[6px] px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50',
        node.emphasis === 'primary' && 'bg-foreground text-background hover:bg-foreground/90',
        node.emphasis === 'secondary' && 'border border-border/70 bg-background hover:bg-muted/70',
        (!node.emphasis || node.emphasis === 'quiet') && 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
      title={node.disabledReason ?? node.label}
      aria-label={accessibleLabel}
      data-mortise-semantic-id={`extension.${extensionId}.command.${node.action.command}`}
      onClick={() => void window.electronAPI?.invokeExtensionCommand?.(sessionId, node.action.command, node.action.args, extensionId)}
    >
      {node.icon && <ExtensionIcon name={node.icon} />}
      <span className="truncate">{node.label}</span>
    </button>
    if (!node.disabled || !node.disabledReason) return button
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex max-w-full" tabIndex={0} aria-label={accessibleLabel}>
              {button}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-80 text-pretty">
            {node.disabledReason}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }
  if (node.type === 'sandbox-app') return <SandboxAppHost node={node} sessionId={sessionId} extensionId={extensionId} runtimeId={runtimeId} />
  const gap = node.gap === 'none' ? 'gap-0' : node.gap === 'medium' ? 'gap-3' : 'gap-1.5'
  return <div className={cn('min-w-0', node.type === 'row' ? 'flex flex-wrap items-center' : 'flex flex-col', gap)}>{node.children.map((child, index) => <ExtensionNode key={index} node={child} sessionId={sessionId} extensionId={extensionId} runtimeId={runtimeId} />)}</div>
}

type StepProgressNode = Extract<ExtensionUINode, { type: 'step-progress' }>

function StepProgress({ node, sessionId, extensionId }: { node: StepProgressNode; sessionId: string; extensionId: string }) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  const [pinned, setPinned] = React.useState(false)
  const closeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const settledCount = node.steps.filter(step => step.status === 'completed' || step.status === 'skipped').length
  const currentIndex = Math.max(0, node.steps.findIndex(step => step.status === 'in_progress') >= 0
    ? node.steps.findIndex(step => step.status === 'in_progress')
    : node.steps.findIndex(step => step.status === 'failed') >= 0
      ? node.steps.findIndex(step => step.status === 'failed')
      : node.steps.findIndex(step => step.status === 'pending') >= 0
        ? node.steps.findIndex(step => step.status === 'pending')
        : node.steps.length - 1)
  const currentStep = node.steps[currentIndex]
  const failed = node.steps.some(step => step.status === 'failed')
  const complete = settledCount === node.steps.length
  const progress = Math.min(100, Math.max(0, (settledCount / node.steps.length) * 100))
  const summary = t('plan.progressStep', {
    current: currentIndex + 1,
    total: node.steps.length,
    defaultValue: 'Step {{current}} / {{total}}',
  })

  const cancelClose = React.useCallback(() => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    closeTimerRef.current = null
  }, [])
  const scheduleClose = React.useCallback(() => {
    cancelClose()
    if (pinned) return
    closeTimerRef.current = setTimeout(() => setOpen(false), 140)
  }, [cancelClose, pinned])

  React.useEffect(() => () => cancelClose(), [cancelClose])

  return (
    <Popover open={open} onOpenChange={(next) => {
      setOpen(next)
      if (!next) setPinned(false)
    }}>
      <PopoverAnchor asChild>
        <button
          type="button"
          aria-label={`${node.label}: ${summary}, ${currentStep?.label ?? ''}`}
          aria-expanded={open}
          aria-haspopup="dialog"
          data-mortise-semantic-id={`extension.${extensionId}.step-progress.${sessionId}`}
          onPointerEnter={() => { cancelClose(); setOpen(true) }}
          onPointerLeave={scheduleClose}
          onFocus={() => { cancelClose(); setOpen(true) }}
          onClick={() => {
            cancelClose()
            setPinned(value => !value)
            setOpen(true)
          }}
          className="relative flex min-h-11 w-full max-w-[34rem] cursor-pointer items-center gap-2.5 overflow-hidden rounded-[10px] border border-border/70 bg-background px-3.5 text-left shadow-middle outline-none transition-colors hover:bg-muted/25 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
            {failed
              ? <AlertCircle className="size-4 text-destructive" />
              : complete
                ? <Check className="size-4 text-success" />
                : <Loader2 className="size-4 animate-spin text-info" />}
          </span>
          <span className="shrink-0 text-xs font-medium text-foreground">{summary}</span>
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{currentStep?.label}</span>
          <span className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-muted" aria-hidden="true">
            <span className={cn('block h-full transition-[width] duration-200', failed ? 'bg-destructive' : 'bg-info')} style={{ width: `${progress}%` }} />
          </span>
        </button>
      </PopoverAnchor>
      <PopoverContent
        role="dialog"
        aria-label={node.label}
        align="center"
        side="top"
        sideOffset={8}
        onPointerEnter={cancelClose}
        onPointerLeave={scheduleClose}
        onEscapeKeyDown={() => { setPinned(false); setOpen(false) }}
        className="w-[var(--radix-popover-trigger-width)] max-w-[calc(100vw-2rem)] overflow-hidden p-0"
      >
        <div className="flex h-10 items-center justify-between border-b border-border/50 px-3.5">
          <span className="truncate text-xs font-semibold text-foreground">{node.label}</span>
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{settledCount}/{node.steps.length}</span>
        </div>
        <ol className="max-h-[min(22rem,55vh)] overflow-y-auto py-1.5" aria-label={node.label}>
          {node.steps.map((step, index) => {
            const isCurrent = index === currentIndex && !complete
            return (
              <li
                key={step.id}
                aria-current={isCurrent ? 'step' : undefined}
                className={cn('flex min-h-10 items-start gap-2.5 px-3.5 py-2 text-xs', isCurrent && 'bg-muted/40')}
              >
                <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
                  {step.status === 'completed' && <Check className="size-3.5 text-success" />}
                  {step.status === 'in_progress' && <Loader2 className="size-3.5 animate-spin text-info" />}
                  {step.status === 'failed' && <AlertCircle className="size-3.5 text-destructive" />}
                  {step.status === 'skipped' && <ChevronRight className="size-3.5 text-muted-foreground" />}
                  {step.status === 'pending' && <Circle className="size-3.5 text-muted-foreground/70" />}
                </span>
                <span className={cn('min-w-0 flex-1 leading-5', step.status === 'completed' || step.status === 'skipped' ? 'text-muted-foreground' : 'text-foreground')}>
                  {step.label}
                </span>
              </li>
            )
          })}
        </ol>
      </PopoverContent>
    </Popover>
  )
}
