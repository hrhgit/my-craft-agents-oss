import * as React from 'react'
import { Activity, AlertCircle, Check, ChevronDown, ChevronRight, Circle, Clock, Compass, Info, Loader2, MoreHorizontal, Repeat, Settings, Sparkles, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ExtensionUIIconName, ExtensionUINode, ExtensionUISurface } from '@mortise/shared/protocol'
import { cn } from '@/lib/utils'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { DropdownMenu, DropdownMenuTrigger, StyledDropdownMenuContent, StyledDropdownMenuItem } from '@/components/ui/styled-dropdown'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@mortise/ui/tooltip'
import { useExtensionContributions } from './useExtensionContributions'
import { Markdown } from '@/components/markdown'
import { SandboxAppHost } from './SandboxAppHost'
import { responsiveSurfaceCapacity, selectMountableOverflow } from './extension-contribution-store'

const icons = { activity: Activity, 'alert-circle': AlertCircle, check: Check, 'chevron-right': ChevronRight, circle: Circle, clock: Clock, compass: Compass, info: Info, loader: Loader2, repeat: Repeat, settings: Settings, sparkles: Sparkles, x: X }

export interface ExtensionContributionZoneProps {
  sessionId: string
  surface: ExtensionUISurface
  className?: string
  target?: { turnId?: string; messageId?: string; toolCallId?: string; artifactId?: string }
  /** Request a runtime snapshot on mount. Disable for passive list decorations. */
  hydrateRuntime?: boolean
}

