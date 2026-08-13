import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  publishVerifiedUvToolchain,
  UV_VERSION,
  type Arch,
  type Platform,
} from './common'

interface SeedUvToolchainOptions {
  cacheRoot?: string
  executable?: string
  platform?: Platform
  arch?: Arch
  readVersion?: (executable: string) => string
}

function currentPlatform(): Platform {
  if (process.platform === 'win32' || process.platform === 'darwin' || process.platform === 'linux') {
    return process.platform
  }
  throw new Error(`Unsupported uv toolchain platform: ${process.platform}`)
}

function currentArch(): Arch {
  if (process.arch === 'x64' || process.arch === 'arm64') return process.arch
  throw new Error(`Unsupported uv toolchain architecture: ${process.arch}`)
}

function defaultVersionReader(executable: string): string {
  return execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim()
}

export function seedCurrentUvToolchain(options: SeedUvToolchainOptions = {}): string {
  const discoveredExecutable = options.executable ?? Bun.which('uv')
  if (!discoveredExecutable) {
    throw new Error(`uv ${UV_VERSION} is not available on PATH`)
  }
  const executable = resolve(discoveredExecutable)

  const versionOutput = (options.readVersion ?? defaultVersionReader)(executable)
  const observedVersion = /^uv\s+(\S+)/.exec(versionOutput)?.[1]
  if (observedVersion !== UV_VERSION) {
    throw new Error(`Expected uv ${UV_VERSION}, observed ${versionOutput || 'no version output'}`)
  }

  const sha256 = createHash('sha256').update(readFileSync(executable)).digest('hex')
  const cacheRoot = resolve(options.cacheRoot ?? 'output/electron-builds/toolchains')
  const published = publishVerifiedUvToolchain(cacheRoot, {
    platform: options.platform ?? currentPlatform(),
    arch: options.arch ?? currentArch(),
  }, executable, sha256)
  console.log(`Published verified uv ${UV_VERSION} toolchain to ${published}`)
  return published
}

if (import.meta.main) seedCurrentUvToolchain()
