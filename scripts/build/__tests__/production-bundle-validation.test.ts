import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import matter from 'gray-matter'
import {
  createProductionBundleEnvironment,
  productionBundleCommand,
} from '../validate-production-bundles'
import {
  createProductionNodeBundleTargets,
  resolvePiWorkspaceSourceImport,
} from '../validate-production-node-bundles'
import { downloadUv, publishVerifiedUvToolchain, stageCompiledPiRuntime } from '../common'
import {
  publishElectronPackageArtifacts,
  reapAbandonedPackageRuns,
  recoverElectronPackagePublication,
  resolvePackageTarget,
} from '../package-electron'
import { getProcessStartTime } from '../process-identity'
import {
  createElectronBuildCommandEnvironment,
  executeElectronBuildStages,
  publishBuildBunToolchain,
} from '../electron-build-cache'
import { runFrozenDependencyInstall } from '../../build-source-snapshot'

const repositoryRoot = resolve(import.meta.dir, '../../..')
const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function packageScripts(): Record<string, string> {
  const manifest = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>
  }
  return manifest.scripts ?? {}
}

function expandPackageScript(name: string, scripts: Record<string, string>, stack: string[] = []): string[] {
  if (stack.includes(name)) throw new Error(`Package script cycle: ${[...stack, name].join(' -> ')}`)
  const command = scripts[name]
  if (!command) throw new Error(`Missing package script: ${name}`)
  return command.split(/\s*&&\s*/).flatMap(part => {
    const match = part.match(/^bun run ([a-zA-Z0-9:_-]+)(.*)$/)
    const compositeScripts = new Set(['validate:ci', 'validate:dev', 'module:validate', 'module-agent', 'test:module-agents'])
    if (!match || !scripts[match[1]!] || !compositeScripts.has(match[1]!)) return [part]
    const expanded = expandPackageScript(match[1]!, scripts, [...stack, name])
    const suffix = match[2]!
    if (!suffix) return expanded
    if (expanded.length !== 1) throw new Error(`Cannot append arguments to composite package script: ${match[1]}`)
    return [`${expanded[0]}${suffix}`]
  })
}

function moduleValidationCommands(path: string): string[] {
  const parsed = matter(readSource(path)).data as { validation?: Array<{ command?: string }> }
  return (parsed.validation ?? []).map(entry => entry.command).filter((command): command is string => Boolean(command))
}

function readSource(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
}

function filesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name)
    return statSync(path).isDirectory() ? filesUnder(path) : [path]
  })
}

