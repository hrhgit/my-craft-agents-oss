import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { acquireElectronBuild, releaseElectronBuild, withStagedElectronBuild } from './electron-build-cache.ts'
import { writeJsonAtomic } from './files.ts'

const repoRoot = resolve(import.meta.dir, '..', '..')
const runId = `production-${process.pid}-${randomUUID().slice(0, 8)}`
const runDir = join(repoRoot, 'output', 'electron-build-runs', runId)

mkdirSync(runDir, { recursive: true })
writeJsonAtomic(join(runDir, 'run.json'), {
  status: 'ready',
  runId,
  launcherPid: process.pid,
  createdAt: new Date().toISOString(),
})

const mode = process.env.MORTISE_DEV_RUNTIME === '1' ? 'development' : 'production'
const lease = acquireElectronBuild({ runId, runDir, repoRoot, mode })
try {
  withStagedElectronBuild(lease, staged => {
    console.log(`Electron production build ${staged.buildId.slice(0, 12)} validated from source ${staged.sourceId.slice(0, 12)}.`)
  })
  console.log(`Immutable build manifest: ${join(lease.buildDir, 'build.json')}`)
} finally {
  releaseElectronBuild(lease)
  rmSync(runDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
