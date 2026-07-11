/**
 * Pi 扩展事件桥接层
 *
 * 将 Pi RpcClient 转发的扩展事件（remoteui:request、
 * extension_notify、extension_status、extension_widget、extension_command_registered）通过
 * eventSink 广播到渲染进程。
 *
 * 事件流：
 *   pi 扩展 → Pi RpcClient extension_ui_request
 *   → PiAgent.handlePiClientEvent → onExtensionEvent 回调
 *   → 此桥接层 → versioned contribution/eventSink → RPC_CHANNELS.extensions.EVENT → 渲染进程
 */

import { RPC_CHANNELS, type ExtensionContributionV1, validateExtensionContributionV1 } from '@craft-agent/shared/protocol'
import type { ExtensionBridgeEvent } from '@craft-agent/shared/agent/backend/types'
import type { EventSink } from '@craft-agent/server-core/transport'

/**
 * 创建扩展事件转发回调。
 *
 * 由 SessionManager 在构造 backend config 时调用，将返回的回调传入
 * CoreBackendConfig.onExtensionEvent。当 PiAgent 收到 Pi RpcClient 的扩展事件时，
 * 通过此回调将事件广播到渲染进程。
 *
 * 对 remoteui_request 事件注入 sessionId，以便渲染进程在回传响应时
 * 能定位到发起请求的会话（SessionManager.sendRemoteUIResponse 据此查找 agent）。
 *
 * @param eventSink - SessionManager 的事件分发器
 * @param workspaceId - 当前工作区 ID（用于定向广播）
 * @param sessionId - 当前会话 ID（注入到 remoteui_request 事件中）
 * @returns onExtensionEvent 回调函数
 */
export function createExtensionEventForwarder(
  eventSink: EventSink | null,
  workspaceId: string,
  sessionId?: string,
): (event: ExtensionBridgeEvent) => void {
  return (event: ExtensionBridgeEvent) => {
    if (!eventSink) return

    // 为 remoteui_request 注入 sessionId（渲染进程回传响应时需要）
    if (event.type === 'remoteui_request' && sessionId) {
      event = { ...event, sessionId }
    }

    if (event.type === 'extension_widget' && sessionId) {
      const contribution: ExtensionContributionV1 = {
        schemaVersion: 1,
        contributionId: `widget:${event.key}`,
        extensionId: event.extensionId,
        sessionId,
        runtimeId: event.runtimeId,
        kind: 'block',
        placement: event.placement === 'aboveEditor' ? 'above_editor' : 'below_editor',
        payload: { format: 'text', content: event.content?.join('\n') ?? '', removed: event.content === undefined, source: event.source },
      }
      if (validateExtensionContributionV1(contribution) === null) {
        eventSink(RPC_CHANNELS.extensions.EVENT, { to: 'workspace', workspaceId }, {
          type: 'extension_contribution',
          extensionId: event.extensionId,
          runtimeId: event.runtimeId,
          sessionId,
          contribution,
        })
        return
      }
    }

    // 所有扩展事件统一通过 extensions:EVENT 频道广播；renderer 只将
    // extension_notify 视为面向用户的 toast，extension_status 作为运行态事件。
    // 渲染进程根据 event.type 区分具体事件类型
    eventSink(RPC_CHANNELS.extensions.EVENT, { to: 'workspace', workspaceId }, event)
  }
}
