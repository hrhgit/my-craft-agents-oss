import { describe, expect, test } from 'bun:test'
import { normalizePathForComparison, pathStartsWith, stripPathPrefix } from '../path-strings.ts'

describe('path-strings', () => {
  test('compares Windows paths case-insensitively', () => {
    expect(pathStartsWith('C:\\Work\\Project\\File.ts', 'c:\\work\\project')).toBe(true)
  })

  test('keeps original casing when stripping a Windows prefix', () => {
    expect(stripPathPrefix('C:\\Work\\Project\\Sub\\File.ts', 'c:\\work\\project')).toBe('Sub/File.ts')
  })

  test('handles POSIX root as a prefix boundary', () => {
    expect(pathStartsWith('/Users/alice/project/file.ts', '/')).toBe(true)
    expect(stripPathPrefix('/Users/alice/project/file.ts', '/')).toBe('Users/alice/project/file.ts')
  })

  test('does not treat sibling paths as children', () => {
    expect(pathStartsWith('/home/user2/file.txt', '/home/user')).toBe(false)
  })

  test('normalizes drive roots without losing Windows case-insensitive comparison', () => {
    expect(normalizePathForComparison('C:\\')).toBe('c:/')
    expect(pathStartsWith('c:\\Work\\File.ts', 'C:\\')).toBe(true)
  })
})
