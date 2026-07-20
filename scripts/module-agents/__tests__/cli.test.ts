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
})
