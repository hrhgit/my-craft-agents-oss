import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertMaterializedBuildSourceIdentity,
  BUILD_DEPENDENCY_INSTALL_TIMEOUT_MS,
  captureBuildSource,
  frozenBunInstallArgs,
  MATERIALIZED_BUILD_SOURCE_PROVENANCE,
  runFrozenDependencyInstall,
} from '../../build-source-snapshot.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('immutable build source snapshot', () => {
  it('bounds frozen dependency preparation with the canonical cold-start budget', () => {
    expect(BUILD_DEPENDENCY_INSTALL_TIMEOUT_MS).toBe(600_000)
    expect(frozenBunInstallArgs()).toEqual([
      'install',
      '--frozen-lockfile',
      '--no-save',
      '--linker=hoisted',
      '--backend=hardlink',
      '--no-progress',
      '--no-summary',
    ])
    expect(frozenBunInstallArgs().some(argument => argument.startsWith('--cache-dir'))).toBe(false)
    expect(() => runFrozenDependencyInstall(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 60_000)'],
      process.cwd(),
      'timeout fixture',
      { timeoutMs: 100 },
    )).toThrow('Frozen installation for timeout fixture timed out after 100ms.')
  }, 5_000)

  it('captures dirty tracked changes, deletions, and untracked files but excludes ignored outputs', () => {
    const root = createRepository()
    write(root, 'package.json', '{"version":2}\n')
    unlinkSync(join(root, 'apps', 'electron', 'deleted.ts'))
    write(root, 'apps/electron/untracked.ts', 'export const untracked = true\n')
    write(root, 'apps/electron/dist/stale.exe', 'ignored')

    const capture = captureBuildSource({ repoRoot: root, scratchRoot: join(root, '.scratch') })
    const materialized = capture.materialize({ parentDir: join(root, '.scratch'), prepareDependencies: false })
    try {
      expect(readFileSync(join(materialized.sourceRoot, 'package.json'), 'utf8')).toContain('"version":2')
      expect(existsSync(join(materialized.sourceRoot, 'apps/electron/deleted.ts'))).toBe(false)
      expect(readFileSync(join(materialized.sourceRoot, 'apps/electron/untracked.ts'), 'utf8')).toContain('untracked')
      expect(existsSync(join(materialized.sourceRoot, 'apps/electron/dist/stale.exe'))).toBe(false)
      expect(() => assertMaterializedBuildSourceIdentity(materialized.sourceRoot, capture.sourceId)).not.toThrow()
      writeFileSync(join(materialized.sourceRoot, MATERIALIZED_BUILD_SOURCE_PROVENANCE), '{}', 'utf8')
      expect(() => assertMaterializedBuildSourceIdentity(materialized.sourceRoot, capture.sourceId)).toThrow('does not match')
    } finally {
      materialized.dispose()
      capture.dispose()
    }
  }, 20_000)

  it('keeps tracked files outside declared source paths out of the identity and capsule', () => {
    const root = createRepository()
    write(root, 'docs/acceptance.md', 'first\n')
    runGit(root, ['add', 'docs/acceptance.md'])
    runGit(root, ['-c', 'user.name=Mortise Test', '-c', 'user.email=test@mortise.local', 'commit', '--quiet', '-m', 'docs'])

    const first = captureBuildSource({
      repoRoot: root,
      scratchRoot: join(root, '.scratch'),
      sourcePaths: ['package.json', 'apps/electron'],
    })
    const firstId = first.sourceId
    first.dispose()

    write(root, 'docs/acceptance.md', 'second\n')
    runGit(root, ['add', 'docs/acceptance.md'])
    runGit(root, ['-c', 'user.name=Mortise Test', '-c', 'user.email=test@mortise.local', 'commit', '--quiet', '-m', 'docs update'])
    const second = captureBuildSource({
      repoRoot: root,
      scratchRoot: join(root, '.scratch'),
      sourcePaths: ['package.json', 'apps/electron'],
    })
    const materialized = second.materialize({ parentDir: join(root, '.scratch'), prepareDependencies: false })
    try {
      expect(second.sourceId).toBe(firstId)
      expect(existsSync(join(materialized.sourceRoot, 'docs/acceptance.md'))).toBe(false)
    } finally {
      materialized.dispose()
      second.dispose()
    }
  }, 20_000)

  it('binds an explicitly declared ignored input into the source identity and materialized tree', () => {
    const root = createRepository()
    write(root, 'apps/electron/dist/required.bin', 'first')
    const first = captureBuildSource({
      repoRoot: root,
      scratchRoot: join(root, '.scratch'),
      extraPaths: ['apps/electron/dist/required.bin'],
    })
    const firstId = first.sourceId
    first.dispose()

    write(root, 'apps/electron/dist/required.bin', 'second')
    const second = captureBuildSource({
      repoRoot: root,
      scratchRoot: join(root, '.scratch'),
      extraPaths: ['apps/electron/dist/required.bin'],
    })
    const materialized = second.materialize({ parentDir: join(root, '.scratch'), prepareDependencies: false })
    try {
      expect(second.sourceId).not.toBe(firstId)
      expect(readFileSync(join(materialized.sourceRoot, 'apps/electron/dist/required.bin'), 'utf8')).toBe('second')
    } finally {
      materialized.dispose()
      second.dispose()
    }
  }, 20_000)

  it('dereferences extra-path symlinks before hashing and materializing them', () => {
    const root = createRepository()
    const target = join(root, 'vendor-target')
    const linked = join(root, 'apps', 'electron', 'dist', 'linked-runtime')
    write(root, 'vendor-target/runtime.txt', 'first')
    mkdirSync(join(linked, '..'), { recursive: true })
    symlinkSync(target, linked, process.platform === 'win32' ? 'junction' : 'dir')

    const first = captureBuildSource({
      repoRoot: root,
      scratchRoot: join(root, '.scratch'),
      extraPaths: ['apps/electron/dist/linked-runtime'],
    })
    const materialized = first.materialize({ parentDir: join(root, '.scratch'), prepareDependencies: false })
    try {
      expect(lstatSync(join(materialized.sourceRoot, 'apps', 'electron', 'dist', 'linked-runtime')).isSymbolicLink()).toBe(false)
      expect(readFileSync(join(materialized.sourceRoot, 'apps', 'electron', 'dist', 'linked-runtime', 'runtime.txt'), 'utf8')).toBe('first')
    } finally {
      materialized.dispose()
      first.dispose()
    }

    write(root, 'vendor-target/runtime.txt', 'second')
    const second = captureBuildSource({
      repoRoot: root,
      scratchRoot: join(root, '.scratch'),
      extraPaths: ['apps/electron/dist/linked-runtime'],
    })
    try {
      expect(second.sourceId).not.toBe(first.sourceId)
    } finally {
      second.dispose()
    }
  }, 20_000)

  it('installs a frozen dependency view entirely inside the materialized source tree', () => {
    const root = createRepository()
    write(root, 'package.json', '{"name":"fixture-root","private":true,"workspaces":["packages/*"],"dependencies":{"@fixture/example":"workspace:*"}}\n')
    write(root, 'packages/example/package.json', '{"name":"@fixture/example","version":"1.0.0"}\n')
    write(root, 'packages/example/index.ts', 'export const example = true\n')
    write(root, 'pi/package.json', '{"name":"fixture-pi","private":true,"devDependencies":{"fixture-tool":"file:tools/fixture-tool"}}\n')
    write(root, 'pi/tools/fixture-tool/package.json', '{"name":"fixture-tool","version":"1.0.0","bin":{"fixture-tool":"bin.js"}}\n')
    write(root, 'pi/tools/fixture-tool/bin.js', '#!/usr/bin/env node\nconsole.log("fixture tool")\n')
    runBun(root, ['install', '--no-progress', '--no-summary'])
    runNpm(join(root, 'pi'), ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'])
    runGit(root, ['add', '.'])
    const capture = captureBuildSource({ repoRoot: root, scratchRoot: join(root, '.scratch') })
    write(root, 'packages/example/index.ts', 'export const example = false\n')
    const materialized = capture.materialize({
      parentDir: join(root, '.scratch'),
      prepareDependencies: true,
      bunExecutable: process.execPath,
    })
    try {
      expect(existsSync(join(materialized.sourceRoot, 'node_modules', '@fixture', 'example', 'index.ts'))).toBe(true)
      expect(readFileSync(join(materialized.sourceRoot, 'node_modules', '@fixture', 'example', 'index.ts'), 'utf8'))
        .toContain('export const example = true')
      expect(realpathSync(join(materialized.sourceRoot, 'node_modules', '@fixture', 'example')).startsWith(realpathSync(materialized.sourceRoot)))
        .toBe(true)
      const toolName = process.platform === 'win32' ? 'fixture-tool.cmd' : 'fixture-tool'
      expect(existsSync(join(materialized.sourceRoot, 'pi', 'node_modules', '.bin', toolName))).toBe(true)
      expect(realpathSync(join(materialized.sourceRoot, 'pi', 'node_modules', 'fixture-tool')).startsWith(realpathSync(materialized.sourceRoot)))
        .toBe(true)
    } finally {
      materialized.dispose()
      capture.dispose()
    }
  }, 20_000)
})

function createRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'mortise-build-source-'))
  roots.push(root)
  write(root, '.gitignore', 'dist/\n.scratch/\n')
  write(root, 'package.json', '{"version":1}\n')
  write(root, 'apps/electron/main.ts', 'export const tracked = true\n')
  write(root, 'apps/electron/deleted.ts', 'export const deleted = true\n')
  runGit(root, ['init', '--quiet'])
  runGit(root, ['add', '.'])
  runGit(root, ['-c', 'user.name=Mortise Test', '-c', 'user.email=test@mortise.local', 'commit', '--quiet', '-m', 'fixture'])
  return root
}

function write(root: string, path: string, content: string): void {
  const target = join(root, ...path.split('/'))
  mkdirSync(join(target, '..'), { recursive: true })
  writeFileSync(target, content, 'utf8')
}

function runGit(root: string, args: string[]): void {
  const result = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr))
}

function runBun(root: string, args: string[]): void {
  const result = Bun.spawnSync([process.execPath, ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr))
}

function runNpm(root: string, args: string[]): void {
  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const result = Bun.spawnSync([command, ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr))
}
