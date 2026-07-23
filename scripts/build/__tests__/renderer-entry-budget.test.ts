import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  assertRendererEntryBudgets,
  measureStaticEntryGraph,
} from '../renderer-entry-budget.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function createRenderer(): string {
  const root = mkdtempSync(join(tmpdir(), 'renderer-entry-budget-'))
  roots.push(root)
  const assets = join(root, 'assets')
  mkdirSync(assets)
  writeFileSync(join(root, 'index.html'), '<script type="module" src="./assets/main.js"></script>')
  writeFileSync(join(assets, 'main.js'), 'import "./shared.js"; import("./optional.js");')
  writeFileSync(join(assets, 'shared.js'), 'export const value = 1;')
  writeFileSync(join(assets, 'optional.js'), 'x'.repeat(1_000))
  return root
}

describe('renderer entry budgets', () => {
  it('counts only the transitive static import graph', () => {
    const renderer = createRenderer()
    const graph = measureStaticEntryGraph(renderer, 'index.html')

    expect(graph.chunks.map(chunk => chunk.name)).toEqual(['main.js', 'shared.js'])
    expect(graph.totalBytes).toBe(69)
  })

  it('reports the largest chunks when an entry exceeds its budget', () => {
    const renderer = createRenderer()

    expect(() => assertRendererEntryBudgets(renderer, { 'index.html': 20 }))
      .toThrow('Largest chunks: main.js=46, shared.js=23')
  })
})
