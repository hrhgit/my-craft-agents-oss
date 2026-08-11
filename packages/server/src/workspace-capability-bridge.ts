import { randomUUID } from 'node:crypto'

import {
  type CapabilityProvider,
  type CapabilityProviderContext,
} from '@mortise/server-core/capabilities'
import {
  EXECUTION_ROUTE_ERROR_CODES,
  REQUESTING_CLIENT_CAPABILITY_NAMES,
  WORKSPACE_CAPABILITY_BRIDGE_VERSION,
  isWorkspaceCapabilityBridgeToServerV1,
  type CapabilityRequestV1,
  type WorkspaceCapabilityBridgeToHostV1,
} from '@mortise/shared/protocol'

export interface WorkspaceCapabilityBridgeTransport {
  isConnected(): boolean
  send(message: WorkspaceCapabilityBridgeToHostV1): void
  subscribe(
    onMessage: (message: unknown) => void,
    onDisconnect: () => void,
  ): () => void
}

interface CapabilitySessionManager {
  registerCapabilityProvider(provider: CapabilityProvider): () => void
  getSession(sessionId: string): Promise<{ workspaceId: string } | null | undefined>
  getSessionPath(sessionId: string): string | null | undefined
}

interface PendingInvocation {
  context: CapabilityProviderContext
  resolve(output: unknown): void
  reject(error: Error): void
  onAbort(): void
}

function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

function createProcessTransport(): WorkspaceCapabilityBridgeTransport {
  return {
    isConnected: () => process.connected === true && typeof process.send === 'function',
    send(message) {
      if (process.connected !== true || typeof process.send !== 'function') {
        throw codedError(
          EXECUTION_ROUTE_ERROR_CODES.noInteractiveClient,
          'Electron capability bridge is not connected',
        )
      }
      process.send(message)
    },
    subscribe(onMessage, onDisconnect) {
      process.on('message', onMessage)
      process.on('disconnect', onDisconnect)
      return () => {
        process.off('message', onMessage)
        process.off('disconnect', onDisconnect)
      }
    },
  }
}

export class WorkspaceCapabilityBridgeClient {
  private readonly pending = new Map<string, PendingInvocation>()
  private readonly providers = new Map<string, CapabilityProvider>()
  private readonly unsubscribe: () => void

  constructor(
    private readonly transport: WorkspaceCapabilityBridgeTransport = createProcessTransport(),
    private readonly validationProbeEnabled = process.env.MORTISE_UI_TEST_HOST === '1',
  ) {
    this.unsubscribe = transport.subscribe(
      message => this.handleMessage(message),
      () => this.rejectAllDisconnected(),
    )
  }

  registerProviders(sessionManager: CapabilitySessionManager): () => void {
    const unregister = REQUESTING_CLIENT_CAPABILITY_NAMES.map(capability => {
      const provider: CapabilityProvider = {
        capability,
        invoke: (operation, input, context) => this.invoke(sessionManager, operation, input, context),
      }
      this.providers.set(capability, provider)
      return sessionManager.registerCapabilityProvider(provider)
    })
    return () => {
      for (const dispose of unregister) dispose()
      this.providers.clear()
      this.dispose()
    }
  }

  dispose(): void {
    this.unsubscribe()
    this.rejectAllDisconnected()
  }

