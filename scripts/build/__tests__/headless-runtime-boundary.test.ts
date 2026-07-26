import { afterEach, describe, expect, test } from 'bun:test'
import { build, type Plugin } from 'esbuild'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { stageCompiledPiRuntime } from '../common.ts'
import {
  assertHeadlessMetafile,
  assertHeadlessStagedRuntime,
  headlessMetafileViolations,
} from '../headless-runtime-boundary.ts'

const repositoryRoot = resolve(import.meta.dir, '../../..')
const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('compiled headless runtime boundary', () => {
  async function buildHeadless(mutation?: Plugin) {
    return build({
      absWorkingDir: repositoryRoot,
      entryPoints: ['pi/packages/coding-agent/src/bun/headless.ts'],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      external: [
        '@mariozechner/clipboard',
        '@mortise/pi-ai',
        '@silvia-odwyer/photon-node',
        'canvas',
        'cross-spawn',
        'jiti',
        'proper-lockfile',
        'undici',
        'yaml',
      ],
      plugins: mutation ? [mutation] : [],
      metafile: true,
      write: false,
      logLevel: 'silent',
    })
  }

  test('production source closure excludes retired terminal and standalone product surfaces', async () => {
    const result = await buildHeadless()
    expect(headlessMetafileViolations(result.metafile)).toEqual([])
    expect(() => assertHeadlessMetafile(result.metafile)).not.toThrow()
  }, 120_000)

  test('reports the complete dependency path for an injected forbidden edge in the real closure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-headless-mutation-'))
    temporaryRoots.push(root)
    const retiredModule = join(root, 'packages', 'tui', 'injected.ts')
    mkdirSync(join(retiredModule, '..'), { recursive: true })
    writeFileSync(retiredModule, 'export const injectedRetiredSurface = true\n')
    const mutation: Plugin = {
      name: 'inject-retired-headless-edge',
      setup(context) {
        context.onLoad({ filter: /[\\/]bun[\\/]headless\.ts$/ }, args => ({
          contents: `${readFileSync(args.path, 'utf8')}\nimport ${JSON.stringify(retiredModule)}\n`,
          loader: 'ts',
          resolveDir: join(args.path, '..'),
        }))
      },
    }
    const result = await buildHeadless(mutation)
    const violations = headlessMetafileViolations(result.metafile)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('retired source module')
    expect(violations[0]).toContain('pi/packages/coding-agent/src/bun/headless.ts ->')
    expect(violations[0]).toContain('packages/tui/injected.ts')
    expect(() => assertHeadlessMetafile(result.metafile)).toThrow('dependency path:')
  }, 120_000)

  test('stages only the compiled executable and bounded runtime assets', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-headless-stage-'))
    temporaryRoots.push(root)
    const packageRoot = join(root, 'node_modules', '@mortise', 'pi-coding-agent')
    const dist = join(packageRoot, 'dist')
    const sidecar = join(dist, 'sidecar', 'bin', 'windows-x64')
    mkdirSync(sidecar, { recursive: true })
    writeFileSync(join(packageRoot, 'package.json'), '{"name":"@mortise/pi-coding-agent"}\n')
    writeFileSync(join(dist, 'pi.exe'), 'compiled-runtime')
    writeFileSync(join(dist, 'package.json'), '{"name":"@mortise/pi-coding-agent","version":"0.1.0"}\n')
    writeFileSync(join(dist, 'photon_rs_bg.wasm'), 'wasm')
    writeFileSync(join(sidecar, 'pi-network-sidecar.exe'), 'sidecar')
    writeFileSync(join(dist, 'cli.js'), 'retired mutation')
    writeFileSync(join(dist, 'headless.bundle.js'), 'build-only source graph evidence')

    const staged = join(root, 'staged')
    const previousSourceId = process.env.MORTISE_BUILD_SOURCE_ID
    process.env.MORTISE_BUILD_SOURCE_ID = 'a'.repeat(64)
    try {
      stageCompiledPiRuntime({
        platform: 'win32',
        arch: 'x64',
        upload: false,
        uploadLatest: false,
        uploadScript: false,
        rootDir: root,
        electronDir: join(root, 'electron'),
      }, staged)
    } finally {
      if (previousSourceId === undefined) delete process.env.MORTISE_BUILD_SOURCE_ID
      else process.env.MORTISE_BUILD_SOURCE_ID = previousSourceId
    }

    expect(assertHeadlessStagedRuntime(staged, 'win32', 'x64')).toEqual([
      'package.json',
      'photon_rs_bg.wasm',
      'pi.exe',
      'sidecar/bin/windows-x64/pi-network-sidecar.exe',
    ])
  })
})
