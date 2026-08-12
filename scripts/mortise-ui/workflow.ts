import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { UiValidationError, type UiValidationResponseEnvelope } from '@mortise/shared/ui-validation'
import type { ExtensionServiceResultDTO } from '@mortise/shared/protocol'
import { requestMortiseUiHost } from './client.ts'
import { readRunManifest, resolveRunDir, startMortiseUiRun, stopMortiseUiRunDetailed, updateRunManifest } from './controller.ts'
import type { MortiseUiRunManifest, MortiseUiSurface, MortiseUiProfileMode, MortiseUiWindowMode } from './protocol.ts'

export const MORTISE_UI_WORKFLOW_SCHEMA_VERSION = 1 as const

export type MortiseUiWorkflowStepType = 'open' | 'snapshot' | 'action' | 'wait' | 'assert' | 'evidence' | 'extension-service'

export interface MortiseUiWorkflowRunConfig {
  surface?: MortiseUiSurface
  profile?: MortiseUiProfileMode
  windowMode?: MortiseUiWindowMode
  label?: string
  fixture?: string
  extensions?: string[]
  adapterCommand?: string[]
  waitMs?: number
  cleanup?: 'always' | 'on-success' | 'never'
}

export interface MortiseUiWorkflowStep {
  id: string
  type: MortiseUiWorkflowStepType
  params?: Record<string, unknown>
  timeoutMs?: number
  maxAttempts?: number
}

export interface MortiseUiWorkflowDocument {
  schemaVersion: typeof MORTISE_UI_WORKFLOW_SCHEMA_VERSION
  name?: string
  run?: MortiseUiWorkflowRunConfig
  defaults?: { timeoutMs?: number; maxAttempts?: number }
  steps: MortiseUiWorkflowStep[]
}

export interface MortiseUiWorkflowStepState {
  id: string
  type: MortiseUiWorkflowStepType
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped'
  attempts: number
  startedAt?: string
  finishedAt?: string
  requestId?: string
  seq?: number
  revision?: number
  verificationLevel?: string
  result?: unknown
  error?: { code: string; message: string; details?: unknown }
}

export interface MortiseUiWorkflowState {
  schemaVersion: typeof MORTISE_UI_WORKFLOW_SCHEMA_VERSION
  executionId: string
  workflowPath: string
  workflowHash: string
  workflowName?: string
  statePath: string
  runDir?: string
  runId?: string
  status: 'running' | 'succeeded' | 'failed' | 'stopped'
  currentStepIndex: number
  createdAt: string
  updatedAt: string
  lastResponseSeq?: number
  lastRevision?: number
  verificationLevel?: string
  steps: MortiseUiWorkflowStepState[]
  error?: { code: string; message: string; details?: unknown }
}

const STEP_TYPES = new Set<MortiseUiWorkflowStepType>(['open', 'snapshot', 'action', 'wait', 'assert', 'evidence', 'extension-service'])

export function workflowSchema(): Record<string, unknown> {
  return {
    schemaVersion: MORTISE_UI_WORKFLOW_SCHEMA_VERSION,
    description: 'AI-facing Mortise UI workflow contract.',
    run: { surface: ['electron', 'webui'], profile: ['fixture', 'isolated', 'clone'], cleanup: ['always', 'on-success', 'never'] },
    steps: Object.fromEntries([...STEP_TYPES].map(type => [type, { required: ['id', 'type'], type }])) ,
  }
}

export function loadWorkflow(filePath: string): { document: MortiseUiWorkflowDocument; filePath: string; hash: string } {
  const resolved = resolve(filePath)
  const source = readFileSync(resolved, 'utf8')
  const parsed = JSON.parse(source) as unknown
  validateWorkflow(parsed)
  return { document: parsed as MortiseUiWorkflowDocument, filePath: resolved, hash: createHash('sha256').update(source).digest('hex') }
}

