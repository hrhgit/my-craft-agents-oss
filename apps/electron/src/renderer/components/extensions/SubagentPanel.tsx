/**
 * SubagentPanel
 *
 * 显示 pi 会话树中从当前会话派生的子会话分支列表。
 *
 * 数据来源：pi 会话树（~/.pi/agent/sessions/<encoded-cwd>/*.jsonl）
 * 通过 Pi runtime 的 listChildSessions RPC 查询，由 list_child_sessions
 * 通道枚举会话目录并按 header.spawnedFrom === parentSessionId 过滤。
 *
 * 这取代了旧的 active-sessions.json 数据源（subagent supervisor 维护）。
 * spawn_session 工具现在通过 pi 的 spawnChildSession 在会话树中创建子分支，
 * 此面板复用展示这些分支。
 *
 * 刷新策略：
 * - 每 5 秒轮询刷新一次
 * - 通过 extension_notify 事件触发即时刷新
 *
 * 面板可折叠，默认收起以节省空间；仅当存在子会话时才显示。
 * 每个分支条目提供"在独立窗口打开"按钮（desktop 专属，CLI 不支持）。
 */

import * as React from 'react'
import { ChevronDown, ChevronRight, Eye, RefreshCw, GitBranch, ExternalLink, MessageSquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import { navigate, routes } from '@/lib/navigate'
import { Spinner } from '@craft-agent/ui'
import { Collapsible, CollapsibleContent, CollapsibleTrigger, AnimatedCollapsibleContent } from '@/components/ui/collapsible'
import type { ExtensionBridgeEvent } from '@craft-agent/shared/agent/backend/types'
import type { PiChildSessionInfo } from '@craft-agent/shared/agent'
import { createSingleFlightLoader, isSubagentRefreshEvent } from './subagent-session-loader'

/** 轮询间隔：每 5 秒刷新一次子会话列表 */
const REFRESH_INTERVAL_MS = 5000

const childSessionLoader = createSingleFlightLoader<PiChildSessionInfo[]>(
  async (sessionId) => window.electronAPI?.listChildSessions?.(sessionId) ?? [],
  { cacheTtlMs: REFRESH_INTERVAL_MS },
)

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
  session: PiChildSessionInfo
}

/**
 * 单个子会话分支条目。
 * - 名称（name 或 sessionId）
 * - 工作目录
 * - "查看"按钮：展开详情（sessionPath、cwd、创建/修改时间、消息数、spawnConfig）
 * - "在独立窗口打开"按钮：desktop 专属，通过 openChildSessionWindow IPC
 *   在新 BrowserWindow 中打开该子会话的 ChatPage
 *
 * 注意：pi 会话树不提供 running/idle 实时状态（不同于旧 supervisor 的 active-sessions.json），
 * 因此不再显示状态徽章和取消按钮。
 */
function SessionRow({ session }: SessionRowProps) {
  const [expanded, setExpanded] = React.useState(false)

  const displayName = session.name || session.sessionId
  const model = session.spawnConfig?.model
  const connection = session.spawnConfig?.connection

  // "在独立窗口打开"仅在 desktop 环境可用（CLI / 非 electron 环境无 electronAPI）
  const canOpenInWindow = typeof window !== 'undefined'
    && typeof (window as unknown as { electronAPI?: { openChildSessionWindow?: unknown } }).electronAPI?.openChildSessionWindow === 'function'

  const handleOpenInWindow = React.useCallback(() => {
    void window.electronAPI?.openChildSessionWindow?.(session.sessionId, { title: displayName })
  }, [session.sessionId, displayName])

  const handleOpenInCurrentPanel = React.useCallback(() => {
    navigate(routes.view.allSessions(session.sessionId))
  }, [session.sessionId])

  return (
    <div className="border-b border-border/40 last:border-b-0">
      {/* 主行：分支图标 + 名称 + 工作目录 + 操作按钮 */}
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

        {/* 分支徽章 */}
        <span
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 bg-muted text-muted-foreground"
        >
          <GitBranch className="h-2.5 w-2.5" />
          branch
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

        {/* 在当前面板打开 */}
        <button
          type="button"
          onClick={handleOpenInCurrentPanel}
          className="text-muted-foreground hover:text-foreground transition-colors shrink-0 p-0.5"
          title="在当前窗口打开"
          aria-label="在当前窗口打开"
        >
          <MessageSquare className="h-3 w-3" />
        </button>

        {/* 在独立窗口打开（desktop 专属） */}
        {canOpenInWindow && (
          <button
            type="button"
            onClick={handleOpenInWindow}
            className="text-muted-foreground hover:text-foreground transition-colors shrink-0 p-0.5"
            title="在独立窗口打开"
            aria-label="在独立窗口打开"
          >
            <ExternalLink className="h-3 w-3" />
          </button>
        )}

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
      </div>

      {/* 展开详情 */}
      <AnimatedCollapsibleContent isOpen={expanded}>
        <div className="px-6 py-1.5 text-[11px] text-muted-foreground space-y-0.5">
          <div>
            <span className="text-foreground/60">Session ID:</span> {session.sessionId}
          </div>
          {model && (
            <div>
              <span className="text-foreground/60">Model:</span> {model}
            </div>
          )}
          {connection && (
            <div>
              <span className="text-foreground/60">Connection:</span> {connection}
            </div>
          )}
          <div>
            <span className="text-foreground/60">CWD:</span>{' '}
            <span className="break-all">{session.cwd}</span>
          </div>
          <div>
            <span className="text-foreground/60">Messages:</span> {session.messageCount}
          </div>
          {session.firstMessage && (
            <div className="truncate" title={session.firstMessage}>
              <span className="text-foreground/60">First:</span> {session.firstMessage}
            </div>
          )}
          <div>
            <span className="text-foreground/60">File:</span>{' '}
            <span className="break-all">{session.sessionPath}</span>
          </div>
          <div>
            <span className="text-foreground/60">Created:</span>{' '}
            {formatTime(session.created)}
          </div>
          <div>
            <span className="text-foreground/60">Modified:</span>{' '}
            {formatTime(session.modified)}
          </div>
        </div>
      </AnimatedCollapsibleContent>
    </div>
  )
}

