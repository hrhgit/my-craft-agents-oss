import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadWorkflow, runWorkflowCommand, validateWorkflow } from '../workflow'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('mortise-ui workflow contract', () => {
  it('validates the workflow envelope and returns a stable source hash', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-ui-workflow-')); roots.push(root)
    const file = join(root, 'verify.json')
    writeFileSync(file, JSON.stringify({
      schemaVersion: 1,
      name: 'conversation smoke',
      run: { surface: 'electron', profile: 'fixture', cleanup: 'never', extensions: [] },
      defaults: { timeoutMs: 5000, maxAttempts: 2 },
      steps: [
        { id: 'open', type: 'open', params: { route: 'session' } },
        { id: 'snapshot', type: 'snapshot' },
        { id: 'assert', type: 'assert', params: { target: 'composer.root' } },
      ],
    }))
    const loaded = loadWorkflow(file)
    expect(loaded.hash).toHaveLength(64)
    expect(loaded.document.steps).toHaveLength(3)
    const result = await runWorkflowCommand(['validate', '--file', file], root)
    expect(result).toMatchObject({ valid: true, stepCount: 3, workflowHash: loaded.hash })
  })

  it('rejects unknown run fields, invalid retry bounds, and duplicate step ids', () => {
    expect(() => validateWorkflow({ schemaVersion: 1, run: { surface: 'playground' }, steps: [{ id: 'open', type: 'open' }] })).toThrow()
    expect(() => validateWorkflow({ schemaVersion: 1, run: { cleanup: 'sometimes' }, steps: [{ id: 'open', type: 'open' }] })).toThrow()
    expect(() => validateWorkflow({ schemaVersion: 1, steps: [{ id: 'open', type: 'open', maxAttempts: 0 }] })).toThrow()
    expect(() => validateWorkflow({ schemaVersion: 1, steps: [{ id: 'open', type: 'open' }, { id: 'open', type: 'snapshot' }] })).toThrow()
  })

  it('exposes the machine-readable schema without starting a host', async () => {
    const result = await runWorkflowCommand(['schema'], join(tmpdir(), 'mortise-ui-workflow-schema'))
    expect(result.schema).toMatchObject({ schemaVersion: 1, steps: { action: { type: 'action' } } })
  })
})