export function validateWorkflow(value: unknown): asserts value is MortiseUiWorkflowDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Workflow must be a JSON object')
  const workflow = value as Record<string, unknown>
  const allowedWorkflowKeys = new Set(['schemaVersion', 'name', 'run', 'defaults', 'steps'])
  if (Object.keys(workflow).some(key => !allowedWorkflowKeys.has(key))) throw new Error('Workflow contains unknown fields')
  if (workflow.schemaVersion !== MORTISE_UI_WORKFLOW_SCHEMA_VERSION) throw new Error('Workflow schemaVersion must be 1')
  if (workflow.name !== undefined && (typeof workflow.name !== 'string' || workflow.name.length > 256)) throw new Error('Workflow name is invalid')
  if (!Array.isArray(workflow.steps) || workflow.steps.length === 0 || workflow.steps.length > 256) throw new Error('Workflow steps must contain 1..256 steps')
  const ids = new Set<string>()
  for (const raw of workflow.steps) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Workflow step must be an object')
    const step = raw as Record<string, unknown>
    if (typeof step.id !== 'string' || !/^[a-z][a-z0-9._-]{0,63}$/.test(step.id) || ids.has(step.id)) throw new Error('Workflow step ids must be unique stable identifiers')
    ids.add(step.id)
    if (typeof step.type !== 'string' || !STEP_TYPES.has(step.type as MortiseUiWorkflowStepType)) throw new Error(`Workflow step ${step.id} has an invalid type`)
    if (step.params !== undefined && (!step.params || typeof step.params !== 'object' || Array.isArray(step.params))) throw new Error(`Workflow step ${step.id} params must be an object`)
    for (const field of ['timeoutMs', 'maxAttempts'] as const) {
      if (step[field] !== undefined && (!Number.isSafeInteger(step[field]) || Number(step[field]) < 1 || Number(step[field]) > 600_000)) throw new Error(`Workflow step ${step.id} ${field} is invalid`)
    }
  }
  if (workflow.defaults !== undefined) {
    if (!workflow.defaults || typeof workflow.defaults !== 'object' || Array.isArray(workflow.defaults)) throw new Error('Workflow defaults must be an object')
    const defaults = workflow.defaults as Record<string, unknown>
    if (Object.keys(defaults).some(key => !['timeoutMs', 'maxAttempts'].includes(key))) throw new Error('Workflow defaults contain unknown fields')
    for (const field of ['timeoutMs', 'maxAttempts'] as const) {
      if (defaults[field] !== undefined && (!Number.isSafeInteger(defaults[field]) || Number(defaults[field]) < 1 || Number(defaults[field]) > 600_000)) throw new Error(`Workflow defaults ${field} is invalid`)
    }
  }
  const run = workflow.run
  if (run !== undefined) {
    if (!run || typeof run !== 'object' || Array.isArray(run)) throw new Error('Workflow run must be an object')
    const runRecord = run as Record<string, unknown>
    const allowedRunKeys = new Set(['surface', 'profile', 'windowMode', 'label', 'fixture', 'extensions', 'adapterCommand', 'waitMs', 'cleanup'])
    if (Object.keys(runRecord).some(key => !allowedRunKeys.has(key))) throw new Error('Workflow run contains unknown fields')
    if (runRecord.surface !== undefined && !['electron', 'webui'].includes(String(runRecord.surface))) throw new Error('Workflow run surface is invalid')
    if (runRecord.profile !== undefined && !['fixture', 'isolated', 'clone'].includes(String(runRecord.profile))) throw new Error('Workflow run profile is invalid')
    if (runRecord.windowMode !== undefined && !['background', 'foreground'].includes(String(runRecord.windowMode))) throw new Error('Workflow run windowMode is invalid')
    if (runRecord.cleanup !== undefined && !['always', 'on-success', 'never'].includes(String(runRecord.cleanup))) throw new Error('Workflow run cleanup is invalid')
    for (const field of ['label', 'fixture'] as const) if (runRecord[field] !== undefined && (typeof runRecord[field] !== 'string' || runRecord[field].length > 512)) throw new Error(`Workflow run ${field} is invalid`)
    for (const field of ['extensions', 'adapterCommand'] as const) if (runRecord[field] !== undefined && (!Array.isArray(runRecord[field]) || runRecord[field].some(item => typeof item !== 'string'))) throw new Error(`Workflow run ${field} is invalid`)
    if (runRecord.waitMs !== undefined && (!Number.isSafeInteger(runRecord.waitMs) || Number(runRecord.waitMs) < 1 || Number(runRecord.waitMs) > 600_000)) throw new Error('Workflow run waitMs is invalid')
  }
}

