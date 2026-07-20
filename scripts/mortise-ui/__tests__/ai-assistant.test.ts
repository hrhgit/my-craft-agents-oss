import { describe, expect, it } from 'bun:test'
import { createActionObservation, createSnapshotBriefing, selectRelevantCapabilities } from '../ai-assistant.ts'

describe('mortise-ui AI disclosure', () => {
  it('prioritizes attention targets and discloses lower-priority omissions', () => {
    const briefing = createSnapshotBriefing({
      revision: 7,
      window: { title: 'Mortise', role: 'main' },
      route: { surface: 'settings', section: 'extensions' },
      regions: {
        dialog: [{ ref: 'confirm', role: 'dialog', name: 'Confirm reload', state: {}, actions: ['click'] }],
        main: Array.from({ length: 8 }, (_, index) => ({
          ref: `main-${index}`,
          semanticId: `main.${index}`,
          role: 'button',
          name: `Main action ${index}`,
          state: {},
          actions: ['click'],
        })),
      },
      truncated: true,
    })

    expect(briefing.targets).toHaveLength(6)
    expect(briefing.targets[0]).toMatchObject({ label: 'Confirm reload', region: 'dialog' })
    expect(briefing.nextActions.length).toBeLessThanOrEqual(3)
    expect(briefing.attention).toEqual(['Confirm reload requires attention.'])
    expect(briefing.summary).toContain('9 actionable targets; 6 decision-relevant targets shown')
    expect(briefing.disclosure).toMatchObject({
      targets: { shown: 6, total: 9, omitted: 3 },
      details: { command: 'snapshot', argv: ['--full-observation'] },
    })
  })

  it('keeps node-level action changes behind full observation', () => {
    const action = {
      actionId: 'action-1',
      beforeRevision: 1,
      afterRevision: 2,
      targetResolved: { role: 'button', name: 'Reload extensions' },
      settledBy: ['semantic-command-ack'],
      warnings: [],
      mode: 'semantic',
      stateChanges: [{ key: 'reload', before: false, after: true }],
    }
    const snapshot = {
      revision: 2,
      full: false,
      window: { title: 'Mortise', role: 'main', bounds: { x: 0, y: 0, width: 1000, height: 700 } },
      route: { surface: 'settings' },
      regions: { main: [] },
      changes: { added: [{ ref: 'new-node' }], updated: [], removed: [] },
      truncated: false,
    }

    const compact = createActionObservation(action, snapshot)
    expect(compact.action).not.toHaveProperty('stateChanges')
    expect(compact.observed).not.toHaveProperty('regions')
    expect(compact.semanticDelta).toMatchObject({ added: 1, updated: 0, removed: 0, stateChanges: 1 })
    expect(compact.semanticDelta).not.toHaveProperty('changes')
    expect(compact.disclosure).toMatchObject({ command: 'action', argv: ['--full-observation'] })

    const full = createActionObservation(action, snapshot, true)
    expect(full.action).toHaveProperty('stateChanges')
    expect(full.observed).toHaveProperty('regions')
    expect(full.semanticDelta).toHaveProperty('changes')
    expect(full.semanticDelta).toHaveProperty('stateChangeDetails')
  })

  it('does not invent a recommendation when several targets require task context', () => {
    const briefing = createSnapshotBriefing({
      regions: { main: [
        { semanticId: 'composer', role: 'textbox', name: 'Message', state: {}, actions: ['click', 'fill'] },
        { semanticId: 'send', role: 'button', name: 'Send', state: {}, actions: ['click'] },
      ] },
    })

    expect(briefing.nextActions).toEqual([])
    expect(briefing.targets[0]?.suggestedAction).toMatchObject({ target: { semanticId: 'composer' }, action: 'fill' })
  })

  it('turns native snapshot nodes into revision-bound actions', () => {
    const briefing = createSnapshotBriefing({
      revision: 3,
      windows: [{ name: 'Open dialog', nodes: [{
        ref: 'n3:open', role: 'button', name: 'Open', enabled: true, focused: false, actions: ['click'],
      }] }],
    })

    expect(briefing.targets).toEqual([expect.objectContaining({
      label: 'Open',
      suggestedAction: {
        target: { kind: 'native', ref: 'n3:open' },
        revision: 3,
        action: 'click',
        mode: 'native',
      },
    })])
  })

  it('includes the embedded surface revision in BrowserView actions', () => {
    const briefing = createSnapshotBriefing({
      embeddedSurfaces: [{ instanceId: 'browser-1', revision: 4, nodes: [{
        ref: 'b4:browser-1:e1', role: 'button', name: 'Continue', actions: ['click'],
      }] }],
    })

    expect(briefing.targets[0]?.suggestedAction).toEqual({
      target: { kind: 'browser', instanceId: 'browser-1', ref: 'b4:browser-1:e1' },
      revision: 4,
      action: 'click',
    })
  })

  it('returns only the current route and currently advertised actions as relevant', () => {
    const briefing = createSnapshotBriefing({
      route: { surface: 'settings' },
      regions: { main: [{ semanticId: 'save', role: 'button', name: 'Save', state: {}, actions: ['click'] }] },
    })
    const result = selectRelevantCapabilities({
      protocolVersion: 1,
      items: [
        { kind: 'route', id: 'settings', description: 'Settings' },
        { kind: 'route', id: 'chat', description: 'Chat' },
        { kind: 'action', id: 'click', description: 'Click' },
        { kind: 'action', id: 'fill', description: 'Fill' },
      ],
      runtimeDiscovery: { extensionDefinitions: { method: 'ui.snapshot' } },
    }, briefing)

    expect(result.items).toEqual([
      expect.objectContaining({ kind: 'route', id: 'settings' }),
      expect.objectContaining({ kind: 'action', id: 'click' }),
    ])
    expect(result).not.toHaveProperty('runtimeDiscovery')
    expect(result.disclosure).toMatchObject({ shown: 2, total: 4, omitted: 2 })
  })
})
