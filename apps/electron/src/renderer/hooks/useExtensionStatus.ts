/**
 * useExtensionStatus Hook
 *
 * 监听 pi 扩展通过桥接层转发到 renderer 的 `extension_notify` 事件，
 * 复用 craft 现有的 sonner toast 系统向用户显示真正的用户通知。
 * `extension_status` 是运行态更新，不在这里 toast。
 *
 * 事件流：
 *   pi 扩展 ctx.ui.notify(message, level)
 *     Pi RpcClient extension_ui_request(notify)
 *     PiAgent.mapExtensionUiRequest   onExtensionEvent
 *     pi-extension-bridge 桥接层   eventSink
 *     RPC_CHANNELS.extensions.EVENT   renderer 的 onExtensionEvent 监听器
 *     此 hook 调用 toast 显示通知
 *
 * 说明：
 * - widget 渲染由 ExtensionWidgetZone 组件通过 `extension_widget` 事件渲染，
 *   本 hook 不重复实现。
 * - 本 hook 只负责 `extension_notify` 事件的提示；`extension_status`
 *   留给状态承载点或静默消费。
 * - `onExtensionEvent` 监听器在 channel-map 中注册；
 *   在其就绪前本 hook 优雅降级（不订阅、不报错）。
 */

import { useEffect } from 'react'
import { toast } from 'sonner'
import type { ExtensionBridgeEvent } from '@craft-agent/shared/agent/backend/types'

/**
 * notificationType   sonner toast 方法映射。
 * 缺省（undefined）按 info 处理。
 */
function showToast(message: string, level: 'info' | 'warning' | 'error' | undefined): void {
  switch (level) {
    case 'error':
      toast.error(message)
      break
    case 'warning':
      toast.warning(message)
      break
    case 'info':
    default:
      toast.info(message)
      break
  }
}

/**
 * 监听所有 pi 扩展的 extension_notify 事件并显示 toast。
 *
 * 该 hook 无返回值——它仅产生副作用（toast）。
 * 在 `onExtensionEvent` 监听器未就绪时（桥接层尚未在 channel-map 注册），
 * hook 静默跳过订阅，不会抛错。
 */
export function useExtensionStatus(sessionId: string): void {
  useEffect(() => {
    const w = window as unknown as {
      electronAPI?: {
        onExtensionEvent?: (callback: (event: ExtensionBridgeEvent) => void) => () => void
      }
    }

    const subscribe = w.electronAPI?.onExtensionEvent
    if (typeof subscribe !== 'function') {
      // 桥接层监听器尚未注册——静默降级。
      return
    }

    const unsubscribe = subscribe((event: ExtensionBridgeEvent) => {
      if (event.sessionId !== sessionId) return
      if (event.type === 'extension_notify') {
        showToast(event.message, event.notificationType)
        return
      }
      if (event.type === 'extension_set_title') {
        document.title = event.title
        return
      }
      if (event.type === 'extension_set_editor_text') {
        window.dispatchEvent(new CustomEvent('craft:restore-input', {
          detail: { sessionId, text: event.text },
        }))
      }
    })

    return () => {
      if (typeof unsubscribe === 'function') unsubscribe()
    }
  }, [sessionId])
}
