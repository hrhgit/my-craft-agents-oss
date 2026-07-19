import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { acquireElectronBuild, releaseElectronBuild } from '../build-cache.ts'

const [repoRootArg, buildRootArg, runDirArg, runId, fingerprint, counterPath, resultPath, startedPath, releasePath] = process.argv.slice(2)
if (!repoRootArg || !buildRootArg || !runDirArg || !runId || !fingerprint || !counterPath || !resultPath) {
  throw new Error('build-cache worker requires repoRoot, buildRoot, runDir, runId, fingerprint, counterPath, and resultPath')
}

const repoRoot = resolve(repoRootArg)
const buildRoot = resolve(buildRootArg)
const runDir = resolve(runDirArg)
const lease = acquireElectronBuild({
  repoRoot,
  buildRoot,
  runDir,
  runId,
  computeFingerprint: () => fingerprint,
  build: sourceRoot => {
    appendFileSync(counterPath, `${process.pid}\n`, 'utf8')
    if (startedPath) writeFileSync(startedPath, `${process.pid}\n`, 'utf8')
    if (releasePath) waitForFile(releasePath, 15_000)
    seedBuildOutputs(sourceRoot, fingerprint)
  },
})
writeFileSync(resultPath, JSON.stringify({ buildId: lease.buildId, appDir: lease.appDir }), 'utf8')
releaseElectronBuild(lease)

function seedBuildOutputs(root: string, content: string): void {
  const appDir = join(root, 'apps', 'electron')
  const distDir = join(appDir, 'dist')
  mkdirSync(join(distDir, 'renderer'), { recursive: true })
  mkdirSync(join(distDir, 'resources'), { recursive: true })
  mkdirSync(appDir, { recursive: true })
  writeFileSync(join(appDir, 'package.json'), JSON.stringify({ name: '@mortise/electron-test', main: 'dist/main.cjs', type: 'module' }), 'utf8')
  for (const path of ['main.cjs', 'bootstrap-preload.cjs', 'browser-toolbar-preload.cjs', 'workspace-server.mjs']) {
    writeFileSync(join(distDir, path), `// ${content}: ${path}\n`, 'utf8')
  }
  writeFileSync(join(distDir, 'renderer', 'index.html'), '<!doctype html>', 'utf8')
  writeFileSync(join(distDir, 'resources', 'fixture.txt'), content, 'utf8')
}

function waitForFile(path: string, timeoutMs: number): void {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for build barrier: ${path}`)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
  }
}
