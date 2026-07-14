import { describe, expect, it } from 'bun:test'
import type { UiBusinessSemanticNode } from '../types'
import { automaticSemanticState, disambiguateAutomaticNodes } from '../bridge'

function node(id: string, domSelector: string): UiBusinessSemanticNode {
  return {
    id,
    role: 'button',
    name: 'Open',
    state: {},
    actions: ['click'],
    actionModes: { semantic: [], physical: ['click'] },
    domSelector,
  }
}

describe('automatic UI semantics', () => {
  it('deterministically disambiguates repeated accessible names', () => {
    const first = node('primitive.button.open', 'main > button[data-slot="button"]:nth-child(1)')
    const second = node('primitive.button.open', 'main > button[data-slot="button"]:nth-child(2)')
    const once = disambiguateAutomaticNodes([first, second])
    const twice = disambiguateAutomaticNodes([first, second])
    expect(once.map(item => item.id)).toEqual(twice.map(item => item.id))
    expect(new Set(once.map(item => item.id)).size).toBe(2)
    expect(once.every(item => item.id.startsWith('primitive.button.open.'))).toBe(true)
  })

  it('preserves duplicate explicit IDs so resolution reports ambiguity', () => {
    const selector = '[data-craft-semantic-id="duplicate"]'
    expect(disambiguateAutomaticNodes([node('duplicate', selector), node('duplicate', selector)]).map(item => item.id))
      .toEqual(['duplicate', 'duplicate'])
  })

  it('reads checked, readonly, busy, hidden and false ARIA state', () => {
    expect(automaticSemanticState({
      role: 'switch',
      disabled: true,
      dataState: 'unchecked',
      ariaSelected: 'false',
      ariaExpanded: 'true',
      ariaBusy: 'true',
      ariaHidden: 'false',
      ariaReadonly: 'true',
      focused: true,
    })).toEqual({
      disabled: true,
      checked: false,
      selected: false,
      expanded: true,
      busy: true,
      hidden: false,
      readonly: true,
      focused: true,
    })
    expect(automaticSemanticState({ role: 'checkbox', disabled: false, indeterminate: true }).checked).toBe('mixed')
  })
})
