/** Queue and settle current versioned extension interactions for the active Session. */

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
} from '@mortise/shared/protocol'
export interface UseExtensionInteractionsResult {
  currentRequest: ExtensionInteractionBridgeRequestV1 | null
  respond: (response: ExtensionInteractionResponseV1) => void
}

export function extensionInteractionKey(request: Pick<ExtensionInteractionBridgeRequestV1, 'requestId' | 'sessionId' | 'runtimeId' | 'extensionId'>): string {
  return `${request.sessionId}\0${request.runtimeId}\0${request.extensionId}\0${request.requestId}`
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

export function takeNextExtensionInteractionForSession(
  queue: ExtensionInteractionBridgeRequestV1[],
  sessionId?: string | null,
): ExtensionInteractionBridgeRequestV1 | null {
  if (!sessionId) return null
  const index = queue.findIndex(request => request.sessionId === sessionId)
  if (index < 0) return null
  return queue.splice(index, 1)[0] ?? null
}

export function useExtensionInteractions(activeSessionId?: string | null): UseExtensionInteractionsResult {
  const [currentRequest, setCurrentRequest] = useState<ExtensionInteractionBridgeRequestV1 | null>(null)
  const currentRequestRef = useRef<ExtensionInteractionBridgeRequestV1 | null>(null)
  const activeSessionIdRef = useRef(activeSessionId)
  // 等待队列：当前已有活跃请求时，新请求入队
  const queueRef = useRef<ExtensionInteractionBridgeRequestV1[]>([])
  // 正在响应的 requestId，避免 onOpenChange 在 React 卸载时重复触发
  const respondingRef = useRef<Set<string>>(new Set())
  const externallySettledRef = useRef<Set<string>>(new Set())
  const timeoutRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  activeSessionIdRef.current = activeSessionId

  useEffect(() => {
    currentRequestRef.current = currentRequest
  }, [currentRequest])

  const sendResponse = useCallback(async (
    request: ExtensionInteractionBridgeRequestV1,
    response: ExtensionInteractionResponseV1,
  ): Promise<boolean> => {
    if (validateExtensionInteractionResponseV1(response) !== null) {
      console.error('[ExtensionInteraction] Refusing to send an invalid response')
      return false
    }
    if (typeof window.electronAPI?.respondToExtensionInteraction !== 'function') {
      console.warn('[ExtensionInteraction] response API is unavailable')
      return false
    }
    try {
      return await window.electronAPI.respondToExtensionInteraction(
        request.sessionId || '',
        request.requestId,
        response,
      )
    } catch (err) {
      console.error('[ExtensionInteraction] Failed to send response:', err)
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

  const finishRequest = useCallback((request: ExtensionInteractionBridgeRequestV1) => {
    const requestKey = extensionInteractionKey(request)
    queueRef.current = queueRef.current.filter(queued => extensionInteractionKey(queued) !== requestKey)
    setCurrentRequest((current) => {
      const next = current && extensionInteractionKey(current) === requestKey
        ? takeNextExtensionInteractionForSession(queueRef.current, activeSessionIdRef.current)
        : current
      currentRequestRef.current = next
      return next
    })
  }, [])

  useEffect(() => {
    setCurrentRequest((current) => {
      if (current?.sessionId === activeSessionId) return current
      if (current) queueRef.current.push(current)
      const next = takeNextExtensionInteractionForSession(queueRef.current, activeSessionId)
      currentRequestRef.current = next
      return next
    })
  }, [activeSessionId])

  useEffect(() => {
    if (typeof window.electronAPI?.onExtensionEvent !== 'function') return

    const cleanup = window.electronAPI.onExtensionEvent((event) => {
      const settlement = asExtensionInteractionCancel(event) ?? asExtensionInteractionSettled(event)
      if (settlement) {
        const settledKey = extensionInteractionKey(settlement)
        rememberResponding(settledKey)
        externallySettledRef.current.add(settledKey)
        clearRequestTimeout(settledKey)
        queueRef.current = queueRef.current.filter(request => extensionInteractionKey(request) !== settledKey)
        setCurrentRequest(current => {
          if (!current || extensionInteractionKey(current) !== settledKey) return current
          const next = takeNextExtensionInteractionForSession(queueRef.current, activeSessionIdRef.current)
          currentRequestRef.current = next
          return next
        })
        return
      }

      const request = asExtensionInteractionRequest(event)
      if (!request) return
      const requestKey = extensionInteractionKey(request)

      // 防止重复入队同一 requestId
      if (respondingRef.current.has(requestKey)) return
      if (
        (currentRequestRef.current && extensionInteractionKey(currentRequestRef.current) === requestKey) ||
        queueRef.current.some(queued => extensionInteractionKey(queued) === requestKey)
      ) return

      if (request.timeout && request.timeout > 0) {
        const timer = setTimeout(() => {
          if (respondingRef.current.has(requestKey)) return
          rememberResponding(requestKey)
          timeoutRef.current.delete(requestKey)
          void sendResponse(
            request,
            { schemaVersion: 1, status: 'cancelled', reason: 'timeout' },
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
        if (prev && extensionInteractionKey(prev) !== requestKey) {
          // 已有活跃请求 → 入队等待
          queueRef.current.push(request)
          return prev
        }
        if (prev && extensionInteractionKey(prev) === requestKey) {
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
      (request): request is ExtensionInteractionBridgeRequestV1 => request !== null,
    )
    for (const request of pending) {
      const requestKey = extensionInteractionKey(request)
      clearRequestTimeout(requestKey)
      void sendResponse(
        request,
        { schemaVersion: 1, status: 'cancelled', reason: 'host-disconnected' },
      )
    }
    queueRef.current = []
  }, [clearRequestTimeout, sendResponse])

  const respond = useCallback(
    (response: ExtensionInteractionResponseV1) => {
      const current = currentRequestRef.current
      if (!current) return
      const requestKey = extensionInteractionKey(current)
      if (respondingRef.current.has(requestKey)) return

      rememberResponding(requestKey)
      clearRequestTimeout(requestKey)
      void sendResponse(current, response).then((sent) => {
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
