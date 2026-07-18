import { describe, expect, it } from 'bun:test'
import {
  UiValidationError,
  UiValidationEventRing,
  UiValidationStateRegistry,
  assertSemanticRefRevision,
  createSemanticRef,
  parseSemanticRef,
  parseSemanticSnapshot,
  parseUiValidationActionRequest,
  parseUiValidationEvidenceCaptureRequest,
  parseUiValidationFaultSetRequest,
  parseUiValidationRequestEnvelope,
  parseUiValidationScenarioApplyRequest,
  parseUiValidationWaitRequest,
  queryUiValidationCapabilities,
} from '../index.ts'

describe('UI validation V1 protocol', () => {
  it('parses a versioned request envelope and rejects other versions', () => {
    expect(parseUiValidationRequestEnvelope({ v: 1, kind: 'request', id: '1', runId: 'run-1', method: 'status.get' })).toEqual({
      v: 1,
      kind: 'request',
      id: '1',
      requestId: '1',
      runId: 'run-1',
      method: 'status.get',
    })
    expect(() => parseUiValidationRequestEnvelope({ v: 2, kind: 'request', id: '1', runId: 'run-1', method: 'status.get' }))
      .toThrow(expect.objectContaining({ code: 'UNSUPPORTED_VERSION' }))
  })

  it('binds semantic refs to a snapshot revision', () => {
    const ref = createSemanticRef(7, 'send-button')
    expect(ref).toBe('r7:send-button')
    expect(parseSemanticRef(ref)).toEqual({ revision: 7, nodeId: 'send-button' })
    expect(assertSemanticRefRevision(ref, 7)).toBe('send-button')
    expect(() => assertSemanticRefRevision(ref, 8)).toThrow(expect.objectContaining({ code: 'STALE_REF', retryable: true }))
  })

  it('validates semantic snapshots and action-specific input', () => {
    expect(parseSemanticSnapshot({
      revision: 3,
      windowId: 'main',
      scope: 'composer',
      nodes: [{
        ref: 'r3:send', nodeId: 'send', role: 'button', name: 'Send', states: { disabled: false },
        actions: ['click'], actionModes: { semantic: ['click'], physical: ['click'] },
      }],
    }).nodes[0]).toMatchObject({ name: 'Send', actionModes: { semantic: ['click'], physical: ['click'] } })
    expect(() => parseSemanticSnapshot({
      revision: 4,
      windowId: 'main',
      scope: 'composer',
      nodes: [{ ref: 'r3:send', nodeId: 'send', role: 'button', name: 'Send' }],
    })).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))

    expect(parseUiValidationActionRequest({ target: { testId: 'composer' }, action: 'fill', mode: 'semantic', value: 'hello' })).toMatchObject({
      target: { testId: 'composer' }, action: 'fill', mode: 'semantic', value: 'hello',
    })
    expect(() => parseUiValidationActionRequest({ target: { testId: 'composer' }, action: 'click', mode: 'native' }))
      .toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
    expect(() => parseUiValidationActionRequest({ target: { role: 'button' }, action: 'press' }))
      .toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
    expect(parseUiValidationActionRequest({ target: { kind: 'native', ref: 'n3:window' }, revision: 3, action: 'focus', mode: 'native' }))
      .toMatchObject({ target: { kind: 'native', ref: 'n3:window' }, revision: 3, action: 'focus', mode: 'native' })
    expect(parseUiValidationActionRequest({
      target: { kind: 'extension', sessionId: 's1', extensionId: 'example', runtimeId: 'r1', definitionId: 'contract' },
      action: 'update', input: { count: 2 },
    })).toMatchObject({ action: 'update', input: { count: 2 } })
  })

  it('accepts direct action wait conditions as a legacy shorthand', () => {
    expect(parseUiValidationActionRequest({
      revision: 3,
      target: { ref: 'r3:save' },
      action: 'click',
      waitUntil: { kind: 'state', scope: 'sessions', phase: 'ready', detail: { count: 1 }, timeoutMs: 60_000 },
    }).waitUntil).toEqual({
      predicate: { kind: 'state', scope: 'sessions', phase: 'ready', detail: { count: 1 } },
      timeoutMs: 60_000,
    })
  })

  it('accepts stable semantic ids as first-class targets', () => {
    expect(parseUiValidationActionRequest({ target: { semanticId: 'composer.session.input' }, action: 'fill', value: 'hello' }))
      .toMatchObject({ target: { semanticId: 'composer.session.input' }, action: 'fill' })
  })

  it('accepts BrowserView refs as isolated physical targets', () => {
    expect(parseUiValidationActionRequest({
      target: { kind: 'browser', instanceId: 'browser-1', ref: 'b2:browser-1:e4' },
      revision: 2,
      action: 'click',
      mode: 'physical',
    })).toMatchObject({
      target: { kind: 'browser', instanceId: 'browser-1', ref: 'b2:browser-1:e4' },
      revision: 2,
      action: 'click',
    })
    expect(() => parseUiValidationActionRequest({
      target: { kind: 'browser', instanceId: 'browser-1', ref: 'b2:browser-1:e4' },
      action: 'drag',
    })).toThrow('Unsupported BrowserView action')
  })

  it('accepts semantic readiness as an event-driven wait contract', () => {
    expect(parseUiValidationWaitRequest({ predicate: { kind: 'semantic-ready' }, stableForMs: 25 }))
      .toEqual({ predicate: { kind: 'semantic-ready' }, stableForMs: 25 })
    expect(parseUiValidationWaitRequest({ predicate: { kind: 'state', scope: 'extension', phase: 'ready', entityId: 'ext:1', detail: { count: 2 } } }))
      .toEqual({ predicate: { kind: 'state', scope: 'extension', phase: 'ready', entityId: 'ext:1', detail: { count: 2 } } })
  })

  it('provides bounded list and describe discovery without exposing driver internals', () => {
    const listed = queryUiValidationCapabilities('webui', { operation: 'list', kind: 'scenario' })
    expect(listed.items.map(item => item.id)).toContain('session.streaming')
    expect(listed.items.every(item => item.kind === 'scenario' && item.surfaces.includes('webui'))).toBe(true)
    expect(listed.runtimeDiscovery).toMatchObject({ extensionDefinitions: { method: 'ui.snapshot' } })

    const fill = queryUiValidationCapabilities('webui', { operation: 'describe', kind: 'action', id: 'fill' }).items[0]!
    expect(fill.inputSchema).toMatchObject({ required: expect.arrayContaining(['target', 'action', 'value']) })

    const described = queryUiValidationCapabilities('electron', { operation: 'describe', kind: 'action', id: 'native.close' })
    expect(described.items).toHaveLength(1)
    expect(described.items[0]).toMatchObject({ verificationLevel: 'native-verified', modes: ['native'] })
    expect(JSON.stringify(described)).not.toMatch(/selector|evaluate|cdp/i)
    expect(() => queryUiValidationCapabilities('webui', { operation: 'describe', kind: 'action', id: 'native.close' }))
      .toThrow(expect.objectContaining({ code: 'TARGET_NOT_FOUND' }))
  })

  it('advertises BrowserView action targets only on Electron', () => {
    const electron = queryUiValidationCapabilities('electron', { operation: 'describe', kind: 'action', id: 'click' })
    const webui = queryUiValidationCapabilities('webui', { operation: 'describe', kind: 'action', id: 'click' })
    expect(JSON.stringify(electron.items[0]!.inputSchema)).toContain('browser')
    expect(JSON.stringify(webui.items[0]!.inputSchema)).not.toContain('browser')
  })
})

