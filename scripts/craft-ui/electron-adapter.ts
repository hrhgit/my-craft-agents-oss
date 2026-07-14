import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '..', '..')
const markerPath = resolve(root, 'apps', 'electron', 'dist', '.ui-validation-build.json')
const requiredOutputs = [
  resolve(root, 'apps', 'electron', 'dist', 'main.cjs'),
  resolve(root, 'apps', 'electron', 'dist', 'bootstrap-preload.cjs'),
  resolve(root, 'apps', 'electron', 'dist', 'renderer', 'index.html'),
]
const skipBuild = process.env.CRAFT_UI_SKIP_BUILD === '1'
const sourceMtimeMs = latestSourceMtime([
  resolve(root, 'apps', 'electron', 'src'),
  resolve(root, 'apps', 'webui', 'src'),
  resolve(root, 'packages', 'shared', 'src'),
  resolve(root, 'packages', 'server-core', 'src'),
  resolve(root, 'packages', 'ui', 'src'),
  resolve(root, 'scripts', 'build'),
  resolve(root, 'scripts', 'electron-build-main.ts'),
  resolve(root, 'scripts', 'electron-build-preload.ts'),
  resolve(root, 'scripts', 'electron-build-renderer.ts'),
  resolve(root, 'scripts', 'electron-build-resources.ts'),
])
const marker = readMarker(markerPath)
if (skipBuild && (!marker || marker.sourceMtimeMs < sourceMtimeMs || requiredOutputs.some(path => !existsSync(path)))) {
  throw new Error('CRAFT_UI_SKIP_BUILD requires a completed source UI validation build marker and all Electron outputs.')
}

const build = skipBuild ? undefined : spawn(process.execPath, ['run', 'electron:build'], {
  cwd: root,
  env: { ...process.env, CRAFT_UI_VALIDATION_BUILD: '1', CRAFT_UI_TEST_HOST: '1' },
  stdio: 'inherit',
  windowsHide: true,
})
let activeChild = build
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => activeChild?.kill(signal))
}

if (build) {
  const buildExit = await new Promise<number>((resolveExit, reject) => {
    build.once('error', reject)
    build.once('exit', code => resolveExit(code ?? 1))
  })
  if (buildExit !== 0) process.exit(buildExit)
  writeFileSync(markerPath, `${JSON.stringify({ protocolVersion: 1, validationBuild: true, sourceMtimeMs, completedAt: new Date().toISOString() })}\n`, 'utf8')
}

const electronExecutable = String(createRequire(import.meta.url)('electron'))
const electron = spawn(electronExecutable, [resolve(root, 'apps', 'electron')], {
  cwd: root,
  env: { ...process.env, CRAFT_UI_VALIDATION_BUILD: '1', CRAFT_UI_TEST_HOST: '1' },
  stdio: 'inherit',
  windowsHide: true,
})
activeChild = electron

const exit = await new Promise<number>((resolveExit, reject) => {
  electron.once('error', reject)
  electron.once('exit', code => resolveExit(code ?? 0))
})
process.exit(exit)

function readMarker(path: string): { sourceMtimeMs: number } | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as { protocolVersion?: unknown; validationBuild?: unknown; sourceMtimeMs?: unknown }
    if (value.protocolVersion !== 1 || value.validationBuild !== true || typeof value.sourceMtimeMs !== 'number') return undefined
    return { sourceMtimeMs: value.sourceMtimeMs }
  } catch { return undefined }
}

function latestSourceMtime(roots: string[]): number {
  let latest = 0
  const visit = (path: string): void => {
    if (!existsSync(path)) return
    const stat = statSync(path)
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'output') continue
        visit(resolve(path, entry.name))
      }
      return
    }
    latest = Math.max(latest, stat.mtimeMs)
  }
  for (const path of roots) visit(path)
  return latest
}
