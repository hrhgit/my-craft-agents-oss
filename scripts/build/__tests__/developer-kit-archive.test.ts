import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ensureDeveloperKitArchive } from '../developer-kit-archive.ts'
import type { DeveloperKitBuildManifest } from '../developer-kit-build-manifest.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Developer Kit derived archive', () => {
  const windowsIt = process.platform === 'win32' ? it : it.skip

  windowsIt('creates an archive once and reuses its verified receipt', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-developer-kit-archive-'))
    roots.push(root)
    const artifactDirectory = join(root, 'content', 'mortise-developer-kit-test-win-x64')
    const cliPath = join(artifactDirectory, 'bin', 'mortise-ui.exe')
    mkdirSync(dirname(cliPath), { recursive: true })
    writeFileSync(cliPath, 'test executable')
    const manifest = {
      buildId: 'a'.repeat(64),
      artifactDirectory,
    } as DeveloperKitBuildManifest

    const archivePath = ensureDeveloperKitArchive(root, manifest)
    expect(existsSync(archivePath)).toBe(true)
    expect(statSync(archivePath).size).toBeGreaterThan(0)
    const createdAt = statSync(archivePath).mtimeMs

    expect(ensureDeveloperKitArchive(root, manifest)).toBe(archivePath)
    expect(statSync(archivePath).mtimeMs).toBe(createdAt)
  })
})
