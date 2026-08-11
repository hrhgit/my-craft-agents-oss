import { describe, expect, test } from 'bun:test'
import { INTERACTION_FLOWS } from '../../e2e/ui-flows/catalog.ts'
import { runInteractionFlowBatch } from '../flow-batch.ts'
import type { MortiseUiRunManifest } from '../protocol.ts'

describe('mortise-ui interaction flow batch', () => {
  test('starts one host and resets the same run before every flow', async () => {
    const run = {
      runId: 'batch-run',
      runDir: 'batch-run-dir',
      status: 'ready',
    } as MortiseUiRunManifest
    const starts: unknown[] = []
    const stops: string[] = []
    const requests: Array<{ runId: string; command: string }> = []

    const result = await runInteractionFlowBatch({
      flowIds: [INTERACTION_FLOWS[0]!.id, INTERACTION_FLOWS[5]!.id],
    }, {
      start: async options => { starts.push(options); return run },
      stop: async runDir => {
        stops.push(runDir)
        return { ...run, status: 'stopped' }
      },
      request: async (_run, command) => {
        requests.push({ runId: _run.runId, command })
        return (command === 'ui.action' ? { verificationLevel: 'renderer-verified' } : {}) as never
      },
    })

    expect(starts).toHaveLength(1)
    expect(stops).toEqual(['batch-run-dir'])
    expect(requests.every(request => request.runId === 'batch-run')).toBe(true)
    expect(requests.filter(request => request.command === 'scenario.reset')).toHaveLength(2)
    expect(result.lifecycle).toEqual({ hostStarts: 1, scenarioResets: 2, hostStopped: true })
    expect(result.flows.map(flow => flow.flowId)).toEqual([INTERACTION_FLOWS[0]!.id, INTERACTION_FLOWS[5]!.id])
  })

  test('can retain the single host for follow-up inspection', async () => {
    const run = { runId: 'kept-run', runDir: 'kept-run-dir', status: 'ready' } as MortiseUiRunManifest
    let stopped = false
    const result = await runInteractionFlowBatch({ flowIds: [INTERACTION_FLOWS[8]!.id], keep: true }, {
      start: async () => run,
      stop: async () => { stopped = true; return run },
      request: async () => ({}) as never,
    })
    expect(stopped).toBe(false)
    expect(result.lifecycle.hostStopped).toBe(false)
  })
})
