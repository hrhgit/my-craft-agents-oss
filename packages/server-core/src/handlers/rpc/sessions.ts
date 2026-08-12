import { existsSync } from 'fs'
import { readFile, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import {
  CodedError,
  RPC_CHANNELS,
  type CreateAndSendFirstTurnRequest,
  type FileAttachment,
  type SendMessageOptions,
  type SessionEvent,
  type Session,
  type ExtensionInteractionResponseV1,
  type SessionSettlementFailure,
  type SessionPublicationFailure,
  type OperationAccepted,
  isSessionSettlementFailure,
  isSessionPublicationFailure,
  isSerializableFrontendValue,
  validateExtensionInteractionResponseV1,
} from '@mortise/shared/protocol'
import type { StoredAttachment } from '@mortise/core/types'
import { requirePrimaryLocalWorkspaceRoot, storedToMessage } from '@mortise/core/types'
import { getWorkspaceByNameOrId } from '@mortise/shared/config'
import { CONFIG_DIR } from '@mortise/shared/config/paths'
import {
  findPiSessionProjectionById,
  projectTreeSessionProjectionAsStoredSession,
  validateSessionId,
} from '@mortise/shared/sessions'
import { perf, writeRuntimeLog } from '@mortise/shared/utils'
import { isValidThinkingLevel, THINKING_LEVEL_IDS } from '@mortise/shared/agent/thinking-levels'

const VALID_THINKING_LEVELS_LIST = THINKING_LEVEL_IDS.map(id => `'${id}'`).join(', ')
import {
  CLIENT_SHOW_IN_FOLDER,
  pushTyped,
  type HandlerFn,
  type RpcServer,
} from '@mortise/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import type { ISessionManager } from '../session-manager-interface'
import { getWorkspaceOrNull, resolveWorkspaceId } from '../utils'
import { setTransferableHandler } from './transfer'
import { collectSessionSearchRoots, serializeExtensionCommandArgs } from './session-route-helpers'
import { validateFilePath } from '../utils'
import { OperationResultArtifactStore } from '../../operations'

interface ClientSessionWatchState {
  watcher: import('fs').FSWatcher
  sessionId: string
  debounceTimer: ReturnType<typeof setTimeout> | null
}

// Per-client session file watcher state (supports concurrent windows/clients safely)
const clientSessionWatches = new Map<string, ClientSessionWatchState>()

const SESSION_GET_LOG_ID_LIMIT = 25

function summarizeIds(ids: Iterable<string>, limit = SESSION_GET_LOG_ID_LIMIT) {
  const all = Array.from(ids)
  return {
    count: all.length,
    ids: all.slice(0, limit),
    truncated: all.length > limit,
  }
}

function sessionWorkspaceDistribution(sessions: Array<{ workspaceId?: string }>): Record<string, number> {
  const distribution: Record<string, number> = {}
  for (const session of sessions) {
    const key = session.workspaceId || '(missing)'
    distribution[key] = (distribution[key] ?? 0) + 1
  }
  return distribution
}

/**
 * Enforce that `sessionId` belongs to the calling client's authenticated
 * workspace.
 *
 * - If `ctxWorkspaceId` is set: throws when the session belongs to a
 *   different workspace.
 * - If `ctxWorkspaceId` is null/undefined (headless/CLI caller): allows
 *   access only to sessions that ALSO have no workspaceId. Workspace-scoped
 *   sessions are rejected — a caller without workspace context must not
 *   read workspace-owned data.
 *
 * Pi read-only sessions are not held in the in-memory session map, so they are
 * allowed to proceed only when the caller already has a workspace context; the
 * downstream resolver then looks them up inside that workspace's Pi bucket.
 */
async function assertSessionWorkspace(
  sessionManager: ISessionManager,
  ctxWorkspaceId: string | null | undefined,
  sessionId: string,
  options: { allowMissingWithWorkspace?: boolean } = {},
): Promise<void> {
  validateSessionId(sessionId)

  const session = await sessionManager.getSession(sessionId)
  if (!session) {
    if (options.allowMissingWithWorkspace && ctxWorkspaceId) {
      return
    }
    throw new Error(`Session not found: ${sessionId}`)
  }

  if (!session.workspaceId || session.workspaceId !== ctxWorkspaceId) {
    throw new Error(
      `Session workspace mismatch: session ${sessionId} belongs to workspace ${session.workspaceId}, but caller is ${ctxWorkspaceId ? `authenticated to ${ctxWorkspaceId}` : 'not workspace-scoped'}`,
    )
  }
}

/**
 * Clean up session file watcher for a client.
 * Called from main process disconnect hooks to prevent watcher leaks.
 */
export function cleanupSessionFileWatchForClient(clientId: string): void {
  const state = clientSessionWatches.get(clientId)
  if (!state) return

  if (state.debounceTimer) {
    clearTimeout(state.debounceTimer)
    state.debounceTimer = null
  }

  state.watcher.close()
  clientSessionWatches.delete(clientId)
}

// Recursive directory scanner for session files
// Filters out internal files (session.jsonl) and hidden files (. prefix)
// Returns only non-empty directories
async function scanSessionDirectory(dirPath: string): Promise<import('@mortise/shared/protocol').SessionFile[]> {
  const { readdir, stat } = await import('fs/promises')
  const entries = await readdir(dirPath, { withFileTypes: true })
  const files: import('@mortise/shared/protocol').SessionFile[] = []

  for (const entry of entries) {
    // Skip internal and hidden files
    if (entry.name === 'session.jsonl' || entry.name.startsWith('.')) continue

    const fullPath = join(dirPath, entry.name)

    if (entry.isDirectory()) {
      // Recursively scan subdirectory
      const children = await scanSessionDirectory(fullPath)
      // Only include non-empty directories
      if (children.length > 0) {
        files.push({
          name: entry.name,
          path: fullPath,
          type: 'directory',
          children,
        })
      }
    } else {
      const stats = await stat(fullPath)
      files.push({
        name: entry.name,
        path: fullPath,
        type: 'file',
        size: stats.size,
      })
    }
  }

  // Sort: directories first, then alphabetically
  return files.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

function resolveWorkspaceRootPath(
  deps: HandlerDeps,
  ctx: { workspaceId?: string | null; webContentsId?: number | null },
): string {
  const windowWorkspaceId = ctx.webContentsId != null
    ? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId)
    : undefined
  const workspaceId = ctx.workspaceId ?? windowWorkspaceId ?? ''
  const workspace = workspaceId ? getWorkspaceByNameOrId(workspaceId) : undefined
  return workspace ? requirePrimaryLocalWorkspaceRoot(workspace) : ''
}

function resolveSessionDirectory(
  sessionManager: ISessionManager,
  sessionId: string,
  _workspaceRootPath: string,
): string | null {
  return sessionManager.getSessionPath(sessionId)
}

function resolveSessionDisplayPath(
  sessionManager: ISessionManager,
  sessionId: string,
  _workspaceRootPath: string,
): string | null {
  return sessionManager.getSessionPath(sessionId)
}

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.sessions.GET,
  RPC_CHANNELS.sessions.GET_UNREAD_SUMMARY,
  RPC_CHANNELS.sessions.MARK_ALL_READ,
  RPC_CHANNELS.sessions.CREATE,
  RPC_CHANNELS.sessions.CREATE_AND_SEND_FIRST_TURN,
  RPC_CHANNELS.sessions.DISCARD_FIRST_TURN_ATTACHMENT_STAGING,
  RPC_CHANNELS.sessions.DELETE,
  RPC_CHANNELS.sessions.GET_MESSAGES,
  RPC_CHANNELS.sessions.GET_PI_PROJECTION_SNAPSHOT,
  RPC_CHANNELS.sessions.SEND_MESSAGE,
  RPC_CHANNELS.sessions.CANCEL,
  RPC_CHANNELS.sessions.KILL_SHELL,
  RPC_CHANNELS.tasks.GET_OUTPUT,
  RPC_CHANNELS.extensions.INTERACTION_RESPONSE,
  RPC_CHANNELS.extensions.COMMAND_INVOKE,
  RPC_CHANNELS.extensions.GET_COMMANDS,
  RPC_CHANNELS.extensions.GET_FRONTEND_STATES,
  RPC_CHANNELS.sessions.COMMAND,
  RPC_CHANNELS.sessions.GET_PENDING_PLAN_EXECUTION,
  RPC_CHANNELS.sessions.LIST_CHILD_SESSIONS,
  RPC_CHANNELS.sessions.SEARCH_CONTENT,
  RPC_CHANNELS.sessions.GET_FILES,
  RPC_CHANNELS.sessions.READ_FILE,
  RPC_CHANNELS.sessions.WRITE_FILE,
  RPC_CHANNELS.sessions.WATCH_FILES,
  RPC_CHANNELS.sessions.UNWATCH_FILES,
  RPC_CHANNELS.sessions.EXPORT,
  RPC_CHANNELS.sessions.GET_EXPORT_RESULT,
  RPC_CHANNELS.sessions.IMPORT,
  RPC_CHANNELS.sessions.EXPORT_REMOTE_TRANSFER,
  RPC_CHANNELS.sessions.GET_REMOTE_TRANSFER_RESULT,
  RPC_CHANNELS.sessions.IMPORT_REMOTE_TRANSFER,
] as const