describe('UiValidationEventRing', () => {
  it('uses monotonic sequence numbers and reports a truncated cursor', () => {
    const ring = new UiValidationEventRing(2, () => 123)
    ring.append('one', {}, 1)
    ring.append('two', {}, 2)
    ring.append('three', {}, 3)
    expect(ring.read({ afterSeq: 0 })).toMatchObject({
      latestSeq: 3,
      droppedBeforeSeq: 2,
      events: [{ seq: 2, type: 'two', timestamp: 123 }, { seq: 3, type: 'three', timestamp: 123 }],
    })
  })

  it('waits for future matching events and supports abort', async () => {
    const ring = new UiValidationEventRing()
    const found = ring.waitFor(event => event.type === 'ready', { timeoutMs: 1_000 })
    ring.append('noise', {}, 0)
    ring.append('ready', { ok: true }, 1)
    expect((await found).payload).toEqual({ ok: true })

    const controller = new AbortController()
    const aborted = ring.waitFor(() => false, { signal: controller.signal })
    controller.abort('stop')
    await expect(aborted).rejects.toMatchObject({ code: 'ABORTED' })
  })
})

describe('UiValidationStateRegistry', () => {
  it('increments revisions, emits state events, and returns defensive snapshots', () => {
    const registry = new UiValidationStateRegistry()
    const event = registry.update({ phase: 'ready', hydrated: true }, 'app.ready')
    expect(event).toMatchObject({ seq: 1, revision: 1, type: 'app.ready' })
    expect(registry.snapshot).toMatchObject({ phase: 'ready', hydrated: true, revision: 1 })
    const copy = registry.snapshot
    copy.pending.rpc = 99
    expect(registry.snapshot.pending.rpc).toBe(0)
  })

  it('waits until matching state remains stable', async () => {
    const registry = new UiValidationStateRegistry()
    const result = registry.waitFor(state => state.phase === 'ready', { timeoutMs: 500, stableForMs: 15 })
    registry.update({ phase: 'ready' })
    expect((await result).phase).toBe('ready')
  })

  it('returns typed timeout errors', async () => {
    const registry = new UiValidationStateRegistry()
    await expect(registry.waitFor(state => state.phase === 'error', { timeoutMs: 5 }))
      .rejects.toBeInstanceOf(UiValidationError)
  })
})

describe('scenario, fault, and evidence validators', () => {
  it('normalizes a deterministic scenario', () => {
    expect(parseUiValidationScenarioApplyRequest({
      name: 'chat-ready', seed: 42, viewport: { width: 1280, height: 800 }, clock: { mode: 'frozen', now: '2026-07-14T00:00:00Z' },
    })).toMatchObject({ name: 'chat-ready', seed: 42, clock: { mode: 'frozen' } })
    expect(() => parseUiValidationScenarioApplyRequest({ name: 'bad', clock: { mode: 'frozen', now: 'never' } }))
      .toThrow(expect.objectContaining({ code: 'SCENARIO_INVALID' }))
  })

  it('accepts bounded named faults and rejects arbitrary point names', () => {
    expect(parseUiValidationFaultSetRequest({ point: 'provider.stream', effect: { kind: 'delay', ms: 50 }, times: 1 }))
      .toEqual({ point: 'provider.stream', effect: { kind: 'delay', ms: 50 }, times: 1 })
    expect(() => parseUiValidationFaultSetRequest({ point: 'provider/../../x', effect: { kind: 'drop' } }))
      .toThrow(expect.objectContaining({ code: 'FAULT_INVALID' }))
  })

  it('deduplicates validated evidence kinds', () => {
    expect(parseUiValidationEvidenceCaptureRequest({ label: 'after-send', include: ['screenshot', 'events', 'screenshot'] })).toEqual({
      label: 'after-send', include: ['screenshot', 'events'],
    })
  })
})
