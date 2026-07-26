#!/usr/bin/env bun
import { resolve } from 'node:path'
import { impact, listModules, route, testModules } from './core.ts'
import { checkTaskPlan, closeTaskPlan, createTaskPlan, readTaskPlan } from './task-plan.ts'
import type { RepositoryValidationModeV1, TaskPlanPhaseV1, ValidationLevelV1, ValidationRiskTierV1 } from './types.ts'
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
  if (!command || !['list', 'route', 'impact', 'validate', 'refresh', 'test', 'plan'].includes(command)) throw new CliError('INVALID_ARGUMENT', `Unknown or missing command: ${command ?? '<none>'}`)
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
    assertKnown(args, ['--root'], ['--structure', '--freshness', '--strict'])
    const selected = (['structure', 'freshness', 'strict'] as const).filter(mode => args.includes(`--${mode}`))
    if (selected.length > 1) throw new CliError('INVALID_ARGUMENT', 'validate mode flags are mutually exclusive')
    const mode: RepositoryValidationModeV1 = selected[0] ?? (repo.config.strict ? 'strict' : 'structure')
    const output = await validateRepository(repo, mode)
    return { code: output.valid ? 0 : 2, output }
  }
  if (command === 'test') {
    assertKnown(args, ['--root', '--module', '--level', '--tier', '--plan', '--source-id', '--build-id'], ['--dry-run', '--reuse-receipts', '--fresh'])
    const planId = value(args, '--plan')
    const taskPlan = planId ? await readTaskPlan(repo, planId) : undefined
    const ids = [...new Set(values(args, '--module'))]
    if (!ids.length && taskPlan) ids.push(...taskPlan.owners)
    if (!ids.length) throw new CliError('INVALID_ARGUMENT', 'test requires --module or --plan')
    if (taskPlan && ids.some(id => !taskPlan.owners.includes(id))) throw new CliError('INVALID_ARGUMENT', '--module must stay within the task plan owner set')
    const levelValue = value(args, '--level')
    const tierValue = value(args, '--tier') as ValidationRiskTierV1 | undefined
    if (levelValue && tierValue) throw new CliError('INVALID_ARGUMENT', '--level and --tier are mutually exclusive')
    if (tierValue && !['A', 'B', 'C'].includes(tierValue)) throw new CliError('INVALID_ARGUMENT', 'test requires --tier A, B, or C')
    const tier = tierValue ?? taskPlan?.recommended_tier
    const level = levelValue ?? (tier === 'A' ? 'fast' : tier === 'B' ? 'contract' : tier === 'C' ? 'full' : undefined)
    if (!level || !['fast', 'contract', 'full'].includes(level)) throw new CliError('INVALID_ARGUMENT', 'test requires --level fast, contract, or full, or --tier A, B, or C')
    const modules = ids.map(id => {
      const module = repo.modules.find(item => item.id === id)
      if (!module) throw new CliError('MODULE_NOT_FOUND', `Unknown module: ${id}`)
      return module
    })
    const batch = await testModules(repo, modules.map(module => ({ module, level: level as ValidationLevelV1 })), {
      dryRun: args.includes('--dry-run'),
      reuseReceipts: args.includes('--reuse-receipts'),
      fresh: args.includes('--fresh'),
      sourceId: value(args, '--source-id') ?? taskPlan?.frozen_source_id,
      buildId: value(args, '--build-id'),
    })
    const output = modules.length === 1 ? batch.results[0] : batch
    return { code: output.passed === false ? 2 : 0, output }
  }
  if (command === 'plan') {
    const [action] = args
    if (!action || !['create', 'status', 'check', 'close'].includes(action)) throw new CliError('INVALID_ARGUMENT', 'plan requires create, status, check, or close')
    if (action === 'create') {
      assertKnown(args, ['--root', '--id', '--query', '--file', '--base'])
      const id = value(args, '--id')
      const query = value(args, '--query')
      if (!id || !query) throw new CliError('INVALID_ARGUMENT', 'plan create requires --id and --query')
      return { code: 0, output: await createTaskPlan(repo, { id, query, files: values(args, '--file'), base: value(args, '--base') ?? 'HEAD' }) }
    }
    if (action === 'status') {
      assertKnown(args, ['--root', '--id'])
      const id = value(args, '--id')
      if (!id) throw new CliError('INVALID_ARGUMENT', 'plan status requires --id')
      return { code: 0, output: await readTaskPlan(repo, id) }
    }
    if (action === 'check') {
      assertKnown(args, ['--root', '--id', '--phase', '--reviewed'])
      const id = value(args, '--id')
      const phase = value(args, '--phase') as Exclude<TaskPlanPhaseV1, 'closed'> | undefined
      if (!id) throw new CliError('INVALID_ARGUMENT', 'plan check requires --id')
      if (phase && !['discover', 'implement', 'integrate', 'accept', 'archive'].includes(phase)) throw new CliError('INVALID_ARGUMENT', 'Unknown task plan phase')
      const output = await checkTaskPlan(repo, id, phase, values(args, '--reviewed'))
      return { code: output.valid ? 0 : 2, output }
    }
    assertKnown(args, ['--root', '--id'])
    const id = value(args, '--id')
    if (!id) throw new CliError('INVALID_ARGUMENT', 'plan close requires --id')
    return { code: 0, output: await closeTaskPlan(repo, id) }
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
