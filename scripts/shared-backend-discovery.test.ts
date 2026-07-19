import { afterEach, describe, expect, it } from 'bun:test'
import { createServer } from 'node:net'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { publishServerEndpoint } from '../packages/server-core/src/bootstrap/server-endpoint'
import { configureSharedBackend } from './shared-backend-discovery'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function createConfigDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'mortise-electron-shared-backend-'))
  temporaryDirectories.push(directory)
  return directory
}

describe('Electron shared backend discovery', () => {
  it('is used by both supported Electron launchers', () => {
    const devLauncher = readFileSync(join(import.meta.dir, 'electron-dev.ts'), 'utf8')
    const startLauncher = readFileSync(join(import.meta.dir, 'electron-start.ts'), 'utf8')
    const electronMain = readFileSync(join(import.meta.dir, '..', 'apps', 'electron', 'src', 'main', 'index.ts'), 'utf8')
    const packageJson = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8'))

    expect(devLauncher).toContain('configureSharedBackend(process.env, DEFAULT_CONFIG_DIR)')
    expect(startLauncher).toContain('configureSharedBackend(env, defaultConfigDir)')
    expect(electronMain).toContain('const sharedBackend = await readLiveServerConnection()')
    expect(packageJson.scripts['electron:start']).toContain('scripts/electron-start.ts')
  })

  it('preserves an explicitly configured server', async () => {
    const env = {
      MORTISE_SERVER_URL: 'ws://explicit.example:9100',
      MORTISE_SERVER_TOKEN: 'explicit-token',
    }

    expect(await configureSharedBackend(env, createConfigDir())).toBeNull()
    expect(env.MORTISE_SERVER_URL).toBe('ws://explicit.example:9100')
    expect(env.MORTISE_SERVER_TOKEN).toBe('explicit-token')
  })

  it('configures thin-client mode from a healthy local endpoint', async () => {
    const configDir = createConfigDir()
    const tokenFile = join(configDir, '.server-token')
    const endpointFile = join(configDir, '.server-endpoint.json')
    const token = '0123456789abcdef0123456789abcdef'
    writeFileSync(tokenFile, token, 'utf8')
    const listener = createServer()
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject)
      listener.listen(0, '127.0.0.1', () => resolve())
    })

    try {
      const address = listener.address()
      if (!address || typeof address === 'string') throw new Error('Expected TCP listener address')
      const manifest = publishServerEndpoint({
        host: '127.0.0.1',
        port: address.port,
        protocol: 'ws',
        tokenFile,
        endpointFile,
      })
      const env = { MORTISE_CONFIG_DIR: configDir }

      expect(await configureSharedBackend(env, configDir)).toEqual({ pid: process.pid, url: manifest.url })
      expect(env.MORTISE_SERVER_URL).toBe(manifest.url)
      expect(env.MORTISE_SERVER_TOKEN).toBe(token)
    } finally {
      await new Promise<void>(resolve => listener.close(() => resolve()))
    }
  })

  it('ignores an endpoint whose port is no longer listening', async () => {
    const configDir = createConfigDir()
    const tokenFile = join(configDir, '.server-token')
    writeFileSync(tokenFile, '0123456789abcdef0123456789abcdef', 'utf8')
    publishServerEndpoint({
      host: '127.0.0.1',
      port: 9,
      protocol: 'ws',
      tokenFile,
      endpointFile: join(configDir, '.server-endpoint.json'),
    })
    const env = { MORTISE_CONFIG_DIR: configDir }

    expect(await configureSharedBackend(env, configDir)).toBeNull()
    expect(env.MORTISE_SERVER_URL).toBeUndefined()
  })
})
