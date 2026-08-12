import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { DeveloperKitBuildManifest } from './developer-kit-build-manifest.ts'
import { writeJsonAtomic } from './files.ts'

export function ensureDeveloperKitArchive(outputRoot: string, manifest: DeveloperKitBuildManifest): string {
  if (manifest.archivePath && existsSync(manifest.archivePath) && statSync(manifest.archivePath).size > 0) {
    return manifest.archivePath
  }

  const publicationRoot = join(outputRoot, 'developer-kit-releases', manifest.buildId)
  const archivePath = join(publicationRoot, `${basename(manifest.artifactDirectory)}.zip`)
  const receiptPath = join(publicationRoot, 'archive.json')
  try {
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as {
      buildId?: string
      archivePath?: string
      sizeBytes?: number
    }
    if (
      receipt.buildId === manifest.buildId
      && resolve(receipt.archivePath ?? '') === resolve(archivePath)
      && existsSync(archivePath)
      && statSync(archivePath).size === receipt.sizeBytes
      && receipt.sizeBytes > 0
    ) {
      process.stdout.write(`[Mortise Developer Kit] Reusing archive ${basename(archivePath)}.\n`)
      return archivePath
    }
  } catch { /* derive a new archive */ }

  mkdirSync(publicationRoot, { recursive: true })
  const stagingArchive = join(publicationRoot, `.staging-${process.pid}-${randomUUID().slice(0, 8)}.zip`)
  rmSync(stagingArchive, { force: true })
  const result = spawnSync('powershell', [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    "$ErrorActionPreference = 'Stop'; Compress-Archive -LiteralPath $env:MORTISE_DEVELOPER_KIT_ARCHIVE_SOURCE -DestinationPath $env:MORTISE_DEVELOPER_KIT_ARCHIVE_DESTINATION -CompressionLevel Optimal -Force",
  ], {
    env: {
      ...process.env,
      MORTISE_DEVELOPER_KIT_ARCHIVE_SOURCE: manifest.artifactDirectory,
      MORTISE_DEVELOPER_KIT_ARCHIVE_DESTINATION: stagingArchive,
    },
    stdio: 'inherit',
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0 || !existsSync(stagingArchive) || statSync(stagingArchive).size === 0) {
    rmSync(stagingArchive, { force: true })
    throw new Error(`Developer Kit archive creation failed with exit code ${result.status ?? 'unknown'}.`)
  }
  rmSync(archivePath, { force: true })
  renameWithRetry(stagingArchive, archivePath)
  writeJsonAtomic(receiptPath, {
    schemaVersion: 1,
    buildId: manifest.buildId,
    archivePath,
    sizeBytes: statSync(archivePath).size,
    createdAt: new Date().toISOString(),
  })
  return archivePath
}

function renameWithRetry(source: string, destination: string): void {
  const retryableCodes = new Set(['EACCES', 'EBUSY', 'EPERM'])
  const sleeper = new Int32Array(new SharedArrayBuffer(4))
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(source, destination)
      return
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined
      if (attempt >= 19 || !code || !retryableCodes.has(code)) throw error
      Atomics.wait(sleeper, 0, 0, 250)
    }
  }
}
