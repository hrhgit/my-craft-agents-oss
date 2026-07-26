import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { collectArtifactInventory, artifactInventorySize } from '../electron-build-cache.ts'
import {
  acquireDeveloperKitBuildLease,
  activeDeveloperKitBuildIdsLocked,
  cleanupDeveloperKitBuildCacheLocked,
  computeDeveloperKitBuildId,
  DEVELOPER_KIT_BUILD_SCHEMA_VERSION,
  readValidDeveloperKitBuildManifest,
  releaseDeveloperKitBuildLease,
  writeDeveloperKitStagingOwner,
} from '../developer-kit-build-manifest.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Developer Kit immutable build manifest', () => {
  const bunExecutableSha256 = 'e'.repeat(64)

  it('protects a build with a process-identity lease until installer staging releases it', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-developer-kit-lease-'))
    roots.push(root)
    const buildId = 'a'.repeat(64)
    const lease = acquireDeveloperKitBuildLease(root, buildId, 'installer-test')
    expect(activeDeveloperKitBuildIdsLocked(root)).toEqual(new Set([buildId]))
    releaseDeveloperKitBuildLease(lease)
    expect(activeDeveloperKitBuildIdsLocked(root)).toEqual(new Set())
  })

  it('rejects artifact and byte-total tampering on cache hits', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-developer-kit-manifest-'))
    roots.push(root)
    const sourceId = 'b'.repeat(64)
    const buildId = computeDeveloperKitBuildId(sourceId, true, bunExecutableSha256)
    const buildDir = join(root, buildId)
    const artifactDirectory = join(buildDir, 'artifacts', 'mortise-developer-kit-0.1.0-win-x64')
    const artifactPath = join(artifactDirectory, 'bin', 'mortise-ui.exe')
    mkdirSync(dirname(artifactPath), { recursive: true })
    writeFileSync(artifactPath, 'immutable kit')
    const artifacts = collectArtifactInventory(join(buildDir, 'artifacts'))
    const manifestPath = join(buildDir, 'build.json')
    writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: DEVELOPER_KIT_BUILD_SCHEMA_VERSION,
      buildId,
      sourceId,
      bunExecutableSha256,
      archiveDisabled: true,
      createdAt: new Date(0).toISOString(),
      artifactDirectory,
      sizeBytes: artifactInventorySize(artifacts),
      artifacts,
      platform: process.platform,
      arch: process.arch,
      immutable: true,
    }))

    expect(readValidDeveloperKitBuildManifest(buildDir, buildId)?.buildId).toBe(buildId)
    writeFileSync(artifactPath, 'tampered kit')
    expect(readValidDeveloperKitBuildManifest(buildDir, buildId)).toBeUndefined()

    writeFileSync(artifactPath, 'immutable kit')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { sizeBytes: number }
    manifest.sizeBytes = 0
    writeFileSync(manifestPath, JSON.stringify(manifest))
    expect(readValidDeveloperKitBuildManifest(buildDir, buildId)).toBeUndefined()
  })

  it('rejects source, archive-mode, and platform relabeling', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-developer-kit-identity-'))
    roots.push(root)
    const sourceId = 'c'.repeat(64)
    const buildId = computeDeveloperKitBuildId(sourceId, true, bunExecutableSha256)
    const buildDir = join(root, buildId)
    const artifactDirectory = join(buildDir, 'artifacts', 'mortise-developer-kit-0.1.0-win-x64')
    const artifactPath = join(artifactDirectory, 'bin', 'mortise-ui.exe')
    mkdirSync(dirname(artifactPath), { recursive: true })
    writeFileSync(artifactPath, 'immutable kit')
    const artifacts = collectArtifactInventory(join(buildDir, 'artifacts'))
    const manifestPath = join(buildDir, 'build.json')
    const manifest = {
      schemaVersion: DEVELOPER_KIT_BUILD_SCHEMA_VERSION,
      buildId,
      sourceId,
      bunExecutableSha256,
      archiveDisabled: true,
      createdAt: new Date(0).toISOString(),
      artifactDirectory,
      sizeBytes: artifactInventorySize(artifacts),
      artifacts,
      platform: process.platform,
      arch: process.arch,
      immutable: true,
    }
    const writeManifest = (): void => writeFileSync(manifestPath, JSON.stringify(manifest))
    writeManifest()
    expect(readValidDeveloperKitBuildManifest(buildDir, buildId)).toBeDefined()

    manifest.sourceId = 'd'.repeat(64)
    writeManifest()
    expect(readValidDeveloperKitBuildManifest(buildDir, buildId)).toBeUndefined()
    manifest.sourceId = sourceId

    manifest.archiveDisabled = false
    writeManifest()
    expect(readValidDeveloperKitBuildManifest(buildDir, buildId)).toBeUndefined()
    manifest.archiveDisabled = true

    manifest.platform = process.platform === 'win32' ? 'linux' : 'win32'
    writeManifest()
    expect(readValidDeveloperKitBuildManifest(buildDir, buildId)).toBeUndefined()
    manifest.platform = process.platform

    manifest.bunExecutableSha256 = 'f'.repeat(64)
    writeManifest()
    expect(readValidDeveloperKitBuildManifest(buildDir, buildId)).toBeUndefined()
  })

  it('reclaims abandoned staging and invalid completed directories without touching active staging', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-developer-kit-gc-'))
    roots.push(root)
    const buildsDir = join(root, 'builds')
    const abandoned = join(buildsDir, '.staging-abandoned')
    const active = join(buildsDir, '.staging-active')
    const invalid = join(buildsDir, 'invalid-build')
    for (const path of [abandoned, active, invalid]) mkdirSync(path, { recursive: true })
    writeDeveloperKitStagingOwner(active)

    const result = cleanupDeveloperKitBuildCacheLocked(root, new Set(), {
      retainCount: 0,
      staleMs: 0,
      nowMs: Date.now() + 1,
    })

    expect(result.removed).toContain('.staging-abandoned')
    expect(result.removed).toContain('invalid-build')
    expect(result.retained).toContain('.staging-active')
  })
})
