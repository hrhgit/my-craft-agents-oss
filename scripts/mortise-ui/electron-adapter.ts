import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import {
  acquireElectronBuild,
  createElectronBuildRuntimeEnvironment,
  releaseElectronBuild,
  resolveElectronBuildExecutable,
} from '../build/electron-build-cache.ts'
import { updateRunManifest } from './controller.ts'

const root = resolve(import.meta.dir, '..', '..')
const runId = requiredEnv('MORTISE_UI_RUN_ID')
const runDir = resolve(requiredEnv('MORTISE_UI_RUN_DIR'))
let lease: ReturnType<typeof acquireElectronBuild>
try {
  lease = acquireElectronBuild({
    runId,
    runDir,
    mode: 'ui-validation',
    repoRoot: root,
    skipBuild: process.env.MORTISE_UI_SKIP_BUILD === '1',
  })
} catch (error) {
  updateRunManifest(runDir, { buildError: error instanceof Error ? error.message : String(error) })
  throw error
}
updateRunManifest(runDir, {
  buildId: lease.buildId,
  buildDir: lease.buildDir,
  sourceId: lease.manifest.sourceId,
})

let activeChild: ReturnType<typeof spawn> | undefined
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => activeChild?.kill(signal))
}

const electronExecutable = resolveElectronBuildExecutable(lease)
const electron = spawn(electronExecutable, [lease.appDir], {
  cwd: root,
  env: {
    ...process.env,
    MORTISE_UI_VALIDATION_BUILD: '1',
    MORTISE_UI_TEST_HOST: '1',
    ...createElectronBuildRuntimeEnvironment(lease, { uiValidation: true }),
  },
  stdio: 'inherit',
  windowsHide: true,
})
activeChild = electron

let exit = 1
try {
  exit = await new Promise<number>((resolveExit, reject) => {
    electron.once('error', reject)
    electron.once('exit', code => resolveExit(code ?? 0))
  })
} finally {
  try {
    releaseElectronBuild(lease)
  } catch (error) {
    console.error(`Mortise UI build cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}
process.exit(exit)

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required.`)
  return value
}
