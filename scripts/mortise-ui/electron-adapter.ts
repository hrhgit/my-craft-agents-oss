import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { acquireElectronBuild, releaseElectronBuild } from './build-cache.ts'
import { updateRunManifest } from './controller.ts'

const root = resolve(import.meta.dir, '..', '..')
const runId = requiredEnv('MORTISE_UI_RUN_ID')
const runDir = resolve(requiredEnv('MORTISE_UI_RUN_DIR'))
let lease: ReturnType<typeof acquireElectronBuild>
try {
  lease = acquireElectronBuild({
    runId,
    runDir,
    repoRoot: root,
    skipBuild: process.env.MORTISE_UI_SKIP_BUILD === '1',
  })
} catch (error) {
  updateRunManifest(runDir, { buildError: error instanceof Error ? error.message : String(error) })
  throw error
}
updateRunManifest(runDir, { buildId: lease.buildId, buildDir: lease.buildDir })

let activeChild: ReturnType<typeof spawn> | undefined
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => activeChild?.kill(signal))
}

const electronExecutable = String(createRequire(import.meta.url)('electron'))
const electron = spawn(electronExecutable, [lease.appDir], {
  cwd: root,
  env: {
    ...process.env,
    MORTISE_UI_VALIDATION_BUILD: '1',
    MORTISE_UI_TEST_HOST: '1',
    MORTISE_UI_BUILD_ID: lease.buildId,
    MORTISE_UI_BUILD_DIR: lease.buildDir,
    MORTISE_UI_RUNTIME_APP_ROOT: lease.appDir,
    MORTISE_UI_RUNTIME_RESOURCES_DIR: join(lease.appDir, 'dist', 'resources'),
    MORTISE_UI_RUNTIME_RESOURCES_BASE: join(lease.appDir, 'dist'),
    MORTISE_WORKSPACE_SERVER_ENTRY: join(lease.appDir, 'dist', 'workspace-server.mjs'),
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
