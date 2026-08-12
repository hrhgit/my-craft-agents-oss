import { describe, expect, it, mock } from 'bun:test'
import { AgentRunService, type AgentRunRecord } from './AgentRunService'

function setup(initial: AgentRunRecord[] = []) {
  let runs = [...initial]
  const persistResult = mock(async (taskId: string) => `/results/${taskId}.json`)
  const start = mock(async options => (runs[0] = { taskId: 'new', status: 'running', agent: options.agent, schema: options.schema }))
  const message = mock(async (taskId: string) => runs.find(run => run.taskId === taskId)!)
  const resume = mock(async (taskId: string) => runs.find(run => run.taskId === taskId)!)
  const interrupt = mock(async (taskId: string) => ({ taskId, status: 'interrupted' as const }))
  const service = new AgentRunService({
    resolveAgents: async () => ({ agents: [{ id: 'reviewer', name: 'Reviewer', description: 'Review', systemPrompt: 'Review.', tools: ['read'], source: 'global', editable: true, path: '/reviewer.md' }], diagnostics: [] }),
    maxInlineResultChars: 20,
    adapter: {
      list: async () => runs,
      start,
      message,
      resume,
      interrupt,
      persistResult,
    },
  })
  return { service, setRuns: (next: AgentRunRecord[]) => { runs = next }, persistResult, start, message, resume, interrupt }
}

describe('AgentRunService', () => {
  it('starts immediately and applies a configured Agent', async () => {
    const { service, start } = setup()
    await expect(service.execute({ action: 'start', prompt: 'Review this', agent: 'reviewer' })).resolves.toEqual({ taskId: 'new', status: 'running', agent: 'reviewer' })
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'Review this',
      agent: 'reviewer',
      systemPrompt: 'Review.',
      tools: ['read'],
    }))
  })

  it('uses explicit empty overrides as replacement values', async () => {
    const { service, start } = setup()
    await service.execute({ action: 'start', prompt: 'Review this', agent: 'reviewer', systemPrompt: '', tools: [] })
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ systemPrompt: '', tools: [] }))
  })

  it('lists Agents and tasks in one result', async () => {
    const { service } = setup([{ taskId: 'a', status: 'running' }])
    const result = await service.execute({ action: 'list' })
    expect(result).toMatchObject({ agents: [{ id: 'reviewer' }], tasks: [{ taskId: 'a', status: 'running' }] })
  })

  it('waits for any terminal task and returns all snapshots', async () => {
    const { service, setRuns } = setup([{ taskId: 'a', status: 'running' }, { taskId: 'b', status: 'running' }])
    setTimeout(() => setRuns([{ taskId: 'a', status: 'completed', output: 'done' }, { taskId: 'b', status: 'running' }]), 10)
    const result = await service.execute({ action: 'wait', taskIds: ['a', 'b'], timeoutMs: 1000 })
    expect(result).toMatchObject({ timedOut: false, tasks: [{ taskId: 'a', status: 'completed' }, { taskId: 'b', status: 'running' }] })
  })

  it('times out without interrupting tasks', async () => {
    const { service } = setup([{ taskId: 'a', status: 'running' }])
    await expect(service.execute({ action: 'wait', taskIds: ['a'], timeoutMs: 0 })).resolves.toEqual({ timedOut: true, tasks: [{ taskId: 'a', status: 'running' }] })
  })

  it('validates structured results and persists large results', async () => {
    const schema = { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } }
    const { service, persistResult } = setup([{ taskId: 'a', status: 'completed', output: JSON.stringify({ answer: 'a sufficiently long answer' }), schema }])
    const result = await service.execute({ action: 'inspect', taskId: 'a' })
    expect(result).toMatchObject({ taskId: 'a', status: 'completed', resultRef: '/results/a.json' })
    expect(persistResult).toHaveBeenCalled()
  })

  it('turns invalid structured output into a failed task while retaining the text', async () => {
    const schema = { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } }
    const { service } = setup([{ taskId: 'a', status: 'completed', output: '{"wrong":true}', schema }])
    await expect(service.execute({ action: 'inspect', taskId: 'a' })).resolves.toMatchObject({
      taskId: 'a',
      status: 'failed',
      result: { text: expect.stringContaining('{"wrong":true}') },
      error: expect.stringContaining('schema validation'),
    })
  })

  it('routes message, resume, and interrupt through the neutral adapter', async () => {
    const { service, message, resume, interrupt } = setup([{ taskId: 'a', status: 'running' }])
    await service.execute({ action: 'message', taskId: 'a', prompt: 'Adjust this' })
    await service.execute({ action: 'resume', taskId: 'a' })
    await service.execute({ action: 'interrupt', taskId: 'a' })
    expect(message).toHaveBeenCalledWith('a', 'Adjust this')
    expect(resume).toHaveBeenCalledWith('a')
    expect(interrupt).toHaveBeenCalledWith('a')
  })
})
