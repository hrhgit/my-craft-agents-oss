import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export function latestInputMtime(path: string): number {
  if (!existsSync(path)) return Number.POSITIVE_INFINITY
  const stats = statSync(path)
  if (!stats.isDirectory()) return stats.mtimeMs

  let latest = stats.mtimeMs
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    latest = Math.max(latest, latestInputMtime(join(path, entry.name)))
  }
  return latest
}

export function needsDevBuild(outputPath: string, inputPaths: string[]): boolean {
  if (!existsSync(outputPath)) return true
  const outputMtime = statSync(outputPath).mtimeMs
  return inputPaths.some(inputPath => latestInputMtime(inputPath) > outputMtime)
}
