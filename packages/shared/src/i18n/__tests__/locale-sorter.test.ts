import { describe, expect, test } from 'bun:test'
import { formatLocaleDocument } from '../../../../../scripts/sort-locales'

describe('locale sorter', () => {
  test('accepts a sorted CRLF document without rewriting its line endings', () => {
    const document = '{\r\n  "a": "A",\r\n  "b": "B"\r\n}\r\n'

    expect(formatLocaleDocument(document)).toEqual({
      changed: false,
      formatted: document,
    })
  })

  test('sorts an unordered CRLF document while preserving its line endings', () => {
    const result = formatLocaleDocument('{\r\n  "b": "B",\r\n  "a": "A"\r\n}\r\n')

    expect(result).toEqual({
      changed: true,
      formatted: '{\r\n  "a": "A",\r\n  "b": "B"\r\n}\r\n',
    })
  })

  test('still rejects formatting drift unrelated to line-ending style', () => {
    const result = formatLocaleDocument('{"a":"A"}\r\n')

    expect(result.changed).toBe(true)
    expect(result.formatted).toBe('{\r\n  "a": "A"\r\n}\r\n')
  })

  test('normalizes mixed line endings to the document style', () => {
    const result = formatLocaleDocument('{\r\n  "a": "A",\n  "b": "B"\r\n}\r\n')

    expect(result.changed).toBe(true)
    expect(result.formatted).toBe('{\r\n  "a": "A",\r\n  "b": "B"\r\n}\r\n')
  })
})
