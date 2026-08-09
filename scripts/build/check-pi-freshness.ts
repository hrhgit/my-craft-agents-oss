import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ELECTRON_BUILD_BLOCK_SPECS } from './build-inputs.ts'
import { computeBuildBlockId, computeBuildBlockInputId, type BuildBlockContext } from './build-block-cache.ts'
import { buildToolchainExecutableSha256 } from './electron-build-cache.ts'

const repoRoot = resolve(import.meta.dir, '..', '..')
const context: BuildBlockContext = {
  sourceRoot: repoRoot,
  buildRoot: join(repoRoot, 'output', 'electron-builds'),
  mode: 'workspace',
  toolchain: `${process.versions.bun ?? process.version}:${buildToolchainExecutableSha256()}`,
  inputHashCache: new Map(),
}

assertFresh('pi-workspace', join(repoRoot, 'pi', '.mortise-build-workspace.json'), [])

// Binary output is optional in a normal workspace check, but once it exists its
// provenance must remain tied to the current workspace block. This catches a
// stale embedded Pi executable without making `pi:check` require a binary build.
const binaryProvenancePath = join(repoRoot, 'pi', 'packages', 'coding-agent', 'dist', '.mortise-build-binary.json')
const binaryOutputPaths = ELECTRON_BUILD_BLOCK_SPECS['pi-binary']?.outputPaths ?? []
const binaryOutputExists = binaryOutputPaths.some(path => existsSync(join(repoRoot, ...path.split('/'))))
if (existsSync(binaryProvenancePath) || binaryOutputExists) {
  const workspaceSpec = ELECTRON_BUILD_BLOCK_SPECS['pi-workspace']
  if (!workspaceSpec) throw new Error('Missing Pi build block spec: pi-workspace')
  const workspaceInputId = computeBuildBlockInputId(context, workspaceSpec)
  const workspaceBlockId = computeBuildBlockId(context, workspaceSpec, workspaceInputId, [])
  assertFresh('pi-binary', binaryProvenancePath, [workspaceBlockId])
}

function assertFresh(name: string, path: string, dependencies: string[]): void {
  if (!existsSync(path)) throw new Error(`Pi ${name} artifacts are missing or stale. Run bun run pi:build${name === 'pi-binary' ? ':binary' : ''}.`)
  const manifest = readManifest(path)
  const spec = ELECTRON_BUILD_BLOCK_SPECS[name]
  if (!spec) throw new Error(`Missing Pi build block spec: ${name}`)
  const inputId = computeBuildBlockInputId(context, spec, dependencies)
  const blockId = computeBuildBlockId(context, spec, inputId, dependencies)
  if (manifest.blockId !== blockId || manifest.inputId !== inputId || JSON.stringify(manifest.dependencyIds) !== JSON.stringify(dependencies)) {
    throw new Error(`Pi ${name} artifacts are stale. Run bun run pi:build${name === 'pi-binary' ? ':binary' : ''}.`)
  }
}

function readManifest(path: string): { blockId: string; inputId: string; dependencyIds: string[] } {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as { blockId: string; inputId: string; dependencyIds: string[] }
  } catch {
    throw new Error(`Pi build provenance is missing or invalid: ${path}`)
  }
}
