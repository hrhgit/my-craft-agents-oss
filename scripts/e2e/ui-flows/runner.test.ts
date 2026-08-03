import { describe, expect, test } from 'bun:test'
import { INTERACTION_FLOWS } from './catalog.ts'
import { UI_FLOW_HOST_START_WAIT_MS } from './config.ts'
import { runInteractionFlows } from './runner.ts'
import type { MortiseUiRunManifest } from '../../mortise-ui/protocol.ts'

describe('interaction flow catalog', () => {
  test('uses unique flow and interaction identities', () => {
    expect(new Set(INTERACTION_FLOWS.map(flow => flow.id)).size).toBe(INTERACTION_FLOWS.length)
    expect(INTERACTION_FLOWS.every(flow => flow.moduleId && flow.interactionId && flow.steps.length > 0)).toBe(true)
  })

  test('preserves the source-development cold-start budget', () => {
    expect(UI_FLOW_HOST_START_WAIT_MS).toBe(900_000)
  })

  test('reuses one run and resets before every flow', async () => {
    const calls: Array<{ command: string; params?: Record<string, unknown> }> = []
    const run = { runId: 'run-flow-test' } as MortiseUiRunManifest
    const results = await runInteractionFlows({
      run,
      flows: [INTERACTION_FLOWS[0]!, INTERACTION_FLOWS[5]!],
      request: async (_run, command, params) => {
        calls.push({ command, params })
        return (command === 'ui.action' ? { verificationLevel: 'renderer-verified' } : {}) as never
      },
    })
    expect(results).toHaveLength(2)
    const commands = calls.map(call => call.command)
    expect(commands.filter(command => command === 'scenario.reset')).toHaveLength(2)
    expect(commands.filter(command => command === 'scenario.apply')).toHaveLength(2)
    expect(commands).not.toContain('ui.snapshot')
    expect(calls.find(call => call.command === 'ui.action')?.params?.target).toEqual({ semanticId: 'navigation.nav_settings' })
  })
})