export function ExtensionContributionZone({ sessionId, surface, className, target, hydrateRuntime = true }: ExtensionContributionZoneProps) {
  const [surfaceElement, setSurfaceElement] = React.useState<HTMLDivElement | null>(null)
  const [capacity, setCapacity] = React.useState<number | undefined>()
  React.useLayoutEffect(() => {
    if (!surfaceElement) return
    const update = () => setCapacity(responsiveSurfaceCapacity(surface, surfaceElement.getBoundingClientRect().width))
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(surfaceElement)
    return () => observer.disconnect()
  }, [surface, surfaceElement])
  const layout = useExtensionContributions(sessionId, surface, target, hydrateRuntime, undefined, capacity)
  const [overflowOpen, setOverflowOpen] = React.useState(false)
  const compact = isCompactSurface(surface)
  const mountableOverflow = selectMountableOverflow(layout)
  const mountableKeys = React.useMemo(() => new Set(mountableOverflow.map(item => `${item.extensionId}\0${item.contribution.id}`)), [mountableOverflow])
  const menuOverflow = layout.menuOverflow.filter(item => mountableKeys.has(`${item.extensionId}\0${item.contribution.id}`))
  const collapsedOverflow = layout.collapsedOverflow.filter(item => mountableKeys.has(`${item.extensionId}\0${item.contribution.id}`))
  const scrollOverflow = (layout.scrollOverflow ?? []).filter(item => mountableKeys.has(`${item.extensionId}\0${item.contribution.id}`))
  const focusedSemanticId = React.useRef<string | null>(null)
  const layoutIdentity = [...layout.visible, ...mountableOverflow].map(item => `${item.extensionId}:${item.contribution.id}`).join('|')
  React.useLayoutEffect(() => {
    const semanticId = focusedSemanticId.current
    if (!semanticId || !surfaceElement || surfaceElement.contains(document.activeElement)) return
    const replacement = Array.from(surfaceElement.querySelectorAll<HTMLElement>('[data-mortise-semantic-id]'))
      .find(element => element.dataset.mortiseSemanticId === semanticId)
    if (!replacement) return
    if (replacement.matches('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])')) {
      replacement.focus()
      return
    }
    replacement.querySelector<HTMLElement>('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])')?.focus()
  }, [layoutIdentity, surfaceElement])
  if (layout.visible.length === 0 && mountableOverflow.length === 0) return null
  return (
    <div
      ref={setSurfaceElement}
      className={cn(
        'flex min-w-0 gap-1',
        compact
          ? 'relative h-8 max-h-8 w-full flex-row items-center overflow-hidden'
          : cn('flex-col', isBoundedSurface(surface) && 'max-h-32 overflow-y-auto overscroll-contain'),
        className,
      )}
      data-extension-surface={surface}
      role={surface === 'composer.status' || surface === 'conversation.status' ? 'status' : undefined}
      aria-live={surface === 'composer.status' || surface === 'conversation.status' ? 'polite' : undefined}
      onFocusCapture={(event) => {
        focusedSemanticId.current = (event.target as HTMLElement).closest<HTMLElement>('[data-mortise-semantic-id]')?.dataset.mortiseSemanticId ?? null
      }}
    >
      {layout.visible.map(item => (
        <div key={`${item.runtimeId}:${item.extensionId}:${item.contribution.id}`} className={cn('min-w-0', compact && 'flex h-7 max-w-[120px] shrink-0 items-center overflow-hidden')} data-extension-id={item.extensionId}>
          <ExtensionNode node={item.contribution.content} contributionId={item.contribution.id} sessionId={item.sessionId} extensionId={item.extensionId} runtimeId={item.runtimeId} />
        </div>
      ))}
      {scrollOverflow.length > 0 && (
        <div className="min-w-0 max-h-32 max-w-full overflow-auto overscroll-contain rounded border border-border/60 px-1 py-0.5">
          <div className="flex min-w-max flex-col gap-1">
            {scrollOverflow.map(item => (
              <div key={`${item.runtimeId}:${item.extensionId}:${item.contribution.id}`} className="min-w-0" data-extension-id={item.extensionId}>
                <ExtensionNode node={item.contribution.content} contributionId={item.contribution.id} sessionId={item.sessionId} extensionId={item.extensionId} runtimeId={item.runtimeId} />
              </div>
            ))}
          </div>
        </div>
      )}
      {menuOverflow.length > 0 && (
        <details className="relative shrink-0 text-xs text-muted-foreground" open={overflowOpen} onToggle={(event) => setOverflowOpen(event.currentTarget.open)}>
          <summary
            className="inline-flex h-7 cursor-pointer list-none items-center gap-1 rounded px-2 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title="More extension items"
            aria-label={`More extension items (${menuOverflow.length})`}
          >
            <MoreHorizontal className="size-4" />
            <span>{menuOverflow.length}</span>
          </summary>
          <div className="absolute right-0 top-full z-popover mt-1 flex max-h-72 w-72 flex-col gap-1 overflow-auto rounded border bg-popover p-2 shadow-strong">
            {overflowOpen && menuOverflow.map(item => <ExtensionNode key={`${item.runtimeId}:${item.extensionId}:${item.contribution.id}`} node={item.contribution.content} contributionId={item.contribution.id} sessionId={item.sessionId} extensionId={item.extensionId} runtimeId={item.runtimeId} />)}
          </div>
        </details>
      )}
      {collapsedOverflow.length > 0 && (
        <details className={cn('min-w-0 text-xs text-muted-foreground', compact && 'basis-full')}>
          <summary className="inline-flex min-h-7 cursor-pointer list-none items-center gap-1 rounded px-2 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <ChevronRight className="size-3.5 transition-transform [[open]>&]:rotate-90" />
            <span>{collapsedOverflow.length}</span>
          </summary>
          <div className="mt-1 flex flex-col gap-1 border-l pl-2">
            {collapsedOverflow.map(item => <ExtensionNode key={`${item.runtimeId}:${item.extensionId}:${item.contribution.id}`} node={item.contribution.content} contributionId={item.contribution.id} sessionId={item.sessionId} extensionId={item.extensionId} runtimeId={item.runtimeId} />)}
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
      {layout.visible.map(item => <div key={`${item.runtimeId}:${item.extensionId}:${item.contribution.id}`} className="min-w-0" data-extension-id={item.extensionId}><ExtensionNode node={item.contribution.content} contributionId={item.contribution.id} sessionId={item.sessionId} extensionId={item.extensionId} runtimeId={item.runtimeId} /></div>)}
    </div>
  )
}

function ExtensionIcon({ name, label, semanticId }: { name: ExtensionUIIconName; label?: string; semanticId?: string }) {
  const Icon = icons[name]
  return (
    <Icon
      className={cn('size-4 shrink-0', name === 'loader' && 'animate-spin')}
      {...(label ? { 'aria-label': label } : { 'aria-hidden': true })}
      data-mortise-semantic-id={semanticId}
    />
  )
}

export function ExtensionContributionContent({
  node,
  sessionId,
  extensionId,
  runtimeId,
  contributionId = 'content',
  className,
}: {
  node: ExtensionUINode
  sessionId: string
  extensionId: string
  runtimeId: string
  contributionId?: string
  className?: string
}) {
  return (
    <div className={cn('min-h-0 min-w-0', className)}>
      <ExtensionNode node={node} contributionId={contributionId} sessionId={sessionId} extensionId={extensionId} runtimeId={runtimeId} />
    </div>
  )
}

function ExtensionNode({ node, contributionId, sessionId, extensionId, runtimeId }: { node: ExtensionUINode; contributionId: string; sessionId: string; extensionId: string; runtimeId: string }) {
  const semanticId = node.semanticId ? `extension.${extensionId}.${contributionId}.${node.semanticId}` : undefined
  if (node.type === 'text') return <span data-mortise-semantic-id={semanticId} className={cn('break-words text-sm', node.tone === 'muted' && 'text-muted-foreground', node.tone === 'success' && 'text-emerald-600', node.tone === 'warning' && 'text-amber-600', node.tone === 'danger' && 'text-destructive')}>{node.text}</span>
  if (node.type === 'markdown') return <div data-mortise-semantic-id={semanticId} className="max-w-none break-words"><Markdown>{node.markdown}</Markdown></div>
  if (node.type === 'icon') return <ExtensionIcon name={node.name} label={node.label} semanticId={semanticId} />
  if (node.type === 'badge') return (
    <span data-mortise-semantic-id={semanticId} className={cn(
      'inline-flex h-6 max-w-full items-center rounded border px-2 text-xs',
      (!node.tone || node.tone === 'default') && 'border-border bg-muted/50 text-foreground',
      node.tone === 'info' && 'border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300',
      node.tone === 'success' && 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
      node.tone === 'warning' && 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300',
      node.tone === 'danger' && 'border-destructive/25 bg-destructive/10 text-destructive',
    )}><span className="truncate">{node.label}</span></span>
  )
  if (node.type === 'divider') return <hr data-mortise-semantic-id={semanticId} className="border-border" />
  if (node.type === 'step-progress') return <StepProgress node={node} sessionId={sessionId} extensionId={extensionId} semanticId={semanticId} />
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
      data-mortise-semantic-id={semanticId ?? `extension.${extensionId}.command.${node.action.command}`}
      onClick={() => void window.electronAPI?.invokeExtensionCommand?.(sessionId, node.action.command, node.action.args, extensionId, crypto.randomUUID())}
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
  if (node.type === 'menu') return <ExtensionMenu node={node} semanticId={semanticId} sessionId={sessionId} extensionId={extensionId} />
  if (node.type === 'responsive') return <ExtensionResponsiveNode node={node} semanticId={semanticId} contributionId={contributionId} sessionId={sessionId} extensionId={extensionId} runtimeId={runtimeId} />
  if (node.type === 'sandbox-app') return <div data-mortise-semantic-id={semanticId}><SandboxAppHost node={node} sessionId={sessionId} extensionId={extensionId} runtimeId={runtimeId} /></div>
  const gap = node.gap === 'none' ? 'gap-0' : node.gap === 'medium' ? 'gap-3' : 'gap-1.5'
  return <div data-mortise-semantic-id={semanticId} className={cn('min-w-0', node.type === 'row' ? 'flex flex-wrap items-center' : 'flex flex-col', gap)}>{node.children.map((child, index) => <ExtensionNode key={child.semanticId ?? index} node={child} contributionId={contributionId} sessionId={sessionId} extensionId={extensionId} runtimeId={runtimeId} />)}</div>
}

function isBoundedSurface(surface: ExtensionUISurface): boolean {
  return surface === 'composer.above' || surface === 'composer.below' || surface === 'conversation.status'
}

type ResponsiveNode = Extract<ExtensionUINode, { type: 'responsive' }>
export type ExtensionResponsiveMode = 'full' | 'compact' | 'minimal'

export function selectResponsiveMode(width: number, node: ResponsiveNode): ExtensionResponsiveMode {
  if (width <= 220 && node.minimal) return 'minimal'
  if (width <= 420 && node.compact) return 'compact'
  return 'full'
}

function ExtensionResponsiveNode({ node, semanticId, contributionId, sessionId, extensionId, runtimeId }: {
  node: ResponsiveNode
  semanticId?: string
  contributionId: string
  sessionId: string
  extensionId: string
  runtimeId: string
}) {
  const [element, setElement] = React.useState<HTMLDivElement | null>(null)
  const [width, setWidth] = React.useState(Number.POSITIVE_INFINITY)
  React.useEffect(() => {
    if (!element) return
    const update = () => setWidth(element.getBoundingClientRect().width)
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])
  const mode = selectResponsiveMode(width, node)
  const selected = mode === 'minimal'
    ? node.minimal ?? node.compact ?? node.full
    : mode === 'compact'
      ? node.compact ?? node.full
      : node.full
  return (
    <div ref={setElement} data-mortise-semantic-id={semanticId} data-mortise-responsive-mode={mode} className="min-w-0">
      <ExtensionNode node={selected} contributionId={contributionId} sessionId={sessionId} extensionId={extensionId} runtimeId={runtimeId} />
    </div>
  )
}

type MenuNode = Extract<ExtensionUINode, { type: 'menu' }>

const menuToneStyles = {
  default: { className: 'bg-foreground/5 text-foreground/60', shadowVar: 'var(--foreground-rgb)' },
  info: { className: 'bg-info/10 text-info', shadowVar: 'var(--info-rgb)' },
  accent: { className: 'bg-accent/5 text-accent', shadowVar: 'var(--accent-rgb)' },
} as const

function ExtensionMenu({ node, semanticId, sessionId, extensionId }: {
  node: MenuNode
  semanticId?: string
  sessionId: string
  extensionId: string
}) {
  const [open, setOpen] = React.useState(false)
  const style = menuToneStyles[node.tone ?? 'default']
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={node.label}
          data-mortise-semantic-id={semanticId ?? `extension.${extensionId}.menu.${sessionId}`}
          className={cn('h-8 pl-2.5 pr-3 text-[13px] font-medium rounded-[6px] flex items-center gap-1.5 shadow-tinted outline-none select-none shrink-0', style.className)}
          style={{ '--shadow-color': style.shadowVar } as React.CSSProperties}
        >
          {node.icon && <ExtensionIcon name={node.icon} />}
          <span className="min-w-0 truncate">{node.label}</span>
          <ChevronDown className="h-3 w-3 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <StyledDropdownMenuContent side="top" align="start" sideOffset={4} className="min-w-[220px]">
        {node.options.map((option) => (
          <StyledDropdownMenuItem
            key={option.id}
            disabled={option.disabled}
            onSelect={() => {
              if (!option.disabled) void window.electronAPI?.invokeExtensionCommand?.(sessionId, option.action.command, option.action.args, extensionId, crypto.randomUUID())
              setOpen(false)
            }}
            className="flex items-center justify-between px-2 py-2 rounded-lg cursor-pointer"
            title={option.disabledReason}
          >
            <div className="flex items-center gap-2 min-w-0">
              {option.icon && <span className={cn('shrink-0', option.tone === 'info' && 'text-info', option.tone === 'accent' && 'text-accent')}><ExtensionIcon name={option.icon} /></span>}
              <div className="min-w-0 text-left">
                <div className="text-sm font-medium">{option.label}</div>
                {option.description && <div className="text-xs text-muted-foreground truncate">{option.description}</div>}
              </div>
            </div>
            {option.selected && <Check className="h-3.5 w-3.5 shrink-0 ml-3 text-foreground/60" />}
          </StyledDropdownMenuItem>
        ))}
      </StyledDropdownMenuContent>
    </DropdownMenu>
  )
}

type StepProgressNode = Extract<ExtensionUINode, { type: 'step-progress' }>

function StepProgress({ node, sessionId, extensionId, semanticId }: { node: StepProgressNode; sessionId: string; extensionId: string; semanticId?: string }) {
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
          data-mortise-semantic-id={semanticId ?? `extension.${extensionId}.step-progress.${sessionId}`}
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
