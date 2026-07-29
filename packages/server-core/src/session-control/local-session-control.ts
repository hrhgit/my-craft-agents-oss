import { createHash, randomUUID } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import type {
  SessionControlCoordinatorSnapshot,
  SessionTurnControl,
  SessionTurnControlHandle,
  SessionTurnControlState,
} from './types'
import { SessionControlAcquireError } from './types'

type CoordinatorRequest =
  | { id: string; type: 'register'; backendId: string; controls: CoordinatorControl[] }
  | { id: string; type: 'acquire'; backendId: string; control: CoordinatorControl }
  | { id: string; type: 'update'; backendId: string; sessionId: string; handleId: string; state: SessionTurnControlState }
  | { id: string; type: 'release'; backendId: string; sessionId: string; handleId: string }
  | { id: string; type: 'snapshot' }

type CoordinatorResponse = {
  id: string
  ok: boolean
  reason?: 'conflict' | 'coordinator-recovering'
  snapshot?: SessionControlCoordinatorSnapshot
}

type CoordinatorRequestWithoutId = CoordinatorRequest extends infer Request
  ? Request extends { id: string } ? Omit<Request, 'id'> : never
  : never

interface CoordinatorControl {
  sessionId: string
  backendId: string
  handleId: string
  attemptId: string
  state: SessionTurnControlState
}

interface LocalSessionControlOptions {
  backendId?: string
  configDir?: string
  recoveryGraceMs?: number
}

interface PendingRequest {
  resolve: (response: CoordinatorResponse) => void
  reject: (error: Error) => void
}

function endpointHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24)
}

function configRoot(configDir?: string): string {
  return configDir ?? process.env.MORTISE_CONFIG_DIR ?? join(homedir(), '.mortise')
}

function localEndpoint(name: string, root: string): string {
  const identity = endpointHash(root)
  if (process.platform === 'win32') return `\\\\.\\pipe\\mortise-${name}-${identity}`
  return join(tmpdir(), `mortise-${name}-${identity}.sock`)
}

export function getSessionCoordinatorEndpoint(configDir?: string): string {
  return localEndpoint('session-coordinator', configRoot(configDir))
}

export function getSessionControlLockEndpoint(sessionId: string, configDir?: string): string {
  return localEndpoint(`session-${endpointHash(sessionId)}`, configRoot(configDir))
}

function listen(server: Server, endpoint: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(endpoint)
  })
}

function connect(endpoint: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint)
    const timeout = setTimeout(() => {
      socket.destroy()
      reject(new Error(`Timed out connecting to local endpoint ${endpoint}`))
    }, 500)
    timeout.unref()
    const onError = (error: Error) => {
      clearTimeout(timeout)
      socket.off('connect', onConnect)
      socket.destroy()
      reject(error)
    }
    const onConnect = () => {
      clearTimeout(timeout)
      socket.off('error', onError)
      resolve(socket)
    }
    socket.once('error', onError)
    socket.once('connect', onConnect)
  })
}

async function closeServer(server: Server, endpoint: string): Promise<void> {
  if (server.listening) {
    await new Promise<void>(resolve => {
      const fallback = setTimeout(resolve, 250)
      fallback.unref()
      server.close(() => {
        clearTimeout(fallback)
        resolve()
      })
    })
  }
  if (process.platform !== 'win32') await rm(endpoint, { force: true }).catch(() => undefined)
}

class CoordinatorHost {
  private readonly server = createServer(socket => this.attach(socket))
  private readonly controls = new Map<string, CoordinatorControl>()
  private readonly sockets = new Map<Socket, string | undefined>()
  private recoveryUntil = 0

  constructor(
    readonly endpoint: string,
    recoveryGraceMs: number,
  ) {
    this.recoveryUntil = Date.now() + recoveryGraceMs
  }

  async start(): Promise<void> {
    await listen(this.server, this.endpoint)
    this.server.unref()
  }

  async close(): Promise<void> {
    for (const socket of this.sockets.keys()) socket.destroy()
    this.sockets.clear()
    await closeServer(this.server, this.endpoint)
  }

  private get recovering(): boolean {
    return Date.now() < this.recoveryUntil
  }

