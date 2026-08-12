import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { SessionManager as PiSessionManager } from '@mortise/pi-coding-agent/internal/host-facade'
import { requirePrimaryLocalWorkspaceRoot, type Workspace } from '@mortise/core/types'
import type { AgentBackend } from '../agent/backend/index.ts'
import { PiProjectionBuilder } from '../agent/backend/pi/projection-builder.ts'
import { getSessionFilePath, getSessionPath } from '../sessions/storage.ts'

const MAX_DIAGNOSTIC_COUNT = 1_000_000

export type SessionValidationMode =
  | { kind: 'fail-before-assistant'; message?: string }
  | { kind: 'fail-publication-metadata'; answer: string }
  | { kind: 'fail-user-persistence-once'; answer: string; message?: string }
  | { kind: 'fail-settlement-projection'; answer: string }
  | { kind: 'succeed'; answer: string }

export interface SessionValidationArmInput {
  runId: string
  workspaceId: string
  sessionId?: string
  mode: SessionValidationMode
}

export interface SessionValidationStatus {
  version: 1
  runId: string
  workspaceId: string
  sessionId?: string
  mode: SessionValidationMode['kind']
  phase: 'armed' | 'claimed' | 'settlement-blocked' | 'settlement-released'
  diagnostics: { chatAttempts: number }
  settlement?: { blockerCreated: boolean; priorProjection: 'absent' | 'file' }
}

interface SettlementState {
  targetPath: string
  backupPath: string
  priorProjection: 'absent' | 'file'
  baselineTemporaryNames: string[]
  blockerCreated: boolean
}

interface PersistedState extends SessionValidationArmInput {
  version: 1
  phase: SessionValidationStatus['phase']
  diagnostics: { chatAttempts: number }
  workspaceRoot?: string
  settlement?: SettlementState
}

export interface SessionValidationBackendArgs {
  coreConfig: {
    workspace: Workspace
    session?: { mortiseId: string }
    onPiProjectionEvent?: (event: ReturnType<PiProjectionBuilder['acceptRuntimeEvent']>[number]) => void
  }
  provisional: boolean
  createDefaultBackend: () => AgentBackend
}

export type SessionValidationBackendFactory = (args: SessionValidationBackendArgs) => AgentBackend

export class SessionValidationController {
  arm(input: SessionValidationArmInput): void {
    assertApprovedRuntime(input.runId)
    if (!input.workspaceId || !isValidMode(input.mode)) throw new Error('Invalid Session validation request.')
    if (requiresExistingSession(input.mode) && !input.sessionId) {
      throw new Error(`${input.mode.kind} requires a target Session.`)
    }
    const path = statePath()
    withStateLock(path, () => {
      const current = readState(path)
      if (current?.settlement) cleanupSettlementState(current)
      replaceState(path, {
        ...input,
        version: 1,
        phase: 'armed',
        diagnostics: { chatAttempts: 0 },
      })
    })
  }

  clear(): void {
    const path = statePath()
    withStateLock(path, () => {
      const current = readState(path)
      if (current?.settlement) cleanupSettlementState(current)
      removeFile(path)
    })
  }

  status(): SessionValidationStatus | undefined {
    const path = statePath()
    return withStateLock(path, () => publicStatus(readState(path)))
  }

  releaseSettlement(): SessionValidationStatus {
    const path = statePath()
    return withStateLock(path, () => {
      const current = readState(path)
      if (!current || current.mode.kind !== 'fail-settlement-projection' || !current.settlement) {
        throw new Error('No settlement projection blocker is active.')
      }
      releaseSettlementBlocker(current)
      current.phase = 'settlement-released'
      current.settlement.blockerCreated = false
      replaceState(path, current)
      return publicStatus(current)!
    })
  }

  readonly backendFactory: SessionValidationBackendFactory = args => {
    const sessionId = args.coreConfig.session?.mortiseId
    if (!sessionId) return args.createDefaultBackend()
    const workspaceRoot = requirePrimaryLocalWorkspaceRoot(args.coreConfig.workspace)
    const path = statePath()
    const state = withStateLock(path, () => claimMatchingState(
      path,
      args.coreConfig.workspace.id,
      workspaceRoot,
      sessionId,
      args.provisional,
    ))
    if (!state) return args.createDefaultBackend()
    return deterministicBackend(
      path,
      sessionId,
      args.coreConfig.workspace.id,
      workspaceRoot,
      state,
      args.coreConfig.onPiProjectionEvent,
    )
  }
}

