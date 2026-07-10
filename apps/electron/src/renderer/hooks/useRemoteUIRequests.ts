/**
 * useRemoteUIRequests — 订阅 pi 扩展的 remoteui:request 事件并管理活跃请求状态。
 *
 * 事件流：
 *   pi 扩展 → Pi RpcClient extension_ui_request
 *   → PiAgent.handlePiClientEvent → onExtensionEvent 回调
 *   → extensions:EVENT 频道广播 → 此 hook 接收
 *
 * 回传路径：
 *   respond() → window.electronAPI.sendRemoteUIResponse(sessionId, requestId, payload, reason)
 *   → RPC extensions:remoteuiResponse → SessionManager.sendRemoteUIResponse
 *   → PiAgent.sendRemoteUIResponse → Pi RpcClient extension_ui_response
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
export function asRemoteUIRequest(event: unknown): RemoteUIRequest | null {
  if (!event || typeof event !== 'object') return null
  const e = event as { type?: string; kind?: string; requestId?: string }
  if (
    e.type !== 'remoteui_request' ||
    !e.requestId ||
    (e.kind !== 'select' && e.kind !== 'confirm' && e.kind !== 'editor')
  ) {
    return null
  }
  return event as RemoteUIRequest
}

export function takeNextRemoteUIRequestForSession(
  queue: RemoteUIRequest[],
  sessionId?: string | null,
): RemoteUIRequest | null {
  if (!sessionId) return null
  const index = queue.findIndex(request => request.sessionId === sessionId)
  if (index < 0) return null
  return queue.splice(index, 1)[0] ?? null
}

export function useRemoteUIRequests(activeSessionId?: string | null): UseRemoteUIRequestsResult {
  const [currentRequest, setCurrentRequest] = useState<RemoteUIRequest | null>(null)
  const currentRequestRef = useRef<RemoteUIRequest | null>(null)
  const activeSessionIdRef = useRef(activeSessionId)
  // 等待队列：当前已有活跃请求时，新请求入队
  const queueRef = useRef<RemoteUIRequest[]>([])
  // 正在响应的 requestId，避免 onOpenChange 在 React 卸载时重复触发
  const respondingRef = useRef<Set<string>>(new Set())
  const timeoutRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  // 服务器是否支持扩展事件桥接（旧版本服务器无此频道）
  const hasExtensionsChannel =
    typeof window !== 'undefined' &&
    typeof window.electronAPI?.isChannelAvailable === 'function' &&
    window.electronAPI.isChannelAvailable(RPC_CHANNELS.extensions.EVENT)

  activeSessionIdRef.current = activeSessionId

  useEffect(() => {
    currentRequestRef.current = currentRequest
  }, [currentRequest])

  const sendResponse = useCallback((
    request: RemoteUIRequest,
    payload: RemoteUIResult | null,
    reason?: RemoteUICancelReason | 'disconnected',
  ) => {
    if (typeof window.electronAPI?.sendRemoteUIResponse !== 'function') {
      console.warn('[RemoteUI] sendRemoteUIResponse not available on this server build')
      return
    }
    void window.electronAPI.sendRemoteUIResponse(
      request.sessionId || '',
      request.requestId,
      payload,
      reason,
    ).catch((err) => {
      console.error('[RemoteUI] Failed to send response:', err)
    })
  }, [])

  const clearRequestTimeout = useCallback((requestId: string) => {
    const timer = timeoutRef.current.get(requestId)
    if (timer) clearTimeout(timer)
    timeoutRef.current.delete(requestId)
  }, [])

  useEffect(() => {
    setCurrentRequest((current) => {
      if (current?.sessionId === activeSessionId) return current
      if (current) queueRef.current.push(current)
      return takeNextRemoteUIRequestForSession(queueRef.current, activeSessionId)
    })
  }, [activeSessionId])

  useEffect(() => {
    if (!hasExtensionsChannel) return

    const cleanup = window.electronAPI.onExtensionEvent((event) => {
      const request = asRemoteUIRequest(event)
      if (!request) return // 忽略非 remoteui_request 事件

      // 防止重复入队同一 requestId
      if (respondingRef.current.has(request.requestId)) return
      if (
        currentRequestRef.current?.requestId === request.requestId ||
        queueRef.current.some(queued => queued.requestId === request.requestId)
      ) return

      if (request.timeout && request.timeout > 0) {
        const timer = setTimeout(() => {
          respondingRef.current.add(request.requestId)
          timeoutRef.current.delete(request.requestId)
          queueRef.current = queueRef.current.filter(queued => queued.requestId !== request.requestId)
          sendResponse(request, null, 'cancelled')
          setTimeout(() => respondingRef.current.delete(request.requestId), 0)
          setCurrentRequest(current => {
            if (current?.requestId !== request.requestId) return current
            return takeNextRemoteUIRequestForSession(queueRef.current, activeSessionIdRef.current)
          })
        }, request.timeout)
        timeoutRef.current.set(request.requestId, timer)
      }

      setCurrentRequest((prev) => {
        if (request.sessionId !== activeSessionId) {
          queueRef.current.push(request)
          return prev
        }
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
  }, [activeSessionId, hasExtensionsChannel, sendResponse])

  useEffect(() => () => {
    const pending = [currentRequestRef.current, ...queueRef.current].filter(
      (request): request is RemoteUIRequest => request !== null,
    )
    for (const request of pending) {
      clearRequestTimeout(request.requestId)
      if (!respondingRef.current.has(request.requestId)) {
        sendResponse(request, null, 'disconnected')
      }
    }
    queueRef.current = []
  }, [clearRequestTimeout, sendResponse])

  const respond = useCallback(
    (payload: RemoteUIResult | null, reason?: RemoteUICancelReason) => {
      setCurrentRequest((current) => {
        if (!current) return null

        const { requestId } = current
        respondingRef.current.add(requestId)
        clearRequestTimeout(requestId)

        // 回传到主进程 → 子进程。sessionId 用于定位发起请求的会话。
        // TODO: 若运行在旧版本服务器（无 sendRemoteUIResponse 频道），请求将无法回传，
        //       pi 扩展会一直等待 remoteui:response（Promise.race 会在 TUI 侧超时/取消）。
        sendResponse(current, payload, reason)

        // 出队下一个待处理请求（若有）
        const next = takeNextRemoteUIRequestForSession(queueRef.current, activeSessionIdRef.current)
        // 短延迟后清理 respondingRef，避免同一 requestId 的残留事件误判
        setTimeout(() => respondingRef.current.delete(requestId), 0)
        return next
      })
    },
    [clearRequestTimeout, sendResponse],
  )

  return {
    currentRequest,
    respond,
  }
}