describe('production bundle validation composition', () => {
  test('compiles every production Node boundary in memory through the production protocol entry', () => {
    const targets = createProductionNodeBundleTargets(repositoryRoot)
    expect(targets.map(target => target.label)).toEqual([
      'workspace server',
      'Electron main',
      'Electron preload',
    ])
    for (const target of targets) {
      expect(target.options.write).toBe(false)
      expect(target.options.alias?.['@mortise/shared/protocol']).toBe(
        resolve(repositoryRoot, 'packages/shared/src/protocol/production.ts'),
      )
      expect(target.options.plugins?.map(plugin => plugin.name)).toContain('mortise-pi-workspace-source')
    }
  })

  test('resolves public Pi workspace exports from source without requiring generated dist files', () => {
    expect(resolvePiWorkspaceSourceImport('@mortise/pi-coding-agent/rpc', repositoryRoot)).toBe(
      resolve(repositoryRoot, 'pi/packages/coding-agent/src/modes/rpc/public.ts'),
    )
    expect(resolvePiWorkspaceSourceImport('@mortise/pi-ai/oauth', repositoryRoot)).toBe(
      resolve(repositoryRoot, 'pi/packages/ai/src/oauth.ts'),
    )
    expect(resolvePiWorkspaceSourceImport('@mortise/pi-tui', repositoryRoot)).toBeUndefined()
    expect(resolvePiWorkspaceSourceImport('@mortise/shared', repositoryRoot)).toBeUndefined()
  })

  test('forces the packaging production mode and executes the canonical Electron build', () => {
    expect(productionBundleCommand).toEqual(['bun', 'run', 'electron:build'])
    expect(createProductionBundleEnvironment({
      MORTISE_UI_VALIDATION_BUILD: '1',
      MORTISE_DEV_HOST_BUILD: '1',
    })).toMatchObject({
      MORTISE_UI_VALIDATION_BUILD: '0',
      MORTISE_DEV_HOST_BUILD: '0',
    })
  })

  test('keeps the real production bundle build in the canonical CI gate', () => {
    const scripts = packageScripts()
    const buildModulePath = resolve(repositoryRoot, '.agents/modules/build-release-observability.md')
    const buildModule = readSource(buildModulePath)
    expect(scripts['bootstrap:ci']).toContain('bun run pi:build:binary')
    expect(scripts['electron:build']).toBe('bun run scripts/build/produce-electron-build.ts')
    expect(scripts['electron:build:source']).toContain('bun run electron:build:resources')
    expect(scripts['validate:production-node-bundles']).toBe(
      'bun run scripts/build/validate-production-node-bundles.ts',
    )
    expect(scripts['validate:dev']?.startsWith('bun run validate:production-node-bundles &&')).toBe(true)
    expect(scripts['validate:production-bundles']).toBe('bun run scripts/build/validate-production-bundles.ts')
    expect(scripts['validate:ci']).toContain('bun run test:build-validation')
    expect(scripts['validate:ci']).toContain('bun run validate:production-bundles')
    expect(buildModule).not.toContain('command: "bun run validate:dev"')
    expect(buildModule).not.toContain('command: "bun run validate:ci"')
    for (const command of [
      'bun run validate:production-node-bundles',
      'bun run scripts/module-agents/cli.ts validate --strict',
      'bun test scripts/module-agents/__tests__',
      'bun run typecheck:all',
      'bun run test:shared:all',
      'bun run test:doc-tools',
      'bun run test:build-validation',
      'bun run validate:production-bundles',
      'bun run test:ui-validation:fast',
      'bun run lint:i18n:parity',
      'bun run lint:i18n:sorted',
    ]) {
      expect(buildModule).toContain(`command: "${command}"`)
    }

    const ciLeaves = expandPackageScript('validate:ci', scripts)
    const moduleCommands = moduleValidationCommands(buildModulePath)
    const moduleOnly = [
      'git diff --check',
      'bun run pi:build && bun run pi:check',
      'bun run pi:test',
    ]
    expect(new Set(ciLeaves).size).toBe(ciLeaves.length)
    expect(new Set(moduleCommands).size).toBe(moduleCommands.length)
    expect(moduleCommands.filter(command => !moduleOnly.includes(command)).sort()).toEqual([...ciLeaves].sort())

    const moduleAgentCommands = moduleValidationCommands(resolve(repositoryRoot, '.agents/modules/module-agent-system.md'))
    expect(moduleCommands.filter(command => moduleAgentCommands.includes(command))).toEqual(moduleAgentCommands)
  })

  test('pins embedded build lifecycle tools to the producer Bun runtime', () => {
    const codingPackage = JSON.parse(readFileSync(
      resolve(repositoryRoot, 'pi/packages/coding-agent/package.json'),
      'utf8',
    )) as { scripts: Record<string, string> }
    expect(codingPackage.scripts.clean).toBe('shx rm -rf dist')
    expect(codingPackage.scripts.clean).not.toContain('sidecar/bin')
    for (const name of ['build:sidecar', 'build:host-facade-cjs', 'copy-binary-assets']) {
      expect(codingPackage.scripts[name]?.startsWith('bun ')).toBe(true)
      expect(codingPackage.scripts[name]).not.toMatch(/(^|\s)node(?:\.exe)?\s/)
    }

    const bunExecutable = resolve(repositoryRoot, 'toolchain', process.platform === 'win32' ? 'bun.exe' : 'bun')
    const environment = createElectronBuildCommandEnvironment(
      { Path: resolve(repositoryRoot, 'machine-node') },
      'production',
      'source-id',
      resolve(repositoryRoot, 'build-root'),
      bunExecutable,
    )
    expect(environment.PATH).toBe(`${dirname(bunExecutable)}${delimiter}${resolve(repositoryRoot, 'machine-node')}`)
    expect(environment.Path).toBeUndefined()
  })

  test('publishes a verified standard Bun command for nested npm lifecycle scripts', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-bun-toolchain-'))
    temporaryRoots.push(root)
    const renamedSource = join(root, process.platform === 'win32' ? 'producer-runtime.exe' : 'producer-runtime')
    copyFileSync(process.execPath, renamedSource)

    const buildRoot = join(root, 'build-root')
    const bunExecutable = publishBuildBunToolchain(buildRoot, renamedSource)
    expect(bunExecutable.endsWith(process.platform === 'win32' ? 'bun.exe' : 'bun')).toBe(true)
    expect(createHash('sha256').update(readFileSync(bunExecutable)).digest('hex')).toBe(
      createHash('sha256').update(readFileSync(process.execPath)).digest('hex'),
    )

    const fixture = join(root, 'fixture')
    mkdirSync(fixture)
    writeFileSync(join(fixture, 'package.json'), JSON.stringify({
      private: true,
      scripts: { probe: 'bun --version' },
    }), 'utf8')
    runFrozenDependencyInstall(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['run', 'probe'],
      fixture,
      'nested npm lifecycle fixture',
      { bunExecutable },
    )
    writeFileSync(join(dirname(bunExecutable), 'bun.json'), '{}', 'utf8')
    expect(publishBuildBunToolchain(buildRoot, renamedSource)).toBe(bunExecutable)
    expect(createHash('sha256').update(readFileSync(bunExecutable)).digest('hex')).toBe(
      createHash('sha256').update(readFileSync(process.execPath)).digest('hex'),
    )
  }, 30_000)

  test('builds the Pi dependency domain before materializing root dependencies', () => {
    const completed: string[] = []
    executeElectronBuildStages(true, {
      preparePiDependencies: () => completed.push('prepare-pi'),
      buildPiWorkspace: () => completed.push('build-pi-workspace'),
      buildPiBinary: () => completed.push('build-pi-binary'),
      prepareRootDependencies: () => completed.push('prepare-root'),
      assertDependencyViews: () => completed.push('assert-dependency-views'),
      buildElectronSource: () => completed.push('build-electron'),
    })
    expect(completed).toEqual([
      'prepare-pi',
      'build-pi-workspace',
      'build-pi-binary',
      'prepare-root',
      'assert-dependency-views',
      'build-electron',
    ])

    const failed: string[] = []
    expect(() => executeElectronBuildStages(true, {
      preparePiDependencies: () => failed.push('prepare-pi'),
      buildPiWorkspace: () => failed.push('build-pi-workspace'),
      buildPiBinary: () => { throw new Error('Pi binary failed') },
      prepareRootDependencies: () => failed.push('prepare-root'),
      assertDependencyViews: () => failed.push('assert-dependency-views'),
      buildElectronSource: () => failed.push('build-electron'),
    })).toThrow('Pi binary failed')
    expect(failed).toEqual(['prepare-pi', 'build-pi-workspace'])
  })

  test('keeps installer creation behind explicit target-platform package commands', () => {
    const scripts = packageScripts()
    expect(scripts['electron:dist:win']).toBe('bun run scripts/build/package-electron.ts --target win')
    expect(scripts['electron:dist:mac']).toBe('bun run scripts/build/package-electron.ts --target mac')
    expect(scripts['electron:dist:linux']).toBe('bun run scripts/build/package-electron.ts --target linux')
    expect(scripts['validate:dev']).not.toContain('electron:dist')
    expect(scripts['validate:ci']).not.toContain('electron:dist')
  })

  test('delegates app-local lifecycle scripts to the root build authority', () => {
    const appPackage = JSON.parse(readFileSync(resolve(repositoryRoot, 'apps/electron/package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(appPackage.scripts.build).toBe('bun --cwd=../.. run electron:build')
    expect(appPackage.scripts.start).toBe('bun --cwd=../.. run electron:start')
    expect(appPackage.scripts['dist:win']).toBe('bun --cwd=../.. run electron:dist:win')
    expect(appPackage.scripts['dist:mac']).toBe('bun --cwd=../.. run electron:dist:mac')
    expect(appPackage.scripts['dist:linux']).toBe('bun --cwd=../.. run electron:dist:linux')
    expect(Object.keys(appPackage.scripts).filter(name => name.startsWith('build:'))).toEqual([])
    expect(appPackage.scripts['start:win']).toBeUndefined()
    expect(appPackage.scripts['dist:mac:x64']).toBeUndefined()
    expect(existsSync(resolve(repositoryRoot, 'apps/electron/scripts/build-dmg.sh'))).toBe(false)
    expect(existsSync(resolve(repositoryRoot, 'apps/electron/scripts/build-linux.sh'))).toBe(false)
    expect(existsSync(resolve(repositoryRoot, 'scripts/build/darwin.ts'))).toBe(false)
    expect(existsSync(resolve(repositoryRoot, 'scripts/build/linux.ts'))).toBe(false)
    const directBuilderCallers = [
      ...filesUnder(resolve(repositoryRoot, 'apps/electron/scripts')),
      ...filesUnder(resolve(repositoryRoot, 'scripts/build')),
    ]
      .filter(path => /\.(?:cjs|js|mjs|ps1|sh|ts)$/.test(path))
      .filter(name => /(?:bunx|npx|bun\s+x)\s+electron-builder/.test(
        readFileSync(name, 'utf8'),
      ))
    expect(directBuilderCallers).toEqual([])
  })

  test('packages only from an isolated immutable app staging directory', () => {
    const packageElectron = readSource(resolve(repositoryRoot, 'scripts/build/package-electron.ts'))
    const buildCache = readSource(resolve(repositoryRoot, 'scripts/build/electron-build-cache.ts'))
    expect(packageElectron).toContain("'--projectDir'")
    expect(packageElectron).toContain('staged.appDir')
    expect(packageElectron).toContain("'--config.directories.output'")
    expect(packageElectron).toContain('captureElectronBuildSource')
    expect(packageElectron).toContain('capturedSource')
    expect(packageElectron).toContain('staged.appDir,\n        `Electron ${resolvedTarget.target} package`')
    expect(packageElectron).toContain("MORTISE_BUILD_TOOLCHAIN_CACHE_DIR: join(buildRoot, 'toolchains')")
    expect(readFileSync(resolve(repositoryRoot, 'scripts/build-developer-kit.ts'), 'utf8'))
      .toContain('prepareDependencies: true')
    expect(readFileSync(resolve(repositoryRoot, 'scripts/build-developer-kit.ts'), 'utf8'))
      .not.toContain('linkDependencies')
    expect(buildCache).toContain("join(lease.buildRoot, 'packaging-staging')")
    expect(buildCache).not.toContain("join(resolvedRepoRoot, 'apps', 'electron', 'dist')")
    expect(buildCache).not.toContain("join(lease.buildRoot, 'working-tree-stage')")
  })

  test('binds default and explicit packaging to one host architecture', () => {
    expect(resolvePackageTarget('default', 'win32', 'x64')).toEqual({
      target: 'win',
      builderArgs: ['--win', '--x64'],
    })
    expect(resolvePackageTarget('default', 'darwin', 'arm64')).toEqual({
      target: 'mac',
      builderArgs: ['--mac', '--arm64'],
    })
    expect(() => resolvePackageTarget('win', 'win32', 'arm64')).toThrow('x64 only')
    expect(() => resolvePackageTarget('win', 'darwin', 'arm64')).toThrow('requires a matching')
  })

  test('publishes isolated package output under a repository-global lock', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-package-publication-'))
    temporaryRoots.push(root)
    const staged = join(root, 'run-a', 'output')
    const release = join(root, 'app', 'release')
    mkdirSync(staged, { recursive: true })
    mkdirSync(release, { recursive: true })
    writeFileSync(join(staged, 'new.exe'), 'new', 'utf8')
    writeFileSync(join(release, 'old.exe'), 'old', 'utf8')

    publishElectronPackageArtifacts(staged, release, join(root, 'global-publication'))

    expect(existsSync(staged)).toBe(false)
    expect(readFileSync(join(release, 'new.exe'), 'utf8')).toBe('new')
    expect(existsSync(join(release, 'old.exe'))).toBe(false)
  })

  test('recovers an interrupted release swap before publishing the next package', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-package-recovery-'))
    temporaryRoots.push(root)
    const staged = join(root, 'run-b', 'output')
    const release = join(root, 'app', 'release')
    const backup = `${release}.previous`
    mkdirSync(staged, { recursive: true })
    mkdirSync(backup, { recursive: true })
    writeFileSync(join(staged, 'new.exe'), 'new', 'utf8')
    writeFileSync(join(backup, 'recoverable.exe'), 'old', 'utf8')

    publishElectronPackageArtifacts(staged, release, join(root, 'global-publication'))

    expect(readFileSync(join(release, 'new.exe'), 'utf8')).toBe('new')
    expect(existsSync(backup)).toBe(false)
  })

  test('restores an interrupted release before a subsequent package build can fail', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-package-startup-recovery-'))
    temporaryRoots.push(root)
    const release = join(root, 'app', 'release')
    const backup = `${release}.previous`
    const publicationLock = join(root, 'global-publication')
    mkdirSync(backup, { recursive: true })
    writeFileSync(join(backup, 'recoverable.exe'), 'old', 'utf8')

    recoverElectronPackagePublication(release, publicationLock)
    expect(readFileSync(join(release, 'recoverable.exe'), 'utf8')).toBe('old')
    expect(existsSync(backup)).toBe(false)

    expect(() => publishElectronPackageArtifacts(join(root, 'missing-output'), release, publicationLock))
      .toThrow('missing or empty')
    expect(readFileSync(join(release, 'recoverable.exe'), 'utf8')).toBe('old')
  })

  test('reclaims crash-abandoned per-run package output without touching an active run', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-package-run-gc-'))
    temporaryRoots.push(root)
    const runsRoot = join(root, 'runs')
    const abandoned = join(runsRoot, 'package-win-dead')
    const active = join(runsRoot, 'package-win-active')
    const unreadable = join(runsRoot, 'package-win-unreadable')
    mkdirSync(abandoned, { recursive: true })
    mkdirSync(active, { recursive: true })
    mkdirSync(unreadable, { recursive: true })
    writeFileSync(join(abandoned, 'run.json'), JSON.stringify({
      launcherPid: 2147483647,
      createdAt: new Date(0).toISOString(),
    }), 'utf8')
    writeFileSync(join(abandoned, 'partial.exe'), 'partial', 'utf8')
    writeFileSync(join(active, 'run.json'), JSON.stringify({
      launcherPid: process.pid,
      launcherStartedAt: getProcessStartTime(process.pid),
      createdAt: new Date().toISOString(),
    }), 'utf8')
    writeFileSync(join(unreadable, 'run.json'), '{partial', 'utf8')

    expect(reapAbandonedPackageRuns(runsRoot)).toEqual(['package-win-dead'])
    expect(existsSync(active)).toBe(true)
    expect(existsSync(unreadable)).toBe(true)
  })

  test('rejects direct Pi runtime staging without an immutable source identity', () => {
    const previous = process.env.MORTISE_BUILD_SOURCE_ID
    delete process.env.MORTISE_BUILD_SOURCE_ID
    try {
      expect(() => stageCompiledPiRuntime({
        platform: 'win32',
        arch: 'x64',
        upload: false,
        uploadLatest: false,
        uploadScript: false,
        rootDir: repositoryRoot,
        electronDir: resolve(repositoryRoot, 'apps/electron'),
      }, resolve(repositoryRoot, 'apps/electron/dist/resources/pi-runtime'))).toThrow('canonical immutable build source identity')
    } finally {
      if (previous === undefined) delete process.env.MORTISE_BUILD_SOURCE_ID
      else process.env.MORTISE_BUILD_SOURCE_ID = previous
    }
  })

  test('restores uv from a verified build toolchain cache without network access', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-uv-toolchain-cache-'))
    temporaryRoots.push(root)
    const sourceBinary = join(root, 'source', 'uv.exe')
    mkdirSync(join(sourceBinary, '..'), { recursive: true })
    writeFileSync(sourceBinary, 'verified uv fixture', 'utf8')
    const cacheRoot = join(root, 'cache')
    const sha256 = createHash('sha256').update(readFileSync(sourceBinary)).digest('hex')
    publishVerifiedUvToolchain(cacheRoot, { platform: 'win32', arch: 'x64' }, sourceBinary, sha256)

    const previous = process.env.MORTISE_BUILD_TOOLCHAIN_CACHE_DIR
    process.env.MORTISE_BUILD_TOOLCHAIN_CACHE_DIR = cacheRoot
    try {
      const electronDir = join(root, 'electron')
      await downloadUv({
        platform: 'win32',
        arch: 'x64',
        upload: false,
        uploadLatest: false,
        uploadScript: false,
        rootDir: root,
        electronDir,
      })
      expect(readFileSync(join(electronDir, 'resources', 'bin', 'win32-x64', 'uv.exe'), 'utf8'))
        .toBe('verified uv fixture')
    } finally {
      if (previous === undefined) delete process.env.MORTISE_BUILD_TOOLCHAIN_CACHE_DIR
      else process.env.MORTISE_BUILD_TOOLCHAIN_CACHE_DIR = previous
    }
  })
})
