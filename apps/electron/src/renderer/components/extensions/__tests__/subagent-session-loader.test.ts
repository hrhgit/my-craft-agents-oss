import { describe, expect, it } from 'bun:test'
import type { ExtensionBridgeEvent } from '@craft-agent/shared/agent/backend/types'
import { createSingleFlightLoader, isSubagentRefreshEvent } from '../subagent-session-loader'

describe('subagent session loader', () => {
  it('shares concurrent work for the same session', async () => {
    let resolveRequest!: (value: string[]) => void
    let requestCount = 0
    const loader = createSingleFlightLoader<string[]>(
      async () => {
        requestCount += 1
        return await new Promise<string[]>((resolve) => { resolveRequest = resolve })
      },
      { cacheTtlMs: 5_000 },
    )

    const first = loader.load('session-1')
    const second = loader.load('session-1')

    expect(first).toBe(second)
    expect(requestCount).toBe(1)

    resolveRequest(['child-1'])
    await expect(first).resolves.toEqual(['child-1'])
    await expect(second).resolves.toEqual(['child-1'])
  })

  it('deduplicates remount refreshes but allows an explicit refresh', async () => {
    let now = 100
    let requestCount = 0
    const loader = createSingleFlightLoader(
      async () => [`request-${++requestCount}`],
      { cacheTtlMs: 5_000, now: () => now },
    )

    await expect(loader.load('session-1')).resolves.toEqual(['request-1'])
    await expect(loader.load('session-1')).resolves.toEqual(['request-1'])
    expect(requestCount).toBe(1)

    await expect(loader.load('session-1', { force: true })).resolves.toEqual(['request-2'])
    expect(requestCount).toBe(2)

    now += 5_001
    await expect(loader.load('session-1')).resolves.toEqual(['request-3'])
  })

  it('clears a failed request so the next refresh can retry', async () => {
    let requestCount = 0
    const loader = createSingleFlightLoader(
      async () => {
        requestCount += 1
        if (requestCount === 1) throw new Error('connection lost')
        return ['recovered']
      },
      { cacheTtlMs: 5_000 },
    )

    await expect(loader.load('session-1')).rejects.toThrow('connection lost')
    await expect(loader.load('session-1')).resolves.toEqual(['recovered'])
    expect(requestCount).toBe(2)
  })
})

describe('subagent refresh events', () => {
  const event = (overrides: Partial<ExtensionBridgeEvent>): ExtensionBridgeEvent => ({
    type: 'extension_notify',
    extensionId: 'subagent',
    runtimeId: 'runtime-1',
    sessionId: 'session-1',
    message: 'child session changed',
    ...overrides,
  } as ExtensionBridgeEvent)

  it('accepts only subagent notifications for the current session', () => {
    expect(isSubagentRefreshEvent(event({}), 'session-1')).toBe(true)
    expect(isSubagentRefreshEvent(event({ extensionId: 'craft-spawn_session' }), 'session-1')).toBe(true)
    expect(isSubagentRefreshEvent(event({ extensionId: 'repo-memory', source: 'repo-memory' }), 'session-1')).toBe(false)
    expect(isSubagentRefreshEvent(event({ sessionId: 'session-2' }), 'session-1')).toBe(false)
    expect(isSubagentRefreshEvent(event({ type: 'extension_status' } as Partial<ExtensionBridgeEvent>), 'session-1')).toBe(false)
  })
})