export interface SubagentPanelProps {
  /** 当前 craft 会话 ID（用于查询 pi 会话树的子分支） */
  sessionId?: string
  /** 额外类名 */
  className?: string
}

/**
 * SubagentPanel —— pi 会话树子分支面板。
 *
 * 通过 listChildSessions RPC 查询当前会话在 pi 会话树中派生的子分支
 * （header.spawnedFrom === 当前会话的 pi session ID）。
 * 面板可折叠；仅在有子分支时渲染。
 */
export function SubagentPanel({ sessionId, className }: SubagentPanelProps) {
  const [sessions, setSessions] = React.useState<PiChildSessionInfo[]>([])
  const [isLoading, setIsLoading] = React.useState(false)
  const [isOpen, setIsOpen] = React.useState(false)
  const mountedRef = React.useRef(false)
  const sessionIdRef = React.useRef(sessionId)
  const requestVersionRef = React.useRef(0)
  sessionIdRef.current = sessionId

  React.useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      requestVersionRef.current += 1
    }
  }, [])

  const refresh = React.useCallback(async (options?: { force?: boolean }) => {
    const requestVersion = ++requestVersionRef.current
    const requestedSessionId = sessionId

    if (!mountedRef.current || sessionIdRef.current !== requestedSessionId) return
    if (!sessionId) {
      setSessions([])
      setIsLoading(false)
      return
    }
    setIsLoading(true)
    try {
      const loaded = await childSessionLoader.load(sessionId, options)
      if (
        !mountedRef.current
        || sessionIdRef.current !== requestedSessionId
        || requestVersionRef.current !== requestVersion
      ) return

      // 按 modified 时间倒序（最近的分支在前）
      const sorted = [...loaded].sort((a, b) => b.modified.localeCompare(a.modified))
      setSessions(sorted)
    } catch {
      if (
        !mountedRef.current
        || sessionIdRef.current !== requestedSessionId
        || requestVersionRef.current !== requestVersion
      ) return
      setSessions([])
    } finally {
      if (
        mountedRef.current
        && sessionIdRef.current === requestedSessionId
        && requestVersionRef.current === requestVersion
      ) {
        setIsLoading(false)
      }
    }
  }, [sessionId])

  // 初次加载 + 每 5 秒轮询刷新
  React.useEffect(() => {
    void refresh()
    const timer = setInterval(() => { void refresh() }, REFRESH_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [refresh])

  // 通过 extension_notify 事件触发即时刷新
  // subagent 扩展在会话状态变更时会通过 notify 发送通知，
  // 收到通知后立即刷新子分支列表。
  React.useEffect(() => {
    const w = window as unknown as {
      electronAPI?: {
        onExtensionEvent?: (callback: (event: ExtensionBridgeEvent) => void) => () => void
      }
    }
    const subscribe = w.electronAPI?.onExtensionEvent
    if (typeof subscribe !== 'function') return

    const unsubscribe = subscribe((event: ExtensionBridgeEvent) => {
      if (!isSubagentRefreshEvent(event, sessionId)) return
      void refresh({ force: true })
    })
    return () => {
      if (typeof unsubscribe === 'function') unsubscribe()
    }
  }, [refresh, sessionId])

  // 无子分支时不渲染面板
  if (sessions.length === 0) return null

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
            {sessions.length} {sessions.length === 1 ? 'branch' : 'branches'}
          </span>
          {isLoading && <Spinner className="text-[10px] text-muted-foreground" />}
          {/* 手动刷新按钮（阻止冒泡避免触发折叠） */}
          <span
            role="button"
            tabIndex={0}
            className="ml-auto text-muted-foreground hover:text-foreground transition-colors p-0.5"
            onClick={(e) => {
              e.stopPropagation()
              void refresh({ force: true })
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.stopPropagation()
                void refresh({ force: true })
              }
            }}
            title="刷新"
            aria-label="刷新"
          >
            <RefreshCw className="h-3 w-3" />
          </span>
        </button>
      </CollapsibleTrigger>

      {/* 子分支列表 */}
      <CollapsibleContent>
        <AnimatedCollapsibleContent isOpen={isOpen}>
          <div className="max-h-64 overflow-y-auto">
            {sessions.map((session) => (
              <SessionRow
                key={session.sessionId}
                session={session}
              />
            ))}
          </div>
        </AnimatedCollapsibleContent>
      </CollapsibleContent>
    </Collapsible>
  )
}
