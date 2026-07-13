import { describe, expect, it } from 'bun:test'
import { createExtensionEventForwarder } from './pi-extension-bridge'
import type { ExtensionBridgeEvent } from '@craft-agent/shared/agent/backend/types'
import type { EventSink } from '@craft-agent/server-core/transport'

const route = { extensionId: 'example', runtimeId: 'runtime', sessionId: 'session' }

describe('Pi extension contribution bridge', () => {
  it('forwards valid native deltas and rejects invalid payloads', () => {
    const payloads: unknown[] = []
    const sink = ((...args: Parameters<EventSink>) => { payloads.push(args[2]) }) as EventSink
    const forward = createExtensionEventForwarder(sink, 'workspace', 'session')
    forward({
      type: 'extension_contribution', ...route,
      delta: {
        schemaVersion: 1, ...route, revision: 1, operation: 'upsert',
        contribution: { schemaVersion: 1, id: 'status', surface: 'composer.status', content: { type: 'text', text: 'Ready' } },
      },
    })
    expect(payloads).toHaveLength(1)

    forward({
      type: 'extension_contribution', ...route,
      delta: {
        schemaVersion: 1, ...route, revision: 2, operation: 'upsert',
        contribution: { schemaVersion: 1, id: 'bad', surface: 'composer.status', content: { type: 'text', text: '' } },
      },
    } as ExtensionBridgeEvent)
    expect(payloads).toHaveLength(1)
  })

  it('normalizes legacy widgets into revisioned contributions', () => {
    const payloads: unknown[] = []
    const sink = ((...args: Parameters<EventSink>) => { payloads.push(args[2]) }) as EventSink
    const forward = createExtensionEventForwarder(sink, 'workspace', 'session')
    forward({ type: 'extension_widget', ...route, key: 'legacy', content: ['one', 'two'], placement: 'belowEditor' })
    const payload = payloads[0] as { type: string; delta: { operation: string; revision: number; contribution: { id: string } } }
    expect(payload.type).toBe('extension_contribution')
    expect(payload.delta).toMatchObject({ operation: 'upsert', revision: 1, contribution: { id: 'legacy-widget:legacy' } })
  })

  it('preserves Pi default placement above the composer', () => {
    const payloads: unknown[] = []
    const sink = ((...args: Parameters<EventSink>) => { payloads.push(args[2]) }) as EventSink
    createExtensionEventForwarder(sink, 'workspace', 'session')({ type: 'extension_widget', ...route, key: 'default', content: ['one'] })
    expect(payloads[0]).toMatchObject({ delta: { contribution: { surface: 'composer.above' } } })
  })

  it('removes a legacy widget when Pi sends an empty content array', () => {
    const payloads: unknown[] = []
    const sink = ((...args: Parameters<EventSink>) => { payloads.push(args[2]) }) as EventSink
    const forward = createExtensionEventForwarder(sink, 'workspace', 'session')
    forward({ type: 'extension_widget', ...route, key: 'legacy', content: ['visible'] })
    forward({ type: 'extension_widget', ...route, key: 'legacy', content: [] })

    expect(payloads[1]).toMatchObject({
      type: 'extension_contribution',
      delta: { operation: 'remove', contributionId: 'legacy-widget:legacy', revision: 2 },
    })
  })
})
