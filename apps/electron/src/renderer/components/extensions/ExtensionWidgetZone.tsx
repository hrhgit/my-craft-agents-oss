/**
 * ExtensionWidgetZone
 *
 * 渲染 pi 扩展通过桥接层转发到 renderer 的 `extension_widget` 事件。
 *
 * 事件流：
 *   pi 扩展 ctx.ui.setWidget(key, renderFn)
 *   → pi-agent-server 子进程 JSONL extension_widget
 *   → pi-extension-bridge 桥接层调用 renderFn(theme) 解析为 string[]
 *   → eventSink(RPC_CHANNELS.extensions.EVENT, target, event)
 *   → renderer 的 onExtensionEvent 监听器
 *   → 本组件按 key 维护 widget 集合，按 placement 渲染文本行数组
 *
 * 渲染规则：
 * - content === undefined：移除该 key 对应的 widget
 * - placement 默认 'belowEditor'，本组件渲染 belowEditor 区（编辑器下方、输入框上方）
 * - aboveEditor 暂未启用（预留位），目前统一回落到 belowEditor
 *
 * [SubTask 3.2] 渲染函数处理说明：
 * - pi 扩展传入的 renderFn(width, theme) => string[] 由 pi-agent-server 子进程
 *   的 createBridgeUIContext().setWidget() 在子进程内调用并解析为纯 string[] 后
 *   通过 JSONL extension_widget 消息转发。
 * - 本组件只负责渲染收到的 string[]，不感知 pi theme 对象（fg/bold 等降级映射
 *   由子进程桥接层完成）。这是为了让 renderer 保持与 pi 内部实现解耦。
 */

import * as React from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { cn } from '@/lib/utils'
import type { ExtensionBridgeEvent } from '@craft-agent/shared/agent/backend/types'
import type { PiExtensionSettings } from '@craft-agent/shared/config'

// ============================================================================
// 类型定义
// ============================================================================

const BACKGROUND_AGENT_WIDGET_KEYS = new Set(['trace-audit', 'yourself', 'repo-memory'])
const PROMPT_AUTOMATION_WIDGET_KEY = 'schedule-prompts'
const PLAN_SPECIAL_WIDGET_KEYS = new Set(['plan-main', 'plan-review', 'plan-todos'])

/** 单个 widget 的渲染态：扩展通过 extension_widget 事件上报的内容 */
interface ExtensionWidgetEntry {
  /** widget 唯一 key（由扩展指定，如 'plan-progress'、'repo-memory'） */
  key: string
  /** 文本行数组；undefined 表示移除该 widget */
  content: string[]
  /** 渲染位置；默认 'belowEditor'，本组件渲染 belowEditor 区 */
  placement: 'aboveEditor' | 'belowEditor'
  /** 扩展来源标识（如 'plan-mode'、'yourself'），用于显示徽章 */
  source?: string
}

// ============================================================================
// 状态更新：根据 ExtensionBridgeEvent 增删 widget
// ============================================================================

/**
 * 将一个 extension_widget 事件合并进现有 widget map。
 * - content === undefined：删除该 key
 * - 其他情况：upsert（按 key 覆盖）
 */
function applyWidgetEvent(
  prev: Map<string, ExtensionWidgetEntry>,
  event: Extract<ExtensionBridgeEvent, { type: 'extension_widget' }>,
): Map<string, ExtensionWidgetEntry> {
  const next = new Map(prev)
  if (event.content === undefined) {
    // 扩展主动清除 widget
    next.delete(event.key)
  } else {
    next.set(event.key, {
      key: event.key,
      content: event.content,
      placement: event.placement ?? 'belowEditor',
      source: event.source,
    })
  }
  return next
}

// ============================================================================
// 组件
// ============================================================================

export interface ExtensionWidgetZoneProps {
  className?: string
}

/**
 * 订阅 `extensions:event` IPC 频道，渲染所有 belowEditor 区的 extension_widget。
 *
 * 监听器 `onExtensionEvent` 已在 channel-map 中注册（与 useExtensionStatus 共用）；
 * 此处再次订阅同一频道——buildClientApi 的 listener 实现支持多订阅者。
 */
export function ExtensionWidgetZone({ className }: ExtensionWidgetZoneProps) {
  const [widgets, setWidgets] = React.useState<Map<string, ExtensionWidgetEntry>>(() => new Map())
  const [settings, setSettings] = React.useState<PiExtensionSettings | null>(null)

  React.useEffect(() => {
    let disposed = false
    window.electronAPI?.getPiExtensionSettings?.()
      .then((next) => {
        if (!disposed) setSettings(next)
      })
      .catch(() => {
        if (!disposed) setSettings(null)
      })
    return () => {
      disposed = true
    }
  }, [])

  React.useEffect(() => {
    // onExtensionEvent 已在 ElectronAPI + CHANNEL_MAP 注册，
    // 但沿用 useExtensionStatus / FreeFormInput 的可选链模式，
    // 保证桥接层未就绪时不报错。
    const w = window as unknown as {
      electronAPI?: {
        onExtensionEvent?: (callback: (event: ExtensionBridgeEvent) => void) => () => void
      }
    }

    const subscribe = w.electronAPI?.onExtensionEvent
    if (typeof subscribe !== 'function') {
      return
    }

    const unsubscribe = subscribe((event: ExtensionBridgeEvent) => {
      if (event.type !== 'extension_widget') return
      if (BACKGROUND_AGENT_WIDGET_KEYS.has(event.key)) return
      setWidgets(prev => applyWidgetEvent(prev, event))
    })

    return () => {
      if (typeof unsubscribe === 'function') unsubscribe()
    }
  }, [])

  // 仅渲染 belowEditor 区；aboveEditor 预留（暂未挂载对应位置）
  const belowWidgets = React.useMemo(() => {
    return Array.from(widgets.values()).filter(w => {
      if (w.placement !== 'belowEditor') return false
      if (w.key === PROMPT_AUTOMATION_WIDGET_KEY) {
        // 扩展启停已迁移到 pi settings.json，craft 侧仅检查全局开关与 widget 可见性
        return settings?.enabled !== false &&
          settings?.promptAutomation.widgetVisible !== false
      }
      if (PLAN_SPECIAL_WIDGET_KEYS.has(w.key)) {
        return settings?.planMode.renderPlanMarkdown === false
      }
      return true
    })
  }, [settings, widgets])

  if (belowWidgets.length === 0) return null

  return (
    <div
      className={cn(
        'w-full mx-auto px-3 @xs/panel:px-4',
        className,
      )}
      data-extension-widget-zone="below"
    >
      <AnimatePresence initial={false}>
        {belowWidgets.map(widget => (
          <motion.div
            key={widget.key}
            layout
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            <WidgetCard widget={widget} />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}

// ============================================================================
// 单个 widget 卡片
// ============================================================================

function WidgetCard({ widget }: { widget: ExtensionWidgetEntry }) {
  return (
    <div
      className={cn(
        'mb-1 rounded-[10px] border border-border/60 bg-background/80 backdrop-blur',
        'px-3 py-2 text-[13px] text-foreground/90 shadow-sm',
        'font-mono whitespace-pre-wrap break-words',
      )}
      data-extension-widget-key={widget.key}
    >
      {widget.source && (
        <div className="mb-1 text-[11px] font-sans font-medium text-muted-foreground uppercase tracking-wide">
          {widget.source}
        </div>
      )}
      <div className="space-y-0.5">
        {widget.content.map((line, idx) => (
          <div key={idx} className="leading-snug">
            {line}
          </div>
        ))}
      </div>
    </div>
  )
}

export default ExtensionWidgetZone
