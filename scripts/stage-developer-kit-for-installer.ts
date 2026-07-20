import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

if (process.platform !== 'win32') {
  process.stdout.write('[Mortise] Skipping offline Developer Kit staging outside Windows.\n')
  process.exit(0)
}

interface DeveloperKitBuildManifest {
  artifactDirectory?: unknown
}

interface DeveloperKitManifest {
  hostVersion?: unknown
}

interface ElectronPackageManifest {
  version?: unknown
}

const repoRoot = resolve(import.meta.dir, '..')
const stagedKitDirectory = join(repoRoot, 'apps', 'electron', 'dist', 'installer-developer-kit')
const buildResult = spawnSync('bun', ['run', join(repoRoot, 'scripts', 'build-developer-kit.ts'), '--no-archive'], {
  cwd: repoRoot,
  env: process.env,
  stdio: 'inherit',
  windowsHide: true,
})

if (buildResult.error) throw buildResult.error
if (buildResult.status !== 0) {
  throw new Error(`Developer Kit build for installer failed with exit code ${buildResult.status ?? 'unknown'}.`)
}

const manifestPath = join(repoRoot, 'output', 'developer-kit-latest.json')
let manifest: DeveloperKitBuildManifest
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as DeveloperKitBuildManifest
} catch {
  throw new Error(`Developer Kit build did not publish a readable manifest at ${manifestPath}.`)
}

if (typeof manifest.artifactDirectory !== 'string' || !existsSync(manifest.artifactDirectory)) {
  throw new Error('Developer Kit build did not publish an artifact directory for the installer.')
}

const kitManifestPath = join(manifest.artifactDirectory, 'developer-kit.json')
const electronPackagePath = join(repoRoot, 'apps', 'electron', 'package.json')
const kitManifest = JSON.parse(readFileSync(kitManifestPath, 'utf8')) as DeveloperKitManifest
const electronPackage = JSON.parse(readFileSync(electronPackagePath, 'utf8')) as ElectronPackageManifest
if (typeof kitManifest.hostVersion !== 'string' || kitManifest.hostVersion !== electronPackage.version) {
  throw new Error(`Developer Kit host version ${String(kitManifest.hostVersion)} does not match Mortise ${String(electronPackage.version)}.`)
}

rmSync(stagedKitDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
mkdirSync(stagedKitDirectory, { recursive: true })
cpSync(manifest.artifactDirectory, stagedKitDirectory, { recursive: true, force: true })
process.stdout.write(`[Mortise] Staged offline Developer Kit: ${stagedKitDirectory}\n`)