const SESSION_TEXT_FILE_LIMIT = 2 * 1024 * 1024
const OPERATION_RESULT_DIR = join(CONFIG_DIR, 'operation-results')

async function assertEditableSessionTextFile(path: string): Promise<void> {
  const fileStats = await stat(path)
  if (!fileStats.isFile()) throw new Error('Session file path must reference a file')
  if (fileStats.size > SESSION_TEXT_FILE_LIMIT) {
    throw new Error('File exceeds the 2 MiB editor limit')
  }
}

export function registerSessionsHandlers(server: RpcServer, deps: HandlerDeps): void {
  const { sessionManager, platform } = deps
  const log = platform.logger
  const operationResults = new OperationResultArtifactStore(OPERATION_RESULT_DIR)
  void operationResults.cleanupExpired().catch(error => log.warn('Failed to clean expired operation results:', error))
  const operationResultCleanupTimer = setInterval(() => {
    void operationResults.cleanupExpired().catch(error => log.warn('Failed to clean expired operation results:', error))
  }, 6 * 60 * 60_000)
  operationResultCleanupTimer.unref?.()
  server.onClose?.(() => clearInterval(operationResultCleanupTimer))

  // Get all sessions for the calling window's workspace
  // Waits for initialization to complete so sessions are never returned empty during startup
  server.handle(RPC_CHANNELS.sessions.GET, async (ctx) => {
    try {
      await sessionManager.waitForInit()
    } catch (error) {
      log.error('GET_SESSIONS continuing after initialization failure:', error)
    }
    const end = perf.start('rpc.getSessions')
    const windowWorkspaceId = ctx.webContentsId != null
      ? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId)
      : undefined
    const workspaceId = ctx.workspaceId ?? windowWorkspaceId
    const sessions = sessionManager.getSessions(workspaceId ?? undefined)
    // Keep the startup list workspace-scoped. Global Pi CLI history can be
    // large; individual pi-* sessions are still loaded on demand below.
    end()

    log.info('[sessions:get] result', {
      ctxWorkspaceId: ctx.workspaceId,
      webContentsId: ctx.webContentsId,
      windowWorkspaceId,
      resolvedWorkspaceId: workspaceId,
      returnedCount: sessions.length,
      returnedWorkspaceIds: sessionWorkspaceDistribution(sessions),
      returnedIds: summarizeIds(sessions.map(s => s.id)),
    })

    return sessions
  })

  // Get unread summary across all workspaces
  server.handle(RPC_CHANNELS.sessions.GET_UNREAD_SUMMARY, async () => {
    try {
      await sessionManager.waitForInit()
    } catch (error) {
      log.error('GET_UNREAD_SUMMARY continuing after initialization failure:', error)
    }
    return sessionManager.getUnreadSummary()
  })

  server.handle(RPC_CHANNELS.sessions.MARK_ALL_READ, async (ctx, workspaceId: string) => {
    const wid = resolveWorkspaceId(ctx.workspaceId, workspaceId)!
    return sessionManager.markAllSessionsRead(wid)
  })

  // Get a single session with messages (for lazy loading)
  server.handle(RPC_CHANNELS.sessions.GET_MESSAGES, async (ctx, sessionId: string) => {
    const end = perf.start('rpc.getSessionMessages')
    await assertSessionWorkspace(sessionManager, ctx.workspaceId, sessionId, { allowMissingWithWorkspace: true })

    const session = await sessionManager.getSession(sessionId)
    if (session) {
      end()
      return session
    }

    // Pi-owned session projection (read-only): load from Pi's session bucket
    // and expose an ordinary Session DTO with readOnly=true. No `pi-*` route id.
    {
      const windowWorkspaceId = ctx.webContentsId != null
        ? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId)
        : undefined
      const workspaceId = ctx.workspaceId ?? windowWorkspaceId ?? ''
      const workspace = workspaceId ? getWorkspaceByNameOrId(workspaceId) : undefined
      const workspaceRoot = workspace ? requirePrimaryLocalWorkspaceRoot(workspace) : ''
      const projection = workspaceRoot
        ? await findPiSessionProjectionById(workspaceId, workspaceRoot, sessionId)
        : null
      const projectedSession = projection
        ? projectTreeSessionProjectionAsStoredSession(projection, { workspaceId, workspaceRootPath: workspaceRoot })
        : null
      if (projection && projectedSession) {
        const messages = projectedSession.messages.map(storedToMessage)
        const piSession: Session = {
          id: sessionId,
          workspaceId,
          workspaceName: workspace?.name ?? 'Pi',
          name: projectedSession.name,
          preview: projectedSession.preview,
          lastMessageAt: projectedSession.lastMessageAt ?? projectedSession.lastUsedAt ?? Date.now(),
          createdAt: projectedSession.createdAt,
          messages,
          isProcessing: false,
          readOnly: true,
          messageCount: messages.length,
          sessionFolderPath: projection.path ?? projection.sessionDir,
        }
        end()
        return piSession
      }
      end()
      return null
    }
  })

  // Canonical Pi-first conversation state. Live updates arrive on
  // PI_PROJECTION_EVENT; clients use this snapshot to initialize or recover
  // after a sequence gap.
  server.handle(RPC_CHANNELS.sessions.GET_PI_PROJECTION_SNAPSHOT, async (ctx, sessionId: string) => {
    await assertSessionWorkspace(sessionManager, ctx.workspaceId, sessionId)
    return sessionManager.getPiProjectionSnapshot(sessionId)
  })

  // Persisted empty sessions remain an internal capability for hidden helpers
  // and branches. An ordinary conversation must use the first-turn transaction
  // so it cannot appear before Pi has persisted an assistant response.
  server.handle(RPC_CHANNELS.sessions.CREATE, async (ctx, workspaceId: string, options?: import('@mortise/shared/protocol').CreateSessionOptions) => {
    const isHiddenInternalSession = options?.hidden === true
    const isBranchSession = Boolean(options?.branchFromSessionId || options?.branchFromMessageId)
    if (!isHiddenInternalSession && !isBranchSession) {
      throw new Error('Ordinary sessions must use sessions:createAndSendFirstTurn')
    }
    const wid = resolveWorkspaceId(ctx.workspaceId, workspaceId)!
    const end = perf.start('rpc.createSession', { workspaceId: wid })
    const session = await sessionManager.createSession(wid, options)
    end()
    return session
  })

  // Ordinary New is one server-owned transaction. The provisional identity is
  // is returned only to the requesting client after Mortise durably accepts the
  // message. Pi later publishes it after its canonical user entry is durable.
  server.handle(RPC_CHANNELS.sessions.CREATE_AND_SEND_FIRST_TURN, async (
    ctx,
    request: CreateAndSendFirstTurnRequest,
  ) => {
    const workspaceId = resolveWorkspaceId(ctx.workspaceId, request.workspaceId)!
    if (!request.operationId) throw new Error('First-turn submission requires operationId')
    if (!deps.operationCoordinator) throw new Error('First-turn submission requires operation coordination')
    const end = perf.start('rpc.createAndSendFirstTurn', { workspaceId })
    const accepted = deps.operationCoordinator.start(
      request.operationId,
      'session.createAndSendFirstTurn',
      { workspaceId },
      async () => {
        try {
          const result = await sessionManager.createAndSendFirstTurn({
            ...request,
            workspaceId,
            // The domain message keeps its own mutation identity. It is
            // deliberately derived only inside the accepted operation.
            sendOptions: {
              ...request.sendOptions,
              operationId: request.operationId,
              optimisticMessageId: request.sendOptions?.optimisticMessageId ?? request.operationId,
            },
            callerClientId: ctx.clientId,
            signal: undefined,
          })
          await operationResults.write(request.operationId, 'first-turn', result)
          writeRuntimeLog('info', {
            scope: 'session',
            event: result.publication === 'pending' ? 'first_turn.accepted' : 'first_turn.published',
            meta: { workspaceId, sessionId: result.session.id, callerClientId: ctx.clientId, publication: result.publication },
          })
          return { resultRef: `first-turn:${request.operationId}` }
        } catch (error) {
          writeRuntimeLog('error', {
            scope: 'session',
            event: 'first_turn.rejected',
            meta: { workspaceId, callerClientId: ctx.clientId, error },
          })
          throw error
        } finally {
          end()
        }
      },
    )
    return accepted
  })

  server.handle(RPC_CHANNELS.sessions.GET_FIRST_TURN_RESULT, async (ctx, operationId: string) => {
    const receipt = deps.operationCoordinator?.get(operationId)
    if (!receipt || receipt.operationType !== 'session.createAndSendFirstTurn') {
      throw new Error(`Unknown first-turn operation ${operationId}`)
    }
    if (receipt.scope.workspaceId && receipt.scope.workspaceId !== ctx.workspaceId) {
      throw new Error('Operation is outside the current Workspace')
    }
    if (receipt.status !== 'succeeded') {
      throw new Error(`First-turn operation is not complete: ${receipt.status}`)
    }
    return operationResults.read(operationId, 'first-turn')
  })

  server.handle(RPC_CHANNELS.sessions.DISCARD_FIRST_TURN_ATTACHMENT_STAGING, async (
    ctx,
    workspaceId: string,
    stagingId: string,
  ) => {
    const wid = resolveWorkspaceId(ctx.workspaceId, workspaceId)!
    return sessionManager.discardFirstTurnAttachmentStaging(wid, stagingId)
  })

  // Delete a session
  server.handle(RPC_CHANNELS.sessions.DELETE, async (ctx, sessionId: string) => {
    await assertSessionWorkspace(sessionManager, ctx.workspaceId, sessionId)
    return sessionManager.deleteSession(sessionId)
  })

  // Send a message to a session (with optional file attachments).
  //
  // Behavior:
  //   - Returns `{ accepted: true, messageId }` after Mortise persists its
  //     recoverable outbox record and UI metadata.
  //   - Pi JSONL persistence is an asynchronous final confirmation.
  //   - The actual model-streaming work continues in the background; results
  //     flow back via SESSION_EVENT as before.
  //   - Pre-persist errors (session not found, Pi write failure, etc.) reject the RPC so the
  //     caller can show a synchronous error.
  //   - Post-persist errors (model API failures, etc.) are routed via the
  //     event stream as today.
  // attachments: FileAttachment[] for Claude (has content), storedAttachments: StoredAttachment[] for persistence (has thumbnailBase64)
  const sendMessageHandler: HandlerFn = async (ctx, sessionId: string, message: string, attachments?: FileAttachment[], storedAttachments?: StoredAttachment[], options?: SendMessageOptions) => {
    await assertSessionWorkspace(sessionManager, ctx.workspaceId, sessionId)

    const operationId = options?.operationId
    if (!operationId) throw new Error('Message submission requires operationId')
    const operation = deps.operationCoordinator
    const operationType = /^\/compact(?:\s|$)/i.test(message.trim()) ? 'session.compact' : 'session.sendMessage'
    const accepted: OperationAccepted = operation?.accept(operationId, operationType, {
      ...(ctx.workspaceId ? { workspaceId: ctx.workspaceId } : {}),
      sessionId,
    }) ?? { accepted: true, operationId, status: 'accepted', revision: 1, duplicate: false }
    if (accepted?.duplicate) {
      return { ...accepted, messageId: operationId }
    }

    // Capture the caller's clientId for error routing
    const callerClientId = ctx.clientId
    const unregisterCancellation = operation?.registerCancellation?.(
      operationId,
      () => sessionManager.cancelProcessing(sessionId, false),
    )

    return await new Promise<OperationAccepted & { messageId: string }>((resolve, reject) => {
      let acked = false
      const onAccepted = (messageId: string) => {
        if (!acked) {
          acked = true
          if (operation) operation.update(operationId, 'running')
          resolve({ ...accepted, messageId })
        }
      }

      sessionManager
        .sendMessage(
          sessionId,
          message,
          attachments,
          storedAttachments,
          options,
          undefined,
          undefined,
          undefined,
          { callerClientId },
          false,
          onAccepted,
        )
        .then(() => {
          // sendMessage finished without firing onAck — should not happen in
          // practice (every code path that creates a user message acks).
          // Treat as a defensive failure rather than silently dropping.
          if (!acked) {
            acked = true
            operation?.update(operationId, 'failed', { error: { code: 'MESSAGE_NOT_ACCEPTED', message: 'sendMessage completed without persisting a user message' } })
            reject(new Error('sendMessage completed without persisting a user message'))
            return
          }
          operation?.update(operationId, 'succeeded', {
            resultRef: operationType === 'session.compact'
              ? `session:${sessionId}:compaction`
              : `session:${sessionId}:message:${operationId}`,
          })
        })
        .catch(err => {
          log.error('Error in sendMessage:', err)
          if (!acked) {
            // Pre-persist error — surface synchronously to the caller.
            writeRuntimeLog('error', {
              scope: 'session',
              event: 'send_message.rejected',
              meta: {
                sessionId,
                workspaceId: ctx.workspaceId,
                callerClientId,
                error: err,
              },
            })
            acked = true
            operation?.update(operationId, 'failed', { error: { code: err?.code ?? 'SEND_MESSAGE_REJECTED', message: err?.message ?? String(err) } })
            reject(err)
            return
          }
          // Settlement failures happen after the canonical user message is
          // accepted. Preserve that distinction on the wire so clients retry
          // only settlement and never submit the message again.
          writeRuntimeLog('error', {
            scope: 'session',
            event: 'send_message.post_accept_error',
            meta: {
              sessionId,
              workspaceId: ctx.workspaceId,
              callerClientId,
              error: err,
            },
          })
          if (operation?.isCancellationRequested?.(operationId)) {
            operation.update(operationId, 'cancelled')
          } else {
            operation?.update(operationId, 'failed', { error: { code: err?.code ?? 'SESSION_SETTLEMENT_FAILED', message: err?.message ?? String(err) } })
          }
          if (isSessionSettlementFailure(err)) {
            const failure: SessionSettlementFailure = {
              code: err.code,
              message: err.message,
              data: err.data,
            }
            pushTyped(server, RPC_CHANNELS.sessions.EVENT, { to: 'client', clientId: callerClientId }, {
              type: 'session_failure',
              sessionId,
              error: failure,
            })
            return
          }
          if (isSessionPublicationFailure(err)) {
            const failure: SessionPublicationFailure = {
              code: err.code,
              message: err.message,
              data: err.data,
            }
            pushTyped(server, RPC_CHANNELS.sessions.EVENT, { to: 'client', clientId: callerClientId }, {
              type: 'session_failure',
              sessionId,
              error: failure,
            })
            return
          }
          pushTyped(server, RPC_CHANNELS.sessions.EVENT, { to: 'client', clientId: callerClientId }, {
            type: 'error',
            sessionId,
            error: err instanceof Error ? err.message : 'Unknown error'
          } as SessionEvent)
        })
        .finally(() => unregisterCancellation?.())
    })
  }
  server.handle(RPC_CHANNELS.sessions.SEND_MESSAGE, sendMessageHandler)
  setTransferableHandler(RPC_CHANNELS.sessions.SEND_MESSAGE, sendMessageHandler)

  // Cancel processing
  server.handle(RPC_CHANNELS.sessions.CANCEL, async (ctx, sessionId: string, silent?: boolean) => {
    await assertSessionWorkspace(sessionManager, ctx.workspaceId, sessionId)
    return sessionManager.cancelProcessing(sessionId, silent)
  })

  // Kill background shell
  server.handle(RPC_CHANNELS.sessions.KILL_SHELL, async (ctx, sessionId: string, shellId: string) => {
    await assertSessionWorkspace(sessionManager, ctx.workspaceId, sessionId)
    return sessionManager.killShell(sessionId, shellId)
  })

  // Get background task output
  server.handle(RPC_CHANNELS.tasks.GET_OUTPUT, async (_ctx, taskId: string) => {
    try {
      const output = await sessionManager.getTaskOutput(taskId)
      return output
    } catch (err) {
      log.error('Failed to get task output:', err)
      throw err
    }
  })

  server.handle(RPC_CHANNELS.extensions.INTERACTION_RESPONSE, async (ctx, sessionId: string, requestId: string, response: ExtensionInteractionResponseV1) => {
    await assertSessionWorkspace(sessionManager, ctx.workspaceId, sessionId)
    const error = validateExtensionInteractionResponseV1(response)
    if (error) throw new TypeError(`Invalid extension interaction response: ${error}`)
    return sessionManager.respondToExtensionInteraction(sessionId, requestId, response)
  })

  // 调用 pi 扩展注册的命令（extension_command_invoke）
  // 由 automation 委托路径触发，转发到对应会话的 PiAgent.sendExtensionCommandInvoke
  server.handle(RPC_CHANNELS.extensions.COMMAND_INVOKE, async (ctx, sessionId: string, commandId: string, args: string | Record<string, unknown> | null | undefined, ownerExtensionId: string | undefined, operationId: string) => {
    await assertSessionWorkspace(sessionManager, ctx.workspaceId, sessionId)
    if (!operationId) throw new Error('Extension command invocation requires operationId')
    if (!deps.operationCoordinator) throw new Error('Operation coordination is unavailable')
    const serializedArgs = serializeExtensionCommandArgs(args)
    const operation = deps.operationCoordinator.start(operationId, 'extension.commandInvoke', {
      ...(ctx.workspaceId ? { workspaceId: ctx.workspaceId } : {}),
      sessionId,
      ...(ownerExtensionId ? { extensionId: ownerExtensionId } : {}),
    }, async () => {
      const result = await sessionManager.invokeExtensionCommand(sessionId, commandId, serializedArgs, ownerExtensionId)
      if (!result.invoked) throw Object.assign(new Error(result.error ?? 'Extension command was not invoked'), { code: 'EXTENSION_COMMAND_FAILED' })
      return { resultRef: `session:${sessionId}` }
    })
    return operation
  })

  // 查询当前会话已注册的 Pi 扩展 slash commands，用于 renderer slash menu 初始快照
  server.handle(RPC_CHANNELS.extensions.GET_COMMANDS, async (ctx, sessionId: string) => {
    await assertSessionWorkspace(sessionManager, ctx.workspaceId, sessionId)
    return sessionManager.listExtensionCommands(sessionId)
  })

  // Recover complete frontend channel state when the renderer subscribed after
  // the live event, refreshed, or reconnected to an already-running session.
  server.handle(RPC_CHANNELS.extensions.GET_FRONTEND_STATES, async (ctx, sessionId: string) => {
    if (sessionId) await assertSessionWorkspace(sessionManager, ctx.workspaceId, sessionId)
    else if (!ctx.workspaceId) throw new Error('Extension frontend state requires a Workspace route')
    return sessionManager.getExtensionFrontendStates(sessionId, ctx.workspaceId)
  })

  server.handle(RPC_CHANNELS.extensions.FRONTEND_MESSAGE, async (
    ctx,
    sessionId: string,
    request: import('@mortise/shared/protocol').ExtensionFrontendMessageV2,
  ) => {
    if (sessionId) await assertSessionWorkspace(sessionManager, ctx.workspaceId, sessionId)
    else if (!ctx.workspaceId) throw new Error('Extension frontend messages require a Workspace route')
    if (!request || request.schemaVersion !== 2 || typeof request.operationId !== 'string' || !request.operationId
      || typeof request.channelId !== 'string' || typeof request.extensionId !== 'string'
      || !request.route || !['session', 'workspace', 'global'].includes(request.scope)
      || !isSerializableFrontendValue(request.message)) {
      throw new TypeError('Invalid extension frontend channel message')
    }
    if (request.route.sessionId && request.route.sessionId !== sessionId) throw new Error('Frontend channel route mismatch')
    if (request.route.workspaceId && request.route.workspaceId !== ctx.workspaceId) throw new Error('Frontend channel workspace mismatch')
    if (!deps.operationCoordinator) throw new Error('Operation coordination is unavailable')
    return deps.operationCoordinator.start(request.operationId, 'extension.frontendMessage', {
      ...(ctx.workspaceId ? { workspaceId: ctx.workspaceId } : {}),
      ...(sessionId ? { sessionId } : {}),
      extensionId: request.extensionId,
    }, async () => {
      await sessionManager.sendExtensionFrontendMessage(sessionId, request.extensionId, request.channelId, request.message, ctx.workspaceId)
      return { resultRef: `extension:${request.extensionId}:frontend:${request.channelId}` }
    })
  })

  server.handle(RPC_CHANNELS.extensions.GET_FILE_STATE, async (ctx, workspaceId: string, extensionId: string) => {
    if (!ctx.workspaceId || ctx.workspaceId !== workspaceId) throw new Error('Extension state requires the authenticated Workspace route')
    return sessionManager.getExtensionFileState(workspaceId, extensionId)
  })

  server.handle(RPC_CHANNELS.extensions.SET_FILE_STATE, async (ctx, workspaceId: string, extensionId: string, state: import('@mortise/shared/protocol').ExtensionFileStateV1) => {
    if (!ctx.workspaceId || ctx.workspaceId !== workspaceId) throw new Error('Extension state requires the authenticated Workspace route')
    await sessionManager.setExtensionFileState(workspaceId, extensionId, state)
    return true
  })

  // List child sessions in pi's session tree spawned from the given parent session.
  // Used by SubagentPanel to render active branches (spawnedFrom filter).
  server.handle(RPC_CHANNELS.sessions.LIST_CHILD_SESSIONS, async (ctx, sessionId: string) => {
    await assertSessionWorkspace(sessionManager, ctx.workspaceId, sessionId)
    return sessionManager.listChildSessions(sessionId)
  })

  // ==========================================================================
  // Consolidated Command Handlers
  // ==========================================================================

  // Session commands - consolidated handler for session operations
  server.handle(RPC_CHANNELS.sessions.COMMAND, async (
    ctx,
    sessionId: string,
    command: import('@mortise/shared/protocol').SessionCommand
  ) => {
    await assertSessionWorkspace(sessionManager, ctx.workspaceId, sessionId)
    const startOperation = <T>(operationId: string, type: string, task: () => Promise<T>) => {
      if (!deps.operationCoordinator) throw new Error('Operation coordination is unavailable')
      return deps.operationCoordinator.start(operationId, type, {
        ...(ctx.workspaceId ? { workspaceId: ctx.workspaceId } : {}),
        sessionId,
      }, async () => {
        const result = await task()
        if (result && typeof result === 'object' && 'success' in result && result.success === false) {
          const message = 'error' in result && typeof result.error === 'string' ? result.error : `${type} failed`
          throw new Error(message)
        }
        return { resultRef: `session:${sessionId}` }
      })
    }
    switch (command.type) {
      case 'rename':
        return sessionManager.renameSession(sessionId, command.name)
      case 'markRead':
        return sessionManager.markSessionRead(sessionId)
      case 'markUnread':
        return sessionManager.markSessionUnread(sessionId)
      case 'setActiveViewing':
        // Track which session user is actively viewing (for unread state machine)
        return sessionManager.setActiveViewingSession(sessionId, command.workspaceId)
      case 'setThinkingLevel':
        // Validate thinking level before passing to session manager
        if (!isValidThinkingLevel(command.level)) {
          throw new Error(`Invalid thinking level: ${command.level}. Valid values: ${VALID_THINKING_LEVELS_LIST}`)
        }
        return sessionManager.setSessionThinkingLevel(sessionId, command.level)
      case 'retrySettlement':
        if (Object.keys(command).length !== 2) {
          throw new Error('retrySettlement does not accept a message or any other payload')
        }
        return startOperation(command.operationId, 'session.retrySettlement', () => sessionManager.retryPendingSettlement(sessionId))
      case 'retryAcceptedMessage':
        if (Object.keys(command).length !== 2) {
          throw new Error('retryAcceptedMessage does not accept a message or any other payload')
        }
        return startOperation(command.operationId, 'session.retryAcceptedMessage', () => sessionManager.retryAcceptedMessage(sessionId, ctx.clientId))
      case 'withdrawQueuedMessage':
        return sessionManager.withdrawQueuedMessage(sessionId, command.messageId)
      case 'showInFinder': {
        const sessionPath = resolveSessionDisplayPath(sessionManager, sessionId, resolveWorkspaceRootPath(deps, ctx))
        if (!sessionPath) throw new Error(`Session path unavailable: ${sessionId}`)
        if (server.hasClientCapability(ctx.clientId, CLIENT_SHOW_IN_FOLDER)) {
          await server.invokeClient(ctx.clientId, CLIENT_SHOW_IN_FOLDER, sessionPath)
          return
        }
        if (deps.platform.showItemInFolder) {
          await deps.platform.showItemInFolder(sessionPath)
          return
        }
        throw new CodedError(
          'CAPABILITY_UNAVAILABLE',
          'Show in Finder is unavailable because neither the requesting client nor this platform implements it',
        )
      }
      case 'copyPath': {
        // Return the session folder path for copying to clipboard
        const sessionPath = resolveSessionDisplayPath(sessionManager, sessionId, resolveWorkspaceRootPath(deps, ctx))
        return sessionPath ? { success: true, path: sessionPath } : { success: false }
      }
      case 'shareToViewer':
        return startOperation(command.operationId, 'session.shareToViewer', () => sessionManager.shareTransferService.publish(sessionId))
      case 'updateShare':
        return startOperation(command.operationId, 'session.updateShare', () => sessionManager.shareTransferService.refresh(sessionId))
      case 'revokeShare':
        return startOperation(command.operationId, 'session.revokeShare', () => sessionManager.shareTransferService.revoke(sessionId))
      case 'refreshTitle':
        log.info(`IPC: refreshTitle received for session ${sessionId}`)
        return startOperation(command.operationId, 'session.refreshTitle', () => sessionManager.refreshTitle(sessionId))
      case 'setProvider':
        log.info(`IPC: setProvider received for session ${sessionId}, provider: ${command.provider}`)
        return sessionManager.setSessionProvider(sessionId, command.provider)
      // Pending plan execution (Accept & Compact flow)
      case 'setPendingPlanExecution':
        return sessionManager.setPendingPlanExecution(sessionId, { planPath: command.planPath, artifactId: command.artifactId }, command.draftInputSnapshot)
      case 'markCompactionComplete':
        return sessionManager.markCompactionComplete(sessionId)
      case 'markPendingPlanExecutionDispatched':
        return sessionManager.markPendingPlanExecutionDispatched(sessionId)
      case 'clearPendingPlanExecution':
        return sessionManager.clearPendingPlanExecution(sessionId)
      case 'addAnnotation':
        return sessionManager.addMessageAnnotation(sessionId, command.messageId, command.annotation)
      case 'removeAnnotation':
        return sessionManager.removeMessageAnnotation(sessionId, command.messageId, command.annotationId)
      case 'updateAnnotation':
        return sessionManager.updateMessageAnnotation(sessionId, command.messageId, command.annotationId, command.patch)
      default: {
        const _exhaustive: never = command
        throw new Error(`Unknown session command: ${JSON.stringify(command)}`)
      }
    }
  })

  // Get pending plan execution state (for reload recovery)
  server.handle(RPC_CHANNELS.sessions.GET_PENDING_PLAN_EXECUTION, async (
    ctx,
    sessionId: string
  ) => {
    await assertSessionWorkspace(sessionManager, ctx.workspaceId, sessionId)
    return sessionManager.getPendingPlanExecution(sessionId)
  })

  // ============================================================
  // Session Content Search
  // ============================================================

  // Search session content using ripgrep
  server.handle(RPC_CHANNELS.sessions.SEARCH_CONTENT, async (ctx, workspaceId: string, query: string, searchId?: string) => {
    const id = searchId || Date.now().toString(36)
    log.info('[search]','ipc:request', { searchId: id, query })

    const wid = resolveWorkspaceId(ctx.workspaceId, workspaceId)
    if (!wid) return []
    const workspace = getWorkspaceOrNull(wid, log, 'SEARCH_SESSIONS')
    if (!workspace) return []

    const { searchSessions } = await import('@mortise/server-core/services')
    const workspaceSessions = sessionManager.getSessions(wid)
    const searchRoots = collectSessionSearchRoots(wid, workspaceSessions)
      .filter((root) => existsSync(root))
    if (searchRoots.length === 0) {
      log.debug(`SEARCH_SESSIONS: No session roots found for workspace ${wid}`)
      return []
    }

    log.debug(`SEARCH_SESSIONS: Searching "${query}" in ${searchRoots.length} session root(s)`)

    const results = await searchSessions(query, searchRoots, {
      timeout: 5000,
      maxMatchesPerSession: 3,
      maxSessions: 50,
      searchId: id,
    })

    // Filter out hidden sessions (e.g., mini edit sessions)
    const workspaceSessionIds = new Set(workspaceSessions.map(s => s.id))
    const hiddenSessionIds = new Set(
      workspaceSessions.filter(s => s.hidden).map(s => s.id)
    )
    const filteredResults = results.filter(r => workspaceSessionIds.has(r.sessionId) && !hiddenSessionIds.has(r.sessionId))

    log.info('[search]','ipc:response', { searchId: id, resultCount: filteredResults.length, totalFound: results.length })
    return filteredResults
  })

  // ============================================================
  // Session Info Panel (files, notes, file watching)
  // ============================================================

  // Get files in session directory (recursive tree structure)
  server.handle(RPC_CHANNELS.sessions.GET_FILES, async (ctx, sessionId: string) => {
    await assertSessionWorkspace(sessionManager, ctx.workspaceId, sessionId)
    const sessionPath = resolveSessionDirectory(sessionManager, sessionId, resolveWorkspaceRootPath(deps, ctx))
    if (!sessionPath) return []

    try {
      return await scanSessionDirectory(sessionPath)
    } catch (error) {
      log.error('Failed to get session files:', error)
      return []
    }
  })

  server.handle(RPC_CHANNELS.sessions.READ_FILE, async (ctx, sessionId: string, path: string) => {
    await assertSessionWorkspace(sessionManager, ctx.workspaceId, sessionId)
    const sessionPath = resolveSessionDirectory(sessionManager, sessionId, resolveWorkspaceRootPath(deps, ctx))
    if (!sessionPath) throw new Error(`Session directory not found: ${sessionId}`)
    const safePath = await validateFilePath(path, [sessionPath], { allowHome: false, allowTmp: false })
    await assertEditableSessionTextFile(safePath)
    return readFile(safePath, 'utf-8')
  })

  server.handle(RPC_CHANNELS.sessions.WRITE_FILE, async (
    ctx,
    sessionId: string,
    path: string,
    content: string,
    expectedContent: string,
  ) => {
    await assertSessionWorkspace(sessionManager, ctx.workspaceId, sessionId)
    if (typeof content !== 'string' || typeof expectedContent !== 'string') {
      throw new Error('File content and expected content must be strings')
    }
    if (
      Buffer.byteLength(content, 'utf-8') > SESSION_TEXT_FILE_LIMIT
      || Buffer.byteLength(expectedContent, 'utf-8') > SESSION_TEXT_FILE_LIMIT
    ) {
      throw new Error('File content exceeds the 2 MiB editor limit')
    }
    const sessionPath = resolveSessionDirectory(sessionManager, sessionId, resolveWorkspaceRootPath(deps, ctx))
    if (!sessionPath) throw new Error(`Session directory not found: ${sessionId}`)
    const safePath = await validateFilePath(path, [sessionPath], { allowHome: false, allowTmp: false })
    await assertEditableSessionTextFile(safePath)
    const currentContent = await readFile(safePath, 'utf-8')
    if (currentContent !== expectedContent) {
      return { status: 'conflict' as const, currentContent }
    }
    await writeFile(safePath, content, 'utf-8')
    return { status: 'saved' as const }
  })

  // Start watching a session directory for file changes (per client)
  server.handle(RPC_CHANNELS.sessions.WATCH_FILES, async (ctx, sessionId: string) => {
    await assertSessionWorkspace(sessionManager, ctx.workspaceId, sessionId)
    const clientId = ctx.clientId
    cleanupSessionFileWatchForClient(clientId)

    const sessionPath = resolveSessionDirectory(sessionManager, sessionId, resolveWorkspaceRootPath(deps, ctx))
    if (!sessionPath) return

    try {
      const { watch } = await import('fs')

      const state: ClientSessionWatchState = {
        watcher: null as unknown as import('fs').FSWatcher,
        sessionId,
        debounceTimer: null,
      }

      state.watcher = watch(sessionPath, { recursive: true }, (_eventType, filename) => {
        // Ignore internal files and hidden files
        if (filename && (filename.includes('session.jsonl') || filename.startsWith('.'))) {
          return
        }

        // Debounce: wait 100ms before notifying to batch rapid changes
        if (state.debounceTimer) {
          clearTimeout(state.debounceTimer)
        }

        state.debounceTimer = setTimeout(() => {
          pushTyped(server, RPC_CHANNELS.sessions.FILES_CHANGED, { to: 'client', clientId }, state.sessionId)
        }, 100)
      })

      clientSessionWatches.set(clientId, state)
    } catch (error) {
      log.error('Failed to start session file watcher:', error)
    }
  })

  // Stop watching session files for the calling client
  server.handle(RPC_CHANNELS.sessions.UNWATCH_FILES, async (ctx) => {
    cleanupSessionFileWatchForClient(ctx.clientId)
  })

  // ============================================
  // Export / Import / Dispatch
  // ============================================

  // Export a session as a portable bundle
  server.handle(RPC_CHANNELS.sessions.EXPORT, async (ctx, sessionId: string, operationId: string) => {
    await sessionManager.waitForInit()
    const workspaceId = ctx.workspaceId ?? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId!)
    if (!workspaceId) throw new Error('No workspace context')

    if (!operationId || !deps.operationCoordinator) throw new Error('Export requires operation coordination and operationId')
    return deps.operationCoordinator.start(operationId, 'session.export', { workspaceId, sessionId }, async () => {
      const bundle = await sessionManager.exportSession(sessionId, workspaceId)
      if (!bundle) throw new Error(`Failed to export session ${sessionId}`)
      await operationResults.write(operationId, 'session-export', bundle)
      return { resultRef: `session-export:${operationId}` }
    })
  }, { timeoutMs: null })

  server.handle(RPC_CHANNELS.sessions.GET_EXPORT_RESULT, async (ctx, operationId: string) => {
    const receipt = deps.operationCoordinator?.get(operationId)
    if (!receipt || receipt.operationType !== 'session.export' || receipt.status !== 'succeeded') throw new Error('Export result is not available')
    if (receipt.scope.workspaceId && receipt.scope.workspaceId !== ctx.workspaceId) throw new Error('Operation is outside the current Workspace')
    return operationResults.read(operationId, 'session-export')
  })

  // Import a session bundle into a target workspace
  // targetWorkspaceId is passed explicitly (not from context) so the renderer
  // can import into any workspace the server manages, not just the active one.
  const importHandler = async (_ctx: any, targetWorkspaceId: string, bundle: unknown, mode: string, operationId: string) => {
    await sessionManager.waitForInit()
    if (!targetWorkspaceId || typeof targetWorkspaceId !== 'string') throw new Error('targetWorkspaceId is required')
    if (mode !== 'move' && mode !== 'fork') throw new Error(`Invalid dispatch mode: ${mode}`)

    if (!operationId || !deps.operationCoordinator) throw new Error('Import requires operation coordination and operationId')
    return deps.operationCoordinator.start(operationId, 'session.import', { workspaceId: targetWorkspaceId }, async () => {
      const result = await sessionManager.importSession(targetWorkspaceId, bundle as import('@mortise/shared/sessions').SessionBundle, mode)
      return { resultRef: `session:${result.sessionId}` }
    })
  }
  server.handle(RPC_CHANNELS.sessions.IMPORT, importHandler, { timeoutMs: null })
  // Also register as transferable so chunked transfer can invoke it on commit
  setTransferableHandler(RPC_CHANNELS.sessions.IMPORT, importHandler)

  // Export a session as a summarized remote-transfer payload.
  server.handle(RPC_CHANNELS.sessions.EXPORT_REMOTE_TRANSFER, async (ctx, sessionId: string, operationId: string) => {
    await sessionManager.waitForInit()
    const workspaceId = ctx.workspaceId ?? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId!)
    if (!workspaceId) throw new Error('No workspace context')

    if (!operationId || !deps.operationCoordinator) throw new Error('Remote export requires operation coordination and operationId')
    return deps.operationCoordinator.start(operationId, 'session.remoteTransferExport', { workspaceId, sessionId }, async () => {
      const payload = await sessionManager.shareTransferService.exportSummary(sessionId, workspaceId)
      if (!payload) throw new Error(`Failed to export remote transfer for session ${sessionId}`)
      await operationResults.write(operationId, 'remote-transfer', payload)
      return { resultRef: `remote-transfer:${operationId}` }
    })
  }, { timeoutMs: null })

  server.handle(RPC_CHANNELS.sessions.GET_REMOTE_TRANSFER_RESULT, async (ctx, operationId: string) => {
    const receipt = deps.operationCoordinator?.get(operationId)
    if (!receipt || receipt.operationType !== 'session.remoteTransferExport' || receipt.status !== 'succeeded') throw new Error('Remote transfer result is not available')
    if (receipt.scope.workspaceId && receipt.scope.workspaceId !== ctx.workspaceId) throw new Error('Operation is outside the current Workspace')
    return operationResults.read(operationId, 'remote-transfer')
  })

  // Import a summarized remote-transfer payload into a target workspace.
  server.handle(RPC_CHANNELS.sessions.IMPORT_REMOTE_TRANSFER, async (_ctx, targetWorkspaceId: string, payload: import('@mortise/shared/protocol').RemoteSessionTransferPayload, operationId: string) => {
    await sessionManager.waitForInit()
    if (!targetWorkspaceId || typeof targetWorkspaceId !== 'string') throw new Error('targetWorkspaceId is required')
    if (!operationId || !deps.operationCoordinator) throw new Error('Remote import requires operation coordination and operationId')
    return deps.operationCoordinator.start(operationId, 'session.remoteTransferImport', { workspaceId: targetWorkspaceId }, async () => {
      const result = await sessionManager.shareTransferService.importSummary(targetWorkspaceId, payload)
      return { resultRef: `session:${result.sessionId}` }
    })
  }, { timeoutMs: null })
}