function isValidMode(mode: SessionValidationMode): boolean {
  if (mode.kind === 'fail-before-assistant') return true
  return typeof mode.answer === 'string' && mode.answer.length > 0
}

function requiresExistingSession(mode: SessionValidationMode): boolean {
  return mode.kind === 'fail-user-persistence-once' || mode.kind === 'fail-settlement-projection'
}

function assertApprovedRuntime(runId: string): void {
  if (process.env.MORTISE_UI_TEST_HOST !== '1' || process.env.MORTISE_UI_RUN_ID !== runId) {
    throw new Error('Session validation may only be armed by the active Dev Host run.')
  }
  const profileMode = process.env.MORTISE_UI_PROFILE_MODE
  if (profileMode !== 'fixture' && profileMode !== 'isolated') {
    throw new Error('Session validation requires a fixture or isolated profile.')
  }
}

function claimMatchingState(
  path: string,
  workspaceId: string,
  workspaceRoot: string,
  sessionId: string,
  provisional: boolean,
): PersistedState | undefined {
  const candidate = readState(path)
  if (
    !candidate
    || candidate.phase !== 'armed'
    || candidate.runId !== process.env.MORTISE_UI_RUN_ID
    || candidate.workspaceId !== workspaceId
    || (candidate.sessionId !== undefined && candidate.sessionId !== sessionId)
    || requiresExistingSession(candidate.mode) === provisional
  ) return undefined
  candidate.phase = 'claimed'
  candidate.sessionId ??= sessionId
  candidate.workspaceRoot = workspaceRoot
  replaceState(path, candidate)
  return candidate
}

function recordChatAttempt(path: string): number {
  return withStateLock(path, () => {
    const current = readState(path)
    if (!current) return 0
    current.diagnostics.chatAttempts = Math.min(
      MAX_DIAGNOSTIC_COUNT,
      current.diagnostics.chatAttempts + 1,
    )
    replaceState(path, current)
    return current.diagnostics.chatAttempts
  })
}

function blockSettlementProjection(path: string, workspaceId: string, sessionId: string): void {
  withStateLock(path, () => {
    const current = readState(path)
    if (!current || current.mode.kind !== 'fail-settlement-projection' || current.sessionId !== sessionId) {
      throw new Error('Settlement projection fault is no longer armed for this Session.')
    }
    if (current.settlement?.blockerCreated) return

    const sidecar = getSessionPath(workspaceId, sessionId)
    const targetPath = join(sidecar, 'pi-projection-v1.json')
    const backupPath = join(sidecar, 'pi-projection-v1.session-validation-backup-v1.json')
    mkdirSync(sidecar, { recursive: true })
    if (existsSync(backupPath)) throw new Error('A Session validation projection backup already exists.')
    if (existsSync(targetPath) && !lstatSync(targetPath).isFile()) {
      throw new Error('The Session projection path is already occupied by a non-file entry.')
    }
    const priorProjection = existsSync(targetPath) ? 'file' : 'absent'
    const state: SettlementState = {
      targetPath,
      backupPath,
      priorProjection,
      baselineTemporaryNames: projectionTemporaryNames(targetPath),
      blockerCreated: false,
    }
    current.settlement = state
    replaceState(path, current)

    if (priorProjection === 'file') renameSync(targetPath, backupPath)
    try {
      mkdirSync(targetPath)
    } catch (error) {
      if (priorProjection === 'file' && existsSync(backupPath) && !existsSync(targetPath)) {
        renameSync(backupPath, targetPath)
      }
      current.settlement = undefined
      replaceState(path, current)
      throw error
    }
    state.blockerCreated = true
    current.phase = 'settlement-blocked'
    replaceState(path, current)
  })
}

function releaseSettlementBlocker(state: PersistedState): void {
  const settlement = state.settlement
  if (!settlement) return
  if (settlement.blockerCreated && existsSync(settlement.targetPath)) {
    if (!lstatSync(settlement.targetPath).isDirectory()) {
      throw new Error('Refusing to release a settlement blocker whose target is no longer a directory.')
    }
    rmdirSync(settlement.targetPath)
  }
  const baseline = new Set(settlement.baselineTemporaryNames)
  for (const name of projectionTemporaryNames(settlement.targetPath)) {
    if (!baseline.has(name)) removeFile(join(dirname(settlement.targetPath), name))
  }
}

