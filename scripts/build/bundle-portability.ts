import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function assertNoSourceRootReferences(
  source: string,
  artifact: string,
  sourceRoot: string,
): void {
  const root = resolve(sourceRoot)
  const candidates = new Set([
    root,
    root.replaceAll('\\', '/'),
    root.replaceAll('\\', '\\\\'),
    pathToFileURL(root).href,
  ])
  const haystack = process.platform === 'win32' ? source.toLowerCase() : source
  const match = [...candidates].find(candidate =>
    haystack.includes(process.platform === 'win32' ? candidate.toLowerCase() : candidate),
  )
  if (match) {
    throw new Error(`${artifact} embeds its source checkout root (${match})`)
  }
}
