import { describe, expect, it } from 'bun:test'
import {
  applySmartTypography,
  findSmartTypographyReplacement,
} from '../smart-typography'

describe('smart typography transaction replacement', () => {
  it('returns the smallest replacement range for the editor transaction', () => {
    expect(findSmartTypographyReplacement('hello <=> ', 10)).toEqual({
      from: 6,
      to: 9,
      text: '⇔',
      cursor: 8,
    })
  })

  it('preserves the public full-text transformation result', () => {
    expect(applySmartTypography('hello -> rest', 9)).toEqual({
      text: 'hello → rest',
      cursor: 8,
      replaced: true,
    })
  })

  it('does not replace patterns inside backticks or without a trailing space', () => {
    expect(findSmartTypographyReplacement('`-> `', 4)).toBeNull()
    expect(findSmartTypographyReplacement('->', 2)).toBeNull()
  })
})
