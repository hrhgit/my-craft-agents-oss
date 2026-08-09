import { describe, it, expect } from 'bun:test'
import { isEscapeDuringComposition, shouldShowPlaceholder } from '../rich-text-input'

describe('isEscapeDuringComposition', () => {
  it('returns true for Escape when local composition ref is active', () => {
    expect(isEscapeDuringComposition({ key: 'Escape' }, true)).toBe(true)
  })

  it('returns true for Escape when nativeEvent.isComposing is true', () => {
    expect(
      isEscapeDuringComposition(
        { key: 'Escape', nativeEvent: { isComposing: true } },
        false
      )
    ).toBe(true)
  })

  it('returns true for Escape when event.isComposing is true', () => {
    expect(isEscapeDuringComposition({ key: 'Escape', isComposing: true }, false)).toBe(true)
  })

  it('returns false for Escape when no composition signal is active', () => {
    expect(isEscapeDuringComposition({ key: 'Escape' }, false)).toBe(false)
  })

  it('returns false for non-Escape keys even if composing', () => {
    expect(isEscapeDuringComposition({ key: 'Enter', isComposing: true }, true)).toBe(false)
  })
})

describe('shouldShowPlaceholder', () => {
  it('shows placeholder only when both DOM and model value are empty', () => {
    expect(shouldShowPlaceholder(false, '')).toBe(true)
    expect(shouldShowPlaceholder(false, '   ')).toBe(true)
    // Empty contenteditable contains a <br>, which getTextFromElement maps to '\n'
    expect(shouldShowPlaceholder(false, '\n')).toBe(true)
  })

  it('hides placeholder when the DOM has content even if the model value lags (IME composition)', () => {
    expect(shouldShowPlaceholder(true, '')).toBe(false)
    expect(shouldShowPlaceholder(true, '你好')).toBe(false)
  })

  it('hides placeholder when the model value has content even if the DOM is momentarily empty', () => {
    expect(shouldShowPlaceholder(false, '你好')).toBe(false)
    expect(shouldShowPlaceholder(true, ' ')).toBe(false)
  })
})
