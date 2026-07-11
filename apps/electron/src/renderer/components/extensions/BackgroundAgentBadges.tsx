import * as React from 'react'
import { Circle, Square } from 'lucide-react'
import { toast } from 'sonner'
import { Spinner } from '@craft-agent/ui'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { ExtensionBridgeEvent } from '@craft-agent/shared/agent/backend/types'
import { toExtensionBlock, type ExtensionBlockContribution } from './extension-contribution-model'
import type { PiExtensionSettings } from '@craft-agent/shared/config'

type BackgroundAgentName = 'trace-audit' | 'yourself' | 'repo-memory'

interface BackgroundAgentBadgeState {
  name: BackgroundAgentName
  status: 'running' | 'queued' | 'idle' | 'failed' | 'unknown'
  lines: string[]
  updatedAt: number
}

const BACKGROUND_AGENT_WIDGET_KEYS: Record<string, BackgroundAgentName> = {
  'trace-audit': 'trace-audit',
  'yourself': 'yourself',
  'repo-memory': 'repo-memory',
}

const AGENT_LABELS: Record<BackgroundAgentName, string> = {
  'trace-audit': 'trace-audit',
  yourself: 'yourself',
  'repo-memory': 'repo-memory',
}

const STOP_COMMANDS: Partial<Record<BackgroundAgentName, { command: string; args: string }>> = {
  'trace-audit': { command: 'trace-audit', args: 'cancel' },
  yourself: { command: 'yourself', args: 'stop' },
  'repo-memory': { command: 'repo-memory', args: 'stop' },
}

const AGENT_ORDER: BackgroundAgentName[] = ['trace-audit', 'yourself', 'repo-memory']

function inferStatus(lines: string[]): BackgroundAgentBadgeState['status'] {
  const text = lines.join('\n').toLowerCase()
  if (/(failed|error|失败|错误)/.test(text)) return 'failed'
  if (/(queued|排队)/.test(text)) return 'queued'
  if (/(running|updating|启动|运行|评审|judging|analyzing|scanning)/.test(text)) return 'running'
  if (/(idle|completed|complete|已完成|stopped|停止|up to date)/.test(text)) return 'idle'
  return 'unknown'
}

function firstUsefulLine(lines: string[]): string {
  return lines.find(line => line.trim())?.trim() ?? 'status available'
}

function isVisibleBySettings(name: BackgroundAgentName, settings: PiExtensionSettings | null): boolean {
  // craft 侧仅检查全局开关与 GUI 徽章可见性
  if (!settings || settings.enabled === false) return false
  if (name === 'trace-audit') {
    return settings.traceAudit.showStatusBadge !== false
  }
  if (name === 'yourself') {
    return settings.yourself.showStatusBadge !== false
  }
  return settings.repoMemory.showStatusBadge !== false
}

function applyWidgetEvent(
  prev: Map<BackgroundAgentName, BackgroundAgentBadgeState>,
  event: ExtensionBlockContribution,
): Map<BackgroundAgentName, BackgroundAgentBadgeState> {
  const name = BACKGROUND_AGENT_WIDGET_KEYS[event.key]
  if (!name) return prev

  const next = new Map(prev)
  if (event.content === undefined || event.content.length === 0) {
    next.delete(name)
    return next
  }

  next.set(name, {
    name,
    status: inferStatus(event.content),
    lines: event.content,
    updatedAt: Date.now(),
  })
  return next
}

async function loadSettings(): Promise<PiExtensionSettings | null> {
  try {
    return await window.electronAPI?.getPiExtensionSettings?.()
  } catch {
    return null
  }
}

export interface BackgroundAgentBadgesProps {
  sessionId?: string
  className?: string
}

