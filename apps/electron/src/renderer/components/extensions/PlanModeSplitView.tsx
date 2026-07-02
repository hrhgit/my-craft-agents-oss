/**
 * PlanModeSplitView
 *
 * 渲染 plan-mode 扩展的 split 面板布局：左侧主计划、右侧架构收缩审查结果。
 *
 * 数据来源：通过 `extension_widget` 事件驱动更新。
 * plan-mode 扩展（或桥接层）用不同的 widget key 区分两侧内容：
 *   - key="plan-main"    → 左侧主计划文本
 *   - key="plan-review"  → 右侧架构收缩审查结果
 *
 * 当任一 panel 有内容时渲染 split view；两侧都被清除（content=undefined）时移除。
 *
 * 响应式布局：
 *   - 宽屏（md 断点以上）：左右并排显示（flex-row，各占 50%）
 *   - 窄屏（md 断点以下）：上下堆叠（flex-col，主计划在上、审查在下）
 *
 * 说明：
 * - plan-mode 扩展当前版本使用 `pi.registerMessageRenderer("plan-review", ...)`
 *   在 TUI 中渲染 split view（通过 customType="plan-review" 的自定义消息）。
 *   在 craft GUI 环境下，split view 内容通过 widget 事件传递（如 spec 所述：
 *   "split view 内容通过扩展的 widget 或 remote-ui 事件驱动更新"）。
 * - 本组件监听 widget 事件，与 ExtensionWidgetZone 独立（不修改 Task 3 的组件）。
 * - 右侧审查结果中的元信息（verdict/model 等）通过审查文本本身展示，
 *   不依赖额外的 structured payload。
 */

import * as React from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { cn } from '@/lib/utils'
import { Markdown, CollapsibleMarkdownProvider } from '@/components/markdown'
import type { ExtensionBridgeEvent } from '@craft-agent/shared/agent/backend/types'
import type { PiExtensionSettings } from '@craft-agent/shared/config'

// ============================================================================
// 常量
// ============================================================================

/** 主计划内容的 widget key（左侧面板） */
const PLAN_MAIN_WIDGET_KEY = 'plan-main'

/** 架构收缩审查结果的 widget key（右侧面板） */
const PLAN_REVIEW_WIDGET_KEY = 'plan-review'

// ============================================================================
// 类型定义
// ============================================================================

/** 单个面板的内容 */
interface PanelContent {
  /** 文本行数组（widget content） */
  lines: string[]
  /** 扩展来源标识 */
  source?: string
}

// ============================================================================
// 组件
// ============================================================================

export interface PlanModeSplitViewProps {
  className?: string
}

/**
 * 订阅 `extension_widget` 事件，渲染 plan-mode split view。
 *
 * 监听 widget key "plan-main"（主计划）和 "plan-review"（架构收缩审查），
 * 任一有内容时渲染对应面板。两侧均无内容时不渲染。
 *
 * 布局响应式：md 以上并排，以下堆叠。
 */
export function PlanModeSplitView({ className }: PlanModeSplitViewProps) {
  const [mainPlan, setMainPlan] = React.useState<PanelContent | null>(null)
  const [review, setReview] = React.useState<PanelContent | null>(null)
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
    const w = window as unknown as {
      electronAPI?: {
        onExtensionEvent?: (callback: (event: ExtensionBridgeEvent) => void) => () => void
      }
    }

    const subscribe = w.electronAPI?.onExtensionEvent
    if (typeof subscribe !== 'function') return

    const unsubscribe = subscribe((event: ExtensionBridgeEvent) => {
      if (event.type !== 'extension_widget') return

      switch (event.key) {
        case PLAN_MAIN_WIDGET_KEY:
          if (event.content === undefined) {
            setMainPlan(null)
          } else {
            setMainPlan({ lines: event.content, source: event.source })
          }
          break
        case PLAN_REVIEW_WIDGET_KEY:
          if (event.content === undefined) {
            setReview(null)
          } else {
            setReview({ lines: event.content, source: event.source })
          }
          break
      }
    })

    return () => {
      if (typeof unsubscribe === 'function') unsubscribe()
    }
  }, [])

  // 扩展启停已迁移到 pi settings.json，craft 侧仅检查全局开关与 markdown 渲染开关
  if (settings?.enabled === false ||
      settings?.planMode.renderPlanMarkdown === false) {
    return null
  }

  // 两侧都无内容时不渲染
  if (!mainPlan && !review) return null

  const mainText = mainPlan ? mainPlan.lines.join('\n') : ''
  const reviewText = review ? review.lines.join('\n') : ''

  return (
    <div
      className={cn('w-full mx-auto px-3 @xs/panel:px-4', className)}
      data-plan-mode-split-view
    >
      <AnimatePresence initial={false}>
        <motion.div
          layout
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          className="overflow-hidden"
        >
          <div
            className={cn(
              'mb-1 rounded-[10px] border border-border/60 bg-background/80 backdrop-blur shadow-sm',
              // 响应式布局：默认堆叠（flex-col），md 以上并排（flex-row）
              'flex flex-col md:flex-row',
            )}
          >
            {/* 左侧：主计划 */}
            {mainPlan && (
              <SplitPanel
                title="Main plan"
                content={mainText}
                side="left"
              />
            )}

            {/* 分隔线：仅并排时显示 */}
            {mainPlan && review && (
              <div className="hidden md:block w-px bg-border/60 shrink-0" />
            )}

            {/* 右侧：架构收缩审查 */}
            {review && (
              <SplitPanel
                title="Compression review"
                content={reviewText}
                side="right"
              />
            )}
          </div>
        </motion.div>
      </AnimatePresence>
    </div>
  )
}

// ============================================================================
// 子组件：单个 split panel
// ============================================================================

interface SplitPanelProps {
  /** 面板标题 */
  title: string
  /** 面板内容（markdown 文本） */
  content: string
  /** 面板位置（left=主计划，right=审查） */
  side: 'left' | 'right'
}

/**
 * 单个 split 面板：标题 + 可滚动的 markdown 内容。
 * 并排时各占 50%，堆叠时全宽。
 */
function SplitPanel({ title, content, side }: SplitPanelProps) {
  return (
    <div
      className={cn(
        'flex-1 min-w-0',
        // 堆叠时上下加分隔；并排时左右分列
        'md:min-w-0',
        side === 'left' ? 'md:flex-1' : 'md:flex-1',
      )}
      data-plan-split-panel={side}
    >
      {/* 面板标题 */}
      <div className="px-3 py-2 border-b border-border/40">
        <span className="text-[11px] font-sans font-medium text-muted-foreground uppercase tracking-wide">
          {title}
        </span>
      </div>
      {/* 面板内容（限制最大高度，内部滚动） */}
      <div className="px-3 py-2 max-h-[50vh] overflow-y-auto">
        <CollapsibleMarkdownProvider>
          <Markdown
            mode="full"
            className="text-[13px]"
          >
            {content}
          </Markdown>
        </CollapsibleMarkdownProvider>
      </div>
    </div>
  )
}

export default PlanModeSplitView
