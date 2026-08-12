import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { needsDevBuild } from '../dev-build-freshness.ts'
import { sessionMcpDevBuildContract } from '../session-mcp-dev-build.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('development build freshness', () => {
  it('rebuilds only when a declared input is newer than the output', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-dev-build-freshness-'))
    roots.push(root)
    const input = join(root, 'src', 'index.ts')
    const output = join(root, 'dist', 'index.js')
    mkdirSync(join(root, 'src'), { recursive: true })
    mkdirSync(join(root, 'dist'), { recursive: true })
    writeFileSync(input, 'input')
    writeFileSync(output, 'output')
    const old = new Date(Date.now() - 3_000)
    const current = new Date(Date.now() - 2_000)
    utimesSync(input, old, old)
    utimesSync(join(root, 'src'), old, old)
    utimesSync(output, current, current)

    expect(needsDevBuild(output, [join(root, 'src')])).toBe(false)
    const newer = new Date(Date.now() - 1_000)
    utimesSync(input, newer, newer)
    expect(needsDevBuild(output, [join(root, 'src')])).toBe(true)
    expect(needsDevBuild(output, [join(root, 'missing-input')])).toBe(true)
  })

  it('declares the Session MCP server and its shared workspace dependencies', () => {
    const contract = sessionMcpDevBuildContract('C:/repo')
    const normalized = contract.inputPaths.map(path => path.replaceAll('\\', '/'))
    expect(contract.outputPath.replaceAll('\\', '/').endsWith('/packages/session-mcp-server/dist/index.js')).toBe(true)
    expect(normalized.some(path => path.endsWith('/packages/session-tools-core/src'))).toBe(true)
    expect(normalized.some(path => path.endsWith('/packages/shared/src'))).toBe(true)
    expect(normalized.some(path => path.endsWith('/packages/core/src'))).toBe(true)
    expect(normalized.some(path => path.endsWith('/bun.lock'))).toBe(true)

    const launcher = readFileSync(join(import.meta.dir, '..', '..', 'build-session-mcp-server.ts'), 'utf8')
    expect(launcher).toContain("'run', '--cwd', resolve(repoRoot, 'packages', 'session-mcp-server'), 'build'")
    expect(launcher).toContain('build completed without producing a fresh dist/index.js output')
  })
})
