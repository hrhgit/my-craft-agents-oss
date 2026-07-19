import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import {
  parseServerEndpointManifest,
  publishServerEndpoint,
  readLiveServerConnection,
  readServerEndpoint,
  removeServerEndpoint,
} from '../server-endpoint'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function createEndpointFile(): string {
  const directory = mkdtempSync(join(tmpdir(), 'mortise-server-endpoint-'))
  temporaryDirectories.push(directory)
  return join(directory, '.server-endpoint.json')
}

describe('server endpoint manifest', () => {
  it('publishes a client-safe loopback URL without embedding the token', () => {
    const endpointFile = createEndpointFile()
    const tokenFile = join(endpointFile, '..', '.server-token')
    const manifest = publishServerEndpoint({
      host: '0.0.0.0',
      port: 9100,
      protocol: 'ws',
      tokenFile,
      webui: { enabled: true, autoLogin: true },
      endpointFile,
    })

    expect(manifest.url).toBe('ws://127.0.0.1:9100')
    expect(readServerEndpoint(endpointFile)).toEqual(manifest)
    expect(readFileSync(endpointFile, 'utf8')).not.toContain('secret-token')
  })

  it('rejects malformed and relative-path manifests', () => {
    expect(parseServerEndpointManifest('{}')).toBeNull()
    expect(parseServerEndpointManifest(JSON.stringify({
      schemaVersion: 1,
      pid: 10,
      startedAt: Date.now(),
      url: 'ws://127.0.0.1:9100',
      tokenFile: '.server-token',
    }))).toBeNull()
  })

  it('only removes an endpoint owned by the current process', () => {
    const endpointFile = createEndpointFile()
    const tokenFile = join(endpointFile, '..', '.server-token')
    publishServerEndpoint({ host: '127.0.0.1', port: 9100, protocol: 'ws', tokenFile, endpointFile })
    removeServerEndpoint(endpointFile)
    expect(existsSync(endpointFile)).toBe(false)
  })

  it('returns connection details only for a live endpoint with a usable token', async () => {
    const endpointFile = createEndpointFile()
    const tokenFile = join(endpointFile, '..', '.server-token')
    writeFileSync(tokenFile, '0123456789abcdef0123456789abcdef', 'utf8')
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
      const connection = await readLiveServerConnection(endpointFile)

      expect(connection?.endpoint).toEqual(manifest)
      expect(connection?.token).toBe('0123456789abcdef0123456789abcdef')
    } finally {
      await new Promise<void>(resolve => listener.close(() => resolve()))
    }
  })
})
