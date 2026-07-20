#!/usr/bin/env bun
import { resolve } from 'node:path'
import { impact, listModules, route, testModule } from './core.ts'
import type { ValidationLevelV1 } from './types.ts'
import { loadRepository, refreshModule, validateRepository } from './repository.ts'

class CliError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

function values(args: string[], flag: string): string[] {
  const result: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== flag) continue
    const value = args[index + 1]
    if (!value || value.startsWith('--')) throw new CliError('INVALID_ARGUMENT', `${flag} requires a value`)
    result.push(value)
  }
  return result
}

function value(args: string[], flag: string): string | undefined {
  const found = values(args, flag)
  if (found.length > 1) throw new CliError('INVALID_ARGUMENT', `${flag} may only be specified once`)
  return found[0]
}

function assertKnown(args: string[], valueFlags: string[], booleanFlags: string[] = []): void {
  const knownValues = new Set(valueFlags)
  const knownBooleans = new Set(booleanFlags)
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (!token.startsWith('--')) continue
    if (knownBooleans.has(token)) continue
    if (!knownValues.has(token)) throw new CliError('INVALID_ARGUMENT', `Unknown argument: ${token}`)
    if (!args[index + 1] || args[index + 1].startsWith('--')) throw new CliError('INVALID_ARGUMENT', `${token} requires a value`)
    index += 1
  }
}

export async function execute(argv: string[]): Promise<{ code: number; output: unknown }> {
  const [command, ...args] = argv
  if (!command || !['list', 'route', 'impact', 'validate', 'refresh', 'test'].includes(command)) throw new CliError('INVALID_ARGUMENT', `Unknown or missing command: ${command ?? '<none>'}`)
  const root = resolve(value(args, '--root') ?? process.cwd())
  const repo = await loadRepository(root)
  if (command === 'list') {
    assertKnown(args, ['--root'], ['--details'])
    return { code: 0, output: { schema: 'module-agent/list/v1', modules: listModules(repo, args.includes('--details')) } }
  }
  if (command === 'route') {
    assertKnown(args, ['--root', '--query', '--file'])
    const positional = args.filter((arg, index) => !arg.startsWith('--') && (index === 0 || !args[index - 1].startsWith('--')))
    const query = value(args, '--query') ?? positional.join(' ')
    const files = values(args, '--file')
    if (!query && !files.length) throw new CliError('INVALID_ARGUMENT', 'route requires --query, positional query text, or --file')
    return { code: 0, output: route(repo, query, files) }
  }
  if (command === 'impact') {
    assertKnown(args, ['--root', '--base'])
    const base = value(args, '--base')
    if (!base) throw new CliError('INVALID_ARGUMENT', 'impact requires --base')
    return { code: 0, output: await impact(repo, base) }
  }
  if (command === 'validate') {
    assertKnown(args, ['--root'], ['--strict'])
    const output = await validateRepository(repo, args.includes('--strict') || repo.config.strict)
    return { code: output.valid ? 0 : 2, output }
  }
  if (command === 'test') {
    assertKnown(args, ['--root', '--module', '--level'], ['--dry-run'])
    const id = value(args, '--module')
    const level = value(args, '--level')
    if (!id) throw new CliError('INVALID_ARGUMENT', 'test requires --module')
    if (!level || !['fast', 'contract', 'full'].includes(level)) throw new CliError('INVALID_ARGUMENT', 'test requires --level fast, contract, or full')
    const module = repo.modules.find(item => item.id === id)
    if (!module) throw new CliError('MODULE_NOT_FOUND', `Unknown module: ${id}`)
    const output = await testModule(repo, module, level as ValidationLevelV1, args.includes('--dry-run'))
    return { code: output.passed === false ? 2 : 0, output }
  }
  assertKnown(args, ['--root', '--module'], ['--all'])
  const ids = values(args, '--module')
  if (args.includes('--all') && ids.length) throw new CliError('INVALID_ARGUMENT', '--all and --module are mutually exclusive')
  if (!args.includes('--all') && ids.length === 0) throw new CliError('INVALID_ARGUMENT', 'refresh requires --all or at least one --module')
  const selected = args.includes('--all') ? repo.modules : ids.map(id => {
    const module = repo.modules.find(item => item.id === id)
    if (!module) throw new CliError('MODULE_NOT_FOUND', `Unknown module: ${id}`)
    return module
  })
  const refreshed = []
  for (const module of selected) refreshed.push({ module: module.id, scope_digest: await refreshModule(repo, module) })
  return { code: 0, output: { schema: 'module-agent/refresh/v1', refreshed } }
}

export async function run(argv = process.argv.slice(2), write: (line: string) => void = line => process.stdout.write(line)): Promise<number> {
  try {
    const result = await execute(argv)
    write(`${JSON.stringify(result.output)}\n`)
    return result.code
  } catch (error) {
    const code = error instanceof CliError ? error.code : 'MODULE_SYSTEM_ERROR'
    const message = error instanceof Error ? error.message : String(error)
    write(`${JSON.stringify({ schema: 'module-agent/error/v1', error: { code, message } })}\n`)
    return error instanceof CliError ? 1 : 3
  }
}

if (import.meta.main) process.exitCode = await run()
