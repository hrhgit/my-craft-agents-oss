import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { immutableRuntimeRequiredAppPaths } from '@mortise/session-tools-core/runtime'
import { ELECTRON_BUILD_INPUTS } from '../build-inputs.ts'
import {
  acquireElectronBuild,
  releaseElectronBuild,
} from '../electron-build-cache.ts'

const [repoRootArg, buildRootArg, runDirArg, runId, counterPath, resultPath, startedPath, releasePath] = process.argv.slice(2)
if (!repoRootArg || !buildRootArg || !runDirArg || !runId || !counterPath || !resultPath) {
  throw new Error('build-cache worker requires repoRoot, buildRoot, runDir, runId, counterPath, and resultPath')
}

const repoRoot = resolve(repoRootArg)
const buildRoot = resolve(buildRootArg)
const runDir = resolve(runDirArg)
const lease = acquireElectronBuild({
  repoRoot,
  buildRoot,
  runDir,
  runId,
  build: sourceRoot => {
    appendFileSync(counterPath, `${process.pid}\n`, 'utf8')
    if (startedPath) writeFileSync(startedPath, `${process.pid}\n`, 'utf8')
    if (releasePath) waitForFile(releasePath, 15_000)
    seedBuildOutputs(sourceRoot, repoRoot)
  },
})
writeFileSync(resultPath, JSON.stringify({ buildId: lease.buildId, appDir: lease.appDir }), 'utf8')
releaseElectronBuild(lease)

function seedBuildOutputs(root: string, content: string): void {
  const appDir = join(root, 'apps', 'electron')
  const distDir = join(appDir, 'dist')
  mkdirSync(appDir, { recursive: true })
  writeFileSync(join(appDir, 'package.json'), JSON.stringify({ name: '@mortise/electron-test', main: 'dist/main.cjs', type: 'module' }), 'utf8')
  for (const input of ELECTRON_BUILD_INPUTS) {
    if (!input.required) continue
    const target = join(root, ...input.path.split('/'), 'package.json')
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, JSON.stringify({ name: `@mortise/${input.path.replaceAll('/', '-')}` }), 'utf8')
  }
  for (const path of immutableRuntimeRequiredAppPaths()) {
    const target = join(appDir, ...path.split('/'))
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, content, 'utf8')
  }
  const fixture = join(distDir, 'resources', 'fixture.txt')
  mkdirSync(join(fixture, '..'), { recursive: true })
  writeFileSync(fixture, content, 'utf8')
}

function waitForFile(path: string, timeoutMs: number): void {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for build barrier: ${path}`)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
  }
}
