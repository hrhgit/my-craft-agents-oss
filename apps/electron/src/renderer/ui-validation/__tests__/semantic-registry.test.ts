import { describe, expect, it } from 'bun:test'
import { UiSemanticRegistry } from '../semantic-registry'

describe('UiSemanticRegistry', () => {
  it('returns stable ordered business semantics and redacts sensitive values', () => {
    const registry = new UiSemanticRegistry()
    registry.register({ id: 'composer.s1.input', role: 'textbox', name: 'Message', value: 'secret prompt', sensitive: true, actions: ['fill'] })
    registry.register({ id: 'composer.s1.send', role: 'button', name: 'Send', state: { disabled: true }, actions: ['click', 'submit'] })
    const snapshot = registry.snapshot()
    expect(snapshot.nodes.map(node => node.id)).toEqual(['composer.s1.input', 'composer.s1.send'])
    expect(snapshot.nodes[0]?.value).toBe('[REDACTED]')
    expect(snapshot.nodes[1]?.state.disabled).toBe(true)
    expect(snapshot.nodes[0]?.domSelector).toContain('data-mortise-semantic-id')
  })

  it('bounds snapshots and clips strings', () => {
    const registry = new UiSemanticRegistry()
    registry.register({ id: 'one', role: 'button', name: 'x'.repeat(100), actions: ['click'] })
    registry.register({ id: 'two', role: 'button', name: 'two', actions: ['click'] })
    const snapshot = registry.snapshot({ maxNodes: 1, maxStringLength: 32 })
    expect(snapshot.nodes).toHaveLength(1)
    expect(snapshot.nodes[0]?.name).toHaveLength(32)
    expect(snapshot.truncated).toBe(true)
  })

  it('publishes complex physical input only when the component declares it', () => {
    const registry = new UiSemanticRegistry()
    registry.register({
      id: 'composer.s1.input', role: 'textbox', name: 'Message', actions: ['fill'],
      physicalActions: ['click', 'fill', 'shortcut', 'clipboard', 'ime', 'rich-text'],
    })
    const node = registry.snapshot().nodes[0]!
    expect(node.actionModes.semantic).toEqual(['fill'])
    expect(node.actionModes.physical).toEqual(['click', 'fill', 'shortcut', 'clipboard', 'ime', 'rich-text'])
    expect(node.actions).toEqual(['fill', 'click', 'shortcut', 'clipboard', 'ime', 'rich-text'])
  })

  it('rejects duplicate ids and disallowed or disabled actions', async () => {
    const registry = new UiSemanticRegistry()
    registry.register({ id: 'send', role: 'button', name: 'Send', state: { disabled: true }, actions: ['click'], invoke: () => {} })
    expect(() => registry.register({ id: 'send', role: 'button', name: 'Other', actions: [] })).toThrow('Duplicate')
    await expect(registry.invoke('send', 'click')).rejects.toThrow('disabled')
    await expect(registry.invoke('send', 'fill')).rejects.toThrow('not allowed')
  })

  it('invokes only registered command-backed actions and advances revision', async () => {
    const registry = new UiSemanticRegistry()
    let submitted = false
    registry.register({ id: 'send', role: 'button', name: 'Send', actions: ['submit'], invoke: () => { submitted = true } })
    const before = registry.revision
    const receipt = await registry.invoke('send', 'submit')
    expect(submitted).toBe(true)
    expect(receipt.beforeRevision).toBe(before)
    expect(receipt.afterRevision).toBeGreaterThan(before)
  })

  it('advances revision only when observable semantics change', () => {
    const registry = new UiSemanticRegistry()
    const definition = { id: 'send', role: 'button', name: 'Send', state: { disabled: false }, actions: ['click'] as const }
    const registration = registry.register(definition)
    const registeredRevision = registry.revision
    registration.update({ ...definition, invoke: () => {} })
    expect(registry.revision).toBe(registeredRevision)
    registration.update({ ...definition, state: { disabled: true } })
    expect(registry.revision).toBe(registeredRevision + 1)
  })
})
