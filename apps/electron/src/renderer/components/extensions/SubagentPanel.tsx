/**
 * SubagentPanel
 *
 * 显示 pi subagent 扩展的活动会话列表。
 *
 * 数据来源：~/.pi/agent/extensions/subagent/supervisor/active-sessions.json
 * 该文件由 subagent 扩展的 supervisor daemon 维护，记录所有向 supervisor
 * 注册过的 pi agent 进程（每个 craft 会话一个条目）。
 *
 * 读取方式：通过 ElectronAPI.getHomeDir() 获取用户主目录，拼接出
 * active-sessions.json 的绝对路径，再用 ElectronAPI.readFile() 读取。
 * readFile 的路径校验（validateFilePath）默认允许主目录下的文件，
 * 因此无需新增 RPC 通道。
 *
 * 刷新策略：
 * - 每 5 秒轮询刷新一次
 * - 通过 extension_notify 事件（subagent 扩展的 status 变更通知）触发即时刷新
 *
 * 面板可折叠，默认收起以节省空间；仅当存在活动会话时才显示。
 */

import * as React from 'react'
import { toast } from 'sonner'
import { ChevronDown, ChevronRight, Eye, X, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Spinner } from '@craft-agent/ui'
import { Collapsible, CollapsibleContent, CollapsibleTrigger, AnimatedCollapsibleContent } from '@/components/ui/collapsible'
import type { ExtensionBridgeEvent } from '@craft-agent/shared/agent/backend/types'
import type { PiExtensionSettings } from '@craft-agent/shared/config'

/**
 * active-sessions.json 中单个条目的结构。
 * 对应 subagent 扩展 supervisor.ts 的 SupervisorActiveSession 接口。
 */
export interface SubagentActiveSession {
  /** 会话唯一标识（格式 pi-<pid>-<timestamp>-<random>） */
  id: string
  /** 进程 PID */
  pid: number
  /** 工作目录 */
  cwd: string
  /** 会话 JSONL 文件路径 */
  sessionFile?: string
  /** pi 会话 ID */
  sessionId?: string
  /** 会话名称 */
  sessionName?: string
  /** 会话状态：running 表示 agent 正在执行，idle 表示已空闲 */
  status: 'idle' | 'running'
  /** 启动时间（ISO 字符串） */
  startedAt: string
  /** 最后更新时间（ISO 字符串） */
  updatedAt: string
  /** 状态变更原因 */
  reason?: string
  /** 使用的模型（provider/model 格式） */
  model?: string
}

/**
 * active-sessions.json 文件格式：会话条目数组。
 */
type ActiveSessionsFile = SubagentActiveSession[]

/**
 * active-sessions.json 的绝对路径（相对于用户主目录）。
 */
const ACTIVE_SESSIONS_REL_PATH =
  '.pi/agent/extensions/subagent/supervisor/active-sessions.json'
const CRAFT_ACTIVE_SESSIONS_REL_PATH =
  '.craft-agent/pi-extensions/extensions/subagent/supervisor/active-sessions.json'

/** 轮询间隔：每 5 秒刷新一次活动会话列表 */
const REFRESH_INTERVAL_MS = 5000

/**
 * 读取 active-sessions.json 并解析为会话数组。
 * 文件不存在或解析失败时返回空数组。
 */
async function loadActiveSessions(settings: PiExtensionSettings | null): Promise<SubagentActiveSession[]> {
  const homeDir = await window.electronAPI.getHomeDir()
  // 扩展启停已迁移到 pi settings.json，craft 侧仅凭全局开关决定会话文件路径
  const relPath = settings && settings.enabled !== false
    ? CRAFT_ACTIVE_SESSIONS_REL_PATH
    : ACTIVE_SESSIONS_REL_PATH
  // 使用正斜杠拼接——readFile 内部会用 normalize 处理跨平台分隔符
  const filePath = `${homeDir}/${relPath}`
  try {
    const content = await window.electronAPI.readFile(filePath)
    const parsed = JSON.parse(content) as ActiveSessionsFile
    return Array.isArray(parsed) ? parsed : []
  } catch {
    // 文件不存在（subagent supervisor 未启动）或读取失败——返回空列表
    return []
  }
}

/**
 * 将 ISO 时间字符串格式化为简短的可读形式（HH:MM:SS）。
 */
function formatTime(iso: string | undefined): string {
  if (!iso) return '—'
  try {
    const date = new Date(iso)
    return date.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    return '—'
  }
}

/**
 * 将绝对路径缩短为 ~ 形式，便于在面板中展示。
 */
function shortenPath(p: string | undefined): string {
  if (!p) return '—'
  return p
}

interface SessionRowProps {
  session: SubagentActiveSession
  sessionId: string | undefined
}

