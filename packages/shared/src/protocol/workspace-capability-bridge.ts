import type { CapabilityError, CapabilityRequestV1 } from './capabilities.ts'

export const WORKSPACE_CAPABILITY_BRIDGE_VERSION = 1 as const

export interface WorkspaceCapabilitySessionContextV1 {
  workspaceId: string
  sessionPath?: string
}

export type WorkspaceCapabilityBridgeToHostV1 =
  | {
      type: 'workspace_capability_request'
      version: typeof WORKSPACE_CAPABILITY_BRIDGE_VERSION
      bridgeId: string
      request: CapabilityRequestV1
      session: WorkspaceCapabilitySessionContextV1
    }
  | {
      type: 'workspace_capability_cancel'
      version: typeof WORKSPACE_CAPABILITY_BRIDGE_VERSION
      bridgeId: string
    }
  | {
      type: 'workspace_capability_probe_result'
      version: typeof WORKSPACE_CAPABILITY_BRIDGE_VERSION
      bridgeId: string
      ok: true
      output: unknown
      progress: unknown[]
    }
  | {
      type: 'workspace_capability_probe_result'
      version: typeof WORKSPACE_CAPABILITY_BRIDGE_VERSION
      bridgeId: string
      ok: false
      error: CapabilityError
      progress: unknown[]
    }

export type WorkspaceCapabilityBridgeToServerV1 =
  | {
      type: 'workspace_capability_progress'
      version: typeof WORKSPACE_CAPABILITY_BRIDGE_VERSION
      bridgeId: string
      progress: unknown
    }
  | {
      type: 'workspace_capability_result'
      version: typeof WORKSPACE_CAPABILITY_BRIDGE_VERSION
      bridgeId: string
      ok: true
      output: unknown
    }
  | {
      type: 'workspace_capability_result'
      version: typeof WORKSPACE_CAPABILITY_BRIDGE_VERSION
      bridgeId: string
      ok: false
      error: CapabilityError
    }
  | {
      type: 'workspace_capability_probe'
      version: typeof WORKSPACE_CAPABILITY_BRIDGE_VERSION
      bridgeId: string
      request: CapabilityRequestV1
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasBridgeEnvelope(value: unknown): value is Record<string, unknown> & { bridgeId: string } {
  return isRecord(value)
    && value.version === WORKSPACE_CAPABILITY_BRIDGE_VERSION
    && typeof value.bridgeId === 'string'
    && value.bridgeId.length > 0
}

export function isWorkspaceCapabilityBridgeToHostV1(value: unknown): value is WorkspaceCapabilityBridgeToHostV1 {
  if (!hasBridgeEnvelope(value)) return false
  if (value.type === 'workspace_capability_cancel') return true
  if (value.type === 'workspace_capability_probe_result') {
    if (typeof value.ok !== 'boolean' || !Array.isArray(value.progress)) return false
    return value.ok || (isRecord(value.error)
      && typeof value.error.code === 'string'
      && typeof value.error.message === 'string')
  }
  if (value.type !== 'workspace_capability_request') return false
  if (!isRecord(value.request) || !isRecord(value.session)) return false
  return typeof value.request.requestId === 'string'
    && typeof value.request.capability === 'string'
    && typeof value.request.sessionId === 'string'
    && typeof value.session.workspaceId === 'string'
    && (value.session.sessionPath === undefined || typeof value.session.sessionPath === 'string')
}

export function isWorkspaceCapabilityBridgeToServerV1(value: unknown): value is WorkspaceCapabilityBridgeToServerV1 {
  if (!hasBridgeEnvelope(value)) return false
  if (value.type === 'workspace_capability_progress') return true
  if (value.type === 'workspace_capability_probe') {
    return isRecord(value.request)
      && typeof value.request.requestId === 'string'
      && typeof value.request.capability === 'string'
      && typeof value.request.sessionId === 'string'
  }
  if (value.type !== 'workspace_capability_result' || typeof value.ok !== 'boolean') return false
  if (value.ok) return true
  return isRecord(value.error)
    && typeof value.error.code === 'string'
    && typeof value.error.message === 'string'
}