export function BackgroundAgentBadges({ sessionId, className }: BackgroundAgentBadgesProps) {
  const [agents, setAgents] = React.useState<Map<BackgroundAgentName, BackgroundAgentBadgeState>>(() => new Map())
  const [settings, setSettings] = React.useState<PiExtensionSettings | null>(null)

  React.useEffect(() => {
    setAgents(new Map())
  }, [sessionId])

  React.useEffect(() => {
    let disposed = false
    void loadSettings().then(next => {
      if (!disposed) setSettings(next)
    })
    return () => {
      disposed = true
    }
  }, [])

  React.useEffect(() => {
    const w = window as unknown as {
      electronAPI?: {
        onExtensionEvent?: (callback: (event: ExtensionBridgeEvent) => void) => () => void
      }
    }
    const subscribe = w.electronAPI?.onExtensionEvent
    if (typeof subscribe !== 'function') return

    const unsubscribe = subscribe((event) => {
      if (event.type !== 'extension_contribution') return
      if (event.contribution.sessionId !== sessionId) return
      const block = toExtensionBlock(event.contribution)
      if (!block) return
      setAgents(prev => applyWidgetEvent(prev, block))
    })
    return () => {
      if (typeof unsubscribe === 'function') unsubscribe()
    }
  }, [sessionId])

  const visibleAgents = React.useMemo(() => {
    return Array.from(agents.values())
      .filter(agent => isVisibleBySettings(agent.name, settings))
      .sort((left, right) => AGENT_ORDER.indexOf(left.name) - AGENT_ORDER.indexOf(right.name))
  }, [agents, settings])

  if (visibleAgents.length === 0) return null

  return (
    <div
      className={cn(
        'pointer-events-none absolute right-3 top-3 z-20 flex max-w-[min(520px,calc(100%-1.5rem))] flex-wrap justify-end gap-1.5',
        className,
      )}
      data-background-agent-badges
    >
      {visibleAgents.map(agent => (
        <BackgroundAgentBadge
          key={agent.name}
          agent={agent}
          sessionId={sessionId}
        />
      ))}
    </div>
  )
}

function BackgroundAgentBadge({
  agent,
  sessionId,
}: {
  agent: BackgroundAgentBadgeState
  sessionId?: string
}) {
  const [open, setOpen] = React.useState(false)
  const stop = STOP_COMMANDS[agent.name]
  const canStop = Boolean(stop && sessionId && agent.status !== 'idle')

  const handleStop = React.useCallback(async () => {
    if (!stop || !sessionId) return
    try {
      const ok = await window.electronAPI?.invokeExtensionCommand?.(sessionId, stop.command, stop.args)
      if (ok?.invoked) {
        toast.info(`Stop requested for ${AGENT_LABELS[agent.name]}`)
      } else {
        toast.warning(`${AGENT_LABELS[agent.name]} stop command is not available`, { description: ok?.error })
      }
    } catch (error) {
      toast.error(`Failed to stop ${AGENT_LABELS[agent.name]}`, {
        description: error instanceof Error ? error.message : 'Unknown error',
      })
    }
  }, [agent.name, sessionId, stop])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'pointer-events-auto inline-flex h-6 max-w-52 items-center gap-1.5 rounded-[6px]',
            'border border-border/60 bg-background/90 px-2 text-[11px] text-foreground/75 shadow-thin backdrop-blur',
            'transition-colors hover:bg-background focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          )}
          onMouseEnter={() => setOpen(true)}
          aria-label={`${AGENT_LABELS[agent.name]} ${agent.status}`}
        >
          <StatusGlyph status={agent.status} />
          <span className="shrink-0 font-medium">{AGENT_LABELS[agent.name]}</span>
          <span className="min-w-0 truncate text-muted-foreground">{agent.status}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="end"
        className="pointer-events-auto w-80 p-0"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
      >
        <div className="border-b border-border/50 px-3 py-2">
          <div className="flex items-center gap-2">
            <StatusGlyph status={agent.status} />
            <div className="min-w-0">
              <div className="text-sm font-medium">{AGENT_LABELS[agent.name]}</div>
              <div className="truncate text-xs text-muted-foreground">{firstUsefulLine(agent.lines)}</div>
            </div>
          </div>
        </div>
        <div className="max-h-56 overflow-y-auto px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground/80">
          {agent.lines.map((line, index) => (
            <div key={index} className="break-words whitespace-pre-wrap">
              {line}
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between border-t border-border/50 px-3 py-2">
          <span className="text-[11px] text-muted-foreground">
            Updated {new Date(agent.updatedAt).toLocaleTimeString()}
          </span>
          {stop ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7"
              onClick={handleStop}
              disabled={!canStop}
            >
              <Square className="h-3 w-3" />
              Stop
            </Button>
          ) : (
            <span className="text-[11px] text-muted-foreground">Stop not supported</span>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function StatusGlyph({ status }: { status: BackgroundAgentBadgeState['status'] }) {
  if (status === 'running' || status === 'queued') {
    return <Spinner className="text-[9px] text-foreground/60" />
  }
  return (
    <Circle
      className={cn(
        'h-2 w-2 fill-current stroke-none',
        status === 'failed' ? 'text-destructive' : 'text-foreground/35',
      )}
    />
  )
}

export default BackgroundAgentBadges
