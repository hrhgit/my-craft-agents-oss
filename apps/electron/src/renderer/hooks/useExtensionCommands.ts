/**
 * useExtensionCommands Hook
 *
 * 监听 pi 扩展通过桥接层转发到 renderer 的 `extension_command_registered` 事件，
 * 维护当前已注册的扩展命令列表，并提供 `triggerCommand` 用于触发执行。
 *
 * 事件流：
 *   pi 扩展 ctx.registerCommand(name, handler, opts)
 *   → Pi RpcClient command listing
 *   → pi-extension-bridge 桥接层 → eventSink
 *   → RPC_CHANNELS.extensions.EVENT → renderer 的 onExtensionEvent 监听器
 *   → 此 hook 累积命令到 state，供命令面板（slash menu）注入展示
 *
 * 触发执行：
 *   用户在 slash menu 选中扩展命令 → triggerCommand(name, args)
 *   → window.electronAPI.invokeExtensionCommand(sessionId, name, args)
 *   → 主进程通过 Pi RpcClient 触发命令
 *
 * 说明：
 * - `onExtensionEvent` 监听器已在 ElectronAPI + CHANNEL_MAP 注册（Task 3 共用）。
 * - `invokeExtensionCommand` ElectronAPI 方法已接入 COMMAND_INVOKE 通道；
 *   此 hook 仍用可选链以兼容旧服务端或 web 适配器。
 */

import * as React from 'react'
import type { ExtensionBridgeEvent, PiExtensionCommand } from '@craft-agent/shared/agent/backend/types'
import type { ExtensionCommandResult } from '@craft-agent/core/types'

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
  /** 按需刷新当前会话的扩展命令快照 */
  refreshCommands: () => void
  /**
   * 触发执行扩展命令。返回 true 表示已成功派发到主进程，
   * false 表示 ElectronAPI 方法未就绪或派发失败。
   */
  triggerCommand: (name: string, args?: Record<string, unknown>) => Promise<ExtensionCommandResult>
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
  const loadedSessionRef = React.useRef<string | undefined>(undefined)
  const inFlightSessionRef = React.useRef<string | undefined>(undefined)

  const upsertCommand = React.useCallback((command: ExtensionCommand) => {
    setCommands(prev => {
      // 同名命令（按 name 去重）：后注册/后查询的覆盖先前版本
      const filtered = prev.filter(c => c.name !== command.name)
      return [...filtered, command]
    })
  }, [])

  React.useEffect(() => {
    setCommands([])
    loadedSessionRef.current = undefined
    inFlightSessionRef.current = undefined
  }, [sessionId])

  const refreshCommands = React.useCallback(() => {
    if (!sessionId) return
    if (loadedSessionRef.current === sessionId || inFlightSessionRef.current === sessionId) return

    const w = window as unknown as {
      electronAPI?: {
        getExtensionCommands?: (sessionId: string) => Promise<PiExtensionCommand[]>
      }
    }

    const getCommands = w.electronAPI?.getExtensionCommands
    if (typeof getCommands !== 'function') return

    inFlightSessionRef.current = sessionId
    void getCommands(sessionId).then(snapshot => {
      if (inFlightSessionRef.current !== sessionId || !Array.isArray(snapshot)) return
      setCommands(snapshot.map(cmd => ({
        name: cmd.name,
        description: cmd.description,
        source: cmd.source,
      })))
      loadedSessionRef.current = sessionId
    }).catch(() => {
      // Older servers may not expose the snapshot channel; event subscription
      // below remains as the compatibility path.
    }).finally(() => {
      if (inFlightSessionRef.current === sessionId) {
        inFlightSessionRef.current = undefined
      }
    })
  }, [sessionId])

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
      upsertCommand({
        name: event.name,
        description: event.description,
        source: event.source,
      })
      loadedSessionRef.current = sessionId
    })

    return () => {
      if (typeof unsubscribe === 'function') unsubscribe()
    }
  }, [sessionId, upsertCommand])

  /**
   * 触发执行扩展命令。
   *
   * 当前沿用类型断言 + 可选链模式，旧服务端未提供该通道时返回 false。
   */
  const triggerCommand = React.useCallback(async (name: string, args?: Record<string, unknown>): Promise<ExtensionCommandResult> => {
    const w = window as unknown as {
      electronAPI?: {
        invokeExtensionCommand?: (
          sessionId: string,
          commandName: string,
          args?: Record<string, unknown>,
        ) => Promise<ExtensionCommandResult>
      }
    }

    const invoke = w.electronAPI?.invokeExtensionCommand
    if (typeof invoke !== 'function') {
      return { invoked: false, error: 'Extension command API is unavailable.' }
    }

    try {
      return await invoke(sessionId ?? '', name, args)
    } catch (error) {
      return { invoked: false, error: error instanceof Error ? error.message : String(error) }
    }
  }, [sessionId])

  return { commands, refreshCommands, triggerCommand }
}
