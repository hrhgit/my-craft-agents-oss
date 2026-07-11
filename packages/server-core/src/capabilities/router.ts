import type {
  CapabilityProvider,
  CapabilityRequestV1,
  CapabilityResultV1,
  CapabilityRouterOptions,
} from './types.ts'
import { isDeepStrictEqual } from 'node:util'

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_COMPLETED_RESULT_LIMIT = 500

function failure(
  requestId: string,
  status: Exclude<CapabilityResultV1['status'], 'success'>,
  code: string,
  message: string,
): CapabilityResultV1 {
  return { requestId, status, error: { code, message } }
}

function validateRequest(request: CapabilityRequestV1): string | undefined {
  if (!request || typeof request !== 'object') return 'Request must be an object'
  if (request.version !== 1) return 'Unsupported capability protocol version'
  for (const key of ['requestId', 'capability', 'sessionId', 'runtimeId', 'extensionId', 'operation'] as const) {
    if (typeof request[key] !== 'string' || request[key].trim() === '') return `${key} must be a non-empty string`
  }
  if (request.timeoutMs !== undefined && (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0)) {
    return 'timeoutMs must be a positive finite number'
  }
  return undefined
}

interface PendingRequest {
  request: CapabilityRequestV1
  runtimeId: string
  controller: AbortController
  promise: Promise<CapabilityResultV1>
}

export class CapabilityRouter {
  private readonly providers = new Map<string, CapabilityProvider>()
  private readonly pending = new Map<string, PendingRequest>()
  private readonly completed = new Map<string, { request: CapabilityRequestV1; result: CapabilityResultV1 }>()
  private readonly declarations = new Map<string, { sessionId: string; operations: Set<string> }>()

  constructor(private readonly options: CapabilityRouterOptions = {}) {}

  register(provider: CapabilityProvider): () => void {
    if (!provider.capability.trim()) throw new Error('Capability provider name must not be empty')
    if (this.providers.has(provider.capability)) {
      throw new Error(`Capability provider already registered: ${provider.capability}`)
    }
    this.providers.set(provider.capability, provider)
    return () => {
      if (this.providers.get(provider.capability) === provider) this.providers.delete(provider.capability)
    }
  }

  declare(declaration: import('./types.ts').ExtensionCapabilityDeclarationV1): void {
    if (declaration.version !== 1 || !declaration.sessionId.trim() || !declaration.runtimeId.trim() || !declaration.extensionId.trim()) {
      throw new Error('Invalid extension capability declaration')
    }
    const key = `${declaration.runtimeId}\0${declaration.extensionId}`
    const allowed = new Set<string>()
    for (const item of declaration.declarations) {
      const capability = item.capability?.trim()
      if (!capability || !Array.isArray(item.operations)) throw new Error('Invalid capability declaration entry')
      for (const operation of item.operations) {
        if (typeof operation !== 'string' || !operation.trim()) throw new Error('Invalid capability declaration operation')
        allowed.add(`${capability}\0${operation.trim()}`)
      }
    }
    this.declarations.set(key, { sessionId: declaration.sessionId, operations: allowed })
  }

  invoke(request: CapabilityRequestV1, onProgress?: (event: import('./types.ts').CapabilityProgressV1) => void): Promise<CapabilityResultV1> {
    const validationError = validateRequest(request)
    if (validationError) {
      return Promise.resolve(failure(request?.requestId ?? '', 'failed', 'INVALID_REQUEST', validationError))
    }

    const completed = this.completed.get(request.requestId)
    if (completed) {
      return Promise.resolve(isDeepStrictEqual(completed.request, request)
        ? completed.result
        : failure(request.requestId, 'failed', 'REQUEST_ID_CONFLICT', 'requestId was already used for a different request'))
    }
    const existing = this.pending.get(request.requestId)
    if (existing) {
      return isDeepStrictEqual(existing.request, request)
        ? existing.promise
        : Promise.resolve(failure(request.requestId, 'failed', 'REQUEST_ID_CONFLICT', 'requestId is in use by a different request'))
    }

    const controller = new AbortController()
    const promise = this.execute(request, controller, onProgress)
    this.pending.set(request.requestId, { request, runtimeId: request.runtimeId, controller, promise })
    return promise
  }

  cancel(requestId: string, runtimeId?: string): boolean {
    const request = this.pending.get(requestId)
    if (!request || (runtimeId !== undefined && request.runtimeId !== runtimeId)) return false
    request.controller.abort('cancelled')
    return true
  }

