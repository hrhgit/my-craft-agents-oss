import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { runBuildBlock, type BuildBlockContext } from '../build-block-cache.ts'
import type { BuildBlockSpec } from '../build-inputs.ts'

const roots: string[] = []

describe('build block cache', () => {
  it('reuses a sealed block and restores only its declared output', () => {
    const root = tempRoot('mortise-build-block-reuse-')
    const sourceRoot = join(root, 'source')
    const buildRoot = join(root, 'cache')
    write(sourceRoot, 'src/value.ts', 'export const value = 1\n')
    const spec = testSpec('test-block', ['src/value.ts'], ['dist/value.js'])
    const context = testContext(sourceRoot, buildRoot)
    let builds = 0

    const first = runBuildBlock({ context, spec, build: () => {
      builds += 1
      write(sourceRoot, 'dist/value.js', readFileSync(join(sourceRoot, 'src/value.ts'), 'utf8'))
      write(sourceRoot, 'dist/other.js', 'preserve me\n')
    } })
    const second = runBuildBlock({ context, spec, build: () => { builds += 1 } })

    expect(first.reused).toBe(false)
    expect(second.reused).toBe(true)
    expect(builds).toBe(1)
    expect(readFileSync(join(sourceRoot, 'dist/value.js'), 'utf8')).toContain('value = 1')
    expect(readFileSync(join(sourceRoot, 'dist/other.js'), 'utf8')).toBe('preserve me\n')
  })

  it('invalidates a block when an input or dependency identity changes', () => {
    const root = tempRoot('mortise-build-block-invalidate-')
    const sourceRoot = join(root, 'source')
    const buildRoot = join(root, 'cache')
    write(sourceRoot, 'src/value.ts', 'export const value = 1\n')
    const spec = testSpec('test-block', ['src/value.ts'], ['dist/value.js'])
    const context = testContext(sourceRoot, buildRoot)
    let builds = 0
    const build = () => {
      builds += 1
      write(sourceRoot, 'dist/value.js', readFileSync(join(sourceRoot, 'src/value.ts'), 'utf8'))
    }

    const first = runBuildBlock({ context, spec, dependencyIds: ['dep-a'], build })
    write(sourceRoot, 'src/value.ts', 'export const value = 2\n')
    const second = runBuildBlock({ context: testContext(sourceRoot, buildRoot), spec, dependencyIds: ['dep-a'], build })
    const third = runBuildBlock({ context: testContext(sourceRoot, buildRoot), spec, dependencyIds: ['dep-b'], build })

    expect(first.manifest.blockId).not.toBe(second.manifest.blockId)
    expect(second.manifest.blockId).not.toBe(third.manifest.blockId)
    expect(builds).toBe(3)
  })

  it('fast hits avoid content hashing while strict verification detects tampering', () => {
    const root = tempRoot('mortise-build-block-verify-')
    const sourceRoot = join(root, 'source')
    const buildRoot = join(root, 'cache')
    write(sourceRoot, 'src/value.ts', 'export const value = 1\n')
    const spec = testSpec('test-block', ['src/value.ts'], ['dist/value.js'])
    const fastContext = testContext(sourceRoot, buildRoot)
    const first = runBuildBlock({ context: fastContext, spec, build: () => write(sourceRoot, 'dist/value.js', 'valid\n') })
    write(sourceRoot, 'dist/value.js', 'bad!!\n')
    expect(runBuildBlock({ context: fastContext, spec, build: () => { throw new Error('fast hit should not build') } }).reused).toBe(true)

    write(join(buildRoot, 'blocks', 'test-block', first.manifest.blockId, 'outputs'), 'dist/value.js', 'tampered\n')
    const strictContext = testContext(sourceRoot, buildRoot)
    strictContext.verify = 'strict'
    let rebuilt = 0
    const result = runBuildBlock({ context: strictContext, spec, build: () => {
      rebuilt += 1
      write(sourceRoot, 'dist/value.js', 'valid again\n')
    } })
    expect(result.reused).toBe(false)
    expect(rebuilt).toBe(1)
  })
})

function testSpec(id: string, inputPaths: string[], outputPaths: string[]): BuildBlockSpec {
  return { id, inputPaths, dependencyIds: [], outputPaths, platformSensitive: false, builder: `${id}-v1` }
}

function testContext(sourceRoot: string, buildRoot: string): BuildBlockContext {
  return {
    sourceRoot,
    buildRoot,
    mode: 'test',
    toolchain: `bun-test-${createHash('sha256').update(process.execPath).digest('hex')}`,
    inputHashCache: new Map(),
  }
}

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(process.env.TEMP ?? process.env.TMP ?? '.', prefix))
  roots.push(root)
  return root
}

function write(root: string, path: string, content: string): void {
  const target = join(root, ...path.split('/'))
  mkdirSync(join(target, '..'), { recursive: true })
  writeFileSync(target, content, 'utf8')
}

process.on('exit', () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})
