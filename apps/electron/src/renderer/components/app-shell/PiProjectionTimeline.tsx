import * as React from 'react'
import { AlertCircle, CheckCircle2, ChevronDown, ChevronRight, File, Image, LoaderCircle, MessageCircleDashed, Wrench } from 'lucide-react'
import type { PiProjectionState } from '@/atoms/pi-projection'
import { cn } from '@/lib/utils'
import { CollapsibleMarkdownProvider, Markdown, StreamingMarkdown } from '@/components/markdown'
import { ActivityCardsOverlay, UserMessageBubble, extractOverlayCards, type ActivityItem } from '@mortise/ui'
import { buildPiTimelineItems, findPiTimelineMatches, getPiTimelinePageStart, type PiTimelineItem } from './pi-timeline-model'
import { ExtensionContributionZone, ExtensionReplaceZone } from '@/components/extensions/ExtensionContributionZone'

interface PiProjectionTimelineProps {
  projection: PiProjectionState
  onOpenFile: (path: string) => void
  onOpenUrl: (url: string) => void
  searchQuery?: string
  currentMatchIndex?: number
  pageSize?: number
  onMatchInfoChange?: (count: number) => void
  onItemRef?: (id: string, element: HTMLDivElement | null) => void
}

function formatDetail(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return ''
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}

