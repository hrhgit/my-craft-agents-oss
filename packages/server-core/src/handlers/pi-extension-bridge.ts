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

import {
  RPC_CHANNELS,
  type ExtensionContributionDeltaV1,
  validateExtensionContributionDeltaV1,
  validateExtensionUIValidationDeltaV1,
} from '@mortise/shared/protocol'
import type { ExtensionBridgeEvent } from '@mortise/shared/agent/backend/types'
import type { EventSink } from '@mortise/server-core/transport'

/**
 * 创建扩展事件转发回调。
 *
 * 由 SessionManager 在构造 backend config 时调用，将返回的回调传入
 * CoreBackendConfig.onExtensionEvent。当 PiAgent 收到 Pi RpcClient 的扩展事件时，
 * 通过此回调将事件广播到渲染进程。
 *
 * 对临时交互事件注入受信 sessionId，以便渲染进程在回传响应时
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
  const legacyRevisions = new Map<string, number>()
  return (event: ExtensionBridgeEvent) => {
    if (!eventSink) return
    const trustedSessionId = sessionId ?? event.sessionId

    // 临时交互的会话归属由 host 注入，不接受扩展提供的路由身份。
    if (
      sessionId
      && (event.type === 'remoteui_request'
        || event.type === 'extension_interaction_request'
        || event.type === 'extension_interaction_cancel'
        || event.type === 'extension_interaction_settled')
    ) {
      event = { ...event, sessionId }
    }

    if (event.type === 'extension_contribution') {
      const trustedRoute = {
        extensionId: event.extensionId,
        runtimeId: event.runtimeId,
        sessionId: trustedSessionId,
      }
      const delta = { ...event.delta, ...trustedRoute, workspaceId }
      if (validateExtensionContributionDeltaV1(delta) !== null) return
      eventSink(RPC_CHANNELS.extensions.EVENT, { to: 'workspace', workspaceId }, {
        type: 'extension_contribution',
        ...trustedRoute,
        delta,
      })
      return
    }

    if (event.type === 'extension_contributions_runtime_reset') {
      eventSink(RPC_CHANNELS.extensions.EVENT, { to: 'workspace', workspaceId }, {
        type: 'extension_contributions_runtime_reset',
        extensionId: event.extensionId,
        runtimeId: event.runtimeId,
        sessionId: trustedSessionId,
        workspaceId,
      })
      return
    }

    if (event.type === 'extension_ui_validation') {
      // Validation is a development-only adjunct. Route identity always comes
      // from the host-owned extension runtime, never from the declaration.
      const delta = {
        ...event.delta,
        extensionId: event.extensionId,
        runtimeId: event.runtimeId,
        ...(sessionId ? { sessionId } : {}),
      }
      if (validateExtensionUIValidationDeltaV1(delta) !== null) return
      eventSink(RPC_CHANNELS.extensions.EVENT, { to: 'workspace', workspaceId }, {
        ...event,
        sessionId: delta.sessionId,
        delta,
      })
      return
    }

    if (event.type === 'extension_widget' && sessionId) {
      // Legacy widgets use a synthetic owner so their adapter-local revisions
      // cannot collide with native revisions from the same extension runtime.
      const legacyExtensionId = `${event.extensionId}:legacy-widget`
      const revisionKey = `${event.runtimeId}\0${legacyExtensionId}`
      const revision = (legacyRevisions.get(revisionKey) ?? 0) + 1
      legacyRevisions.set(revisionKey, revision)
      const delta: ExtensionContributionDeltaV1 = {
        schemaVersion: 1,
        extensionId: legacyExtensionId,
        sessionId,
        runtimeId: event.runtimeId,
        workspaceId,
        revision,
        ...(event.content === undefined || event.content.length === 0
          ? { operation: 'remove', contributionId: `legacy-widget:${event.key}` }
          : {
              operation: 'upsert',
              contribution: {
                schemaVersion: 1,
                id: `legacy-widget:${event.key}`,
                surface: event.placement === 'belowEditor' ? 'composer.below' : 'composer.above',
                content: { type: 'text', text: event.content.join('\n') },
                group: event.source,
              },
            }),
      }
      if (validateExtensionContributionDeltaV1(delta) === null) {
        eventSink(RPC_CHANNELS.extensions.EVENT, { to: 'workspace', workspaceId }, {
          type: 'extension_contribution',
          extensionId: event.extensionId,
          runtimeId: event.runtimeId,
          sessionId,
          delta,
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
