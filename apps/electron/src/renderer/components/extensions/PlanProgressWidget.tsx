/**
 * PlanProgressWidget
 *
 * 渲染 plan-mode 扩展的执行进度 widget。
 *
 * 数据来源：plan-mode 扩展在执行阶段调用 `ctx.ui.setWidget("plan-todos", lines)`，
 * 通过桥接层转发为 `extension_widget` 事件（key="plan-todos"）。
 *
 * lines 格式（桥接层已将 pi theme 函数解析为纯文本）：
 *   - 已完成步骤：`☑ step text`（TUI 中带删除线，纯文本中可能保留也可能丢失）
 *   - 未完成步骤：`☐ step text`
 *
 * 本组件解析这些标记，统计已完成/总数，渲染为：
 *   - 进度条（CSS 百分比条）
 *   - "3/8 tasks completed" 文本
 *   - 可选的步骤列表（折叠展示）
 *
 * 挂载位置：ChatDisplay 中 ExtensionWidgetZone 附近（独立于 ExtensionWidgetZone，
 * 不修改 Task 3 的组件）。
 */

import * as React from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ExtensionBridgeEvent } from '@craft-agent/shared/agent/backend/types'
import type { PiExtensionSettings } from '@craft-agent/shared/config'

// ============================================================================
// 常量
// ============================================================================

/** plan-mode 扩展使用的 widget key */
const PLAN_TODOS_WIDGET_KEY = 'plan-todos'

/** 已完成步骤的标记字符 */
const COMPLETED_MARKER = '☑'
/** 未完成步骤的标记字符 */
const PENDING_MARKER = '☐'

// ============================================================================
// 类型定义
// ============================================================================

/** 单个 todo 步骤的解析结果 */
interface ParsedStep {
  /** 步骤文本（已去除标记和前后空格） */
  text: string
  /** 是否已完成 */
  completed: boolean
}

/** 从 widget lines 解析出的进度数据 */
interface PlanProgress {
  /** 已完成步骤数 */
  completed: number
  /** 总步骤数 */
  total: number
  /** 解析出的步骤列表（用于折叠展示） */
  steps: ParsedStep[]
}

// ============================================================================
// 解析逻辑
// ============================================================================

/**
 * 从一行文本中解析出单个步骤。
 * 识别 `☑` 和 `☐` 标记，提取步骤文本。
 */
function parseStepLine(line: string): ParsedStep | null {
  const trimmed = line.trim()
  if (!trimmed) return null

  if (trimmed.startsWith(COMPLETED_MARKER)) {
    return {
      text: trimmed.slice(COMPLETED_MARKER.length).trim(),
      completed: true,
    }
  }
  if (trimmed.startsWith(PENDING_MARKER)) {
    return {
      text: trimmed.slice(PENDING_MARKER.length).trim(),
      completed: false,
    }
  }
  // 不含标记的行不视为步骤
  return null
}

/**
 * 从 widget 的 string[] lines 解析出进度数据。
 */
function parseProgress(lines: string[] | undefined): PlanProgress | null {
  if (!lines || lines.length === 0) return null

  const steps: ParsedStep[] = []
  for (const line of lines) {
    const step = parseStepLine(line)
    if (step) steps.push(step)
  }

  if (steps.length === 0) return null

  const completed = steps.filter((s) => s.completed).length
  return {
    completed,
    total: steps.length,
    steps,
  }
}

// ============================================================================
// 组件
// ============================================================================

export interface PlanProgressWidgetProps {
  className?: string
}

/**
 * 订阅 `extension_widget` 事件，渲染 plan-mode 执行进度。
 *
 * 当收到 key="plan-todos" 的 widget 事件时，解析 lines 中的 `☑`/`☐` 标记，
 * 渲染进度条和步骤列表。widget 被清除（content === undefined）时移除。
 */
export function PlanProgressWidget({ className }: PlanProgressWidgetProps) {
  const [progress, setProgress] = React.useState<PlanProgress | null>(null)
  const [showSteps, setShowSteps] = React.useState(false)
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
      if (event.key !== PLAN_TODOS_WIDGET_KEY) return

      if (event.content === undefined) {
        // 扩展主动清除 widget（执行结束 / 退出 plan mode）
        setProgress(null)
        setShowSteps(false)
        return
      }

      const parsed = parseProgress(event.content)
      setProgress(parsed)
      // 当进度更新时自动展开步骤列表（让用户看到实时进度）
      if (parsed && parsed.completed < parsed.total) {
        // 保持当前展开状态
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

  if (!progress) return null

  const percentage = progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0
  const isComplete = progress.completed === progress.total

  return (
    <div
      className={cn('w-full mx-auto px-3 @xs/panel:px-4', className)}
      data-plan-progress-widget
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
              'mb-1 rounded-[10px] border border-border/60 bg-background/80 backdrop-blur',
              'px-3 py-2 text-[13px] shadow-sm',
            )}
          >
            {/* 标题行 + 进度数字 */}
            <button
              type="button"
              onClick={() => setShowSteps((v) => !v)}
              className="flex w-full items-center gap-2 text-left"
            >
              <span className="text-muted-foreground shrink-0">
                {showSteps ? (
                  <ChevronDown className="h-3.5 w-3.5" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" />
                )}
              </span>
              <span className="text-[11px] font-sans font-medium text-muted-foreground uppercase tracking-wide">
                plan-mode
              </span>
              <span className="ml-auto text-xs tabular-nums text-foreground/80 font-medium">
                {progress.completed}/{progress.total}
                <span className="text-muted-foreground ml-1">({percentage}%)</span>
              </span>
            </button>

            {/* 进度条 */}
            <div
              className="mt-2 h-1.5 w-full rounded-full bg-foreground/10 overflow-hidden"
              role="progressbar"
              aria-valuenow={percentage}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <motion.div
                className={cn(
                  'h-full rounded-full transition-colors',
                  isComplete
                    ? 'bg-success'
                    : 'bg-foreground/70',
                )}
                initial={{ width: 0 }}
                animate={{ width: `${percentage}%` }}
                transition={{ duration: 0.3, ease: 'easeOut' }}
              />
            </div>

            {/* 完成提示 */}
            {isComplete && (
              <div className="mt-1.5 text-xs text-success font-medium">
                All steps completed
              </div>
            )}

            {/* 步骤列表（折叠） */}
            <AnimatePresence initial={false}>
              {showSteps && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.15, ease: 'easeOut' }}
                  className="overflow-hidden"
                >
                  <ul className="mt-2 space-y-0.5 font-mono text-[12px]">
                    {progress.steps.map((step, idx) => (
                      <li
                        key={idx}
                        className={cn(
                          'flex items-start gap-1.5 leading-snug',
                          step.completed && 'text-muted-foreground line-through',
                        )}
                      >
                        <span className="shrink-0">
                          {step.completed ? COMPLETED_MARKER : PENDING_MARKER}
                        </span>
                        <span className="break-words">{step.text}</span>
                      </li>
                    ))}
                  </ul>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </motion.div>
      </AnimatePresence>
    </div>
  )
}

export default PlanProgressWidget
