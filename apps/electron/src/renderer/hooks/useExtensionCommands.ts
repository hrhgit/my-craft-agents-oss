/**
 * useExtensionCommands Hook
 *
 * 监听 pi 扩展通过桥接层转发到 renderer 的 `extension_command_registered` 事件，
 * 维护当前已注册的扩展命令列表，并提供 `triggerCommand` 用于触发执行。
 *
 * 事件流：
 *   pi 扩展 ctx.registerCommand(name, handler, opts)
 *   → pi-agent-server 子进程 JSONL extension_command_registered
 *   → pi-extension-bridge 桥接层 → eventSink
 *   → RPC_CHANNELS.extensions.EVENT → renderer 的 onExtensionEvent 监听器
 *   → 此 hook 累积命令到 state，供命令面板（slash menu）注入展示
 *
 * 触发执行：
 *   用户在 slash menu 选中扩展命令 → triggerCommand(name, args)
 *   → window.electronAPI.invokeExtensionCommand(sessionId, name, args)
 *   → 主进程通过 extension_command_invoke 向子进程转发
 *
 * 说明：
 * - `onExtensionEvent` 监听器已在 ElectronAPI + CHANNEL_MAP 注册（Task 3 共用）。
 * - `invokeExtensionCommand` ElectronAPI 方法已接入 COMMAND_INVOKE 通道；
 *   此 hook 仍用可选链以兼容旧服务端或 web 适配器。
 */

import * as React from 'react'
import type { ExtensionBridgeEvent } from '@craft-agent/shared/agent/backend/types'

// ============================================================================
// 类型定义
// ============================================================================

/** 已注册的扩展命令（来自 extension_command_registered 事件） */
export interface ExtensionCommand {
  /** 命令名（如 'plan-finalize'、'discuss'） */
  name: string
  /** 命令描述（可选，扩展提供） */
  description?: string
  /** 扩展来源标识（如 'plan-mode'） */
  source: string
}

export interface UseExtensionCommandsReturn {
  /** 当前已注册的扩展命令列表 */
  commands: ExtensionCommand[]
  /**
   * 触发执行扩展命令。返回 true 表示已成功派发到主进程，
   * false 表示 ElectronAPI 方法未就绪或派发失败。
   */
  triggerCommand: (name: string, args?: Record<string, unknown>) => boolean
}

// ============================================================================
// Hook
// ============================================================================

/**
 * 订阅 `extensions:event` 频道，累积 extension_command_registered 事件，
 * 并提供触发执行入口。
 *
 * 与 useExtensionStatus / ExtensionWidgetZone 共用同一 onExtensionEvent 监听器；
 * buildClientApi 的 listener 实现支持多订阅者。
 */
export function useExtensionCommands(sessionId: string | undefined): UseExtensionCommandsReturn {
  const [commands, setCommands] = React.useState<ExtensionCommand[]>([])

  React.useEffect(() => {
    // onExtensionEvent 已在 channel-map 注册；可选链降级保持向后兼容。
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
      if (event.type !== 'extension_command_registered') return
      setCommands(prev => {
        // 同名命令（按 name 去重）：后注册的覆盖先注册的
        const filtered = prev.filter(c => c.name !== event.name)
        return [...filtered, {
          name: event.name,
          description: event.description,
          source: event.source,
        }]
      })
    })

    return () => {
      if (typeof unsubscribe === 'function') unsubscribe()
    }
  }, [])

  /**
   * 触发执行扩展命令。
   *
   * 当前沿用类型断言 + 可选链模式，旧服务端未提供该通道时返回 false。
   */
  const triggerCommand = React.useCallback((name: string, args?: Record<string, unknown>): boolean => {
    const w = window as unknown as {
      electronAPI?: {
        invokeExtensionCommand?: (
          sessionId: string,
          commandName: string,
          args?: Record<string, unknown>,
        ) => Promise<boolean> | boolean
      }
    }

    const invoke = w.electronAPI?.invokeExtensionCommand
    if (typeof invoke !== 'function') {
      return false
    }

    try {
      const ret = invoke(sessionId ?? '', name, args)
      // 兼容 Promise 与同步返回
      if (ret && typeof (ret as Promise<boolean>).then === 'function') {
        // 异步路径：fire-and-forget；调用方已通过返回 true 得知派发成功
        return true
      }
      return Boolean(ret)
    } catch {
      return false
    }
  }, [sessionId])

  return { commands, triggerCommand }
}
