import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  createProductionBundleEnvironment,
  productionBundleCommand,
} from '../validate-production-bundles'
import {
  createProductionNodeBundleTargets,
  resolvePiWorkspaceSourceImport,
} from '../validate-production-node-bundles'

const repositoryRoot = resolve(import.meta.dir, '../../..')

function packageScripts(): Record<string, string> {
  const manifest = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>
  }
  return manifest.scripts ?? {}
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
    expect(resolvePiWorkspaceSourceImport('@mortise/pi-tui', repositoryRoot)).toBe(
      resolve(repositoryRoot, 'pi/packages/tui/src/index.ts'),
    )
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
    expect(scripts['validate:production-node-bundles']).toBe(
      'bun run scripts/build/validate-production-node-bundles.ts',
    )
    expect(scripts['validate:dev']?.startsWith('bun run validate:production-node-bundles &&')).toBe(true)
    expect(scripts['validate:production-bundles']).toBe('bun run scripts/build/validate-production-bundles.ts')
    expect(scripts['validate:ci']).toContain('bun run test:build-validation')
    expect(scripts['validate:ci']).toContain('bun run validate:production-bundles')
  })

  test('keeps installer creation behind explicit target-platform package commands', () => {
    const scripts = packageScripts()
    expect(scripts['electron:dist:win']).toContain('electron-builder --config electron-builder.yml --win')
    expect(scripts['electron:dist:mac']).toContain('electron-builder --config electron-builder.yml --mac')
    expect(scripts['electron:dist:linux']).toContain('electron-builder --config electron-builder.yml --linux')
    expect(scripts['validate:dev']).not.toContain('electron:dist')
    expect(scripts['validate:ci']).not.toContain('electron:dist')
  })
})