function cleanupSettlementState(state: PersistedState): void {
  const settlement = state.settlement
  if (!settlement) return
  releaseSettlementBlocker(state)
  if (settlement.priorProjection === 'file' && existsSync(settlement.backupPath)) {
    if (existsSync(settlement.targetPath)) {
      if (!lstatSync(settlement.targetPath).isFile()) {
        throw new Error('Refusing to clean settlement state whose projection target is not a file.')
      }
      removeFile(settlement.backupPath)
    } else {
      renameSync(settlement.backupPath, settlement.targetPath)
    }
  } else if (existsSync(settlement.backupPath)) {
    throw new Error('Unexpected Session validation projection backup.')
  }
}

function projectionTemporaryNames(targetPath: string): string[] {
  const directory = dirname(targetPath)
  if (!existsSync(directory)) return []
  const prefix = `${basename(targetPath)}.`
  return readdirSync(directory).filter(name => name.startsWith(prefix) && name.endsWith('.tmp')).sort()
}

function publicStatus(state: PersistedState | undefined): SessionValidationStatus | undefined {
  if (!state) return undefined
  return {
    version: 1,
    runId: state.runId,
    workspaceId: state.workspaceId,
    ...(state.sessionId ? { sessionId: state.sessionId } : {}),
    mode: state.mode.kind,
    phase: state.phase,
    diagnostics: { chatAttempts: state.diagnostics.chatAttempts },
    ...(state.settlement ? {
      settlement: {
        blockerCreated: state.settlement.blockerCreated,
        priorProjection: state.settlement.priorProjection,
      },
    } : {}),
  }
}

function replaceState(path: string, state: PersistedState): void {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  const displaced = `${path}.${process.pid}.${randomUUID()}.replaced`
  try {
    writeFileSync(temp, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 })
    try {
      renameSync(temp, path)
    } catch (error) {
      if (!existsSync(path)) throw error
      renameSync(path, displaced)
      try {
        renameSync(temp, path)
      } catch (replacementError) {
        renameSync(displaced, path)
        throw replacementError
      }
      removeFile(displaced)
    }
  } finally {
    removeFile(temp)
    removeFile(displaced)
  }
}

function withStateLock<T>(path: string, operation: () => T): T {
  const lockPath = `${path}.lock`
  const deadline = Date.now() + 10_000
  let descriptor: number | undefined
  while (descriptor === undefined) {
    try {
      descriptor = openSync(lockPath, 'wx', 0o600)
    } catch (error) {
      if (!existsSync(lockPath) || Date.now() >= deadline) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
    }
  }
  try {
    return operation()
  } finally {
    closeSync(descriptor)
    removeFile(lockPath)
  }
}

function removeFile(path: string): void {
  try { unlinkSync(path) } catch { /* already absent */ }
}

function statePath(): string {
  const profileDir = process.env.MORTISE_UI_PROFILE_DIR
  if (!profileDir) throw new Error('MORTISE_UI_PROFILE_DIR is required for Session validation.')
  return join(profileDir, 'session-validation.v1.json')
}

function readState(path: string): PersistedState | undefined {
  if (!existsSync(path)) return undefined
  try { return JSON.parse(readFileSync(path, 'utf8')) as PersistedState } catch { return undefined }
}

function emitCanonicalProjectionEvents(
  sessionId: string,
  runId: string,
  userMessage: Record<string, unknown>,
  assistantMessage: Record<string, unknown>,
  emit: SessionValidationBackendArgs['coreConfig']['onPiProjectionEvent'],
): PiProjectionBuilder {
  const builder = new PiProjectionBuilder(sessionId, `ui-validation:${runId}`)
  if (!emit) return builder
  const emitAll = (events: ReturnType<PiProjectionBuilder['acceptRuntimeEvent']>) => events.forEach(emit)
  emitAll(builder.acceptRuntimeEvent({ type: 'agent_start', timestamp: Date.now() }))
  emitAll(builder.acceptRuntimeEvent({ type: 'message_end', message: userMessage }))
  emitAll(builder.acceptRuntimeEvent({ type: 'turn_start', timestamp: Date.now() }))
  emitAll(builder.acceptRuntimeEvent({ type: 'message_end', message: assistantMessage }))
  emitAll(builder.acceptRuntimeEvent({ type: 'turn_end', message: assistantMessage, toolResults: [], timestamp: Date.now() }))
  emitAll(builder.acceptRuntimeEvent({ type: 'agent_end', messages: [userMessage, assistantMessage], timestamp: Date.now() }))
  return builder
}

