import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { isAbsolute, join } from 'node:path'
import { CONFIG_DIR } from '@craft-agent/shared/config/paths'

export const DEFAULT_SERVER_ENDPOINT_NAME = '.server-endpoint.json'

export interface ServerEndpointManifest {
  schemaVersion: 1
  pid: number
  startedAt: number
  url: string
  tokenFile: string
  webui?: {
    enabled: true
    autoLogin: boolean
  }
}

export interface PublishServerEndpointOptions {
  host: string
  port: number
  protocol: 'ws' | 'wss'
  tokenFile: string
  webui?: {
    enabled: true
    autoLogin: boolean
  }
  endpointFile?: string
}

export interface LiveServerConnection {
  endpoint: ServerEndpointManifest
  token: string
}

const publishedEndpointFiles = new Set<string>()
let exitCleanupRegistered = false

export function resolveServerEndpointFile(endpointFile?: string): string {
  const name = endpointFile || DEFAULT_SERVER_ENDPOINT_NAME
  return isAbsolute(name) ? name : join(CONFIG_DIR, name)
}

function normalizeClientHost(host: string): string {
  if (host === '0.0.0.0' || host === '::') return '127.0.0.1'
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

export function parseServerEndpointManifest(raw: string): ServerEndpointManifest | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ServerEndpointManifest>
    if (parsed.schemaVersion !== 1) return null
    if (!Number.isInteger(parsed.pid) || (parsed.pid ?? 0) <= 0) return null
    if (!Number.isFinite(parsed.startedAt) || (parsed.startedAt ?? 0) <= 0) return null
    if (typeof parsed.url !== 'string' || !/^wss?:\/\//.test(parsed.url)) return null
    if (typeof parsed.tokenFile !== 'string' || !isAbsolute(parsed.tokenFile)) return null
    if (parsed.webui !== undefined) {
      if (parsed.webui.enabled !== true || typeof parsed.webui.autoLogin !== 'boolean') return null
    }
    return parsed as ServerEndpointManifest
  } catch {
    return null
  }
}

export function readServerEndpoint(endpointFile?: string): ServerEndpointManifest | null {
  const file = resolveServerEndpointFile(endpointFile)
  if (!existsSync(file)) return null
  try {
    return parseServerEndpointManifest(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function canConnect(url: URL, timeoutMs: number): Promise<boolean> {
  const port = Number.parseInt(url.port || (url.protocol === 'wss:' ? '443' : '80'), 10)
  return new Promise(resolve => {
    const socket = createConnection({ host: url.hostname, port })
    let settled = false
    const finish = (connected: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(connected)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

export async function readLiveServerConnection(
  endpointFile?: string,
  timeoutMs = 750,
): Promise<LiveServerConnection | null> {
  const endpoint = readServerEndpoint(endpointFile)
  if (!endpoint || !isProcessAlive(endpoint.pid)) return null

  let token: string
  try {
    token = readFileSync(endpoint.tokenFile, 'utf8').trim()
  } catch {
    return null
  }
  if (token.length < 16) return null

  let url: URL
  try {
    url = new URL(endpoint.url)
  } catch {
    return null
  }
  if (!await canConnect(url, timeoutMs)) return null

  return { endpoint, token }
}

export function publishServerEndpoint(options: PublishServerEndpointOptions): ServerEndpointManifest {
  const endpointFile = resolveServerEndpointFile(options.endpointFile)
  const manifest: ServerEndpointManifest = {
    schemaVersion: 1,
    pid: process.pid,
    startedAt: Date.now(),
    url: `${options.protocol}://${normalizeClientHost(options.host)}:${options.port}`,
    tokenFile: options.tokenFile,
    ...(options.webui ? { webui: options.webui } : {}),
  }
  const temporaryFile = `${endpointFile}.${process.pid}.tmp`
  try {
    writeFileSync(temporaryFile, JSON.stringify(manifest), { encoding: 'utf8', mode: 0o600 })
    renameSync(temporaryFile, endpointFile)
  } finally {
    try { unlinkSync(temporaryFile) } catch { /* already moved or never created */ }
  }
  publishedEndpointFiles.add(endpointFile)
  if (!exitCleanupRegistered) {
    exitCleanupRegistered = true
    process.once('exit', () => {
      for (const file of publishedEndpointFiles) removeServerEndpoint(file)
    })
  }
  return manifest
}

export function removeServerEndpoint(endpointFile?: string): void {
  const file = resolveServerEndpointFile(endpointFile)
  try {
    const manifest = readServerEndpoint(file)
    if (manifest?.pid === process.pid) {
      unlinkSync(file)
      publishedEndpointFiles.delete(file)
    }
  } catch {
    // Endpoint cleanup is best effort; stale manifests are rejected by clients.
  }
}
