import { describe, expect, it } from 'bun:test'
import { UiValidationError } from '@mortise/shared/ui-validation'
import {
  buildWebSemanticSnapshot,
  buildWebAccessibilityDescriptor,
  readBoundedWebEvents,
  resolveWebTarget,
  routeFromParams,
  waitForWebCondition,
  WebSemanticRevisionClock,
} from '../web-adapter-core.ts'

describe('mortise-ui web adapter semantics', () => {
  const built = buildWebSemanticSnapshot({
    revision: 7,
    descriptors: [
      { selector: '#send', testId: 'send', role: 'button', name: 'Send' },
      { selector: '#cancel', role: 'button', name: 'Cancel' },
    ],
  })

  it('uses revision-bound opaque refs and resolves semantic targets', () => {
    const send = resolveWebTarget({ role: 'button', name: 'Send' }, built.snapshot, built.descriptorsByNodeId)
    expect(send.descriptor.selector).toBe('#send')
    expect(send.node.ref).toStartWith('r7:web.')
    expect(resolveWebTarget({ testId: 'send' }, built.snapshot, built.descriptorsByNodeId).node.name).toBe('Send')
  })

  it('rejects stale refs and ambiguous roles with typed errors', () => {
    const stale = built.snapshot.nodes[0]!.ref.replace('r7:', 'r6:')
    expect(() => resolveWebTarget({ ref: stale }, built.snapshot, built.descriptorsByNodeId)).toThrow(UiValidationError)
    expect(() => resolveWebTarget({ role: 'button' }, built.snapshot, built.descriptorsByNodeId)).toThrow(UiValidationError)
  })

  it('only accepts registered route surfaces', () => {
    expect(routeFromParams({ route: { surface: 'chat', sessionId: 's1' } }).query.get('session')).toBe('s1')
    expect(() => routeFromParams({ route: { surface: 'sources' } })).toThrow(UiValidationError)
    expect(() => routeFromParams({ route: { surface: 'raw-dom' } })).toThrow(UiValidationError)
  })

  it('prefers stable business semantics over a duplicate DOM descriptor', () => {
    const result = buildWebSemanticSnapshot({
      revision: 9,
      descriptors: [
        { selector: '#composer', role: 'textbox', name: 'inferred' },
        {
          selector: '#composer', semanticId: 'composer.s1.input', role: 'textbox', name: 'Message', value: '[REDACTED]',
          actions: ['fill', 'ime'], actionModes: { semantic: ['fill'], physical: ['fill', 'ime'] },
        },
      ],
    })
    expect(result.snapshot.nodes).toHaveLength(1)
    expect(result.snapshot.nodes[0]?.nodeId).toBe('business.composer.s1.input')
    expect(result.snapshot.nodes[0]?.value).toBe('[REDACTED]')
    expect(result.snapshot.nodes[0]?.actionModes).toEqual({ semantic: ['fill'], physical: ['fill', 'ime'] })
  })

  it('merges real accessibility semantics over DOM inference while preserving layout', () => {
    const result = buildWebSemanticSnapshot({
      revision: 10,
      descriptors: [
        { source: 'dom', selector: '#save', role: 'generic', name: 'Save draft', bounds: { x: 10, y: 20, width: 80, height: 30 }, states: { focused: false } },
        { source: 'accessibility', selector: '#save', role: 'button', name: 'Save', states: { focused: true, disabled: false } },
      ],
    })
    expect(result.snapshot.nodes).toHaveLength(1)
    expect(result.snapshot.nodes[0]).toMatchObject({
      role: 'button', name: 'Save', bounds: { x: 10, y: 20, width: 80, height: 30 },
      states: { focused: true, disabled: false },
    })
  })

  it('reconciles different selectors that resolve to the same DOM identity', () => {
    const result = buildWebSemanticSnapshot({
      revision: 12,
      descriptors: [
        { source: 'dom', selector: '[data-testid="settings"]', identity: 'body > button:nth-child(1)', role: 'button', name: 'Settings' },
        { source: 'accessibility', selector: 'body > button:nth-child(1)', identity: 'body > button:nth-child(1)', role: 'button', name: 'Settings' },
        { source: 'business', selector: '[data-mortise-semantic-id="navigation.nav_settings"]', identity: 'body > button:nth-child(1)', semanticId: 'navigation.nav_settings', role: 'button', name: 'Settings', actions: ['click'] },
      ],
    })
    expect(result.snapshot.nodes).toHaveLength(1)
    expect(result.snapshot.nodes[0]).toMatchObject({ semanticId: 'navigation.nav_settings', role: 'button', name: 'Settings' })
    expect(resolveWebTarget({ role: 'button', name: 'Settings' }, result.snapshot, result.descriptorsByNodeId).descriptor.selector)
      .toBe('[data-mortise-semantic-id="navigation.nav_settings"]')
  })

  it('keeps genuinely distinct controls ambiguous even when role and name match', () => {
    const result = buildWebSemanticSnapshot({
      revision: 13,
      descriptors: [
        { selector: '#first', identity: 'body > button:nth-child(1)', role: 'button', name: 'Open' },
        { selector: '#second', identity: 'body > button:nth-child(2)', role: 'button', name: 'Open' },
      ],
    })
    expect(result.snapshot.nodes).toHaveLength(2)
    expect(() => resolveWebTarget({ role: 'button', name: 'Open' }, result.snapshot, result.descriptorsByNodeId))
      .toThrow(UiValidationError)
  })

  it('preserves same-source duplicate semantic IDs as an explicit ambiguity', () => {
    const result = buildWebSemanticSnapshot({
      revision: 14,
      descriptors: [
        { source: 'business', selector: '[data-mortise-semantic-id="duplicate"]', semanticId: 'duplicate', role: 'button', name: 'Duplicate', actions: ['click'] },
        { source: 'business', selector: '[data-mortise-semantic-id="duplicate"]', semanticId: 'duplicate', role: 'button', name: 'Duplicate', actions: ['click'] },
      ],
    })
    expect(result.snapshot.nodes).toHaveLength(2)
    expect(new Set(result.snapshot.nodes.map(node => node.nodeId)).size).toBe(2)
    expect(() => resolveWebTarget({ semanticId: 'duplicate' }, result.snapshot, result.descriptorsByNodeId))
      .toThrow(UiValidationError)
  })

  it('advances revisions only for decision-relevant merged semantic changes', () => {
    const clock = new WebSemanticRevisionClock()
    const snapshot = (placeholder: string, semanticName = 'Message') => buildWebSemanticSnapshot({
      revision: clock.revision,
      descriptors: [
        { source: 'dom', selector: '#composer', identity: 'body > textarea', role: 'textbox', name: placeholder },
        { source: 'business', selector: '[data-mortise-semantic-id="composer.s1.input"]', identity: 'body > textarea', semanticId: 'composer.s1.input', role: 'textbox', name: semanticName, actions: ['fill'] },
      ],
    })
    const initial = snapshot('Ask anything')
    expect(clock.observe(initial.decisionFingerprint)).toBe(1)
    const placeholderOnly = snapshot('Rotating suggestion')
    expect(clock.observe(placeholderOnly.decisionFingerprint)).toBe(1)
    const renamed = snapshot('Rotating suggestion', 'Prompt')
    expect(clock.observe(renamed.decisionFingerprint)).toBe(2)
  })

  it('does not invalidate refs for rotating descendant text in passive containers', () => {
    const clock = new WebSemanticRevisionClock()
    const snapshot = (tip: string) => buildWebSemanticSnapshot({
      revision: clock.revision,
      descriptors: [
        { source: 'business', selector: '#dock', semanticId: 'workspace.unified-dock', role: 'region', name: `Workspace ${tip}`, actions: [] },
        { source: 'business', selector: '#settings', semanticId: 'navigation.nav_settings', role: 'button', name: 'Settings', actions: ['click'] },
      ],
    })
    expect(clock.observe(snapshot('Use Shift + Tab').decisionFingerprint)).toBe(1)
    expect(clock.observe(snapshot('Press Ctrl + .').decisionFingerprint)).toBe(1)
    expect(clock.observe(buildWebSemanticSnapshot({
      revision: clock.revision,
      descriptors: [
        { source: 'business', selector: '#dock', semanticId: 'workspace.unified-dock', role: 'region', name: 'Workspace Press Ctrl + .', actions: [] },
        { source: 'business', selector: '#settings', semanticId: 'navigation.nav_settings', role: 'button', name: 'Preferences', actions: ['click'] },
      ],
    }).decisionFingerprint)).toBe(2)
  })

  it('normalizes bounded AX state and redacts sensitive AX values', () => {
    expect(buildWebAccessibilityDescriptor({
      role: { value: 'textbox' },
      name: { value: 'API key' },
      value: { value: 'secret-value' },
      properties: [
        { name: 'disabled', value: { value: false } },
        { name: 'focused', value: { value: true } },
      ],
    }, { selector: '#key', bounds: { x: 1, y: 2, width: 3, height: 4 } })).toMatchObject({
      source: 'accessibility', selector: '#key', role: 'textbox', name: 'API key', value: '[REDACTED]',
      states: { disabled: false, focused: true }, bounds: { x: 1, y: 2, width: 3, height: 4 },
    })
  })

  it('preserves stable coverage for navigation, sessions, settings, dialogs, and notifications', () => {
    const descriptors = [
      { selector: '[data-mortise-semantic-id="navigation.main"]', semanticId: 'navigation.main', role: 'navigation', name: 'Main navigation', actions: [] },
      { selector: '[data-mortise-semantic-id="session.s1"]', semanticId: 'session.s1', role: 'button', name: 'Session one', actions: ['click'] },
      { selector: '[data-mortise-semantic-id="settings.appearance"]', semanticId: 'settings.appearance', role: 'button', name: 'Appearance', actions: ['click'] },
      { selector: '[data-slot="dialog-content"]', semanticId: 'dialog.rename', role: 'dialog', name: 'Rename', actions: [] },
      { selector: '[role="status"]', semanticId: 'notification.saved', role: 'status', name: 'Saved', actions: [] },
    ] as const
    const result = buildWebSemanticSnapshot({ revision: 11, descriptors: descriptors.map(item => ({ ...item, actions: [...item.actions] })) })
    expect(result.snapshot.nodes.map(node => node.nodeId)).toEqual([
      'business.navigation.main', 'business.session.s1', 'business.settings.appearance', 'business.dialog.rename', 'business.notification.saved',
    ])
    expect(result.snapshot.nodes.map(node => node.role)).toEqual(['navigation', 'button', 'button', 'dialog', 'status'])
  })

  it('reports an expired event cursor while retaining bounded replay', () => {
    const events = [{ seq: 4, type: 'four' }, { seq: 5, type: 'five' }]
    expect(readBoundedWebEvents(events, 5, 1)).toEqual({
      latestSeq: 5,
      droppedBeforeSeq: 4,
      events,
    })
    expect(readBoundedWebEvents(events, 5, 4)).toEqual({ latestSeq: 5, events: [events[1]] })
  })

  it('closes the check-to-subscribe race through a baseline-aware change wait', async () => {
    let revision = 1
    let checks = 0
    const result = await waitForWebCondition({
      baseline: async () => ({ revision, latestSeq: revision }),
      evaluate: async () => {
        checks += 1
        if (checks === 1) revision += 1
        return { matched: checks > 1, value: checks }
      },
      waitForChange: async baseline => {
        expect(revision).toBeGreaterThan(baseline.revision)
      },
      timeoutMs: 100,
    })
    expect(result.observed).toBe(2)
  })

  it('uses a single stability deadline when a matched condition does not change', async () => {
    let now = 1_000
    let waits = 0
    const result = await waitForWebCondition({
      baseline: async () => ({ revision: 1, latestSeq: 1 }),
      evaluate: async () => ({ matched: true, value: 'ready' }),
      waitForChange: async (_baseline, timeoutMs) => {
        waits += 1
        now += timeoutMs
      },
      timeoutMs: 1_000,
      stableForMs: 75,
      now: () => now,
    })
    expect(result).toEqual({ observed: 'ready', elapsedMs: 75 })
    expect(waits).toBe(1)
  })

  it('aborts an event wait without waiting for its timeout', async () => {
    const controller = new AbortController()
    const waiting = waitForWebCondition({
      baseline: async () => ({ revision: 1, latestSeq: 1 }),
      evaluate: async () => ({ matched: false, value: null }),
      waitForChange: async (_baseline, _timeoutMs, signal) => await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new UiValidationError('ABORTED', 'cancelled')), { once: true })
      }),
      timeoutMs: 10_000,
      signal: controller.signal,
    })
    controller.abort('client disconnected')
    await expect(waiting).rejects.toMatchObject({ code: 'ABORTED' })
  })
})