  private async invoke(
    sessionManager: CapabilitySessionManager,
    operation: string,
    input: unknown,
    context: CapabilityProviderContext,
  ): Promise<unknown> {
    if (!this.transport.isConnected()) {
      throw codedError(
        EXECUTION_ROUTE_ERROR_CODES.noInteractiveClient,
        `No Electron client can execute capability: ${context.request.capability}`,
      )
    }

    const session = await sessionManager.getSession(context.request.sessionId)
    if (!session) throw new Error('Session not found')

    const bridgeId = randomUUID()
    const request: CapabilityRequestV1 = {
      ...context.request,
      operation,
      input,
    }

    return new Promise<unknown>((resolve, reject) => {
      const onAbort = () => {
        const invocation = this.pending.get(bridgeId)
        if (!invocation) return
        this.pending.delete(bridgeId)
        try {
          if (this.transport.isConnected()) {
            this.transport.send({
              type: 'workspace_capability_cancel',
              version: WORKSPACE_CAPABILITY_BRIDGE_VERSION,
              bridgeId,
            })
          }
        } catch {
          // The router already owns the cancellation result.
        }
        reject(codedError('CAPABILITY_CANCELLED', 'Capability request cancelled'))
      }

      this.pending.set(bridgeId, { context, resolve, reject, onAbort })
      context.signal.addEventListener('abort', onAbort, { once: true })

      try {
        this.transport.send({
          type: 'workspace_capability_request',
          version: WORKSPACE_CAPABILITY_BRIDGE_VERSION,
          bridgeId,
          request,
          session: {
            workspaceId: session.workspaceId,
            sessionPath: sessionManager.getSessionPath(context.request.sessionId) ?? undefined,
          },
        })
      } catch (error) {
        this.pending.delete(bridgeId)
        context.signal.removeEventListener('abort', onAbort)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private handleMessage(message: unknown): void {
    if (!isWorkspaceCapabilityBridgeToServerV1(message)) return
    if (message.type === 'workspace_capability_probe') {
      void this.handleProbe(message.bridgeId, message.request)
      return
    }
    const invocation = this.pending.get(message.bridgeId)
    if (!invocation) return

    if (message.type === 'workspace_capability_progress') {
      invocation.context.reportProgress(message.progress)
      return
    }

    this.pending.delete(message.bridgeId)
    invocation.context.signal.removeEventListener('abort', invocation.onAbort)
    if (message.ok) invocation.resolve(message.output)
    else invocation.reject(codedError(message.error.code, message.error.message))
  }

  private async handleProbe(bridgeId: string, request: CapabilityRequestV1): Promise<void> {
    if (!this.validationProbeEnabled) {
      this.sendProbeResult({
        type: 'workspace_capability_probe_result',
        version: WORKSPACE_CAPABILITY_BRIDGE_VERSION,
        bridgeId,
        ok: false,
        error: { code: 'UNSUPPORTED_CAPABILITY', message: 'Capability probes require the UI validation host' },
        progress: [],
      })
      return
    }
    const provider = this.providers.get(request.capability)
    const progress: unknown[] = []
    if (!provider) {
      this.sendProbeResult({
        type: 'workspace_capability_probe_result',
        version: WORKSPACE_CAPABILITY_BRIDGE_VERSION,
        bridgeId,
        ok: false,
        error: { code: 'UNSUPPORTED_CAPABILITY', message: `Unsupported capability probe: ${request.capability}` },
        progress,
      })
      return
    }

    const controller = new AbortController()
    const timeoutMs = request.timeoutMs ?? 30_000
    const timer = setTimeout(() => controller.abort('timeout'), timeoutMs)
    try {
      const output = await provider.invoke(request.operation, request.input, {
        request,
        signal: controller.signal,
        reportProgress(value) { progress.push(value) },
      })
      this.sendProbeResult({
        type: 'workspace_capability_probe_result',
        version: WORKSPACE_CAPABILITY_BRIDGE_VERSION,
        bridgeId,
        ok: true,
        output,
        progress,
      })
    } catch (error) {
      this.sendProbeResult({
        type: 'workspace_capability_probe_result',
        version: WORKSPACE_CAPABILITY_BRIDGE_VERSION,
        bridgeId,
        ok: false,
        error: {
          code: error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
            ? error.code
            : 'PROVIDER_ERROR',
          message: error instanceof Error ? error.message : String(error ?? 'Capability probe failed'),
        },
        progress,
      })
    } finally {
      clearTimeout(timer)
    }
  }

  private sendProbeResult(message: WorkspaceCapabilityBridgeToHostV1): void {
    try { this.transport.send(message) } catch { /* parent disconnect owns probe settlement */ }
  }

  private rejectAllDisconnected(): void {
    const error = codedError(
      EXECUTION_ROUTE_ERROR_CODES.noInteractiveClient,
      'Electron capability bridge disconnected',
    )
    for (const [bridgeId, invocation] of this.pending) {
      this.pending.delete(bridgeId)
      invocation.context.signal.removeEventListener('abort', invocation.onAbort)
      invocation.reject(error)
    }
  }
}

export function registerWorkspaceCapabilityBridgeProviders(
  sessionManager: CapabilitySessionManager,
  transport?: WorkspaceCapabilityBridgeTransport,
): () => void {
  return new WorkspaceCapabilityBridgeClient(transport).registerProviders(sessionManager)
}
