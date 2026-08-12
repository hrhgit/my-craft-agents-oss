import { join, resolve } from 'node:path'
import { needsDevBuild } from './dev-build-freshness.ts'

export function sessionMcpDevBuildContract(repoRootValue: string): {
  outputPath: string
  inputPaths: string[]
} {
  const repoRoot = resolve(repoRootValue)
  const packageRoot = join(repoRoot, 'packages', 'session-mcp-server')
  return {
    outputPath: join(packageRoot, 'dist', 'index.js'),
    inputPaths: [
      join(packageRoot, 'src'),
      join(packageRoot, 'package.json'),
      join(repoRoot, 'packages', 'session-tools-core', 'src'),
      join(repoRoot, 'packages', 'session-tools-core', 'package.json'),
      join(repoRoot, 'packages', 'shared', 'src'),
      join(repoRoot, 'packages', 'shared', 'package.json'),
      join(repoRoot, 'packages', 'core', 'src'),
      join(repoRoot, 'packages', 'core', 'package.json'),
      join(repoRoot, 'bun.lock'),
      join(repoRoot, 'scripts', 'build', 'session-mcp-dev-build.ts'),
    ],
  }
}

export function needsSessionMcpDevBuild(repoRoot: string): boolean {
  const contract = sessionMcpDevBuildContract(repoRoot)
  return needsDevBuild(contract.outputPath, contract.inputPaths)
}