  private attach(socket: Socket): void {
    this.sockets.set(socket, undefined)
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', chunk => {
      buffer += chunk
      while (true) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) break
        const raw = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (!raw) continue
        try {
          const request = JSON.parse(raw) as CoordinatorRequest
          const response = this.handle(socket, request)
          socket.write(`${JSON.stringify(response)}\n`)
        } catch {
          socket.destroy()
          return
        }
      }
    })
    socket.on('close', () => {
      const backendId = this.sockets.get(socket)
      this.sockets.delete(socket)
      if (!backendId) return
      for (const [sessionId, control] of this.controls) {
        if (control.backendId === backendId) this.controls.delete(sessionId)
      }
    })
  }

  private handle(socket: Socket, request: CoordinatorRequest): CoordinatorResponse {
    if (request.type === 'snapshot') {
      return {
        id: request.id,
        ok: true,
        snapshot: { recovering: this.recovering, controls: [...this.controls.values()] },
      }
    }

    this.sockets.set(socket, request.backendId)
    if (request.type === 'register') {
      for (const control of request.controls) {
        const current = this.controls.get(control.sessionId)
        if (!current || current.handleId === control.handleId) this.controls.set(control.sessionId, control)
      }
      return { id: request.id, ok: true }
    }

    if (request.type === 'acquire') {
      if (this.recovering) return { id: request.id, ok: false, reason: 'coordinator-recovering' }
      const current = this.controls.get(request.control.sessionId)
      if (current && current.handleId !== request.control.handleId) {
        return { id: request.id, ok: false, reason: 'conflict' }
      }
      this.controls.set(request.control.sessionId, request.control)
      return { id: request.id, ok: true }
    }

    const current = this.controls.get(request.sessionId)
    if (!current || current.backendId !== request.backendId || current.handleId !== request.handleId) {
      return { id: request.id, ok: false, reason: 'conflict' }
    }
    if (request.type === 'update') current.state = request.state
    else this.controls.delete(request.sessionId)
    return { id: request.id, ok: true }
  }
}

class OsSessionLock {
  private closed = false

  private constructor(
    private readonly server: Server,
    readonly endpoint: string,
  ) {}

  static async acquire(sessionId: string, configDir?: string): Promise<OsSessionLock> {
    const endpoint = getSessionControlLockEndpoint(sessionId, configDir)
    const server = createServer(socket => socket.destroy())
    try {
      await listen(server, endpoint)
      server.unref()
      return new OsSessionLock(server, endpoint)
    } catch (error) {
      server.close()
      throw new SessionControlAcquireError(sessionId, 'conflict')
    }
  }

  async release(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await closeServer(this.server, this.endpoint)
  }
}

class LocalSessionTurnControlHandle implements SessionTurnControlHandle {
  private released = false
  state: SessionTurnControlState = 'starting'

  constructor(
    readonly sessionId: string,
    readonly backendId: string,
    readonly handleId: string,
    readonly attemptId: string,
    readonly acquiredAt: number,
    private readonly osLock: OsSessionLock,
    private readonly owner: LocalSessionControlClient,
  ) {}

  get valid(): boolean {
    return !this.released
  }

  assertValid(): void {
    if (this.released) throw new Error(`Session turn control handle ${this.handleId} is no longer valid`)
  }

  async setState(state: SessionTurnControlState): Promise<void> {
    this.assertValid()
    await this.owner.update(this, state)
    this.state = state
  }

  async release(): Promise<void> {
    if (this.released) return
    this.released = true
    this.owner.remove(this)
    await this.owner.releaseRemote(this).catch(() => undefined)
    await this.osLock.release()
  }
}

export class LocalSessionControlClient implements SessionTurnControl {
  readonly backendId: string
  private readonly configDir: string
  private readonly endpoint: string
  private readonly recoveryGraceMs: number
  private socket?: Socket
  private host?: CoordinatorHost
  private buffer = ''
  private connectedBefore = false
  private readonly pending = new Map<string, PendingRequest>()
  private readonly active = new Map<string, LocalSessionTurnControlHandle>()

  constructor(options: LocalSessionControlOptions = {}) {
    this.backendId = options.backendId ?? `${process.pid}:${randomUUID()}`
    this.configDir = configRoot(options.configDir)
    this.endpoint = getSessionCoordinatorEndpoint(this.configDir)
    this.recoveryGraceMs = options.recoveryGraceMs ?? 150
  }

  async acquire(sessionId: string): Promise<SessionTurnControlHandle> {
    const existing = this.active.get(sessionId)
    if (existing?.valid) throw new SessionControlAcquireError(sessionId, 'conflict')

    const osLock = await OsSessionLock.acquire(sessionId, this.configDir)
    const handle = new LocalSessionTurnControlHandle(
      sessionId,
      this.backendId,
      randomUUID(),
      randomUUID(),
      Date.now(),
      osLock,
      this,
    )
    try {
      const request: CoordinatorRequestWithoutId = {
        type: 'acquire',
        backendId: this.backendId,
        control: this.toControl(handle),
      }
      let response: CoordinatorResponse | undefined
      let lastError: unknown
      for (let attempt = 0; attempt < 5 && !response; attempt++) {
        try {
          await this.ensureConnected()
          response = await this.request(request)
        } catch (error) {
          lastError = error
          this.socket?.destroy()
          this.socket = undefined
          await new Promise(resolve => setTimeout(resolve, 25))
        }
      }
      if (!response) throw lastError ?? new Error('Session coordinator is unavailable')
      if (!response.ok) {
        throw new SessionControlAcquireError(sessionId, response.reason ?? 'conflict')
      }
      this.active.set(sessionId, handle)
      return handle
    } catch (error) {
      await osLock.release()
      if (error instanceof SessionControlAcquireError) throw error
      throw new SessionControlAcquireError(sessionId, 'coordinator-unavailable')
    }
  }

