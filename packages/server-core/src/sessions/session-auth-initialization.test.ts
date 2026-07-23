import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PlatformServices } from '../runtime/platform'

const configDir = mkdtempSync(join(tmpdir(), 'mortise-session-auth-'))
const originalConfigDir = process.env.MORTISE_CONFIG_DIR
process.env.MORTISE_CONFIG_DIR = configDir

const {
  SessionManager,
  resolveAuthProviderForReinitialization,
  setSessionPlatform,
} = await import('./SessionManager.ts')

afterAll(() => {
  if (originalConfigDir === undefined) delete process.env.MORTISE_CONFIG_DIR
  else process.env.MORTISE_CONFIG_DIR = originalConfigDir
  rmSync(configDir, { recursive: true, force: true })
})

function createPlatform(logs: Record<'info' | 'warn' | 'error' | 'debug', unknown[][]>): PlatformServices {
  return {
    appRootPath: configDir,
    resourcesPath: configDir,
    isPackaged: false,
    appVersion: 'test',
    imageProcessor: {
      getMetadata: async () => null,
      process: async input => Buffer.isBuffer(input) ? input : Buffer.from(input),
    },
    logger: {
      info: (...args) => logs.info.push(args),
      warn: (...args) => logs.warn.push(args),
      error: (...args) => logs.error.push(args),
      debug: (...args) => logs.debug.push(args),
    },
    isDebugMode: true,
  }
}

function createLogs(): Record<'info' | 'warn' | 'error' | 'debug', unknown[][]> {
  return { info: [], warn: [], error: [], debug: [] }
}

describe('SessionManager authentication initialization', () => {
  it('treats an unconfigured provider as a valid pristine-profile state', async () => {
    expect(resolveAuthProviderForReinitialization(undefined, undefined, {
      free: { provider: 'free' },
    })).toEqual({ status: 'unconfigured' })
  })

  it('distinguishes configured and missing providers', () => {
    expect(resolveAuthProviderForReinitialization(undefined, 'free', {
      free: { provider: 'free' },
    })).toEqual({ status: 'configured', slug: 'free' })
    expect(resolveAuthProviderForReinitialization('missing-provider', 'free', {
      free: { provider: 'free' },
    })).toEqual({ status: 'missing', slug: 'missing-provider' })
  })

  it('keeps a configured but missing provider observable as an error', async () => {
    const logs = createLogs()
    setSessionPlatform(createPlatform(logs))
    const manager = Object.create(SessionManager.prototype) as InstanceType<typeof SessionManager>

    await manager.reinitializeAuth('missing-provider')

    expect(logs.error.flat()).toContain('No provider found for key: missing-provider')
  })
})