/**
 * 单个活动会话条目。
 * - 名称（sessionName 或 sessionId 或 id）
 * - 状态徽章（running / idle）
 * - 工作目录
 * - "查看"按钮：展开详情（PID、模型、时间戳、会话文件路径）
 * - "取消"按钮：通过 extension_command_invoke 触发 subagent-cancel 命令
 */
function SessionRow({ session, sessionId }: SessionRowProps) {
  const [expanded, setExpanded] = React.useState(false)

  const displayName = session.sessionName || session.sessionId || session.id
  const isRunning = session.status === 'running'

  const handleCancel = React.useCallback(() => {
    // 取消通过 extension_command_invoke 触发 subagent 扩展的 /subagent-cancel 命令。
    //
    // 注意：subagent 扩展当前的 subagent-cancel 命令期望的是 supervisor JOB ID
    // （由 submitSupervisorJob 产生的 job-<timestamp>-<hex>），而 active-sessions.json
    // 中的 id 是活动 SESSION ID（pi-<pid>-<timestamp>-<hex>），两者不是同一实体。
    // 因此该取消调用在 subagent 扩展未增加 session 级取消支持前可能返回 "job not found"。
    // 若需精确取消活动会话对应的子代理任务，需要 subagent 扩展新增按 session id 取消的命令。
    const w = window as unknown as {
      electronAPI?: {
        invokeExtensionCommand?: (
          sessionId: string,
          commandName: string,
          args?: Record<string, unknown>,
        ) => Promise<boolean> | boolean
      }
    }
    const invoked = w.electronAPI?.invokeExtensionCommand?.(
      sessionId ?? '',
      'subagent-cancel',
      { jobId: session.id },
    )
    if (invoked) {
      toast.info(`已请求取消会话 ${displayName}`)
    } else {
      toast.warning('subagent 扩展命令桥接未就绪，无法取消')
    }
  }, [session.id, sessionId, displayName])

  return (
    <div className="border-b border-border/40 last:border-b-0">
      {/* 主行：状态 + 名称 + 工作目录 + 操作按钮 */}
      <div className="flex items-center gap-2 px-2 py-1.5 text-xs">
        {/* 展开/收起触发器 */}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
          aria-label={expanded ? '收起详情' : '展开详情'}
        >
          {expanded ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
        </button>

        {/* 状态徽章 */}
        <span
          className={cn(
            'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0',
            isRunning
              ? 'bg-blue-500/15 text-blue-600 dark:text-blue-400'
              : 'bg-muted text-muted-foreground',
          )}
        >
          {isRunning && <Spinner className="text-[8px]" />}
          {isRunning ? 'running' : 'idle'}
        </span>

        {/* 名称 */}
        <span className="font-medium truncate flex-1 min-w-0" title={displayName}>
          {displayName}
        </span>

        {/* 工作目录（截断显示） */}
        <span
          className="text-muted-foreground truncate max-w-[30%] hidden sm:inline"
          title={session.cwd}
        >
          {shortenPath(session.cwd)}
        </span>

        {/* 操作按钮 */}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-muted-foreground hover:text-foreground transition-colors shrink-0 p-0.5"
          title="查看详情"
          aria-label="查看详情"
        >
          <Eye className="h-3 w-3" />
        </button>
        <button
          type="button"
          onClick={handleCancel}
          className="text-muted-foreground hover:text-destructive transition-colors shrink-0 p-0.5"
          title="取消任务"
          aria-label="取消任务"
          disabled={!isRunning}
        >
          <X className="h-3 w-3" />
        </button>
      </div>

      {/* 展开详情 */}
      <AnimatedCollapsibleContent isOpen={expanded}>
        <div className="px-6 py-1.5 text-[11px] text-muted-foreground space-y-0.5">
          <div>
            <span className="text-foreground/60">ID:</span> {session.id}
          </div>
          <div>
            <span className="text-foreground/60">PID:</span> {session.pid}
          </div>
          {session.model && (
            <div>
              <span className="text-foreground/60">Model:</span> {session.model}
            </div>
          )}
          <div>
            <span className="text-foreground/60">CWD:</span>{' '}
            <span className="break-all">{session.cwd}</span>
          </div>
          {session.sessionId && (
            <div>
              <span className="text-foreground/60">Session:</span> {session.sessionId}
            </div>
          )}
          {session.sessionFile && (
            <div>
              <span className="text-foreground/60">File:</span>{' '}
              <span className="break-all">{session.sessionFile}</span>
            </div>
          )}
          <div>
            <span className="text-foreground/60">Started:</span>{' '}
            {formatTime(session.startedAt)}
          </div>
          <div>
            <span className="text-foreground/60">Updated:</span>{' '}
            {formatTime(session.updatedAt)}
          </div>
          {session.reason && (
            <div>
              <span className="text-foreground/60">Reason:</span> {session.reason}
            </div>
          )}
        </div>
      </AnimatedCollapsibleContent>
    </div>
  )
}

export interface SubagentPanelProps {
  /** 当前 craft 会话 ID（用于 extension_command_invoke 的 sessionId 参数） */
  sessionId?: string
  /** 额外类名 */
  className?: string
}

/**
 * SubagentPanel —— subagent 活动会话面板。
 *
 * 读取 ~/.pi/agent/extensions/subagent/supervisor/active-sessions.json，
 * 显示所有向 subagent supervisor 注册的 pi agent 进程。
 * 面板可折叠；仅在有活动会话时渲染。
 */
export function SubagentPanel({ sessionId, className }: SubagentPanelProps) {
  const [sessions, setSessions] = React.useState<SubagentActiveSession[]>([])
  const [isLoading, setIsLoading] = React.useState(false)
  const [isOpen, setIsOpen] = React.useState(false)
  const [piExtensionSettings, setPiExtensionSettings] = React.useState<PiExtensionSettings | null>(null)

  React.useEffect(() => {
    let disposed = false
    window.electronAPI?.getPiExtensionSettings?.()
      .then((settings) => {
        if (!disposed) setPiExtensionSettings(settings)
      })
      .catch(() => {
        if (!disposed) setPiExtensionSettings(null)
      })
    return () => {
      disposed = true
    }
  }, [])

  const refresh = React.useCallback(async () => {
    setIsLoading(true)
    try {
      const loaded = await loadActiveSessions(piExtensionSettings)
      // running 会话排在前面，其余按 updatedAt 倒序
      loaded.sort((a, b) => {
        if (a.status === 'running' && b.status !== 'running') return -1
        if (a.status !== 'running' && b.status === 'running') return 1
        return b.updatedAt.localeCompare(a.updatedAt)
      })
      setSessions(loaded)
    } catch {
      setSessions([])
    } finally {
      setIsLoading(false)
    }
  }, [piExtensionSettings])

  // 初次加载 + 每 5 秒轮询刷新
  React.useEffect(() => {
    refresh()
    const timer = setInterval(refresh, REFRESH_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [refresh])

  // 通过 extension_notify 事件触发即时刷新
  // subagent 扩展在会话状态变更时会通过 notify 发送通知，
  // 收到来自 subagent 来源的通知后立即刷新会话列表。
  React.useEffect(() => {
    const w = window as unknown as {
      electronAPI?: {
        onExtensionEvent?: (callback: (event: ExtensionBridgeEvent) => void) => () => void
      }
    }
    const subscribe = w.electronAPI?.onExtensionEvent
    if (typeof subscribe !== 'function') return

    const unsubscribe = subscribe((event: ExtensionBridgeEvent) => {
      if (event.type !== 'extension_notify') return
      const source = event.source ?? ''
      if (source.startsWith('subagent')) {
        refresh()
      }
    })
    return () => {
      if (typeof unsubscribe === 'function') unsubscribe()
    }
  }, [refresh])

  // 无活动会话时不渲染面板
  if (piExtensionSettings?.enabled === false ||
      piExtensionSettings?.subagent.reviewEnabled === false ||
      sessions.length === 0) return null

  const runningCount = sessions.filter((s) => s.status === 'running').length

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className={cn('border-t border-border/60 bg-background/50', className)}>
      {/* 折叠头 */}
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-2 w-full px-3 py-1.5 text-xs font-medium hover:bg-accent/50 transition-colors"
        >
          {isOpen ? (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          )}
          <span className="text-foreground/80">Subagents</span>
          <span className="text-muted-foreground">
            {runningCount > 0 ? `${runningCount} running` : `${sessions.length} idle`}
          </span>
          {isLoading && <Spinner className="text-[10px] text-muted-foreground" />}
          {/* 手动刷新按钮（阻止冒泡避免触发折叠） */}
          <span
            role="button"
            tabIndex={0}
            className="ml-auto text-muted-foreground hover:text-foreground transition-colors p-0.5"
            onClick={(e) => {
              e.stopPropagation()
              refresh()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.stopPropagation()
                refresh()
              }
            }}
            title="刷新"
            aria-label="刷新"
          >
            <RefreshCw className="h-3 w-3" />
          </span>
        </button>
      </CollapsibleTrigger>

      {/* 会话列表 */}
      <CollapsibleContent>
        <AnimatedCollapsibleContent isOpen={isOpen}>
          <div className="max-h-64 overflow-y-auto">
            {sessions.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                sessionId={sessionId}
              />
            ))}
          </div>
        </AnimatedCollapsibleContent>
      </CollapsibleContent>
    </Collapsible>
  )
}
