import { readFileSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

export const RENDERER_ENTRY_BUDGETS = {
  'index.html': 5_200_000,
  'playground.html': 1_250_000,
} as const

export interface StaticEntryGraph {
  html: string
  totalBytes: number
  chunks: Array<{ name: string; bytes: number }>
}

const SCRIPT_SOURCE_RE = /<script[^>]+src=["']\.\/assets\/([^"']+\.js)["']/g
const STATIC_IMPORT_RE = /(?:from\s*|import\s*)["']\.\/([^"']+\.js)["']/g

export function measureStaticEntryGraph(rendererDir: string, htmlName: string): StaticEntryGraph {
  const html = readFileSync(join(rendererDir, htmlName), 'utf8')
  const entries = [...html.matchAll(SCRIPT_SOURCE_RE)].map(match => match[1]!)
  if (entries.length === 0) throw new Error(`${htmlName} has no renderer module entry`)

  const assetsDir = join(rendererDir, 'assets')
  const seen = new Set<string>()
  const visit = (name: string): void => {
    if (seen.has(name)) return
    seen.add(name)
    const code = readFileSync(join(assetsDir, name), 'utf8')
    for (const match of code.matchAll(STATIC_IMPORT_RE)) visit(match[1]!)
  }
  for (const entry of entries) visit(entry)

  const chunks = [...seen]
    .map(name => ({ name, bytes: statSync(join(assetsDir, name)).size }))
    .sort((left, right) => right.bytes - left.bytes || left.name.localeCompare(right.name))
  return {
    html: htmlName,
    totalBytes: chunks.reduce((total, chunk) => total + chunk.bytes, 0),
    chunks,
  }
}

export function assertRendererEntryBudgets(
  rendererDir: string,
  budgets: Readonly<Record<string, number>> = RENDERER_ENTRY_BUDGETS,
): StaticEntryGraph[] {
  const graphs = Object.entries(budgets).map(([html, budget]) => {
    const graph = measureStaticEntryGraph(rendererDir, html)
    if (graph.totalBytes > budget) {
      const largest = graph.chunks.slice(0, 5)
        .map(chunk => `${chunk.name}=${chunk.bytes}`)
        .join(', ')
      throw new Error(
        `${html} static JavaScript graph is ${graph.totalBytes} bytes; budget is ${budget}. Largest chunks: ${largest}`,
      )
    }
    return graph
  })
  return graphs
}

if (import.meta.main) {
  const rendererDir = resolve(process.argv[2] ?? join(import.meta.dir, '../../apps/electron/dist/renderer'))
  for (const graph of assertRendererEntryBudgets(rendererDir)) {
    process.stdout.write(
      `[renderer-entry-budget] ${graph.html}: ${graph.totalBytes} bytes across ${graph.chunks.length} static chunks\n`,
    )
  }
}