interface WorkflowCommandOptions {
  file?: string
  execution?: string
  run?: string
  runRoot?: string
}

function parseWorkflowArgs(args: string[]): { operation: string; options: WorkflowCommandOptions } {
  const operation = args[0] ?? 'help'
  const parsed = parseArgs({
    args: args.slice(1),
    options: {
      file: { type: 'string' }, execution: { type: 'string' }, run: { type: 'string' }, 'run-root': { type: 'string' },
    },
    allowPositionals: false,
    strict: true,
  })
  const values = parsed.values as Record<string, string | undefined>
  return { operation, options: { file: values.file, execution: values.execution, run: values.run, runRoot: values['run-root'] } }
}

export async function runWorkflowCommand(args: string[], defaultRunRoot: string): Promise<Record<string, unknown>> {
  const { operation, options } = parseWorkflowArgs(args)
  if (operation === 'help' || operation === '--help' || operation === '-h') return { help: workflowHelp() }
  if (operation === 'schema') return { schema: workflowSchema() }
  if (!['validate', 'run', 'resume', 'inspect'].includes(operation)) throw new Error('workflow requires schema, validate, run, resume, or inspect')

  if (operation === 'inspect') {
    const state = readWorkflowState(options.execution, options.runRoot ?? defaultRunRoot)
    return { execution: state.executionId, state }
  }
  if (operation === 'resume' && !options.execution) throw new Error('workflow resume requires --execution')
  if (operation === 'validate' && !options.file) throw new Error('workflow validate requires --file')
  if (operation === 'run' && !options.file) throw new Error('workflow run requires --file')

  const loaded = loadWorkflow(options.file ?? readWorkflowState(options.execution, options.runRoot ?? defaultRunRoot).workflowPath)
  if (operation === 'validate') return { valid: true, workflowPath: loaded.filePath, workflowHash: loaded.hash, stepCount: loaded.document.steps.length }
  if (operation === 'resume') {
    const previous = readWorkflowState(options.execution, options.runRoot ?? defaultRunRoot)
    if (previous.workflowHash !== loaded.hash) throw new Error('Workflow file changed since the execution was created; validate and start a new execution')
    return executeWorkflow(loaded, previous, options.runRoot ?? defaultRunRoot)
  }

  const executionId = `wf-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
  const workflowRoot = join(resolve(options.runRoot ?? defaultRunRoot), '_workflows', executionId)
  await mkdir(workflowRoot, { recursive: true })
  const statePath = join(workflowRoot, 'state.json')
  const state: MortiseUiWorkflowState = {
    schemaVersion: MORTISE_UI_WORKFLOW_SCHEMA_VERSION,
    executionId, workflowPath: loaded.filePath, workflowHash: loaded.hash, workflowName: loaded.document.name,
    statePath, status: 'running', currentStepIndex: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    steps: loaded.document.steps.map(step => ({ id: step.id, type: step.type, status: 'pending', attempts: 0 })),
  }
  writeWorkflowState(state)
  return executeWorkflow(loaded, state, options.runRoot ?? defaultRunRoot, options.run)
}

function workflowHelp(): string {
  return 'mortise-ui workflow schema | validate --file <workflow.json> | run --file <workflow.json> [--run <run-id>] | resume --execution <id> | inspect --execution <id>'
}

function workflowStatePath(execution: string | undefined, runRoot: string): string {
  if (!execution) throw new Error('workflow requires --execution')
  const safe = execution.replace(/[^a-zA-Z0-9._-]/g, '')
  if (!safe || safe !== execution) throw new Error('Workflow execution id is invalid')
  return join(resolve(runRoot), '_workflows', execution, 'state.json')
}

function readWorkflowState(execution: string | undefined, runRoot: string): MortiseUiWorkflowState {
  const path = workflowStatePath(execution, runRoot)
  if (!existsSync(path)) throw new Error(`Workflow execution not found: ${execution}`)
  return JSON.parse(readFileSync(path, 'utf8')) as MortiseUiWorkflowState
}

function writeWorkflowState(state: MortiseUiWorkflowState): void {
  state.updatedAt = new Date().toISOString()
  writeFileSync(state.statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

async function executeWorkflow(
  loaded: { document: MortiseUiWorkflowDocument; filePath: string; hash: string },
  state: MortiseUiWorkflowState,
  runRoot: string,
  attachRunId?: string,
): Promise<Record<string, unknown>> {
  let manifest: MortiseUiRunManifest | undefined = state.runDir ? readRunManifest(state.runDir) : undefined
  const run = loaded.document.run ?? {}
  const cleanup = run.cleanup ?? 'on-success'
  try {
    if (!manifest && attachRunId) {
      state.runDir = resolveRunDir(runRoot, attachRunId)
      manifest = readRunManifest(state.runDir)
      state.runId = manifest.runId
      writeWorkflowState(state)
    }
    if (!manifest) {
      const workflowDir = dirname(loaded.filePath)
      const fixture = run.fixture ? resolve(workflowDir, run.fixture) : undefined
      const extensions = (run.extensions ?? []).map(path => resolve(workflowDir, path))
      manifest = await startMortiseUiRun({
        surface: run.surface ?? 'electron', profileMode: run.profile ?? 'fixture', windowMode: run.windowMode,
        label: run.label ?? loaded.document.name, adapterCommand: run.adapterCommand, waitMs: run.waitMs,
        runRoot, extensionPaths: extensions, fixtureSpec: fixture ? JSON.parse(await readFile(fixture, 'utf8')) : undefined,
      })
      state.runDir = manifest.runDir
      state.runId = manifest.runId
      writeWorkflowState(state)
    }
    for (let index = state.currentStepIndex; index < loaded.document.steps.length; index += 1) {
      const step = loaded.document.steps[index]!
      const stepState = state.steps[index]!
      if (stepState.status === 'succeeded') continue
      stepState.status = 'running'
      stepState.startedAt = new Date().toISOString()
      const maxAttempts = step.maxAttempts ?? loaded.document.defaults?.maxAttempts ?? 1
      let response: UiValidationResponseEnvelope | undefined
      let lastError: unknown
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        stepState.attempts = attempt
        stepState.requestId ??= randomUUID()
        try {
          const params = step.type === 'extension-service'
            ? { ...(step.params ?? {}), requestId: stepState.requestId }
            : (step.params ?? {})
          response = await requestMortiseUiHost({
            ...readRunManifest(manifest.runDir), command: hostCommandForStep(step.type), params,
            timeoutMs: step.timeoutMs ?? loaded.document.defaults?.timeoutMs,
            minimumSeqExclusive: state.lastResponseSeq, requestId: stepState.requestId,
          })
          const serviceResult = step.type === 'extension-service' && response.ok
            ? extensionServiceResult(response.result)
            : undefined
          if (serviceResult?.status !== 'succeeded' && isRetryableExtensionServiceResult(serviceResult) && attempt < maxAttempts) {
            await Bun.sleep(Math.min(1000, 100 * 2 ** (attempt - 1)))
            continue
          }
          if (response.ok || !isRetryableWorkflowResponse(response)) break
        } catch (error) {
          lastError = error
          if (!isRetryableWorkflowError(error) || attempt === maxAttempts) break
          await Bun.sleep(Math.min(1000, 100 * 2 ** (attempt - 1)))
        }
      }
      if (!response) throw lastError ?? new Error(`Workflow step ${step.id} did not return a response`)
      stepState.seq = response.seq
      stepState.revision = response.revision
      stepState.verificationLevel = response.verificationLevel
      state.lastResponseSeq = response.seq
      state.lastRevision = response.revision
      state.verificationLevel = response.verificationLevel
      stepState.result = response.ok ? response.result : undefined
      if (!response.ok) {
        stepState.status = 'failed'
        stepState.error = response.error
        state.status = 'failed'
        state.error = response.error
        writeWorkflowState(state)
        if (cleanup === 'always') await stopMortiseUiRunDetailed(manifest.runDir)
        return { execution: state.executionId, status: state.status, failedStep: step.id, state }
      }
      const serviceResult = step.type === 'extension-service' ? extensionServiceResult(response.result) : undefined
      if (serviceResult && serviceResult.status !== 'succeeded') {
        const failure = {
          code: serviceResult.error?.code ?? `extension_service_${serviceResult.status}`,
          message: serviceResult.error?.message ?? `Extension service invocation ${serviceResult.status}.`,
          details: { serviceResult },
        }
        stepState.status = 'failed'
        stepState.error = failure
        stepState.finishedAt = new Date().toISOString()
        state.status = 'failed'
        state.error = failure
        writeWorkflowState(state)
        if (cleanup === 'always') await stopMortiseUiRunDetailed(manifest.runDir)
        return { execution: state.executionId, status: state.status, failedStep: step.id, state }
      }
      stepState.status = 'succeeded'
      stepState.finishedAt = new Date().toISOString()
      state.currentStepIndex = index + 1
      writeWorkflowState(state)
    }
    state.status = 'succeeded'
    writeWorkflowState(state)
    if (cleanup === 'always' || cleanup === 'on-success') await stopMortiseUiRunDetailed(manifest.runDir)
    return { execution: state.executionId, status: state.status, runId: state.runId, state }
  } catch (error) {
    const failure = { code: error instanceof UiValidationError ? error.code : 'WORKFLOW_ERROR', message: error instanceof Error ? error.message : String(error) }
    state.status = 'failed'
    state.error = failure
    writeWorkflowState(state)
    if (manifest && cleanup === 'always') await stopMortiseUiRunDetailed(manifest.runDir)
    return { execution: state.executionId, status: state.status, failedStep: state.steps[state.currentStepIndex]?.id, state, error: failure }
  }
}

function hostCommandForStep(type: MortiseUiWorkflowStepType): string {
  return { open: 'ui.open', snapshot: 'ui.snapshot', action: 'ui.action', wait: 'ui.wait', assert: 'ui.assert', evidence: 'evidence.capture', 'extension-service': 'extension-services.invoke' }[type]
}

function isRetryableWorkflowResponse(response: UiValidationResponseEnvelope): boolean {
  return !response.ok && Boolean(response.error.retryable)
}

function isRetryableWorkflowError(error: unknown): boolean {
  return error instanceof Error && /HOST_UNREACHABLE|ENDPOINT_NOT_READY|timed out|connection reset|fetch failed/i.test(error.message)
}

function extensionServiceResult(value: unknown): ExtensionServiceResultDTO | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as Partial<ExtensionServiceResultDTO>
  if (candidate.protocolVersion !== 1 || typeof candidate.requestId !== 'string' || typeof candidate.runtimeId !== 'string' || typeof candidate.status !== 'string') return undefined
  return candidate as ExtensionServiceResultDTO
}

function isRetryableExtensionServiceResult(result: ExtensionServiceResultDTO | undefined): boolean {
  return result !== undefined && ['timed_out', 'unavailable', 'runtime_stale', 'failed'].includes(result.status)
}
