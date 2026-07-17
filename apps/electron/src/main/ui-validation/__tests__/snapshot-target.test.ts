import { describe, expect, it } from 'bun:test'
import type { UiDriverSnapshotNode } from '../electron-surface-driver'
import { findRendererSnapshotTargets, resolveRendererSnapshotTarget } from '../snapshot-target'

function node(overrides: Partial<UiDriverSnapshotNode>): UiDriverSnapshotNode {
  return {
    ref: 'r1:node',
    role: 'button',
    name: 'Run',
    state: {},
    actions: ['click'],
    ...overrides,
  }
}

describe('renderer snapshot target resolution', () => {
  const nodes = [
    node({ ref: 'r1:semantic', semanticId: 'workspace.tab.release', role: 'tab', name: 'Release readiness' }),
    node({ ref: 'r1:test', testId: 'composer-input', role: 'textbox', name: 'Message' }),
    node({ ref: 'r1:settings', role: 'button', name: 'Open Settings' }),
  ]

  it('resolves semantic IDs, test IDs, and named roles', () => {
    expect(resolveRendererSnapshotTarget(nodes, { semanticId: 'workspace.tab.release' }).ref).toBe('r1:semantic')
    expect(resolveRendererSnapshotTarget(nodes, { testId: 'composer-input' }).ref).toBe('r1:test')
    expect(resolveRendererSnapshotTarget(nodes, { role: 'button', name: 'settings', exact: false }).ref).toBe('r1:settings')
  })

  it('rejects missing and ambiguous role targets', () => {
    expect(() => resolveRendererSnapshotTarget(nodes, { testId: 'missing' })).toThrow('No renderer node matched')
    expect(() => resolveRendererSnapshotTarget([...nodes, node({ ref: 'r1:other' })], { role: 'button' })).toThrow('more than one')
  })

  it('uses exact role names unless substring matching is requested', () => {
    expect(findRendererSnapshotTargets(nodes, { role: 'button', name: 'Settings' })).toHaveLength(0)
    expect(findRendererSnapshotTargets(nodes, { role: 'button', name: 'Settings', exact: false })).toHaveLength(1)
  })
})
