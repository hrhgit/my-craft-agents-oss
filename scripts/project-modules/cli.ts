#!/usr/bin/env bun
import { resolve } from 'node:path'
import { buildProjectModuleCatalog, lintProjectModules, renderProjectModuleCatalog } from './catalog'

function rootFrom(args: string[]): string {
  const index = args.indexOf('--root')
  if (index === -1) return process.cwd()
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error('--root requires a value')
  return resolve(value)
}

export async function execute(argv: string[]): Promise<{ code: number; output: string }> {
  const [command, ...args] = argv
  const unknown = args.filter((value, index) => value.startsWith('--') && value !== '--root' && args[index - 1] !== '--root')
  if (unknown.length) throw new Error(`Unknown argument: ${unknown[0]}`)
  const root = rootFrom(args)
  if (command === 'catalog') {
    return { code: 0, output: renderProjectModuleCatalog(await buildProjectModuleCatalog(root)) }
  }
  if (command === 'lint') {
    const result = await lintProjectModules(root)
    return { code: result.valid ? 0 : 2, output: `${JSON.stringify(result)}\n` }
  }
  throw new Error(`Unknown or missing command: ${command ?? '<none>'}`)
}

export async function run(argv = process.argv.slice(2)): Promise<number> {
  try {
    const result = await execute(argv)
    process.stdout.write(result.output)
    return result.code
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      schema: 'project-modules/error/v1',
      error: error instanceof Error ? error.message : String(error),
    })}\n`)
    return 1
  }
}

if (import.meta.main) process.exitCode = await run()
