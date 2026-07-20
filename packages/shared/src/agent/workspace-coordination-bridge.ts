import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import {
  WorkspaceCoordinationStore,
  type CoordinationActor,
} from '../coordination/index.ts'
import { isReadOnlyBashCommandWithConfig } from './mode-manager.ts'
import { permissionsConfigCache } from './permissions-config.ts'

const TOOL_ACTIVITY_LEASE_MS = 30 * 60 * 1000

export type CoordinationPermissionDecision =
  | { action: 'allow' }
  | { action: 'block'; reason?: string }
  | { action: 'modify'; input: Record<string, unknown> }

export interface CoordinationToolRequest {
  toolName: string
  toolCallId: string
  input: Record<string, unknown>
  assistantResponseId?: string
  assistantTimestamp: number
}

export interface CoordinationToolResultRequest extends CoordinationToolRequest {
  isError: boolean
}

interface PendingMutation {
  activityId: string
  actor: CoordinationActor
  beforeContent: Uint8Array | null
  filePath?: string
  resource: { kind: 'file'; path: string } | { kind: 'logical'; name: string }
  summary: string
}

export interface WorkspaceCoordinationBridgeOptions {
  workspaceRoot: string
  workspaceId?: string
  sessionId: string
  writerId?: string
  configDir?: string
  isReadOnlyShellCommand?: (command: string) => boolean
}

function filePathFromInput(input: Record<string, unknown>): string | null {
  const value = typeof input.path === 'string'
    ? input.path
    : typeof input.file_path === 'string'
      ? input.file_path
      : null
  return value?.trim() || null
}

function summarizeTool(toolName: string, input: Record<string, unknown>, resource: string): string {
  const intent = typeof input._intent === 'string' ? input._intent.trim() : ''
  if (intent) return intent
  if (toolName === 'bash') {
    const command = typeof input.command === 'string' ? input.command.trim() : ''
    return command ? `Shell: ${command.slice(0, 240)}` : 'Shell command'
  }
  return `${toolName === 'write' ? 'Write' : 'Edit'} ${resource}`
}

async function readFileOrNull(path: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(path))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function contentsEqual(left: Uint8Array | null, right: Uint8Array | null): boolean {
  if (left === null || right === null) return left === right
  if (left.byteLength !== right.byteLength) return false
  return Buffer.from(left).equals(Buffer.from(right))
}

export class WorkspaceCoordinationBridge {
  private readonly store: WorkspaceCoordinationStore
  private readonly pending = new Map<string, PendingMutation>()
  private currentActivityId: string | null = null
  private closed = false

  constructor(private readonly options: WorkspaceCoordinationBridgeOptions) {
    this.store = WorkspaceCoordinationStore.open({
      workspaceRoot: options.workspaceRoot,
      workspaceId: options.workspaceId,
      writerId: options.writerId ?? `agent-${process.pid}-${randomUUID()}`,
      configDir: options.configDir,
    })
  }

