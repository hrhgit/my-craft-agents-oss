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
import {
  validateExtensionInteractionBridgeCancelV1,
  validateExtensionInteractionBridgeRequestV1,
  validateExtensionInteractionBridgeSettledV1,
  validateExtensionInteractionResponseV1,
  type ExtensionInteractionBridgeCancelV1,
  type ExtensionInteractionBridgeRequestV1,
  type ExtensionInteractionBridgeSettledV1,
  type ExtensionInteractionResponseV1,
} from '@craft-agent/shared/protocol'
import type {
  RemoteUIRequest,
  RemoteUIResult,
  RemoteUICancelReason,
} from '../components/extensions/RemoteUIModal'

export interface UseRemoteUIRequestsResult {
  /** 当前需要展示的 remoteui:request（无则为 null） */
  currentRequest: ExtensionUIRequest | null
  /** 用户确认/取消时调用：payload 为结果或 null + reason */
  respond: (payload: ExtensionUIResponse, reason?: RemoteUICancelReason) => void
}

export type ExtensionUIRequest = RemoteUIRequest | ExtensionInteractionBridgeRequestV1
export type ExtensionUIResponse = RemoteUIResult | ExtensionInteractionResponseV1 | null

export function extensionUIRequestKey(request: Pick<ExtensionUIRequest, 'requestId' | 'sessionId' | 'runtimeId' | 'extensionId'>): string {
  return `${request.sessionId}\0${request.runtimeId}\0${request.extensionId}\0${request.requestId}`
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

export function asExtensionInteractionRequest(event: unknown): ExtensionInteractionBridgeRequestV1 | null {
  return validateExtensionInteractionBridgeRequestV1(event) === null
    ? event as ExtensionInteractionBridgeRequestV1
    : null
}

export function asExtensionInteractionCancel(event: unknown): ExtensionInteractionBridgeCancelV1 | null {
  return validateExtensionInteractionBridgeCancelV1(event) === null
    ? event as ExtensionInteractionBridgeCancelV1
    : null
}

export function asExtensionInteractionSettled(event: unknown): ExtensionInteractionBridgeSettledV1 | null {
  return validateExtensionInteractionBridgeSettledV1(event) === null
    ? event as ExtensionInteractionBridgeSettledV1
    : null
}

export function takeNextRemoteUIRequestForSession(
  queue: ExtensionUIRequest[],
  sessionId?: string | null,
): ExtensionUIRequest | null {
  if (!sessionId) return null
  const index = queue.findIndex(request => request.sessionId === sessionId)
  if (index < 0) return null
  return queue.splice(index, 1)[0] ?? null
}

export function useRemoteUIRequests(activeSessionId?: string | null): UseRemoteUIRequestsResult {
  const [currentRequest, setCurrentRequest] = useState<ExtensionUIRequest | null>(null)
  const currentRequestRef = useRef<ExtensionUIRequest | null>(null)
  const activeSessionIdRef = useRef(activeSessionId)
  // 等待队列：当前已有活跃请求时，新请求入队
  const queueRef = useRef<ExtensionUIRequest[]>([])
  // 正在响应的 requestId，避免 onOpenChange 在 React 卸载时重复触发
  const respondingRef = useRef<Set<string>>(new Set())
  const externallySettledRef = useRef<Set<string>>(new Set())
  const timeoutRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  activeSessionIdRef.current = activeSessionId

  useEffect(() => {
    currentRequestRef.current = currentRequest
  }, [currentRequest])

  const sendResponse = useCallback(async (
    request: ExtensionUIRequest,
    payload: ExtensionUIResponse,
    reason?: RemoteUICancelReason | 'disconnected',
  ): Promise<boolean> => {
    if (request.type === 'extension_interaction_request' && validateExtensionInteractionResponseV1(payload) !== null) {
      console.error('[ExtensionInteraction] Refusing to send an invalid response')
      return false
    }
    if (typeof window.electronAPI?.sendRemoteUIResponse !== 'function') {
      console.warn('[RemoteUI] sendRemoteUIResponse not available on this server build')
      return false
    }
    try {
      return await window.electronAPI.sendRemoteUIResponse(
        request.sessionId || '',
        request.requestId,
        payload,
        reason,
      )
    } catch (err) {
      console.error('[RemoteUI] Failed to send response:', err)
      return false
    }
  }, [])

  const clearRequestTimeout = useCallback((requestId: string) => {
    const timer = timeoutRef.current.get(requestId)
    if (timer) clearTimeout(timer)
    timeoutRef.current.delete(requestId)
  }, [])

  const rememberResponding = useCallback((requestKey: string) => {
    respondingRef.current.add(requestKey)
    if (respondingRef.current.size > 512) {
      const oldest = respondingRef.current.values().next().value
      if (oldest) {
        respondingRef.current.delete(oldest)
        externallySettledRef.current.delete(oldest)
      }
    }
  }, [])

  const finishRequest = useCallback((request: ExtensionUIRequest) => {
    const requestKey = extensionUIRequestKey(request)
    queueRef.current = queueRef.current.filter(queued => extensionUIRequestKey(queued) !== requestKey)
    setCurrentRequest((current) => {
      const next = current && extensionUIRequestKey(current) === requestKey
        ? takeNextRemoteUIRequestForSession(queueRef.current, activeSessionIdRef.current)
        : current
      currentRequestRef.current = next
      return next
    })
  }, [])

  useEffect(() => {
    setCurrentRequest((current) => {
      if (current?.sessionId === activeSessionId) return current
      if (current) queueRef.current.push(current)
      const next = takeNextRemoteUIRequestForSession(queueRef.current, activeSessionId)
      currentRequestRef.current = next
      return next
    })
  }, [activeSessionId])

  useEffect(() => {
    if (typeof window.electronAPI?.onExtensionEvent !== 'function') return

    const cleanup = window.electronAPI.onExtensionEvent((event) => {
      const settlement = asExtensionInteractionCancel(event) ?? asExtensionInteractionSettled(event)
      if (settlement) {
        const settledKey = extensionUIRequestKey(settlement)
        rememberResponding(settledKey)
        externallySettledRef.current.add(settledKey)
        clearRequestTimeout(settledKey)
        queueRef.current = queueRef.current.filter(request => extensionUIRequestKey(request) !== settledKey)
        setCurrentRequest(current => {
          if (!current || extensionUIRequestKey(current) !== settledKey) return current
          const next = takeNextRemoteUIRequestForSession(queueRef.current, activeSessionIdRef.current)
          currentRequestRef.current = next
          return next
        })
        return
      }

      const request = asExtensionInteractionRequest(event) ?? asRemoteUIRequest(event)
      if (!request) return
      const requestKey = extensionUIRequestKey(request)

      // 防止重复入队同一 requestId
      if (respondingRef.current.has(requestKey)) return
      if (
        (currentRequestRef.current && extensionUIRequestKey(currentRequestRef.current) === requestKey) ||
        queueRef.current.some(queued => extensionUIRequestKey(queued) === requestKey)
      ) return

      if (request.timeout && request.timeout > 0) {
        const timer = setTimeout(() => {
          if (respondingRef.current.has(requestKey)) return
          rememberResponding(requestKey)
          timeoutRef.current.delete(requestKey)
          void sendResponse(
            request,
            request.type === 'extension_interaction_request'
              ? { schemaVersion: 1, status: 'cancelled', reason: 'timeout' }
              : null,
            request.type === 'remoteui_request' ? 'cancelled' : undefined,
          )
          // The request deadline has elapsed. Delivery is best-effort; keeping
          // an expired card visible would leave it retryable without a timer.
          finishRequest(request)
        }, request.timeout)
        timeoutRef.current.set(requestKey, timer)
      }

      setCurrentRequest((prev) => {
        if (request.sessionId !== activeSessionIdRef.current) {
          queueRef.current.push(request)
          return prev
        }
        if (prev && extensionUIRequestKey(prev) !== requestKey) {
          // 已有活跃请求 → 入队等待
          queueRef.current.push(request)
          return prev
        }
        if (prev && extensionUIRequestKey(prev) === requestKey) {
          return prev // 同一请求重复到达，忽略
        }
        currentRequestRef.current = request
        return request
      })
    })

    return cleanup
  }, [clearRequestTimeout, finishRequest, rememberResponding, sendResponse])

  useEffect(() => () => {
    const pending = [currentRequestRef.current, ...queueRef.current].filter(
      (request): request is ExtensionUIRequest => request !== null,
    )
    for (const request of pending) {
      const requestKey = extensionUIRequestKey(request)
      clearRequestTimeout(requestKey)
      void sendResponse(
        request,
        request.type === 'extension_interaction_request'
          ? { schemaVersion: 1, status: 'cancelled', reason: 'host-disconnected' }
          : null,
        request.type === 'remoteui_request' ? 'disconnected' : undefined,
      )
    }
    queueRef.current = []
  }, [clearRequestTimeout, sendResponse])

  const respond = useCallback(
    (payload: ExtensionUIResponse, reason?: RemoteUICancelReason) => {
      const current = currentRequestRef.current
      if (!current) return
      const requestKey = extensionUIRequestKey(current)
      if (respondingRef.current.has(requestKey)) return

      rememberResponding(requestKey)
      clearRequestTimeout(requestKey)
      void sendResponse(current, payload, reason).then((sent) => {
        if (sent) {
          finishRequest(current)
        } else if (!externallySettledRef.current.has(requestKey)) {
          // Keep the same request visible and retryable when delivery fails.
          respondingRef.current.delete(requestKey)
        }
      })
    },
    [clearRequestTimeout, finishRequest, rememberResponding, sendResponse],
  )

  return {
    currentRequest,
    respond,
  }
}
