import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyCachePrunePlan, planBuildBlockCleanup, planPackageArtifactCleanup } from '../build-cache-prune.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function writeBlockIdentity(buildRoot: string, type: string, blockId: string, createdAt: string): void {
  const dir = join(buildRoot, 'blocks', type, blockId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'block.json'), JSON.stringify({ createdAt, sealed: true }))
}

function writePackageIdentity(cacheRoot: string, packageId: string, createdAt: string): void {
  const dir = join(cacheRoot, 'builds', packageId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ createdAt }))
}

describe('build cache prune', () => {
  it('keeps the newest block identities per type and removes older ones plus staging remnants', () => {
    const buildRoot = tempRoot('mortise-build-cache-prune-blocks-')
    writeBlockIdentity(buildRoot, 'electron-main', 'a', '2026-08-12T10:00:00.000Z')
    writeBlockIdentity(buildRoot, 'electron-main', 'b', '2026-08-12T11:00:00.000Z')
    writeBlockIdentity(buildRoot, 'electron-main', 'c', '2026-08-12T12:00:00.000Z')
    writeBlockIdentity(buildRoot, 'electron-main', 'd', '2026-08-12T13:00:00.000Z')
    writeBlockIdentity(buildRoot, 'pi-binary', 'x', '2026-08-12T09:00:00.000Z')
    writeBlockIdentity(buildRoot, 'pi-binary', 'y', '2026-08-12T10:00:00.000Z')
    mkdirSync(join(buildRoot, 'blocks', 'electron-main', '.staging-deadbeef-1-1'), { recursive: true })

    const plan = planBuildBlockCleanup(buildRoot, 3)
    expect(plan.retained).toEqual(['electron-main/d', 'electron-main/c', 'electron-main/b', 'pi-binary/y', 'pi-binary/x'])
    expect(plan.targets.map(target => target.path)).toEqual([
      join(buildRoot, 'blocks', 'electron-main', '.staging-deadbeef-1-1'),
      join(buildRoot, 'blocks', 'electron-main', 'a'),
    ])
  })

  it('keeps protected locked block identities', () => {
    const buildRoot = tempRoot('mortise-build-cache-prune-locked-')
    const lockedBlockId = 'a'.repeat(64)
    writeBlockIdentity(buildRoot, 'electron-main', lockedBlockId, '2026-08-10T00:00:00.000Z')
    writeBlockIdentity(buildRoot, 'electron-main', 'recent', '2026-08-12T00:00:00.000Z')
    mkdirSync(join(buildRoot, 'blocks', 'locks', `electron-main-${lockedBlockId}`), { recursive: true })

    const plan = planBuildBlockCleanup(buildRoot, 1)
    expect(plan.retained).toContain(`electron-main/${lockedBlockId}`)
    expect(plan.targets.map(target => target.path)).not.toContain(join(buildRoot, 'blocks', 'electron-main', lockedBlockId))
  })

  it('keeps the newest package artifacts and removes older ones plus staging remnants', () => {
    const cacheRoot = tempRoot('mortise-build-cache-prune-packages-')
    writePackageIdentity(cacheRoot, 'aaa', '2026-08-12T09:00:00.000Z')
    writePackageIdentity(cacheRoot, 'bbb', '2026-08-12T10:00:00.000Z')
    writePackageIdentity(cacheRoot, 'ccc', '2026-08-12T11:00:00.000Z')
    mkdirSync(join(cacheRoot, 'builds', '.staging-aaa-1-1'), { recursive: true })

    const plan = planPackageArtifactCleanup(cacheRoot, 2)
    expect(plan.retained).toEqual(['ccc', 'bbb'])
    expect(plan.targets.map(target => target.path)).toEqual([
      join(cacheRoot, 'builds', '.staging-aaa-1-1'),
      join(cacheRoot, 'builds', 'aaa'),
    ])
  })

  it('applies a plan by removing the targeted directories', () => {
    const cacheRoot = tempRoot('mortise-build-cache-prune-apply-')
    writePackageIdentity(cacheRoot, 'old', '2026-08-10T00:00:00.000Z')
    writePackageIdentity(cacheRoot, 'new', '2026-08-12T00:00:00.000Z')
    const plan = planPackageArtifactCleanup(cacheRoot, 1)
    const removed = applyCachePrunePlan(plan)
    expect(removed).toContain(join(cacheRoot, 'builds', 'old'))
    expect(plan.retained).toEqual(['new'])
  })
})