  async afterPermission(
    request: CoordinationToolRequest,
    decision: CoordinationPermissionDecision,
  ): Promise<CoordinationPermissionDecision> {
    if (this.closed || decision.action === 'block') return decision

    const toolName = request.toolName.toLocaleLowerCase('en-US')
    const effectiveInput = decision.action === 'modify' ? decision.input : request.input
    let resource: PendingMutation['resource']
    let filePath: string | undefined
    let beforeContent: Uint8Array | null = null
    let enforcement: 'blocking' | 'advisory'

    if (toolName === 'write' || toolName === 'edit') {
      const requestedPath = filePathFromInput(effectiveInput)
      if (!requestedPath) return decision
      filePath = isAbsolute(requestedPath)
        ? resolve(requestedPath)
        : resolve(this.options.workspaceRoot, requestedPath)
      resource = { kind: 'file', path: filePath }
      enforcement = 'blocking'
    } else if (toolName === 'bash') {
      const command = typeof effectiveInput.command === 'string' ? effectiveInput.command : ''
      const permissions = permissionsConfigCache.getMergedConfig({
        workspaceRootPath: this.options.workspaceRoot,
      })
      const isReadOnly = this.options.isReadOnlyShellCommand
        ? this.options.isReadOnlyShellCommand(command)
        : isReadOnlyBashCommandWithConfig(command, permissions)
      if (!command || isReadOnly) return decision
      resource = { kind: 'logical', name: 'workspace/fs' }
      enforcement = 'advisory'
    } else {
      return decision
    }

    const activityId = this.currentActivityId ?? randomUUID()
    const activityWasStarted = this.currentActivityId !== null
    const claimId = randomUUID()
    const actor: CoordinationActor = {
      kind: 'agent',
      id: `mortise-agent:${this.options.sessionId}`,
      sessionId: this.options.sessionId,
      toolUseId: request.toolCallId,
      backendInstanceId: String(process.pid),
      ...(request.assistantResponseId
        ? { assistantResponseId: request.assistantResponseId, turnId: request.assistantResponseId }
        : {}),
      assistantTimestamp: request.assistantTimestamp,
    }
    const summary = summarizeTool(toolName, request.input, filePath ?? 'workspace files')

    if (!activityWasStarted) {
      this.store.beginActivity({
        operationId: `begin:${activityId}`,
        activityId,
        actor,
        intent: summary,
        leaseDurationMs: TOOL_ACTIVITY_LEASE_MS,
      })
      this.currentActivityId = activityId
    } else {
      this.store.heartbeatActivity({
        operationId: `heartbeat:${request.toolCallId}`,
        activityId,
        leaseDurationMs: TOOL_ACTIVITY_LEASE_MS,
      })
    }

    let claimAcquired = false
    try {
      const claim = this.store.acquireClaim({
        operationId: `claim:${claimId}`,
        claimId,
        activityId,
        resource,
        access: 'write',
        enforcement,
        leaseDurationMs: TOOL_ACTIVITY_LEASE_MS,
      })
      if (claim.status === 'conflict') {
        const snapshot = this.store.snapshot({ recentChangeLimit: 0 })
        const conflictingActivities = new Map(snapshot.activities.map(activity => [activity.activityId, activity]))
        const owners = claim.conflicts.map(conflict => {
          const activity = conflictingActivities.get(conflict.activityId)
          return activity?.actor.sessionId ?? activity?.actor.id ?? conflict.activityId
        })
        if (!activityWasStarted && this.pending.size === 0) this.completeTurn()
        return {
          action: 'block',
          reason: `Workspace coordination blocked ${filePath ?? 'this write'} because it is being modified by ${owners.join(', ')}. Wait for that activity to finish, then retry.`,
        }
      }
      claimAcquired = true
      if (filePath) beforeContent = await readFileOrNull(filePath)

      this.pending.set(request.toolCallId, {
        activityId,
        actor,
        beforeContent,
        filePath,
        resource,
        summary,
      })
      return decision
    } catch (error) {
      if (claimAcquired) {
        this.store.releaseClaim({
          operationId: `release-failed-claim:${claimId}`,
          claimId,
          activityId,
        })
      }
      if (!activityWasStarted && this.pending.size === 0) this.completeTurn()
      throw error
    }
  }

  async recordResult(request: CoordinationToolResultRequest): Promise<void> {
    const pending = this.pending.get(request.toolCallId)
    if (!pending) return
    this.pending.delete(request.toolCallId)

    if (pending.filePath) {
      const afterContent = await readFileOrNull(pending.filePath)
      if (!contentsEqual(pending.beforeContent, afterContent)) {
        this.store.recordChange({
          operationId: `change:${request.toolCallId}`,
          changeId: randomUUID(),
          activityId: pending.activityId,
          actor: pending.actor,
          resource: pending.resource,
          beforeContent: pending.beforeContent,
          afterContent,
          summary: `${pending.summary}${request.isError ? ' (tool reported an error)' : ''}`,
        })
      }
    } else {
      this.store.recordChange({
        operationId: `change:${request.toolCallId}`,
        changeId: randomUUID(),
        activityId: pending.activityId,
        actor: pending.actor,
        resource: pending.resource,
        beforeContent: null,
        afterContent: null,
        summary: `${pending.summary} (broad shell attribution; changed files were not enumerated)`,
      })
    }
  }

  completeTurn(): void {
    const activityId = this.currentActivityId
    if (activityId) {
      this.store.releaseActivity({
        operationId: `release-turn:${activityId}`,
        activityId,
      })
    }
    this.pending.clear()
    this.currentActivityId = null
  }

  releasePending(): void {
    this.completeTurn()
  }

  close(): void {
    if (this.closed) return
    this.completeTurn()
    this.closed = true
    this.store.close()
  }
}