  releaseRuntime(runtimeId: string): number {
    let cancelled = 0
    for (const request of this.pending.values()) {
      if (request.runtimeId === runtimeId && !request.controller.signal.aborted) {
        request.controller.abort('runtime_released')
        cancelled++
      }
    }
    for (const key of this.declarations.keys()) {
      if (key.startsWith(`${runtimeId}\0`)) this.declarations.delete(key)
    }
    for (const [requestId, completed] of this.completed) {
      if (completed.request.runtimeId === runtimeId) this.completed.delete(requestId)
    }
    return cancelled
  }

  private async execute(
    request: CapabilityRequestV1,
    controller: AbortController,
    onProgress?: (event: import('./types.ts').CapabilityProgressV1) => void,
  ): Promise<CapabilityResultV1> {
    const startedAt = Date.now()
    this.options.audit?.({
      phase: 'started', requestId: request.requestId, capability: request.capability,
      operation: request.operation, sessionId: request.sessionId, runtimeId: request.runtimeId,
      extensionId: request.extensionId,
    })

    let progressSequence = 0
    const timeoutMs = request.timeoutMs ?? this.options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
    const timer = setTimeout(() => controller.abort('timeout'), timeoutMs)
    let result: CapabilityResultV1

    try {
      const declaration = this.declarations.get(`${request.runtimeId}\0${request.extensionId}`)
      const declared = this.options.requireDeclarations !== true || (
        declaration?.sessionId === request.sessionId &&
        declaration.operations.has(`${request.capability}\0${request.operation}`)
      )
      if (!declared) {
        result = failure(request.requestId, 'denied', 'CAPABILITY_NOT_DECLARED', 'Extension did not declare this capability operation')
      } else {
        const provider = this.providers.get(request.capability)
        if (!provider) {
        result = failure(request.requestId, 'unsupported', 'UNSUPPORTED_CAPABILITY', `Unsupported capability: ${request.capability}`)
        } else {
          const authorization = await this.options.authorize?.(request) ?? { allowed: true as const }
          if (!authorization.allowed) {
            result = failure(request.requestId, 'denied', 'PERMISSION_DENIED', authorization.reason ?? 'Capability request denied')
          } else {
            if (controller.signal.aborted) throw controller.signal.reason
            const aborted = new Promise<never>((_, reject) => {
              if (controller.signal.aborted) reject(controller.signal.reason)
              else controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })
            })
            const output = await Promise.race([
              provider.invoke(request.operation, request.input, {
                request,
                signal: controller.signal,
                reportProgress: (progress) => {
                  if (controller.signal.aborted) return
                  const event = { version: 1 as const, requestId: request.requestId, sequence: ++progressSequence, progress }
                  this.options.onProgress?.(event)
                  onProgress?.(event)
                },
              }),
              aborted,
            ])
            result = { requestId: request.requestId, status: 'success', output }
          }
        }
      }
    } catch (error) {
      if (controller.signal.aborted) {
        const timedOut = controller.signal.reason === 'timeout'
        result = failure(
          request.requestId,
          'cancelled',
          timedOut ? 'CAPABILITY_TIMEOUT' : 'CAPABILITY_CANCELLED',
          timedOut ? `Capability request timed out after ${timeoutMs}ms` : 'Capability request cancelled',
        )
      } else {
        result = failure(request.requestId, 'failed', 'PROVIDER_ERROR', error instanceof Error ? error.message : 'Capability provider failed')
      }
    } finally {
      clearTimeout(timer)
    }

    this.pending.delete(request.requestId)
    this.remember(request, result)
    this.options.audit?.({
      phase: 'finished', requestId: request.requestId, capability: request.capability,
      operation: request.operation, sessionId: request.sessionId, runtimeId: request.runtimeId,
      extensionId: request.extensionId, status: result.status, durationMs: Date.now() - startedAt,
    })
    return result
  }

  private remember(request: CapabilityRequestV1, result: CapabilityResultV1): void {
    this.completed.set(result.requestId, { request, result })
    const limit = this.options.completedResultLimit ?? DEFAULT_COMPLETED_RESULT_LIMIT
    while (this.completed.size > limit) {
      const oldest = this.completed.keys().next().value
      if (oldest === undefined) break
      this.completed.delete(oldest)
    }
  }
}
