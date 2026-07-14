import { expect, it } from 'bun:test'
import { captureMainProcessDiagnostics, captureRendererDriverDiagnosticFallback } from '../main-process-diagnostics'

it('collects fixed Node Inspector diagnostics without exposing evaluate', async () => {
  const result = await captureMainProcessDiagnostics()
  expect(result).toMatchObject({ source: 'node-inspector-local-session', pid: process.pid, arbitraryEvaluationExposed: false })
  expect(result.memory.heapUsed).toBeGreaterThan(0)
  expect(result).not.toHaveProperty('evaluate')
})

it('provides a bounded diagnostic fallback for renderer CDP failure without evaluate', async () => {
  const fallback = await captureRendererDriverDiagnosticFallback(new Error('debugger attach failed'))
  expect(fallback).toMatchObject({
    source: 'node-inspector-local-session',
    cause: 'debugger attach failed',
    arbitraryEvaluationExposed: false,
  })
  expect(fallback).not.toHaveProperty('evaluate')
})