function ToolRow({ item, onOpenFile, onOpenUrl }: { item: Extract<PiTimelineItem, { type: 'tool' }>; onOpenFile: (path: string) => void; onOpenUrl: (url: string) => void }) {
  const [expanded, setExpanded] = React.useState(false)
  const [inspecting, setInspecting] = React.useState(false)
  const detail = item.result !== undefined ? item.result : item.input
  const Icon = item.status === 'running' ? LoaderCircle : item.status === 'failed' ? AlertCircle : CheckCircle2
  const activity = React.useMemo<ActivityItem>(() => ({
    id: item.id,
    type: 'tool',
    status: item.status === 'running' ? 'running' : item.status === 'failed' ? 'error' : 'completed',
    toolName: item.toolName,
    toolUseId: item.toolCallId,
    toolInput: item.input && typeof item.input === 'object' && !Array.isArray(item.input) ? item.input as Record<string, unknown> : undefined,
    content: formatDetail(item.result),
    displayName: item.displayName,
    timestamp: item.seq,
    error: item.isError ? formatDetail(item.result) : undefined,
  }), [item])
  const cards = React.useMemo(() => extractOverlayCards(activity), [activity])
  return (
    <div className="border-l border-border/60 pl-3" data-pi-entity-id={item.id}>
      <button
        type="button"
        className="flex min-h-8 w-full items-center gap-2 text-left text-xs text-muted-foreground hover:text-foreground"
        onClick={() => setExpanded(value => !value)}
        aria-expanded={expanded}
      >
        {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <Icon className={cn('h-3.5 w-3.5', item.status === 'running' && 'animate-spin', item.status === 'failed' && 'text-destructive')} />
        <span className="font-medium text-foreground/80">{item.displayName || item.toolName}</span>
        <span className="ml-auto">{item.status}</span>
      </button>
      {expanded && detail !== undefined && (
        <div className="mb-2">
          <pre className="max-h-72 overflow-auto rounded-[6px] bg-foreground/[0.04] p-3 text-xs whitespace-pre-wrap break-words">{formatDetail(detail)}</pre>
          <button type="button" className="mt-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => setInspecting(true)}>Open inspector</button>
        </div>
      )}
      <ActivityCardsOverlay isOpen={inspecting} onClose={() => setInspecting(false)} cards={cards} title={item.displayName || item.toolName} onOpenFile={onOpenFile} onOpenUrl={onOpenUrl} />
    </div>
  )
}

function ContentBlock({ item, onOpenFile, onOpenUrl }: {
  item: Extract<PiTimelineItem, { type: 'content' }>
  onOpenFile: (path: string) => void
  onOpenUrl: (url: string) => void
}) {
  const content = item.streaming
    ? <StreamingMarkdown content={item.text} isStreaming onUrlClick={onOpenUrl} onFileClick={onOpenFile} />
    : <Markdown id={item.id} mode="minimal" onUrlClick={onOpenUrl} onFileClick={onOpenFile}>{item.text}</Markdown>

  if (item.contentKind === 'thinking') {
    return (
      <div data-pi-entity-id={item.id} className="border-l border-border/60 py-1 pl-3 text-muted-foreground">
        <div className="mb-1 flex items-center gap-2 text-xs font-medium">
          {item.streaming
            ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            : <MessageCircleDashed className="h-3.5 w-3.5" />}
          <span>Thinking</span>
        </div>
        <div className="text-sm opacity-80">{content}</div>
      </div>
    )
  }

  if (item.role === 'user') {
    return (
      <div data-pi-entity-id={item.id}>
        <UserMessageBubble
          content={item.text}
          timestamp={item.timestamp}
          onUrlClick={onOpenUrl}
          onFileClick={onOpenFile}
        />
      </div>
    )
  }

  return <div data-pi-entity-id={item.id}>{content}</div>
}

function formatFileSize(size?: number): string {
  if (size === undefined) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function AttachmentRef({ item }: { item: Extract<PiTimelineItem, { type: 'attachment' }> }) {
  const isImage = item.mediaType?.startsWith('image/') === true
  const Icon = isImage ? Image : File
  return (
    <div data-pi-entity-id={item.id} className="ml-auto flex max-w-[85%] items-center gap-2 rounded-[6px] border border-border/70 px-3 py-2">
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <div className="truncate text-xs font-medium" title={item.name}>{item.name}</div>
        <div className="text-[11px] text-muted-foreground">{[item.mediaType, formatFileSize(item.size)].filter(Boolean).join(' · ')}</div>
      </div>
    </div>
  )
}

export function PiProjectionTimeline({
  projection,
  onOpenFile,
  onOpenUrl,
  searchQuery = '',
  currentMatchIndex = 0,
  pageSize = 20,
  onMatchInfoChange,
  onItemRef,
}: PiProjectionTimelineProps) {
  const items = React.useMemo(() => buildPiTimelineItems(
    projection.entityIds.map(id => projection.entitiesById[id]).filter(Boolean),
  ), [projection.entitiesById, projection.entityIds])
  const matches = React.useMemo(() => findPiTimelineMatches(items, searchQuery), [items, searchQuery])
  const [visibleItemCount, setVisibleItemCount] = React.useState(pageSize)
  React.useEffect(() => setVisibleItemCount(pageSize), [pageSize, projection.sessionId])
  React.useEffect(() => onMatchInfoChange?.(matches.length), [matches.length, onMatchInfoChange])
  const pageStart = getPiTimelinePageStart(items.length, visibleItemCount, matches)
  const visibleItems = items.slice(pageStart)
  const activeMatchId = matches[currentMatchIndex]?.itemId
  React.useEffect(() => {
    if (!activeMatchId) return
    document.querySelector(`[data-pi-entity-id="${CSS.escape(activeMatchId)}"]`)?.scrollIntoView({ block: 'center' })
  }, [activeMatchId])

  if (projection.syncState === 'desynced') {
    return <div className="flex items-center gap-2 py-4 text-xs text-destructive"><AlertCircle className="h-4 w-4" />Conversation is resynchronizing.</div>
  }

  return (
    <CollapsibleMarkdownProvider>
      <div data-testid="pi-projection-timeline">
        {pageStart > 0 && <button type="button" className="w-full py-2 text-xs text-muted-foreground hover:text-foreground" onClick={() => setVisibleItemCount(value => value + pageSize)}>Show {Math.min(pageSize, pageStart)} earlier items</button>}
        {visibleItems.map(item => {
          const matchClass = item.id === activeMatchId ? 'ring-2 ring-info ring-offset-2 ring-offset-background rounded-[6px]' : matches.some(match => match.itemId === item.id) ? 'ring-1 ring-info/30 rounded-[6px]' : undefined
          if (item.type === 'tool') return <div key={item.id} ref={element => onItemRef?.(item.id, element)} className={matchClass}>
            <ExtensionContributionZone sessionId={projection.sessionId} surface="conversation.tool.before" target={{ toolCallId: item.toolCallId }} />
            <ExtensionReplaceZone sessionId={projection.sessionId} surface="conversation.tool.replace" target={{ toolCallId: item.toolCallId }}><ToolRow item={item} onOpenFile={onOpenFile} onOpenUrl={onOpenUrl} /></ExtensionReplaceZone>
            <ExtensionContributionZone sessionId={projection.sessionId} surface="conversation.tool.after" target={{ toolCallId: item.toolCallId }} />
          </div>
          if (item.type === 'attachment') return <div key={item.id} ref={element => onItemRef?.(item.id, element)} className={cn('my-3', matchClass)}><AttachmentRef item={item} /></div>
          if (item.type === 'artifact') return <div key={item.id} ref={element => onItemRef?.(item.id, element)} data-pi-entity-id={item.id} className={cn('my-3', matchClass)}><Markdown>{item.content}</Markdown></div>
          if (item.type === 'error') {
            return <div key={item.id} ref={element => onItemRef?.(item.id, element)} data-pi-entity-id={item.id} className={cn('my-3 flex items-start gap-2 border-l border-destructive/50 py-1 pl-3 text-sm text-destructive', matchClass)}><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span>{item.message}</span></div>
          }
          return <div key={item.id} ref={element => onItemRef?.(item.id, element)} className={cn(item.contentKind === 'thinking' ? undefined : 'my-3', matchClass)}>
            <ExtensionContributionZone sessionId={projection.sessionId} surface="conversation.message.before" target={{ messageId: item.id }} />
            <ExtensionReplaceZone sessionId={projection.sessionId} surface="conversation.message.replace" target={{ messageId: item.id }}><ContentBlock item={item} onOpenFile={onOpenFile} onOpenUrl={onOpenUrl} /></ExtensionReplaceZone>
            <ExtensionContributionZone sessionId={projection.sessionId} surface="conversation.message.after" target={{ messageId: item.id }} />
          </div>
        })}
        {items.length === 0 && <div className="flex h-64 items-center justify-center text-xs text-muted-foreground"><Wrench className="mr-2 h-4 w-4" />Waiting for Pi events</div>}
      </div>
    </CollapsibleMarkdownProvider>
  )
}
