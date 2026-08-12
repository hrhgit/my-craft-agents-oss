import { describe, expect, it, mock } from 'bun:test'
import type { AgentBackend } from '@mortise/shared/agent/backend'
import { createManagedSession, SessionManager } from './SessionManager.ts'

const workspace = {
  schemaVersion: 2,
  id: 'extension-services-workspace',
  name: 'Extension Services Workspace',
  nameSource: 'custom',
  slug: 'extension-services-workspace',
  revision: 1,
  primaryLocationId: 'local',
  locations: [{
    id: 'local',
    name: 'Local',
    rootName: 'extension-services-workspace',
    endpoint: { kind: 'local', rootPath: process.cwd() },
  }],
  createdAt: Date.now(),
} as const

describe('SessionManager extension service boundary', () => {
  it('returns unavailable when no active Pi Session owns a service runtime', async () => {
    const manager = new SessionManager()
    await expect(manager.invokeExtensionService({
      requestId: 'request-unavailable',
      capability: 'search.query',
      operation: 'query',
      input: {},
    })).resolves.toMatchObject({
      protocolVersion: 1,
      requestId: 'request-unavailable',
      runtimeId: '',
      status: 'unavailable',
      error: { code: 'extension_service_runtime_unavailable' },
    })
  })

  it('returns runtime_stale before invoking a replaced service runtime', async () => {
    const invoke = mock(async () => ({
      protocolVersion: 1 as const,
      requestId: 'unexpected',
      runtimeId: 'runtime-current',
      status: 'succeeded' as const,
    }))
    const managed = createManagedSession({ mortiseId: 'session-extension-services' }, workspace as never)
    managed.agent = {
      extensionServicesList: async () => ({
        protocolVersion: 1,
        runtimeId: 'runtime-current',
        scope: 'session',
        providers: [],
        consumers: [],
      }),
      extensionServicesInvoke: invoke,
    } as unknown as AgentBackend
    const manager = new SessionManager()
    ;(manager as unknown as { sessions: Map<string, typeof managed> }).sessions.set(managed.id, managed)
    await expect(manager.invokeExtensionService({
      requestId: 'request-stale',
      runtimeId: 'runtime-old',
      sessionId: managed.id,
      capability: 'search.query',
      operation: 'query',
      input: {},
    })).resolves.toMatchObject({
      protocolVersion: 1,
      requestId: 'request-stale',
      runtimeId: 'runtime-current',
      status: 'runtime_stale',
      error: { code: 'extension_service_runtime_stale' },
    })
    expect(invoke).not.toHaveBeenCalled()
  })
})
