import { spawn } from 'bun'
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  acquireElectronBuild,
  createElectronBuildRuntimeEnvironment,
  releaseElectronBuild,
  resolveElectronBuildExecutable,
} from './build/electron-build-cache.ts'
import { writeJsonAtomic } from './build/files.ts'
import { configureSharedBackend } from './shared-backend-discovery'

const rootDir = join(import.meta.dir, '..')
const env = { ...process.env }
const defaultConfigDir = join(homedir(), '.mortise')
const runId = `electron-start-${process.pid}-${randomUUID().slice(0, 8)}`
const runDir = join(rootDir, 'output', 'electron-build-runs', runId)

env.MORTISE_CONFIG_DIR ||= defaultConfigDir
const sharedBackend = await configureSharedBackend(env, defaultConfigDir)
if (sharedBackend) {
  console.log(`Reusing shared Mortise backend PID ${sharedBackend.pid} at ${sharedBackend.url}`)
}

mkdirSync(runDir, { recursive: true })
writeJsonAtomic(join(runDir, 'run.json'), {
  status: 'ready',
  runId,
  launcherPid: process.pid,
  createdAt: new Date().toISOString(),
})
const mode = process.env.MORTISE_DEV_RUNTIME === '1' ? 'development' : 'production'
const lease = acquireElectronBuild({ runId, runDir, repoRoot: rootDir, mode })
try {
  const electronBin = resolveElectronBuildExecutable(lease)
  const electron = spawn({
    cmd: [electronBin, lease.appDir],
    cwd: rootDir,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
    env: {
      ...env,
      ...createElectronBuildRuntimeEnvironment(lease),
    } as Record<string, string>,
  })
  process.exitCode = await electron.exited
} finally {
  releaseElectronBuild(lease)
  rmSync(runDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
