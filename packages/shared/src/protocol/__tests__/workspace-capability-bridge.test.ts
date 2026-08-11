import { describe, expect, it } from 'bun:test'

import {
  WORKSPACE_CAPABILITY_BRIDGE_VERSION,
  isWorkspaceCapabilityBridgeToHostV1,
  isWorkspaceCapabilityBridgeToServerV1,
} from '../workspace-capability-bridge'

const request = {
  version: 1 as const,
  requestId: 'request-1',
  capability: 'browser.command',
  sessionId: 'session-1',
  runtimeId: 'runtime-1',
  extensionId: 'mortise-browser',
  operation: 'execute',
  input: { command: 'snapshot' },
}

describe('workspace capability bridge protocol', () => {
  it('accepts request, cancellation, progress, and result envelopes', () => {
    expect(isWorkspaceCapabilityBridgeToHostV1({
      type: 'workspace_capability_request',
      version: WORKSPACE_CAPABILITY_BRIDGE_VERSION,
      bridgeId: 'bridge-1',
      request,
      session: { workspaceId: 'workspace-1', sessionPath: 'C:\\sessions\\session-1' },
    })).toBe(true)
    expect(isWorkspaceCapabilityBridgeToHostV1({
      type: 'workspace_capability_cancel',
      version: WORKSPACE_CAPABILITY_BRIDGE_VERSION,
      bridgeId: 'bridge-1',
    })).toBe(true)
    expect(isWorkspaceCapabilityBridgeToServerV1({
      type: 'workspace_capability_progress',
      version: WORKSPACE_CAPABILITY_BRIDGE_VERSION,
      bridgeId: 'bridge-1',
      progress: { phase: 'running' },
    })).toBe(true)
    expect(isWorkspaceCapabilityBridgeToServerV1({
      type: 'workspace_capability_result',
      version: WORKSPACE_CAPABILITY_BRIDGE_VERSION,
      bridgeId: 'bridge-1',
      ok: true,
      output: { text: 'done' },
    })).toBe(true)
    expect(isWorkspaceCapabilityBridgeToServerV1({
      type: 'workspace_capability_probe',
      version: 1,
      bridgeId: 'probe-1',
      request,
    })).toBe(true)
    expect(isWorkspaceCapabilityBridgeToHostV1({
      type: 'workspace_capability_probe_result',
      version: 1,
      bridgeId: 'probe-1',
      ok: true,
      output: { text: 'done' },
      progress: [],
    })).toBe(true)
  })

  it('rejects incomplete or wrong-version envelopes', () => {
    expect(isWorkspaceCapabilityBridgeToHostV1({
      type: 'workspace_capability_request',
      version: 2,
      bridgeId: 'bridge-1',
      request,
      session: { workspaceId: 'workspace-1' },
    })).toBe(false)
    expect(isWorkspaceCapabilityBridgeToServerV1({
      type: 'workspace_capability_result',
      version: 1,
      bridgeId: 'bridge-1',
      ok: false,
      error: { message: 'missing code' },
    })).toBe(false)
  })
})
