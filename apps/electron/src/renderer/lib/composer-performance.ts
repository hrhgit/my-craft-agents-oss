export type ComposerPerformanceMetric =
  | 'input-to-frame'
  | 'editor-transaction'
  | 'draft-snapshot'
  | 'draft-persist-queue'

type ComposerPerformanceSample = {
  durationMs: number
  timestamp: number
}

type ComposerPerformanceSummary = {
  count: number
  p50: number
  p95: number
  max: number
}

const SAMPLE_LIMIT = 240
const samples = new Map<ComposerPerformanceMetric, ComposerPerformanceSample[]>()
let runtimeEnabled = false

function enabled(): boolean {
  if (typeof window === 'undefined' || typeof performance === 'undefined') return false
  const env = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env
  return env?.DEV === true || runtimeEnabled
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0
}

export function recordComposerPerformance(metric: ComposerPerformanceMetric, durationMs: number): void {
  if (!enabled() || !Number.isFinite(durationMs)) return
  const metricSamples = samples.get(metric) ?? []
  metricSamples.push({ durationMs, timestamp: Date.now() })
  if (metricSamples.length > SAMPLE_LIMIT) metricSamples.splice(0, metricSamples.length - SAMPLE_LIMIT)
  samples.set(metric, metricSamples)
}

export function measureComposerPerformance<T>(metric: ComposerPerformanceMetric, operation: () => T): T {
  if (!enabled()) return operation()
  const startedAt = performance.now()
  try {
    return operation()
  } finally {
    recordComposerPerformance(metric, performance.now() - startedAt)
  }
}

export function markComposerInputFrame(): void {
  if (!enabled()) return
  const startedAt = performance.now()
  requestAnimationFrame(() => {
    recordComposerPerformance('input-to-frame', performance.now() - startedAt)
  })
}

export function getComposerPerformanceSummary(): Partial<Record<ComposerPerformanceMetric, ComposerPerformanceSummary>> {
  const result: Partial<Record<ComposerPerformanceMetric, ComposerPerformanceSummary>> = {}
  for (const [metric, metricSamples] of samples) {
    const values = metricSamples.map(sample => sample.durationMs)
    result[metric] = {
      count: values.length,
      p50: percentile(values, 0.5),
      p95: percentile(values, 0.95),
      max: Math.max(...values),
    }
  }
  return result
}

export function clearComposerPerformance(): void {
  samples.clear()
}

export function setComposerPerformanceEnabled(enabled: boolean): void {
  runtimeEnabled = enabled
}

if (typeof window !== 'undefined') {
  ;(window as typeof window & {
    __mortiseComposerPerformance?: {
      snapshot: typeof getComposerPerformanceSummary
      clear: typeof clearComposerPerformance
      setEnabled: typeof setComposerPerformanceEnabled
    }
  }).__mortiseComposerPerformance = {
    snapshot: getComposerPerformanceSummary,
    clear: clearComposerPerformance,
    setEnabled: setComposerPerformanceEnabled,
  }
}
