import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { ELECTRON_BUILD_BLOCK_SPECS } from './build-inputs.ts'
import { computeBuildBlockId, computeBuildBlockInputId, type BuildBlockContext } from './build-block-cache.ts'
import { buildToolchainExecutableSha256 } from './toolchain-identity.ts'

const repoRoot = resolve(import.meta.dir, '..', '..')
const binary = process.argv.includes('--binary')
const spec = binary
  ? ELECTRON_BUILD_BLOCK_SPECS['pi-binary']
  : ELECTRON_BUILD_BLOCK_SPECS['pi-workspace']
if (!spec) throw new Error(`Missing Pi build block spec: ${binary ? 'pi-binary' : 'pi-workspace'}`)

const context: BuildBlockContext = {
  sourceRoot: repoRoot,
  buildRoot: join(repoRoot, 'output', 'electron-builds'),
  mode: 'workspace',
  toolchain: `${process.versions.bun ?? process.version}:${buildToolchainExecutableSha256()}`,
  inputHashCache: new Map(),
}
const dependencyIds = binary
  ? [computeBuildBlockId(
      context,
      ELECTRON_BUILD_BLOCK_SPECS['pi-workspace']!,
      computeBuildBlockInputId(context, ELECTRON_BUILD_BLOCK_SPECS['pi-workspace']!),
      [],
    )]
  : []
const inputId = computeBuildBlockInputId(context, spec, dependencyIds)
const blockId = computeBuildBlockId(context, spec, inputId, dependencyIds)
const outputPath = binary
  ? join(repoRoot, 'pi', 'packages', 'coding-agent', 'dist', '.mortise-build-binary.json')
  : join(repoRoot, 'pi', '.mortise-build-workspace.json')

mkdirSync(dirname(outputPath), { recursive: true })
writeFileSync(outputPath, `${JSON.stringify({
  schemaVersion: 1,
  blockName: spec.id,
  blockId,
  inputId,
  dependencyIds,
  producerVersion: 'mortise-build-blocks-v1',
  toolchain: context.toolchain,
  createdAt: new Date().toISOString(),
}, null, 2)}\n`, 'utf8')
