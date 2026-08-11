import { createHash } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { PROTOCOL_VERSION, REQUIRED_PROTOCOL_CAPABILITIES } from '@mortise/shared/protocol'
import { downloadUv, type Arch, type BuildConfig, type Platform } from './common.ts'
import { writeJsonAtomic } from './files.ts'

const repoRoot = resolve(import.meta.dir, '..', '..')
const electronDir = join(repoRoot, 'apps', 'electron')
const packagingRoot = join(electronDir, 'dist', 'packaging-inputs')
const platform = process.platform
const arch = process.arch

if (!['darwin', 'win32', 'linux'].includes(platform)) {
  throw new Error(`Unsupported Electron packaging platform: ${platform}`)
}
if (!['x64', 'arm64'].includes(arch)) {
  throw new Error(`Unsupported Electron packaging architecture: ${arch}`)
}

const buildConfig: BuildConfig = {
  platform: platform as Platform,
  arch: arch as Arch,
  upload: false,
  uploadLatest: false,
  uploadScript: false,
  rootDir: repoRoot,
  electronDir,
}

rmSync(packagingRoot, { recursive: true, force: true })
mkdirSync(packagingRoot, { recursive: true })

for (const name of ['electron-builder.yml', 'electron-builder.devhost.yml']) {
  copyRequired(join(electronDir, name), join(packagingRoot, name))
}
copyRequired(join(electronDir, 'package.json'), join(packagingRoot, 'runtime-package.json'))
writeJsonAtomic(join(packagingRoot, 'workspace-rpc-protocol.json'), {
  schemaVersion: 1,
  protocolVersion: PROTOCOL_VERSION,
  protocolCapabilities: [...REQUIRED_PROTOCOL_CAPABILITIES],
})
for (const name of ['beforePack.cjs', 'afterPack.cjs', 'afterSign.cjs']) {
  copyRequired(join(electronDir, 'scripts', name), join(packagingRoot, 'hooks', name))
}
cpRequired(join(electronDir, 'build'), join(packagingRoot, 'build'))
copyRequired(
  join(repoRoot, 'packages', 'messaging-whatsapp-worker', 'dist', 'worker.cjs'),
  join(packagingRoot, 'runtime', 'messaging-whatsapp-worker', 'worker.cjs'),
)
cpRequired(
  join(repoRoot, 'node_modules', '@vscode', 'ripgrep'),
  join(packagingRoot, 'runtime', 'ripgrep'),
)
cpRequired(
  join(repoRoot, 'node_modules', 'electron', 'dist'),
  join(packagingRoot, 'runtime', 'electron'),
)

const bunName = platform === 'win32' ? 'bun.exe' : 'bun'
const bunTarget = join(packagingRoot, 'runtime', 'bun', bunName)
copyRequired(process.execPath, bunTarget)

const uvDirectory = join(electronDir, 'resources', 'bin', `${platform}-${arch}`)
rmSync(uvDirectory, { recursive: true, force: true })
await downloadUv(buildConfig)
cpRequired(uvDirectory, join(electronDir, 'dist', 'resources', 'bin', `${platform}-${arch}`))

const bun = readFileSync(bunTarget)
const electronExecutableName = platform === 'win32'
  ? 'electron.exe'
  : platform === 'darwin'
    ? join('Electron.app', 'Contents', 'MacOS', 'Electron')
    : 'electron'
const electronExecutable = join(packagingRoot, 'runtime', 'electron', electronExecutableName)
const electron = readFileSync(electronExecutable)
writeJsonAtomic(join(packagingRoot, 'toolchain.json'), {
  schemaVersion: 1,
  bunVersion: process.versions.bun ?? process.version,
  bunExecutable: basename(bunTarget),
  bunSizeBytes: bun.byteLength,
  bunSha256: createHash('sha256').update(bun).digest('hex'),
  electronVersion: readFileSync(join(repoRoot, 'node_modules', 'electron', 'dist', 'version'), 'utf8').trim(),
  electronExecutable: electronExecutableName.replaceAll('\\', '/'),
  electronSizeBytes: electron.byteLength,
  electronSha256: createHash('sha256').update(electron).digest('hex'),
})

function copyRequired(source: string, destination: string): void {
  if (!existsSync(source)) throw new Error(`Required Electron packaging input is missing: ${source}`)
  mkdirSync(dirname(destination), { recursive: true })
  copyFileSync(source, destination)
}

function cpRequired(source: string, destination: string): void {
  if (!existsSync(source)) throw new Error(`Required Electron packaging input is missing: ${source}`)
  mkdirSync(dirname(destination), { recursive: true })
  cpSync(source, destination, { recursive: true, force: true, dereference: true })
}
