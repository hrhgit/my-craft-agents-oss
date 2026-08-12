import type {
  SubagentAgentInfo,
  SubagentListResult,
  SubagentOperationResult,
  SubagentRequest,
  SubagentTask,
  SubagentWaitResult,
} from '@mortise/shared/agent'
import type { SubagentConfigDiagnostic, SubagentTemplate } from '@mortise/shared/config'
import { Check, Errors } from 'typebox/value'
import type { TSchema } from 'typebox'

export interface AgentRunRecord {
  taskId: string
  status: 'running' | 'completed' | 'failed' | 'interrupted'
  agent?: string
  output?: string
  schema?: Record<string, unknown>
  error?: string
}

export interface AgentRunStartOptions {
  prompt: string
  agent?: string
  forkTurns?: number | 'all'
  systemPrompt?: string
  tools?: string[]
  model?: string
  thinkingLevel?: SubagentRequest['thinkingLevel']
  schema?: Record<string, unknown>
}

export interface AgentRunAdapter {
  list(): Promise<AgentRunRecord[]>
  start(options: AgentRunStartOptions): Promise<AgentRunRecord>
  message(taskId: string, prompt: string): Promise<AgentRunRecord>
  resume(taskId: string): Promise<AgentRunRecord>
  interrupt(taskId: string): Promise<AgentRunRecord>
  persistResult?(taskId: string, result: { text: string; data?: unknown }): Promise<string>
}

export interface AgentRunServiceOptions {
  adapter: AgentRunAdapter
  resolveAgents: () => Promise<{ agents: SubagentTemplate[]; diagnostics: SubagentConfigDiagnostic[] }>
  maxInlineResultChars?: number
}

const TERMINAL = new Set<SubagentTask['status']>(['completed', 'failed', 'interrupted'])

function parseStructuredResult(text: string, schema: Record<string, unknown>): { data?: unknown; error?: string } {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (error) {
    return { error: `Structured result is not valid JSON: ${error instanceof Error ? error.message : String(error)}` }
  }
  const typedSchema = schema as TSchema
  if (Check(typedSchema, data)) return { data }
  const first = Errors(typedSchema, data)[0]
  return { error: `Structured result failed schema validation${first ? `: ${first.message}` : ''}` }
}

export class AgentRunService {
  private readonly adapter: AgentRunAdapter
  private readonly resolveAgents: AgentRunServiceOptions['resolveAgents']
  private readonly maxInlineResultChars: number

  constructor(options: AgentRunServiceOptions) {
    this.adapter = options.adapter
    this.resolveAgents = options.resolveAgents
    this.maxInlineResultChars = options.maxInlineResultChars ?? 32_000
  }

  async execute(request: SubagentRequest): Promise<SubagentOperationResult> {
    switch (request.action) {
      case 'list': return this.list()
      case 'inspect': return this.inspect(request.taskId!)
      case 'message': return this.toTask(await this.adapter.message(request.taskId!, request.prompt!))
      case 'resume': return this.toTask(await this.adapter.resume(request.taskId!))
      case 'interrupt': return this.toTask(await this.adapter.interrupt(request.taskId!))
      case 'wait': return this.wait(request.taskIds!, request.timeoutMs ?? 30_000)
      case 'start': return this.start(request)
    }
  }

  async list(): Promise<SubagentListResult> {
    const [{ agents, diagnostics }, runs] = await Promise.all([this.resolveAgents(), this.adapter.list()])
    return {
      agents: agents.map(({ id, name, description, source, model, thinkingLevel, tools }): SubagentAgentInfo => ({
        id, name, description, source, tools,
        ...(model ? { model } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
      })),
      tasks: await Promise.all(runs.map(run => this.toTask(run))),
      diagnostics,
    }
  }

  async inspect(taskId: string): Promise<SubagentTask> {
    const run = (await this.adapter.list()).find(candidate => candidate.taskId === taskId)
    if (!run) throw new Error(`Subagent task not found: ${taskId}`)
    return this.toTask(run)
  }

  async start(request: SubagentRequest): Promise<SubagentTask> {
    const configs = await this.resolveAgents()
    const configured = request.agent ? configs.agents.find(candidate => candidate.id === request.agent) : undefined
    if (request.agent && !configured) throw new Error(`Agent configuration not found: ${request.agent}`)
    const run = await this.adapter.start({
      prompt: request.prompt!,
      ...(request.agent ? { agent: request.agent } : {}),
      ...(request.forkTurns !== undefined ? { forkTurns: request.forkTurns } : {}),
      ...(request.systemPrompt !== undefined ? { systemPrompt: request.systemPrompt } : configured ? { systemPrompt: configured.systemPrompt } : {}),
      ...(request.tools !== undefined ? { tools: request.tools } : configured ? { tools: configured.tools } : {}),
      ...(request.model !== undefined ? { model: request.model } : configured?.model ? { model: configured.model } : {}),
      ...(request.thinkingLevel !== undefined ? { thinkingLevel: request.thinkingLevel } : configured?.thinkingLevel ? { thinkingLevel: configured.thinkingLevel } : {}),
      ...(request.schema ? { schema: request.schema } : {}),
    })
    return this.toTask(run)
  }

  async wait(taskIds: string[], timeoutMs: number): Promise<SubagentWaitResult> {
    const deadline = Date.now() + Math.min(Math.max(timeoutMs, 0), 300_000)
    while (true) {
      const runs = await this.adapter.list()
      const selected = taskIds.map(taskId => {
        const run = runs.find(candidate => candidate.taskId === taskId)
        if (!run) throw new Error(`Subagent task not found: ${taskId}`)
        return run
      })
      const tasks = await Promise.all(selected.map(run => this.toTask(run)))
      if (tasks.some(task => TERMINAL.has(task.status))) return { tasks, timedOut: false }
      if (Date.now() >= deadline) return { tasks, timedOut: true }
      await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(deadline - Date.now(), 0))))
    }
  }

  private async toTask(run: AgentRunRecord): Promise<SubagentTask> {
    let status: SubagentTask['status'] = run.status
    let error = run.error
    let data: unknown
    const text = run.output ?? ''
    if (run.status === 'completed' && run.schema) {
      const structured = parseStructuredResult(text, run.schema)
      if (structured.error) {
        status = 'failed'
        error = structured.error
      } else data = structured.data
    }
    const fullResult = text || data !== undefined ? { text, ...(data !== undefined ? { data } : {}) } : undefined
    let result = fullResult
    let resultRef: string | undefined
    if (fullResult && JSON.stringify(fullResult).length > this.maxInlineResultChars && this.adapter.persistResult) {
      resultRef = await this.adapter.persistResult(run.taskId, fullResult)
      result = { text: `${text.slice(0, this.maxInlineResultChars)}\n\n[Result truncated; use resultRef for the complete result.]` }
    }
    return {
      taskId: run.taskId,
      status,
      ...(run.agent ? { agent: run.agent } : {}),
      ...(result ? { result } : {}),
      ...(resultRef ? { resultRef } : {}),
      ...(error ? { error } : {}),
    }
  }
}
