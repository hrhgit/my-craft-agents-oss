import { describe, expect, it } from 'bun:test'
import { execute, run } from '../cli.ts'

describe('module-agents CLI', () => {
  it('returns a structured error for an unknown command', async () => {
    let output = ''
    const code = await run(['unknown'], line => { output += line })
    expect(code).toBe(1)
    expect(JSON.parse(output)).toMatchObject({
      schema: 'module-agent/error/v1',
      error: { code: 'INVALID_ARGUMENT' },
    })
  })

  it('returns a structured module validation plan without executing it', async () => {
    const result = await execute(['test', '--module', 'module-agent-system', '--level', 'contract', '--dry-run'])
    expect(result.code).toBe(0)
    expect(result.output).toMatchObject({
      schema: 'module-agent/test/v1', module: 'module-agent-system', level: 'contract', dry_run: true, passed: null,
    })
  })

  it('builds one deduplicated batch plan for repeated module flags and risk tiers', async () => {
    const result = await execute([
      'test', '--module', 'module-agent-system', '--module', 'build-release-observability', '--tier', 'B', '--dry-run',
    ])
    expect(result.code).toBe(0)
    expect(result.output).toMatchObject({
      schema: 'module-agent/test-batch/v1',
      dry_run: true,
      passed: null,
      modules: [
        { module: 'module-agent-system', level: 'contract' },
        { module: 'build-release-observability', level: 'contract' },
      ],
    })
  })

  it('runs structural validation without requiring fresh digests', async () => {
    const result = await execute(['validate', '--structure'])
    expect(result.code).toBe(0)
    expect(result.output).toMatchObject({ schema: 'module-agent/validation/v1', valid: true, mode: 'structure' })
  })
})
