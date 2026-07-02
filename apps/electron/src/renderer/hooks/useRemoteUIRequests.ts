/**
 * useRemoteUIRequests — 订阅 pi 扩展的 remoteui:request 事件并管理活跃请求状态。
 *
 * 事件流：
 *   pi 扩展 → pi.events.emit("remoteui:request") → pi-agent-server 子进程
 *   → JSONL remoteui_request → PiAgent.handleLine → onExtensionEvent 回调
 *   → extensions:EVENT 频道广播 → 此 hook 接收
 *
 * 回传路径：
 *   respond() → window.electronAPI.sendRemoteUIResponse(sessionId, requestId, payload, reason)
 *   → RPC extensions:remoteuiResponse → SessionManager.sendRemoteUIResponse
 *   → PiAgent.sendRemoteUIResponse → 子进程 remoteui_response → pi.events.emit("remoteui:response")
 *
 * 只允许一个 modal 同时显示：新请求到达时若已有活跃请求，则入队等待，
 * 当前请求被响应（确认/取消）后自动出队下一个。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type {
  RemoteUIRequest,
  RemoteUIResult,
  RemoteUICancelReason,
} from '../components/extensions/RemoteUIModal'

export interface UseRemoteUIRequestsResult {
  /** 当前需要展示的 remoteui:request（无则为 null） */
  currentRequest: RemoteUIRequest | null
  /** 用户确认/取消时调用：payload 为结果或 null + reason */
  respond: (payload: RemoteUIResult | null, reason?: RemoteUICancelReason) => void
}

/**
 * 将 extensions:EVENT 广播的 ExtensionBridgeEvent 规约为 RemoteUIRequest。
 * 仅处理 type === 'remoteui_request' 的事件，其余返回 null。
 */
function asRemoteUIRequest(event: unknown): RemoteUIRequest | null {
  if (!event || typeof event !== 'object') return null
  const e = event as { type?: string; kind?: string; requestId?: string }
  if (e.type !== 'remoteui_request' || !e.requestId || (e.kind !== 'select' && e.kind !== 'editor')) {
    return null
  }
  return event as RemoteUIRequest
}

export function useRemoteUIRequests(): UseRemoteUIRequestsResult {
  const [currentRequest, setCurrentRequest] = useState<RemoteUIRequest | null>(null)
  // 等待队列：当前已有活跃请求时，新请求入队
  const queueRef = useRef<RemoteUIRequest[]>([])
  // 正在响应的 requestId，避免 onOpenChange 在 React 卸载时重复触发
  const respondingRef = useRef<Set<string>>(new Set())

  // 服务器是否支持扩展事件桥接（旧版本服务器无此频道）
  const hasExtensionsChannel =
    typeof window !== 'undefined' &&
    typeof window.electronAPI?.isChannelAvailable === 'function' &&
    window.electronAPI.isChannelAvailable(RPC_CHANNELS.extensions.EVENT)

  // 取下一个待处理请求
  const dequeueNext = useCallback(() => {
    setCurrentRequest((prev) => {
      if (prev) return prev // 仍有活跃请求，保留
      const next = queueRef.current.shift()
      return next ?? null
    })
  }, [])

  useEffect(() => {
    if (!hasExtensionsChannel) return

    const cleanup = window.electronAPI.onExtensionEvent((event) => {
      const request = asRemoteUIRequest(event)
      if (!request) return // 忽略非 remoteui_request 事件

      // 防止重复入队同一 requestId
      if (respondingRef.current.has(request.requestId)) return

      setCurrentRequest((prev) => {
        if (prev && prev.requestId !== request.requestId) {
          // 已有活跃请求 → 入队等待
          queueRef.current.push(request)
          return prev
        }
        if (prev && prev.requestId === request.requestId) {
          return prev // 同一请求重复到达，忽略
        }
        return request
      })
    })

    return cleanup
  }, [hasExtensionsChannel])

  const respond = useCallback(
    (payload: RemoteUIResult | null, reason?: RemoteUICancelReason) => {
      setCurrentRequest((current) => {
        if (!current) return null

        const { requestId, sessionId } = current
        respondingRef.current.add(requestId)

        // 回传到主进程 → 子进程。sessionId 用于定位发起请求的会话。
        // TODO: 若运行在旧版本服务器（无 sendRemoteUIResponse 频道），请求将无法回传，
        //       pi 扩展会一直等待 remoteui:response（Promise.race 会在 TUI 侧超时/取消）。
        if (typeof window.electronAPI?.sendRemoteUIResponse === 'function' && sessionId) {
          void window.electronAPI.sendRemoteUIResponse(
            sessionId,
            requestId,
            payload,
            reason,
          ).catch((err) => {
            console.error('[RemoteUI] Failed to send response:', err)
          })
        } else if (typeof window.electronAPI?.sendRemoteUIResponse === 'function') {
          // 缺少 sessionId：仍尝试回传（主进程将无法路由，会记录警告）
          void window.electronAPI.sendRemoteUIResponse(
            '',
            requestId,
            payload,
            reason,
          ).catch((err) => {
            console.error('[RemoteUI] Failed to send response (no sessionId):', err)
          })
        } else {
          console.warn('[RemoteUI] sendRemoteUIResponse not available on this server build')
        }

        // 出队下一个待处理请求（若有）
        const next = queueRef.current.shift() ?? null
        // 短延迟后清理 respondingRef，避免同一 requestId 的残留事件误判
        setTimeout(() => respondingRef.current.delete(requestId), 0)
        return next
      })
    },
    [],
  )

  return {
    currentRequest,
    respond,
  }
}