  async close(options: { graceMs?: number } = {}): Promise<void> {
    const handles = [...this.active.values()]
    if (options.graceMs && handles.length > 0) {
      await Promise.race([
        Promise.all(handles.map(handle => handle.release())),
        new Promise(resolve => setTimeout(resolve, options.graceMs)),
      ])
    }
    await Promise.all([...this.active.values()].map(handle => handle.release()))
    this.socket?.destroy()
    this.socket = undefined
    for (const pending of this.pending.values()) pending.reject(new Error('Session coordinator client closed'))
    this.pending.clear()
    await this.host?.close()
    this.host = undefined
  }

  async snapshot(): Promise<SessionControlCoordinatorSnapshot> {
    let lastError: unknown
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await this.ensureConnected()
        const response = await this.request({ type: 'snapshot' })
        if (!response.snapshot) throw new Error('Session coordinator did not return a snapshot')
        return response.snapshot
      } catch (error) {
        lastError = error
        this.socket?.destroy()
        this.socket = undefined
        await new Promise(resolve => setTimeout(resolve, 25))
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Session coordinator is unavailable')
  }

  /** Test seam for coordinator-crash recovery; active OS locks remain held. */
  async simulateCoordinatorCrashForTest(): Promise<void> {
    const host = this.host
    this.host = undefined
    await host?.close()
    this.socket?.destroy()
    this.socket = undefined
  }

  async update(handle: LocalSessionTurnControlHandle, state: SessionTurnControlState): Promise<void> {
    handle.assertValid()
    try {
      await this.ensureConnected()
      const response = await this.request({
        type: 'update',
        backendId: this.backendId,
        sessionId: handle.sessionId,
        handleId: handle.handleId,
        state,
      })
      if (!response.ok) throw new Error(`Session coordinator rejected handle ${handle.handleId}`)
    } catch {
      // Existing control survives coordinator failure because the backend still
      // owns the operating-system lock. The next connection re-registers it.
    }
  }

  remove(handle: LocalSessionTurnControlHandle): void {
    if (this.active.get(handle.sessionId) === handle) this.active.delete(handle.sessionId)
  }

  async releaseRemote(handle: LocalSessionTurnControlHandle): Promise<void> {
    if (!this.socket) return
    await this.request({
      type: 'release',
      backendId: this.backendId,
      sessionId: handle.sessionId,
      handleId: handle.handleId,
    })
  }

  private toControl(handle: LocalSessionTurnControlHandle): CoordinatorControl {
    return {
      sessionId: handle.sessionId,
      backendId: handle.backendId,
      handleId: handle.handleId,
      attemptId: handle.attemptId,
      state: handle.state,
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return
    let socket: Socket | undefined
    try {
      socket = await connect(this.endpoint)
    } catch {
      const host = new CoordinatorHost(this.endpoint, this.connectedBefore ? this.recoveryGraceMs : 0)
      try {
        await host.start()
        this.host = host
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
      }
      socket = await connect(this.endpoint)
    }
    this.attachSocket(socket)
    this.connectedBefore = true
    const response = await this.request({
      type: 'register',
      backendId: this.backendId,
      controls: [...this.active.values()].filter(handle => handle.valid).map(handle => this.toControl(handle)),
    })
    if (!response.ok) throw new Error('Session coordinator rejected backend registration')
  }

  private attachSocket(socket: Socket): void {
    this.socket = socket
    this.buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', chunk => {
      this.buffer += chunk
      while (true) {
        const newline = this.buffer.indexOf('\n')
        if (newline < 0) break
        const raw = this.buffer.slice(0, newline)
        this.buffer = this.buffer.slice(newline + 1)
        if (!raw) continue
        const response = JSON.parse(raw) as CoordinatorResponse
        const pending = this.pending.get(response.id)
        if (!pending) continue
        this.pending.delete(response.id)
        pending.resolve(response)
      }
    })
    socket.on('close', () => {
      if (this.socket === socket) this.socket = undefined
      for (const pending of this.pending.values()) pending.reject(new Error('Session coordinator disconnected'))
      this.pending.clear()
    })
    socket.on('error', () => socket.destroy())
  }

  private request(request: CoordinatorRequestWithoutId): Promise<CoordinatorResponse> {
    const socket = this.socket
    if (!socket || socket.destroyed) return Promise.reject(new Error('Session coordinator is not connected'))
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Session coordinator request timed out'))
      }, 1_000)
      timeout.unref()
      this.pending.set(id, {
        resolve: response => {
          clearTimeout(timeout)
          resolve(response)
        },
        reject: error => {
          clearTimeout(timeout)
          reject(error)
        },
      })
      socket.write(`${JSON.stringify({ ...request, id })}\n`, error => {
        if (!error) return
        this.pending.delete(id)
        clearTimeout(timeout)
        reject(error)
      })
    })
  }
}

export function getDefaultSessionTurnControl(): SessionTurnControl {
  return new LocalSessionControlClient()
}
