import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startWebuiHttpServer } from '../http-server'

const SECRET = 'test-server-secret'
const PASSWORD = 'test-password'
const TEMP_DIRS: string[] = []
const SERVERS: Array<{ stop: () => void }> = []
const ORIGINAL_BUNDLED_EXTENSIONS = process.env.MORTISE_BUNDLED_PI_EXTENSIONS_PATH

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as any

function createTestWebuiDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mortise-webui-test-'))
  TEMP_DIRS.push(dir)
  writeFileSync(join(dir, 'login.html'), '<!doctype html><html><body>login</body></html>')
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body>app</body></html>')
  return dir
}

async function createServer(overrides?: {
  secureCookies?: boolean
  autoLogin?: boolean
  publicWsUrl?: string
  wsProtocol?: 'ws' | 'wss'
  wsPort?: number
}) {
  const server = await startWebuiHttpServer({
    port: 0,
    webuiDir: createTestWebuiDir(),
    secret: SECRET,
    password: PASSWORD,
    secureCookies: overrides?.secureCookies,
    autoLogin: overrides?.autoLogin,
    publicWsUrl: overrides?.publicWsUrl,
    wsProtocol: overrides?.wsProtocol ?? 'wss',
    wsPort: overrides?.wsPort ?? 9100,
    getHealthCheck: () => ({ status: 'ok' }),
    logger,
  })

  SERVERS.push(server)

  return {
    server,
    baseUrl: `http://127.0.0.1:${server.port}`,
  }
}

function extractSessionCookie(res: Response): string {
  const setCookie = res.headers.get('set-cookie')
  expect(setCookie).toBeTruthy()
  return setCookie!.split(';')[0]!
}

afterEach(() => {
  if (ORIGINAL_BUNDLED_EXTENSIONS === undefined) delete process.env.MORTISE_BUNDLED_PI_EXTENSIONS_PATH
  else process.env.MORTISE_BUNDLED_PI_EXTENSIONS_PATH = ORIGINAL_BUNDLED_EXTENSIONS
  while (SERVERS.length > 0) {
    SERVERS.pop()?.stop()
  }

  while (TEMP_DIRS.length > 0) {
    const dir = TEMP_DIRS.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('startWebuiHttpServer', () => {
  it('allows plain-http login even when the RPC transport is wss', async () => {
    const { baseUrl } = await createServer({ wsProtocol: 'wss', wsPort: 9100 })

    const authRes = await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    })

    expect(authRes.status).toBe(200)
    const setCookie = authRes.headers.get('set-cookie')
    expect(setCookie).toContain('mortise_session=')
    expect(setCookie).not.toContain('Secure')

    const configRes = await fetch(`${baseUrl}/api/config`, {
      headers: {
        cookie: extractSessionCookie(authRes),
      },
    })

    expect(configRes.status).toBe(200)
    expect(await configRes.json()).toEqual({
      wsUrl: 'wss://127.0.0.1:9100',
    })
  })

  it('rejects invalid credentials', async () => {
    const { baseUrl } = await createServer()

    const res = await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'wrong-password' }),
    })

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Invalid credentials' })
  })

  it('supports opt-in automatic local development login', async () => {
    const { baseUrl } = await createServer({ autoLogin: true })

    const res = await fetch(`${baseUrl}/api/auth/auto`, { method: 'POST' })

    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toContain('mortise_session=')
  })

  it('does not expose automatic login unless explicitly enabled', async () => {
    const { baseUrl } = await createServer()

    const res = await fetch(`${baseUrl}/api/auth/auto`, { method: 'POST' })

    expect(res.status).toBe(404)
  })

  it('honors an explicit secure-cookie override', async () => {
    const { baseUrl } = await createServer({ secureCookies: true, wsProtocol: 'ws', wsPort: 9100 })

    const res = await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toContain('Secure')
  })

  it('infers secure cookies from proxy https headers when no override is set', async () => {
    const { baseUrl } = await createServer({ wsProtocol: 'wss', wsPort: 9100 })

    const res = await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-Proto': 'https',
      },
      body: JSON.stringify({ password: PASSWORD }),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toContain('Secure')
  })

  it('derives a browser-facing websocket URL from forwarded public host headers', async () => {
    const { baseUrl } = await createServer({ wsProtocol: 'wss', wsPort: 9100 })

    const authRes = await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-Proto': 'https',
        'X-Forwarded-Host': 'mortise.example.com:3100',
      },
      body: JSON.stringify({ password: PASSWORD }),
    })

    const configRes = await fetch(`${baseUrl}/api/config`, {
      headers: {
        cookie: extractSessionCookie(authRes),
        'X-Forwarded-Proto': 'https',
        'X-Forwarded-Host': 'mortise.example.com:3100',
      },
    })

    expect(configRes.status).toBe(200)
    expect(await configRes.json()).toEqual({
      wsUrl: 'wss://mortise.example.com:9100',
    })
  })

  it('returns an explicit public websocket URL override from /api/config', async () => {
    const { baseUrl } = await createServer({
      publicWsUrl: 'wss://mortise.example.com/ws',
      wsProtocol: 'wss',
      wsPort: 9100,
    })

    const authRes = await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    })

    const configRes = await fetch(`${baseUrl}/api/config`, {
      headers: {
        cookie: extractSessionCookie(authRes),
      },
    })

    expect(configRes.status).toBe(200)
    expect(await configRes.json()).toEqual({
      wsUrl: 'wss://mortise.example.com/ws',
    })
  })

  it('serves authenticated V2 extension modules and styles with browser MIME types', async () => {
    process.env.MORTISE_BUNDLED_PI_EXTENSIONS_PATH = fileURLToPath(new URL('../../../../../apps/electron/resources/pi-extensions/extension-ui-v2-lab', import.meta.url))
    const { baseUrl } = await createServer()
    const unauthenticated = await fetch(`${baseUrl}/api/extensions/ui/extension-ui-v2-lab/toolbar/entry`)
    expect(unauthenticated.status).toBe(401)

    const auth = await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    })
    const cookie = extractSessionCookie(auth)
    const entry = await fetch(`${baseUrl}/api/extensions/ui/extension-ui-v2-lab/toolbar/entry`, { headers: { cookie } })
    expect(entry.status).toBe(200)
    expect(entry.headers.get('content-type')).toContain('application/javascript')
    expect((await entry.text()).length).toBeGreaterThan(1000)

    const typedEntry = await fetch(`${baseUrl}/api/extensions/ui/frontend/extension-ui-v2-lab/toolbar/entry`, { headers: { cookie } })
    expect(typedEntry.status).toBe(200)
    expect(typedEntry.headers.get('content-type')).toContain('application/javascript')

    const style = await fetch(`${baseUrl}/api/extensions/ui/extension-ui-v2-lab/toolbar/style/0`, { headers: { cookie } })
    expect(style.status).toBe(200)
    expect(style.headers.get('content-type')).toContain('text/css')

    const typedStyle = await fetch(`${baseUrl}/api/extensions/ui/frontend/extension-ui-v2-lab/toolbar/style/0`, { headers: { cookie } })
    expect(typedStyle.status).toBe(200)
    expect(typedStyle.headers.get('content-type')).toContain('text/css')

    const missing = await fetch(`${baseUrl}/api/extensions/ui/extension-ui-v2-lab/toolbar/style/99`, { headers: { cookie } })
    expect(missing.status).toBe(404)
  })
})
