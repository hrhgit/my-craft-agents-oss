import { pruneBuildCaches, type BuildCachePruneOptions } from './build/build-cache-prune.ts'

const args = process.argv.slice(2)
const dryRun = !args.some(arg => arg.toLowerCase() === '--apply')
assertSupportedArguments(args)

const options: BuildCachePruneOptions = {
  dryRun,
  blocksRetain: optionInteger(args, '--blocks-retain'),
  packagesRetain: optionInteger(args, '--packages-retain'),
  buildsRetain: optionInteger(args, '--builds-retain'),
  maxBytes: optionInteger(args, '--max-bytes') ?? undefined,
}

const summary = pruneBuildCaches(options)

printSummary(summary)
if (dryRun) {
  process.stdout.write('\nDry-run: pass --apply to remove the listed cache entries.\n')
} else {
  process.stdout.write('\nBuild cache prune complete.\n')
}

function optionInteger(values: string[], name: string): number | undefined {
  const index = values.indexOf(name)
  if (index < 0) return undefined
  const value = values[index + 1]
  if (value === undefined || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${name} requires a non-negative integer value.`)
  }
  return Number(value)
}

function assertSupportedArguments(values: string[]): void {
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!
    if (value === '--apply') continue
    if (['--blocks-retain', '--packages-retain', '--builds-retain', '--max-bytes'].includes(value)) {
      if (!values[index + 1] || values[index + 1]!.startsWith('--')) throw new Error(`${value} requires a value.`)
      index += 1
      continue
    }
    throw new Error(`Unsupported build cache prune argument: ${value}`)
  }
}

function printSummary(summary: ReturnType<typeof pruneBuildCaches>): void {
  process.stdout.write(`Build cache prune (${summary.dryRun ? 'dry-run' : 'applied'})\n`)
  process.stdout.write(`blocks: ${summary.blocks.targets.length} to remove, ${summary.blocks.retained.length} retained\n`)
  for (const target of summary.blocks.targets) {
    process.stdout.write(`  ${formatBytes(target.sizeBytes)} ${target.kind} ${target.path}\n`)
  }
  process.stdout.write(`packages: ${summary.packages.targets.length} to remove, ${summary.packages.retained.length} retained\n`)
  for (const target of summary.packages.targets) {
    process.stdout.write(`  ${formatBytes(target.sizeBytes)} ${target.kind} ${target.path}\n`)
  }
  if (summary.dryRun) {
    process.stdout.write('builds: skipped in dry-run (existing cleanupElectronBuildCache)\n')
  } else {
    process.stdout.write(
      `builds: ${summary.builds.removedBuildIds.length} removed, ${summary.builds.retainedBuildIds.length} retained\n`,
    )
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}
