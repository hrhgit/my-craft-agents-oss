import * as React from 'react'
import { Activity, AlertCircle, Check, ChevronRight, Circle, Clock, Info, Loader2, MoreHorizontal, Settings, Sparkles, X } from 'lucide-react'
import type { ExtensionUIIconName, ExtensionUINode, ExtensionUISurface } from '@craft-agent/shared/protocol'
import { cn } from '@/lib/utils'
import { useExtensionContributions } from './useExtensionContributions'
import { Markdown } from '@/components/markdown'
import { SandboxAppHost } from './SandboxAppHost'
import { selectMountableOverflow } from './extension-contribution-store'

const icons = { activity: Activity, 'alert-circle': AlertCircle, check: Check, 'chevron-right': ChevronRight, circle: Circle, clock: Clock, info: Info, loader: Loader2, settings: Settings, sparkles: Sparkles, x: X }

export interface ExtensionContributionZoneProps {
  sessionId: string
  surface: ExtensionUISurface
  className?: string
  target?: { turnId?: string; messageId?: string; toolCallId?: string }
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
    <div className={cn('flex min-w-0 gap-1', compact ? 'relative max-h-8 w-full flex-row items-center' : 'flex-col', className)} data-extension-surface={surface}>
      {layout.visible.map(item => (
        <div key={`${item.runtimeId}:${item.extensionId}:${item.contribution.id}`} className={cn('min-w-0', compact && 'max-w-[120px] overflow-hidden')} data-extension-id={item.extensionId}>
          <ExtensionNode node={item.contribution.content} sessionId={sessionId} extensionId={item.extensionId} runtimeId={item.runtimeId} />
        </div>
      ))}
      {mountableOverflow.length > 0 && (
        <details className={cn('text-xs text-muted-foreground', compact && 'relative shrink-0')} open={overflowOpen} onToggle={(event) => setOverflowOpen(event.currentTarget.open)}>
          <summary className="inline-flex h-7 cursor-pointer list-none items-center gap-1 rounded px-2 hover:bg-muted" title="More extension items">
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

function ExtensionIcon({ name, label }: { name: ExtensionUIIconName; label: string }) {
  const Icon = icons[name]
  return <Icon className={cn('size-4 shrink-0', name === 'loader' && 'animate-spin')} aria-label={label} />
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
  if (node.type === 'badge') return <span className="inline-flex h-6 max-w-full items-center rounded border bg-muted/50 px-2 text-xs"><span className="truncate">{node.label}</span></span>
  if (node.type === 'divider') return <hr className="border-border" />
  if (node.type === 'button') return (
    <button
      type="button"
      disabled={node.disabled}
      className="inline-flex h-7 max-w-full items-center gap-1.5 rounded px-2 text-xs font-medium hover:bg-muted disabled:opacity-50"
      title={`${node.label} (${extensionId})`}
      onClick={() => void window.electronAPI?.invokeExtensionCommand?.(sessionId, node.action.command, node.action.args, extensionId)}
    >
      {node.icon && <ExtensionIcon name={node.icon} label="" />}
      <span className="truncate">{node.label}</span>
    </button>
  )
  if (node.type === 'sandbox-app') return <SandboxAppHost node={node} sessionId={sessionId} extensionId={extensionId} runtimeId={runtimeId} />
  const gap = node.gap === 'none' ? 'gap-0' : node.gap === 'medium' ? 'gap-3' : 'gap-1.5'
  return <div className={cn('min-w-0', node.type === 'row' ? 'flex flex-wrap items-center' : 'flex flex-col', gap)}>{node.children.map((child, index) => <ExtensionNode key={index} node={child} sessionId={sessionId} extensionId={extensionId} runtimeId={runtimeId} />)}</div>
}
