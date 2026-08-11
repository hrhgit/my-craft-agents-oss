import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, connect, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export type ElectronDevControlCommand = 'status' | 'start' | 'restart'

export interface ElectronDevControlStatus {
  state: 'idle' | 'starting' | 'running' | 'restarting' | 'stopping'
  supervisorPid: number
  vitePid?: number
  vitePort?: number
  electronPid?: number
}

export interface ElectronDevControlResponse extends ElectronDevControlStatus {
  ok: boolean
  operationId: string
  previousElectronPid?: number
  elapsedMs?: number
  error?: string
}

interface ElectronDevControlRequest {
  version: 1
  operationId: string
  command: ElectronDevControlCommand
  repoRoot: string
  token: string
}

interface ElectronDevControlStateFile {
  version: 1
  repoRoot: string
  pid: number
  recordedAt: number
  port: number
  token: string
}

export interface ElectronDevControlHandlers {
  status(): ElectronDevControlStatus
  start(): Promise<ElectronDevControlResponse>
  restart(): Promise<ElectronDevControlResponse>
}

export interface ElectronDevControlServer {
  port: number
  statePath: string
  close(): Promise<void>
}

const MAX_REQUEST_BYTES = 64 * 1024

export function electronDevControlStatePath(repoRoot: string, stateDirectory = defaultStateDirectory()): string {
  const identity = createHash('sha256').update(normalizeRepoRoot(repoRoot)).digest('hex').slice(0, 24)
  return join(stateDirectory, `${identity}.json`)
}

export async function startElectronDevControlServer(
  repoRoot: string,
  handlers: ElectronDevControlHandlers,
  stateDirectory = defaultStateDirectory(),
): Promise<ElectronDevControlServer> {
  const normalizedRoot = normalizeRepoRoot(repoRoot)
  const statePath = electronDevControlStatePath(normalizedRoot, stateDirectory)
  const token = randomUUID()
  let closed = false

  const server = createServer(socket => {
    socket.setEncoding('utf8')
    let body = ''
    let handled = false
    socket.on('data', chunk => {
      if (handled) return
      body += chunk
      if (body.length > MAX_REQUEST_BYTES) socket.destroy(new Error('Electron dev control request is too large'))
      if (!body.includes('\n')) return
      handled = true
      const line = body.slice(0, body.indexOf('\n'))
      void handleRequest(line, normalizedRoot, token, handlers)
        .then(response => socket.end(`${JSON.stringify(response)}\n`))
        .catch(error => socket.end(`${JSON.stringify(failureResponse('', handlers.status(), error))}\n`))
    })
  })

  await listen(server)
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Electron dev control server did not bind a TCP port')

  const state: ElectronDevControlStateFile = {
    version: 1,
    repoRoot: normalizedRoot,
    pid: process.pid,
    recordedAt: Date.now(),
    port: address.port,
    token,
  }
  writeStateFile(statePath, state)

  return {
    port: address.port,
    statePath,
    close: async () => {
      if (closed) return
      closed = true
      await closeServer(server)
      removeOwnedStateFile(statePath, token)
    },
  }
}

export async function sendElectronDevControlCommand(
  repoRoot: string,
  command: ElectronDevControlCommand,
  options: { stateDirectory?: string; timeoutMs?: number } = {},
): Promise<ElectronDevControlResponse | undefined> {
  const normalizedRoot = normalizeRepoRoot(repoRoot)
  const statePath = electronDevControlStatePath(normalizedRoot, options.stateDirectory)
  const state = readStateFile(statePath)
  if (!state || state.repoRoot !== normalizedRoot) {
    if (state) removeOwnedStateFile(statePath, state.token)
    return undefined
  }

  const operationId = randomUUID()
  const request: ElectronDevControlRequest = {
    version: 1,
    operationId,
    command,
    repoRoot: normalizedRoot,
    token: state.token,
  }

  let response: ElectronDevControlResponse
  try {
    response = await sendRequest(state.port, request, options.timeoutMs ?? 15_000)
  } catch (error) {
    if (!isUnavailableControlEndpoint(error)) throw error
    removeOwnedStateFile(statePath, state.token)
    return undefined
  }

  if (response.operationId !== operationId || response.supervisorPid !== state.pid) {
    removeOwnedStateFile(statePath, state.token)
    return undefined
  }
  return response
}

function normalizeRepoRoot(repoRoot: string): string {
  const normalized = resolve(repoRoot)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function defaultStateDirectory(): string {
  return join(tmpdir(), 'mortise-electron-dev')
}

async function handleRequest(
  line: string,
  repoRoot: string,
  token: string,
  handlers: ElectronDevControlHandlers,
): Promise<ElectronDevControlResponse> {
  let request: ElectronDevControlRequest
  try {
    request = JSON.parse(line) as ElectronDevControlRequest
  } catch (error) {
    return failureResponse('', handlers.status(), error)
  }

  if (
    request.version !== 1
    || request.token !== token
    || normalizeRepoRoot(request.repoRoot) !== repoRoot
    || !request.operationId
  ) {
    return failureResponse(request.operationId ?? '', handlers.status(), 'Electron dev control identity mismatch')
  }

  if (request.command === 'status') return { ok: true, operationId: request.operationId, ...handlers.status() }
  if (request.command === 'start') return { ...await handlers.start(), operationId: request.operationId }
  if (request.command === 'restart') return { ...await handlers.restart(), operationId: request.operationId }
  return failureResponse(request.operationId, handlers.status(), `Unsupported command: ${String(request.command)}`)
}

function failureResponse(
  operationId: string,
  status: ElectronDevControlStatus,
  error: unknown,
): ElectronDevControlResponse {
  return { ok: false, operationId, ...status, error: error instanceof Error ? error.message : String(error) }
}

function listen(server: Server): Promise<void> {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolveListen()
    })
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise(resolveClose => server.close(() => resolveClose()))
}

function writeStateFile(statePath: string, state: ElectronDevControlStateFile): void {
  mkdirSync(dirname(statePath), { recursive: true })
  const tempPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(tempPath, `${JSON.stringify(state)}\n`, 'utf8')
  renameSync(tempPath, statePath)
}

function readStateFile(statePath: string): ElectronDevControlStateFile | undefined {
  if (!existsSync(statePath)) return undefined
  try {
    const value = JSON.parse(readFileSync(statePath, 'utf8')) as ElectronDevControlStateFile
    if (value.version !== 1 || !value.repoRoot || !value.pid || !value.port || !value.token) return undefined
    return value
  } catch {
    return undefined
  }
}

function removeOwnedStateFile(statePath: string, token: string): void {
  const current = readStateFile(statePath)
  if (current?.token !== token) return
  rmSync(statePath, { force: true })
}

function sendRequest(
  port: number,
  request: ElectronDevControlRequest,
  timeoutMs: number,
): Promise<ElectronDevControlResponse> {
  return new Promise((resolveResponse, reject) => {
    const socket = connect({ host: '127.0.0.1', port })
    let body = ''
    const timeout = setTimeout(() => socket.destroy(new Error('Electron dev control request timed out')), timeoutMs)
    socket.setEncoding('utf8')
    socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`))
    socket.on('data', chunk => { body += chunk })
    socket.once('error', error => {
      clearTimeout(timeout)
      reject(error)
    })
    socket.once('end', () => {
      clearTimeout(timeout)
      try {
        resolveResponse(JSON.parse(body.trim()) as ElectronDevControlResponse)
      } catch (error) {
        reject(error)
      }
    })
  })
}

function isUnavailableControlEndpoint(error: unknown): boolean {
  if (error instanceof SyntaxError) return true
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EPIPE'
}
