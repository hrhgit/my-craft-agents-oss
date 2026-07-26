#!/usr/bin/env bun
/**
 * sort-locales.ts — Sort top-level keys alphabetically in every locale JSON.
 *
 * Convention enforced by `packages/shared/CLAUDE.md` § i18n Rules #7 and the
 * `locale-parity.test.ts` test. New keys appended to a file in any order get
 * normalized in-place. Run via `bun run sort-locales` (or `--check` in CI).
 *
 * Format: 2-space indent, trailing newline, no other transformations.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const LOCALES_DIR = resolve(
  import.meta.dir ?? new URL('.', import.meta.url).pathname,
  '..',
  'packages',
  'shared',
  'src',
  'i18n',
  'locales',
)

export function formatLocaleDocument(original: string): { changed: boolean; formatted: string } {
  const lineEnding = original.includes('\r\n') ? '\r\n' : '\n'
  const parsed = JSON.parse(original) as Record<string, unknown>

  const sortedKeys = Object.keys(parsed).sort()
  const sorted: Record<string, unknown> = {}
  for (const key of sortedKeys) sorted[key] = parsed[key]

  const canonical = JSON.stringify(sorted, null, 2) + '\n'
  const formatted = lineEnding === '\r\n' ? canonical.replace(/\n/g, '\r\n') : canonical
  return {
    changed: formatted !== original,
    formatted,
  }
}

function run(): number {
  const checkOnly = process.argv.includes('--check')
  const localeFiles = readdirSync(LOCALES_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()

  let drift = 0
  for (const file of localeFiles) {
    const path = resolve(LOCALES_DIR, file)
    const original = readFileSync(path, 'utf-8')
    const { changed, formatted } = formatLocaleDocument(original)

    if (!changed) continue

    drift++
    if (checkOnly) {
      console.error(`drift: ${file} is not sorted`)
    } else {
      writeFileSync(path, formatted, 'utf-8')
      console.log(`sorted: ${file}`)
    }
  }

  if (checkOnly && drift > 0) {
    console.error(`\n${drift} locale file(s) out of order. Run \`bun run sort-locales\` to fix.`)
    return 1
  }

  if (!checkOnly && drift === 0) {
    console.log('all locale files already sorted')
  }

  return 0
}

if (import.meta.main) process.exitCode = run()
