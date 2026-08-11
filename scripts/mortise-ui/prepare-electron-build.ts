import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import {
  acquireElectronBuild,
  releaseElectronBuild,
} from '../build/electron-build-cache.ts'

export const MORTISE_UI_PREPARE_RESULT_PREFIX = '__MORTISE_UI_PREPARE_RESULT__'

export interface PreparedMortiseUiElectronBuild {
  buildId: string
  sourceId: string
  elapsedMs: number
}

export function prepareMortiseUiElectronBuild(options: {
  repoRoot?: string
  buildRoot?: string
  runRoot?: string
} = {}): PreparedMortiseUiElectronBuild {
  const startedAt = performance.now()
  const runId = `prepare-${randomUUID()}`
  const runDir = resolve(options.runRoot ?? process.cwd(), '.prepare', runId)
  const lease = acquireElectronBuild({
    runId,
    runDir,
    repoRoot: options.repoRoot,
    buildRoot: options.buildRoot,
    mode: 'ui-validation',
  })
  try {
    return {
      buildId: lease.buildId,
      sourceId: lease.manifest.sourceId,
      elapsedMs: Math.round(performance.now() - startedAt),
    }
  } finally {
    releaseElectronBuild(lease)
  }
}

if (import.meta.main) {
  try {
    const prepared = prepareMortiseUiElectronBuild({ runRoot: process.argv[2] })
    process.stdout.write(`${MORTISE_UI_PREPARE_RESULT_PREFIX}${JSON.stringify(prepared)}\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exit(1)
  }
}
