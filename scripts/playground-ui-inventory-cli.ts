#!/usr/bin/env bun
import { resolve } from 'node:path'
import {
  buildPlaygroundUiInventory,
  checkPlaygroundUiCoverage,
  loadPlaygroundUiCoverageManifest,
} from './playground-ui-inventory'

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index === -1) return undefined
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

function assertKnownOptions(args: string[], allowed: string[]): void {
  for (let index = 0; index < args.length; index += 1) {
    if (!args[index]!.startsWith('--')) continue
    if (!allowed.includes(args[index]!)) throw new Error(`Unknown argument: ${args[index]}`)
    index += 1
  }
}

export async function execute(argv: string[]): Promise<{ code: number; output: string }> {
  const [command, ...args] = argv
  assertKnownOptions(args, command === 'check' ? ['--root', '--manifest'] : ['--root'])
  const root = resolve(option(args, '--root') ?? process.cwd())
  const inventory = await buildPlaygroundUiInventory(root)
  if (command === 'inventory') return { code: 0, output: `${JSON.stringify(inventory, null, 2)}\n` }
  if (command === 'check') {
    const manifest = option(args, '--manifest')
    if (!manifest) throw new Error('check requires --manifest')
    const result = checkPlaygroundUiCoverage(inventory, await loadPlaygroundUiCoverageManifest(resolve(root, manifest)))
    return { code: result.valid ? 0 : 2, output: `${JSON.stringify(result, null, 2)}\n` }
  }
  throw new Error(`Unknown or missing command: ${command ?? '<none>'}`)
}

export async function run(argv = process.argv.slice(2)): Promise<number> {
  try {
    const result = await execute(argv)
    process.stdout.write(result.output)
    return result.code
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ schema: 'playground-ui-inventory/error/v1', error: error instanceof Error ? error.message : String(error) })}\n`)
    return 1
  }
}

if (import.meta.main) process.exitCode = await run()