function deterministicBackend(
  statePathValue: string,
  sessionId: string,
  workspaceId: string,
  workspaceRoot: string,
  state: PersistedState,
  emitProjection: SessionValidationBackendArgs['coreConfig']['onPiProjectionEvent'],
): AgentBackend {
  const chat: AgentBackend['chat'] = async function* (message, _attachments, options) {
    const attempt = recordChatAttempt(statePathValue)
    const mode = state.mode
    if (mode.kind === 'fail-before-assistant') {
      throw new Error(mode.message ?? 'Deterministic failure before assistant output')
    }
    if (mode.kind === 'fail-user-persistence-once' && attempt === 1) {
      throw new Error(mode.message ?? 'Deterministic failure before canonical user persistence')
    }

    const timestamp = Date.now()
    const clientMutationId = options?.clientMutationId
    const userMessage = {
      role: 'user',
      content: [{ type: 'text', text: message }],
      timestamp,
      ...(clientMutationId ? { clientMutationId } : {}),
    }
    const assistantMessage = {
      role: 'assistant',
      api: 'openai-completions',
      content: [{ type: 'text', text: mode.answer }],
      timestamp,
      provider: 'ui-validation',
      model: 'deterministic',
      stopReason: 'stop',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    }
    const sessionFile = getSessionFilePath(workspaceId, sessionId, timestamp)
    const piSession = mode.kind === 'fail-user-persistence-once' || mode.kind === 'fail-settlement-projection'
      ? PiSessionManager.open(sessionFile, dirname(sessionFile), workspaceRoot)
      : PiSessionManager.create(workspaceRoot, dirname(sessionFile), { id: sessionId })
    piSession.appendMessage(userMessage as never)
    piSession.appendMessage(assistantMessage as never)
    // Publication probes the canonical JSONL as soon as the first backend
    // event is observed, so queued Pi writes must be durable before yielding.
    await piSession.flush()
    const builder = emitCanonicalProjectionEvents(sessionId, state.runId, userMessage, assistantMessage, emitProjection)

    if (mode.kind === 'fail-publication-metadata') {
      const blockedSessionPath = getSessionPath(workspaceId, sessionId)
      mkdirSync(dirname(blockedSessionPath), { recursive: true })
      writeFileSync(blockedSessionPath, 'blocked Session sidecar directory', 'utf8')
    }
    if (mode.kind === 'fail-settlement-projection') {
      blockSettlementProjection(statePathValue, workspaceId, sessionId)
    }
    for (const event of builder.accept({ type: 'complete' })) emitProjection?.(event)
    yield { type: 'pi_user_message_persisted' }
    yield { type: 'text_complete', text: mode.answer, isIntermediate: false }
    yield { type: 'complete' }
  }
  return {
    supportsBranching: true, chat, postInit: async () => ({ authInjected: false }), ensureBranchReady: async () => undefined,
    getModel: () => 'deterministic', setModel: () => undefined, getThinkingLevel: () => 'medium', setThinkingLevel: () => undefined,
    getSessionId: () => sessionId, setSessionId: () => undefined, isProcessing: () => false,
    abort: async () => undefined, forceAbort: () => undefined, interruptForHandoff: () => undefined, redirect: async () => false,
    followUp: async () => false, runMiniCompletion: async () => null, dispose: () => undefined, destroy: () => undefined,
    updateRuntimeConfig: async () => false,
    projectQueuedUser: () => undefined, projectQueuedCancellation: () => 0, projectRuntimeError: () => undefined, getSummarizeCallback: () => async () => null,
    updateSdkCwd: () => undefined, setWorkspace: () => undefined, generateTitle: async () => null, regenerateTitle: async () => null,
    sendExtensionCommandInvoke: async () => ({ invoked: false, customMessages: [] }),
    onPlanSubmitted: null, onDebug: null, onBackendAuthRequired: null, onSubagent: null,
  }
}

export const sessionValidation = new SessionValidationController()
export function installSessionValidationBackend(): SessionValidationBackendFactory {
  return sessionValidation.backendFactory
}
