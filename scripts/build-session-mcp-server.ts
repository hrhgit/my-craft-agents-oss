import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { needsSessionMcpDevBuild } from './build/session-mcp-dev-build.ts'

const repoRoot = resolve(import.meta.dir, '..')
const force = process.argv.slice(2).includes('--force')

if (!force && !needsSessionMcpDevBuild(repoRoot)) {
  process.stdout.write('[session-mcp] Inputs unchanged, reusing dist/index.js.\n')
  process.exit(0)
}

const result = spawnSync(process.execPath, [
  'run', '--cwd', resolve(repoRoot, 'packages', 'session-mcp-server'), 'build',
], {
  cwd: repoRoot,
  env: process.env,
  stdio: 'inherit',
  windowsHide: true,
})
if (result.error) throw result.error
if (result.status !== 0) {
  throw new Error(`Session MCP server build failed with exit code ${result.status ?? 'unknown'}.`)
}
if (needsSessionMcpDevBuild(repoRoot)) {
  throw new Error('Session MCP server build completed without producing a fresh dist/index.js output.')
}
