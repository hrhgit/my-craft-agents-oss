/**
 * Session Event Normalizer (边界适配层)
 *
 * 在 IPC 边界把 SessionEvent (shared DTO) 转换为 AgentEvent (renderer canonical)。
 * legacy 事件在此处转换为 canonical 事件，processor 不再知道 legacy 事件类型。
 *
 * 当前处理：title_regenerating → async_operation
 *   (title_regenerating 已从 SessionEvent union 中移除，但可能从旧服务端残留)
 */

import type { SessionEvent } from '@mortise/shared/protocol'
import type { AgentEvent } from './types'

/**
 * 把 SessionEvent 转换为 canonical AgentEvent。
 * legacy 事件被映射为对应的 canonical 事件，processor 只处理 canonical 事件。
 */
export function normalizeSessionEvent(event: SessionEvent): AgentEvent {
  // Runtime safety net: title_regenerating removed from SessionEvent union,
  // but may still arrive from old server versions. Convert to async_operation.
  if ((event as { type: string }).type === 'title_regenerating') {
    const legacy = event as unknown as { sessionId: string; isRegenerating: boolean }
    return { type: 'async_operation', sessionId: legacy.sessionId, isOngoing: legacy.isRegenerating }
  }
  return event as unknown as AgentEvent
}
