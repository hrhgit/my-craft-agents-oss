import { Session } from 'node:inspector'
import { performance } from 'node:perf_hooks'

export interface MainProcessDiagnostics {
  source: 'node-inspector-local-session'
  pid: number
  uptimeSeconds: number
  memory: NodeJS.MemoryUsage
  resource: NodeJS.ResourceUsage
  eventLoop: { timeOrigin: number; sampledAt: number }
  activeResources: Record<string, number>
  inspector: { isolateId?: string; heapUsage?: Record<string, number>; error?: string }
  arbitraryEvaluationExposed: false
}

export interface RendererDriverDiagnosticFallback {
  source: MainProcessDiagnostics['source']
  pid: number
  uptimeSeconds: number
  memory: NodeJS.MemoryUsage
  activeResources: Record<string, number>
  inspector: MainProcessDiagnostics['inspector']
  arbitraryEvaluationExposed: false
  cause: string
}

/** Fixed, in-process diagnostics only. This class intentionally has no evaluate API. */
export async function captureMainProcessDiagnostics(): Promise<MainProcessDiagnostics> {
  const session = new Session()
  const inspector: MainProcessDiagnostics['inspector'] = {}
  try {
    session.connect()
    const isolate = await post(session, 'Runtime.getIsolateId') as { id?: unknown }
    if (typeof isolate.id === 'string') inspector.isolateId = isolate.id
    const heap = await post(session, 'Runtime.getHeapUsage') as Record<string, unknown>
    inspector.heapUsage = Object.fromEntries(Object.entries(heap).filter((entry): entry is [string, number] => typeof entry[1] === 'number'))
  } catch (error) {
    inspector.error = error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000)
  } finally {
    session.disconnect()
  }
  const activeResources: Record<string, number> = {}
  for (const name of process.getActiveResourcesInfo()) activeResources[name] = (activeResources[name] ?? 0) + 1
  return {
    source: 'node-inspector-local-session',
    pid: process.pid,
    uptimeSeconds: process.uptime(),
    memory: process.memoryUsage(),
    resource: process.resourceUsage(),
    eventLoop: { timeOrigin: performance.timeOrigin, sampledAt: performance.now() },
    activeResources,
    inspector,
    arbitraryEvaluationExposed: false,
  }
}

export async function captureRendererDriverDiagnosticFallback(error: unknown): Promise<RendererDriverDiagnosticFallback> {
  const diagnostics = await captureMainProcessDiagnostics()
  return {
    source: diagnostics.source,
    pid: diagnostics.pid,
    uptimeSeconds: diagnostics.uptimeSeconds,
    memory: diagnostics.memory,
    activeResources: diagnostics.activeResources,
    inspector: diagnostics.inspector,
    arbitraryEvaluationExposed: false,
    cause: error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000),
  }
}

function post(session: Session, method: string): Promise<unknown> {
  return new Promise((resolvePost, reject) => {
    session.post(method, (error, result) => error ? reject(error) : resolvePost(result ?? {}))
  })
}
