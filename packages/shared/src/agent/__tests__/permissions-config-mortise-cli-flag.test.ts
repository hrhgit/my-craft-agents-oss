import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { permissionsConfigCache } from '../permissions-config.ts'

const originalConfigDir = process.env.MORTISE_CONFIG_DIR
const originalCliFlag = process.env.MORTISE_FEATURE_CLI

function writeDefaultPermissions(configDir: string) {
  const permissionsDir = join(configDir, 'permissions')
  mkdirSync(permissionsDir, { recursive: true })
  writeFileSync(
    join(permissionsDir, 'default.json'),
    JSON.stringify(
      {
        version: '2026-03-07',
        allowedBashPatterns: [
          { pattern: '^mortise\\s+automation\\s+list\\b', comment: 'mortise automation read-only operations' },
          { pattern: '^rg\\b', comment: 'Ripgrep search' },
        ],
        allowedMcpPatterns: [],
        allowedApiEndpoints: [],
        allowedWritePaths: [],
        blockedCommandHints: [],
      },
      null,
      2,
    ),
  )
}

beforeEach(() => {
  permissionsConfigCache.clear()
})

afterEach(() => {
  permissionsConfigCache.clear()

  if (originalConfigDir === undefined) delete process.env.MORTISE_CONFIG_DIR
  else process.env.MORTISE_CONFIG_DIR = originalConfigDir

  if (originalCliFlag === undefined) delete process.env.MORTISE_FEATURE_CLI
  else process.env.MORTISE_FEATURE_CLI = originalCliFlag
})

describe('permissions config mortise-cli feature flag', () => {
  it('skips compiling mortise bash allowlist patterns when feature is disabled', () => {
    const tempConfigDir = mkdtempSync(join(tmpdir(), 'mortise-permissions-'))
    try {
      process.env.MORTISE_CONFIG_DIR = tempConfigDir
      process.env.MORTISE_FEATURE_CLI = '0'
      writeDefaultPermissions(tempConfigDir)

      const merged = permissionsConfigCache.getMergedConfig({
        workspaceRootPath: '/tmp/workspace',
        activeSourceSlugs: [],
      })

      const sources = merged.readOnlyBashPatterns.map(p => p.source)
      expect(sources.some(source => source.startsWith('^mortise\\s'))).toBe(false)
      expect(sources).toContain('^rg\\b')
    } finally {
      rmSync(tempConfigDir, { recursive: true, force: true })
    }
  })

  it('compiles mortise bash allowlist patterns when feature is enabled', () => {
    const tempConfigDir = mkdtempSync(join(tmpdir(), 'mortise-permissions-'))
    try {
      process.env.MORTISE_CONFIG_DIR = tempConfigDir
      process.env.MORTISE_FEATURE_CLI = '1'
      writeDefaultPermissions(tempConfigDir)

      const merged = permissionsConfigCache.getMergedConfig({
        workspaceRootPath: '/tmp/workspace',
        activeSourceSlugs: [],
      })

      const sources = merged.readOnlyBashPatterns.map(p => p.source)
      expect(sources).toContain('^mortise\\s+automation\\s+list\\b')
      expect(sources).toContain('^rg\\b')
    } finally {
      rmSync(tempConfigDir, { recursive: true, force: true })
    }
  })
})
