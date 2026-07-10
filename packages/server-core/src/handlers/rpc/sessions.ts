import { existsSync } from 'fs'
import { readFile, writeFile, stat } from 'fs/promises'
import { join } from 'path'
import { RPC_CHANNELS, type FileAttachment, type SendMessageOptions, type SessionEvent, type Session } from '@craft-agent/shared/protocol'
import type { StoredAttachment } from '@craft-agent/core/types'
import { storedToMessage } from '@craft-agent/core/types'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import {
  findPiSessionProjectionById,
  projectTreeSessionProjectionAsStoredSession,
  validateSessionId,
} from '@craft-agent/shared/sessions'
import { perf, writeRuntimeLog } from '@craft-agent/shared/utils'
import { isValidThinkingLevel, THINKING_LEVEL_IDS } from '@craft-agent/shared/agent/thinking-levels'

const VALID_THINKING_LEVELS_LIST = THINKING_LEVEL_IDS.map(id => `'${id}'`).join(', ')
import { pushTyped, type HandlerFn, type RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import type { ISessionManager } from '../session-manager-interface'
import { getWorkspaceOrNull, resolveWorkspaceId } from '../utils'
import { setTransferableHandler } from './transfer'
import { collectSessionSearchRoots, serializeExtensionCommandArgs } from './session-route-helpers'

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
async function scanSessionDirectory(dirPath: string): Promise<import('@craft-agent/shared/protocol').SessionFile[]> {
  const { readdir, stat } = await import('fs/promises')
  const entries = await readdir(dirPath, { withFileTypes: true })
  const files: import('@craft-agent/shared/protocol').SessionFile[] = []

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
  return workspace?.rootPath ?? ''
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
  RPC_CHANNELS.sessions.DELETE,
  RPC_CHANNELS.sessions.GET_MESSAGES,
  RPC_CHANNELS.sessions.SEND_MESSAGE,
  RPC_CHANNELS.sessions.CANCEL,
  RPC_CHANNELS.sessions.KILL_SHELL,
  RPC_CHANNELS.tasks.GET_OUTPUT,
  RPC_CHANNELS.sessions.RESPOND_TO_PERMISSION,
  RPC_CHANNELS.sessions.RESPOND_TO_CREDENTIAL,
  RPC_CHANNELS.extensions.REMOTEUI_RESPONSE,
  RPC_CHANNELS.extensions.COMMAND_INVOKE,
  RPC_CHANNELS.sessions.COMMAND,
  RPC_CHANNELS.sessions.GET_PENDING_PLAN_EXECUTION,
  RPC_CHANNELS.sessions.GET_PERMISSION_MODE_STATE,
  RPC_CHANNELS.sessions.LIST_CHILD_SESSIONS,
  RPC_CHANNELS.sessions.SEARCH_CONTENT,
  RPC_CHANNELS.sessions.GET_FILES,
  RPC_CHANNELS.sessions.GET_NOTES,
  RPC_CHANNELS.sessions.SET_NOTES,
  RPC_CHANNELS.sessions.WATCH_FILES,
  RPC_CHANNELS.sessions.UNWATCH_FILES,
  RPC_CHANNELS.sessions.EXPORT,
  RPC_CHANNELS.sessions.IMPORT,
  RPC_CHANNELS.sessions.EXPORT_REMOTE_TRANSFER,
  RPC_CHANNELS.sessions.IMPORT_REMOTE_TRANSFER,
] as const

export function registerSessionsHandlers(server: RpcServer, deps: HandlerDeps): void {
  const { sessionManager, platform } = deps
  const log = platform.logger

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
      const workspaceRoot = workspace?.rootPath ?? ''
      const projection = workspaceRoot
        ? await findPiSessionProjectionById(workspaceRoot, sessionId)
        : null
      const projectedSession = projection
        ? projectTreeSessionProjectionAsStoredSession(projection, { workspaceRootPath: workspaceRoot })
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
          workingDirectory: projectedSession.workingDirectory,
          sessionFolderPath: projection.path ?? projection.sessionDir,
        }
        end()
        return piSession
      }
      end()
      return null
    }
  })

  // Create a new session
  server.handle(RPC_CHANNELS.sessions.CREATE, async (ctx, workspaceId: string, options?: import('@craft-agent/shared/protocol').CreateSessionOptions) => {
    const wid = resolveWorkspaceId(ctx.workspaceId, workspaceId)!
    const end = perf.start('rpc.createSession', { workspaceId: wid })
    const session = await sessionManager.createSession(wid, options)
    end()
    return session
  })

  // Delete a session
  server.handle(RPC_CHANNELS.sessions.DELETE, async (ctx, sessionId: string) => {
    await assertSessionWorkspace(sessionManager, ctx.workspaceId, sessionId)
    return sessionManager.deleteSession(sessionId)
  })

  // Send a message to a session (with optional file attachments).
  //
  // Behavior:
  //   - Awaits until the user message is persisted to disk, then returns
  //     `{ accepted: true, messageId }`. This guarantees the message survives
  //     a mid-stream crash (#616).
  //   - The actual model-streaming work continues in the background; results
  //     flow back via SESSION_EVENT as before.
  //   - Pre-persist errors (session not found, etc.) reject the RPC so the
  //     caller can show a synchronous error.
  //   - Post-persist errors (model API failures, etc.) are routed via the
  //     event stream as today.
  // attachments: FileAttachment[] for Claude (has content), storedAttachments: StoredAttachment[] for persistence (has thumbnailBase64)
  const sendMessageHandler: HandlerFn = async (ctx, sessionId: string, message: string, attachments?: FileAttachment[], storedAttachments?: StoredAttachment[], options?: SendMessageOptions) => {
    await assertSessionWorkspace(sessionManager, ctx.workspaceId, sessionId)

    // Capture the caller's clientId for error routing
    const callerClientId = ctx.clientId

    return await new Promise<{ accepted: true; messageId: string }>((resolve, reject) => {
      let acked = false
      const onAck = (messageId: string) => {
        if (!acked) {
          acked = true
          resolve({ accepted: true, messageId })
        }
      }

      sessionManager
        .sendMessage(sessionId, message, attachments, storedAttachments, options, undefined, undefined, onAck, { callerClientId })
        .then(() => {
          // sendMessage finished without firing onAck — should not happen in
          // practice (every code path that creates a user message acks).
          // Treat as a defensive failure rather than silently dropping.
          if (!acked) {
            acked = true
            reject(new Error('sendMessage completed without persisting a user message'))
          }
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
            reject(err)
            return
          }
          // Post-persist error — route via the event stream as today.
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
          pushTyped(server, RPC_CHANNELS.sessions.EVENT, { to: 'client', clientId: callerClientId }, {
            type: 'error',
            sessionId,
            error: err instanceof Error ? err.message : 'Unknown error'
          } as SessionEvent)
          pushTyped(server, RPC_CHANNELS.sessions.EVENT, { to: 'client', clientId: callerClientId }, {
            type: 'complete',
            sessionId
          } as SessionEvent)
        })
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

  // Respond to a permission request (bash command approval)
  // Returns true if the response was delivered, false if agent/session is gone
  server.handle(RPC_CHANNELS.sessions.RESPOND_TO_PERMISSION, async (ctx, sessionId: string, requestId: string, allowed: boolean, alwaysAllow: boolean) => {
    await assertSessionWorkspace(sessionManager, ctx.workspaceId, sessionId)
    return sessionManager.respondToPermission(sessionId, requestId, allowed, alwaysAllow)
  })

  // Respond to a credential request (secure auth input)
  // Returns true if the response was delivered, false if agent/session is gone
  server.handle(RPC_CHANNELS.sessions.RESPOND_TO_CREDENTIAL, async (ctx, sessionId: string, requestId: string, response: import('@craft-agent/shared/protocol').CredentialResponse) => {
    await assertSessionWorkspace(sessionManager, ctx.workspaceId, sessionId)
    return sessionManager.respondToCredential(sessionId, requestId, response)
  })

  // 回复 pi 扩展发起的 remoteui:request（payload=null 表示用户取消）
  // 由渲染进程 RemoteUIModal 调用，转发到对应会话的 PiAgent.sendRemoteUIResponse
  server.handle(RPC_CHANNELS.extensions.REMOTEUI_RESPONSE, async (ctx, sessionId: string, requestId: string, payload: unknown | null, reason?: 'cancelled' | 'no_remote' | 'disconnected') => {
    await assertSessionWorkspace(sessionManager, ctx.workspaceId, sessionId)
    return sessionManager.sendRemoteUIResponse(sessionId, requestId, payload, reason)
  })

  // 调用 pi 扩展注册的命令（extension_command_invoke）
  // 由 automation 委托路径触发，转发到对应会话的 PiAgent.sendExtensionCommandInvoke
  server.handle(RPC_CHANNELS.extensions.COMMAND_INVOKE, async (ctx, sessionId: string, commandId: string, args?: string | Record<string, unknown> | null) => {
    await assertSessionWorkspace(sessionManager, ctx.workspaceId, sessionId)
    const serializedArgs = serializeExtensionCommandArgs(args)
    return sessionManager.invokeExtensionCommand(sessionId, commandId, serializedArgs)
  })

  // 查询当前会话已注册的 Pi 扩展 slash commands，用于 renderer slash menu 初始快照
  server.handle(RPC_CHANNELS.extensions.GET_COMMANDS, async (ctx, sessionId: string) => {
    await assertSessionWorkspace(sessionManager, ctx.workspaceId, sessionId)
    return sessionManager.listExtensionCommands(sessionId)
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
    command: import('@craft-agent/shared/protocol').SessionCommand
  ) => {
    await assertSessionWorkspace(sessionManager, ctx.workspaceId, sessionId)
    switch (command.type) {
      case 'flag':
        return sessionManager.flagSession(sessionId)
      case 'unflag':
        return sessionManager.unflagSession(sessionId)
      case 'archive':
        return sessionManager.archiveSession(sessionId)
      case 'unarchive':
        return sessionManager.unarchiveSession(sessionId)
      case 'rename':
        return sessionManager.renameSession(sessionId, command.name)
      case 'setSessionStatus':
        return sessionManager.setSessionStatus(sessionId, command.state)
      case 'markRead':
        return sessionManager.markSessionRead(sessionId)
      case 'markUnread':
        return sessionManager.markSessionUnread(sessionId)
      case 'setActiveViewing':
        // Track which session user is actively viewing (for unread state machine)
        return sessionManager.setActiveViewingSession(sessionId, command.workspaceId)
      case 'setPermissionMode':
        return sessionManager.setSessionPermissionMode(sessionId, command.mode)
      case 'setThinkingLevel':
        // Validate thinking level before passing to session manager
        if (!isValidThinkingLevel(command.level)) {
          throw new Error(`Invalid thinking level: ${command.level}. Valid values: ${VALID_THINKING_LEVELS_LIST}`)
        }
        return sessionManager.setSessionThinkingLevel(sessionId, command.level)
      case 'updateWorkingDirectory':
        return sessionManager.updateWorkingDirectory(sessionId, command.dir)
      case 'setSources':
        return sessionManager.setSessionSources(sessionId, command.sourceSlugs)
      case 'setLabels':
        return sessionManager.setSessionLabels(sessionId, command.labels)
      case 'showInFinder': {
        const sessionPath = resolveSessionDisplayPath(sessionManager, sessionId, resolveWorkspaceRootPath(deps, ctx))
        if (sessionPath) {
          deps.platform.showItemInFolder?.(sessionPath)
        }
        return
      }
      case 'copyPath': {
        // Return the session folder path for copying to clipboard
        const sessionPath = resolveSessionDisplayPath(sessionManager, sessionId, resolveWorkspaceRootPath(deps, ctx))
        return sessionPath ? { success: true, path: sessionPath } : { success: false }
      }
      case 'shareToViewer':
        return sessionManager.shareToViewer(sessionId)
      case 'updateShare':
        return sessionManager.updateShare(sessionId)
      case 'revokeShare':
        return sessionManager.revokeShare(sessionId)
      case 'refreshTitle':
        log.info(`IPC: refreshTitle received for session ${sessionId}`)
        return sessionManager.refreshTitle(sessionId)
      // Connection selection
      case 'setConnection':
        log.info(`IPC: setConnection received for session ${sessionId}, connection: ${command.connectionSlug}`)
        return sessionManager.setSessionConnection(sessionId, command.connectionSlug)
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

  // Get authoritative permission mode diagnostics for renderer reconciliation
  server.handle(RPC_CHANNELS.sessions.GET_PERMISSION_MODE_STATE, async (
    ctx,
    sessionId: string
  ) => {
    await assertSessionWorkspace(sessionManager, ctx.workspaceId, sessionId)
    return sessionManager.getSessionPermissionModeState(sessionId)
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

    const { searchSessions } = await import('@craft-agent/server-core/services')
    const workspaceSessions = sessionManager.getSessions(wid)
    const searchRoots = collectSessionSearchRoots(workspace.rootPath, workspaceSessions)
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

  // Get session notes (reads notes.md from session directory)
  server.handle(RPC_CHANNELS.sessions.GET_NOTES, async (ctx, sessionId: string) => {
    await assertSessionWorkspace(sessionManager, ctx.workspaceId, sessionId)
    const sessionPath = resolveSessionDirectory(sessionManager, sessionId, resolveWorkspaceRootPath(deps, ctx))
    if (!sessionPath) return ''

    try {
      const notesPath = join(sessionPath, 'notes.md')
      const content = await readFile(notesPath, 'utf-8')
      return content
    } catch {
      // File doesn't exist yet - return empty string
      return ''
    }
  })

  // Set session notes (writes to notes.md in session directory)
  server.handle(RPC_CHANNELS.sessions.SET_NOTES, async (ctx, sessionId: string, content: string) => {
    await assertSessionWorkspace(sessionManager, ctx.workspaceId, sessionId)

    const sessionPath = resolveSessionDirectory(sessionManager, sessionId, resolveWorkspaceRootPath(deps, ctx))
    if (!sessionPath) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    try {
      const notesPath = join(sessionPath, 'notes.md')
      await writeFile(notesPath, content, 'utf-8')
    } catch (error) {
      log.error('Failed to save session notes:', error)
      throw error
    }
  })

  // ============================================
  // Export / Import / Dispatch
  // ============================================

  // Export a session as a portable bundle
  server.handle(RPC_CHANNELS.sessions.EXPORT, async (ctx, sessionId: string) => {
    await sessionManager.waitForInit()
    const workspaceId = ctx.workspaceId ?? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId!)
    if (!workspaceId) throw new Error('No workspace context')

    const bundle = await sessionManager.exportSession(sessionId, workspaceId)
    if (!bundle) throw new Error(`Failed to export session ${sessionId}`)
    return bundle
  })

  // Import a session bundle into a target workspace
  // targetWorkspaceId is passed explicitly (not from context) so the renderer
  // can import into any workspace the server manages, not just the active one.
  const importHandler = async (_ctx: any, targetWorkspaceId: string, bundle: unknown, mode: string) => {
    await sessionManager.waitForInit()
    if (!targetWorkspaceId || typeof targetWorkspaceId !== 'string') throw new Error('targetWorkspaceId is required')
    if (mode !== 'move' && mode !== 'fork') throw new Error(`Invalid dispatch mode: ${mode}`)

    return sessionManager.importSession(targetWorkspaceId, bundle as import('@craft-agent/shared/sessions').SessionBundle, mode)
  }
  server.handle(RPC_CHANNELS.sessions.IMPORT, importHandler)
  // Also register as transferable so chunked transfer can invoke it on commit
  setTransferableHandler(RPC_CHANNELS.sessions.IMPORT, importHandler)

  // Export a session as a summarized remote-transfer payload.
  server.handle(RPC_CHANNELS.sessions.EXPORT_REMOTE_TRANSFER, async (ctx, sessionId: string) => {
    await sessionManager.waitForInit()
    const workspaceId = ctx.workspaceId ?? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId!)
    if (!workspaceId) throw new Error('No workspace context')

    const payload = await sessionManager.exportRemoteSessionTransfer(sessionId, workspaceId)
    if (!payload) throw new Error(`Failed to export remote transfer for session ${sessionId}`)
    return payload
  })

  // Import a summarized remote-transfer payload into a target workspace.
  server.handle(RPC_CHANNELS.sessions.IMPORT_REMOTE_TRANSFER, async (_ctx, targetWorkspaceId: string, payload: import('@craft-agent/shared/protocol').RemoteSessionTransferPayload) => {
    await sessionManager.waitForInit()
    if (!targetWorkspaceId || typeof targetWorkspaceId !== 'string') throw new Error('targetWorkspaceId is required')
    return sessionManager.importRemoteSessionTransfer(targetWorkspaceId, payload)
  })
}
