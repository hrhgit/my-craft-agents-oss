import { describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertNoSourceRootReferences } from '../bundle-portability'

describe('production bundle portability', () => {
  const root = resolve('C:/work/mortise')

  it('rejects file URLs and path literals that identify the source checkout', () => {
    expect(() => assertNoSourceRootReferences(
      `createRequire(${JSON.stringify(pathToFileURL(resolve(root, 'packages/tool.ts')).href)})`,
      'session-mcp-server/index.js',
      root,
    )).toThrow('embeds its source checkout root')
    expect(() => assertNoSourceRootReferences(
      JSON.stringify(resolve(root, 'packages/tool.ts')),
      'session-mcp-server/index.js',
      root,
    )).toThrow('embeds its source checkout root')
  })

  it('accepts runtime-relative and unrelated paths', () => {
    expect(() => assertNoSourceRootReferences(
      "require('./runtime.js'); const cache = 'C:/Users/user/.mortise'",
      'session-mcp-server/index.js',
      root,
    )).not.toThrow()
  })
})
