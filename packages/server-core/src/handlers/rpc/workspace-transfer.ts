import { createHash, randomUUID, type Hash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { constants, createReadStream } from 'node:fs'
import { access as accessPath, copyFile, link, lstat, open, readFile, readdir, realpath, rename, stat, unlink, utimes, type FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import {
  parseWorkspacePathRefV1,
  parseWorkspaceTransferRequestV1,
  parseWorkspaceTransferResultV1,
  CLIENT_WORKSPACE_EXECUTE_TRANSFER,
  parseWorkspaceTransferEndpointAbortV1,
  parseWorkspaceTransferEndpointAccessV1,
  parseWorkspaceTransferEndpointCommitV1,
  parseWorkspaceTransferEndpointCompleteV1,
  parseWorkspaceTransferEndpointOpenV1,
  parseWorkspaceTransferEndpointImportOpenV1,
  parseWorkspaceTransferEndpointReadV1,
  parseWorkspaceTransferEndpointWriteV1,
  parseWorkspaceTransferEndpointCleanupV1,
  parseWorkspaceTransferEndpointImportCleanupV1,
  RPC_CHANNELS,
  type WorkspacePathRefV1,
  type WorkspaceTransferRequestV1,
  type WorkspaceTransferResultV1,
  type WorkspaceTransferJournalV2,
} from '@mortise/shared/protocol'
import {
  getDefaultWorkspaceTopologyStore,
  readWorkspaceMarker,
  WorkspaceTopologyError,
  type WorkspaceTopologyStore,
} from '@mortise/shared/workspaces'
import { WORKSPACE_TOPOLOGY_ERROR_CODES } from '@mortise/shared/protocol'
import type { RpcServer } from '../../transport'
import type { OperationCoordinator } from '../../operations'

export const WORKSPACE_TRANSFER_HANDLED_CHANNELS = [
  RPC_CHANNELS.workspaces.TRANSFER,
  RPC_CHANNELS.workspaces.TRANSFER_JOURNAL_GET,
  RPC_CHANNELS.workspaces.TRANSFER_JOURNAL_PREPARE,
  RPC_CHANNELS.workspaces.TRANSFER_JOURNAL_PUBLISHED,
  RPC_CHANNELS.workspaces.TRANSFER_JOURNAL_SOURCE_RESOLVED,
  RPC_CHANNELS.workspaces.TRANSFER_JOURNAL_ABORT,
  RPC_CHANNELS.workspaces.TRANSFER_JOURNAL_CLEANUP_COMPLETE,
  RPC_CHANNELS.workspaces.TRANSFER_JOURNAL_LIST_PENDING_CLEANUP,
  RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_ACCESS,
  RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_EXPORT_OPEN,
  RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_EXPORT_READ,
  RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_EXPORT_COMPLETE,
  RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_EXPORT_CLEANUP,
  RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_IMPORT_OPEN,
  RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_IMPORT_WRITE,
  RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_IMPORT_COMMIT,
  RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_IMPORT_CLEANUP,
  RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_ABORT,
  RPC_CHANNELS.workspaces.TRANSFER_RECEIPT_GET,
  RPC_CHANNELS.workspaces.TRANSFER_RECEIPT_RECORD,
] as const

export function registerWorkspaceTransferHandlers(
  server: RpcServer,
  store: WorkspaceTopologyStore = getDefaultWorkspaceTopologyStore(),
  options: { endpointSessionTtlMs?: number; operationCoordinator?: OperationCoordinator } = {},
): void {
  const endpointSessionTtlMs = options.endpointSessionTtlMs ?? 5 * 60_000
  if (!Number.isFinite(endpointSessionTtlMs) || endpointSessionTtlMs <= 0) {
    throw new Error('Workspace transfer endpoint session TTL must be positive')
  }
  const inFlight = new Map<string, {
    request: WorkspaceTransferRequestV1
    result: Promise<WorkspaceTransferResultV1>
  }>()
  const exports = new Map<string, ExportSession>()
  const imports = new Map<string, ImportSession>()
  const sourceCompletions = new Map<string, Promise<SourceRemovalOutcome>>()

  server.handle(RPC_CHANNELS.workspaces.TRANSFER, async (ctx, requestValue: unknown) => {
    const request = parseWorkspaceTransferRequestV1(requestValue)
    if (ctx.workspaceId && ctx.workspaceId !== request.workspaceId) {
      throw new Error(
        `Workspace mismatch: authenticated workspace (${ctx.workspaceId}) does not match requested (${request.workspaceId})`,
      )
    }
    const executeTransfer = async (): Promise<WorkspaceTransferResultV1> => {
    const replay = store.getTransferResult(request)
    if (replay) {
      const completed = store.getTransferJournal(request)
      if (completed?.phase === 'completed' && completed.cleanupPending) {
        try {
          await cleanupTransferClaims(store, request, replay)
          store.markTransferCleanupComplete(request)
        } catch {}
      }
      return replay
    }
    const journal = store.getTransferJournal(request)
    if (journal) {
      const recovered = await reconcileLocalTransferJournal(store, request, journal)
      if (recovered) return recovered
    }

    const key = `${request.workspaceId}\0${request.operationId}`
    const running = inFlight.get(key)
    if (running) {
      if (!isDeepStrictEqual(running.request, request)) {
        throw new Error(`operationId was already used for a different Workspace transfer: ${request.operationId}`)
      }
      return running.result.then(result => ({ ...result, status: 'duplicate' as const }))
    }

    const result = (async (): Promise<WorkspaceTransferResultV1> => {
      const transferred = await transferWorkspaceFile(store, request)
      store.markTransferSourceResolved(request, transferred.sourceRemoved, transferred.sourceConflict)
      if (transferred.sourceConflict) throw new Error('Workspace transfer source resolution conflicted')
      const recorded = store.recordTransferResult(request, {
        schemaVersion: 1,
        operationId: request.operationId,
        status: 'applied',
        ...transferred,
      })
      try {
        await cleanupTransferClaims(store, request, recorded)
        store.markTransferCleanupComplete(request)
      } catch {}
      return recorded
    })()
    inFlight.set(key, { request, result })
    try {
      return await result
    } finally {
      if (inFlight.get(key)?.result === result) inFlight.delete(key)
    }
    }
    if (!options.operationCoordinator) return executeTransfer()
    return options.operationCoordinator.start(
      request.operationId,
      'workspace.transfer',
      { workspaceId: request.workspaceId, transferId: request.operationId },
      async () => {
        const result = server.hasClientCapability(ctx.clientId, CLIENT_WORKSPACE_EXECUTE_TRANSFER)
          ? await (server.invokeClientWithOptions
              ? server.invokeClientWithOptions(ctx.clientId, CLIENT_WORKSPACE_EXECUTE_TRANSFER, [request], { timeoutMs: null })
              : server.invokeClient(ctx.clientId, CLIENT_WORKSPACE_EXECUTE_TRANSFER, request))
          : await executeTransfer()
        if (result && typeof result === 'object' && 'status' in result && result.status === 'failed') {
          throw new Error('Workspace transfer execution failed')
        }
        return { resultRef: `workspace-transfer:${request.operationId}` }
      },
    )
  })

  server.handle(RPC_CHANNELS.workspaces.TRANSFER_RECEIPT_GET, async (ctx, requestValue: unknown) => {
    const request = parseWorkspaceTransferRequestV1(requestValue)
    assertAuthenticatedWorkspace(ctx.workspaceId, request.workspaceId)
    return store.getTransferResult(request)
  })

  server.handle(RPC_CHANNELS.workspaces.TRANSFER_JOURNAL_GET, async (ctx, requestValue: unknown) => {
    const request = parseWorkspaceTransferRequestV1(requestValue)
    assertAuthenticatedWorkspace(ctx.workspaceId, request.workspaceId)
    return store.getTransferJournal(request)
  })

  server.handle(RPC_CHANNELS.workspaces.TRANSFER_JOURNAL_PREPARE, async (ctx, requestValue: unknown, manifestValue: unknown) => {
    const request = parseWorkspaceTransferRequestV1(requestValue)
    assertAuthenticatedWorkspace(ctx.workspaceId, request.workspaceId)
    return store.prepareTransfer(request, manifestValue as { bytes: number; sha256: string })
  })

  server.handle(RPC_CHANNELS.workspaces.TRANSFER_JOURNAL_PUBLISHED, async (ctx, requestValue: unknown, cleanupValue: unknown) => {
    const request = parseWorkspaceTransferRequestV1(requestValue)
    assertAuthenticatedWorkspace(ctx.workspaceId, request.workspaceId)
    return store.markTransferDestinationPublished(request, parseOptionalCleanupToken(cleanupValue, 'destination'))
  })

  server.handle(RPC_CHANNELS.workspaces.TRANSFER_JOURNAL_SOURCE_RESOLVED, async (ctx, requestValue: unknown, outcomeValue: unknown) => {
    const request = parseWorkspaceTransferRequestV1(requestValue)
    assertAuthenticatedWorkspace(ctx.workspaceId, request.workspaceId)
    const outcome = parseSourceResolution(outcomeValue)
    return store.markTransferSourceResolved(
      request,
      outcome.sourceRemoved,
      outcome.sourceConflict,
      parseOptionalCleanupToken((outcomeValue as { sourceCleanupToken?: unknown })?.sourceCleanupToken, 'source'),
    )
  })

  server.handle(RPC_CHANNELS.workspaces.TRANSFER_JOURNAL_ABORT, async (ctx, requestValue: unknown) => {
    const request = parseWorkspaceTransferRequestV1(requestValue)
    assertAuthenticatedWorkspace(ctx.workspaceId, request.workspaceId)
    return store.abortTransfer(request)
  })

  server.handle(RPC_CHANNELS.workspaces.TRANSFER_JOURNAL_CLEANUP_COMPLETE, async (ctx, requestValue: unknown) => {
    const request = parseWorkspaceTransferRequestV1(requestValue)
    assertAuthenticatedWorkspace(ctx.workspaceId, request.workspaceId)
    return store.markTransferCleanupComplete(request)
  })

  server.handle(RPC_CHANNELS.workspaces.TRANSFER_JOURNAL_LIST_PENDING_CLEANUP, async (ctx, workspaceIdValue: unknown) => {
    if (typeof workspaceIdValue !== 'string') throw new Error('Workspace id is invalid')
    assertAuthenticatedWorkspace(ctx.workspaceId, workspaceIdValue)
    return store.listPendingTransferCleanup(workspaceIdValue)
  })

  server.handle(RPC_CHANNELS.workspaces.TRANSFER_RECEIPT_RECORD, async (ctx, requestValue: unknown, resultValue: unknown, cleanupValue: unknown) => {
    const request = parseWorkspaceTransferRequestV1(requestValue)
    const result = parseWorkspaceTransferResultV1(resultValue)
    assertAuthenticatedWorkspace(ctx.workspaceId, request.workspaceId)
    if (result.operationId !== request.operationId || result.workspaceId !== request.workspaceId) {
      throw new Error('Workspace transfer receipt does not match its request')
    }
    return store.recordTransferResult(request, { ...result, status: 'applied' }, parseTransferCleanupTokens(cleanupValue))
  })

  server.handle(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_ACCESS, async (ctx, value: unknown) => {
    const request = parseWorkspaceTransferEndpointAccessV1(value)
    assertAuthenticatedWorkspace(ctx.workspaceId, request.workspaceId)
    const resolved = await resolveEndpointPath(store, request.workspaceId, request.locationId, '', 'destination')
    await accessPath(resolved.rootPath, constants.R_OK)
    let write = true
    try { await accessPath(resolved.rootPath, constants.W_OK) } catch { write = false }
    return { schemaVersion: 1, operationId: request.operationId, availability: 'available', permissions: { read: true, write } }
  })

  server.handle(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_EXPORT_OPEN, async (ctx, value: unknown) => {
    const request = parseWorkspaceTransferEndpointOpenV1(value)
    assertAuthenticatedWorkspace(ctx.workspaceId, request.workspaceId)
    const key = endpointKey(ctx.clientId, request.operationId)
    if (exports.has(key)) throw new Error('Workspace transfer endpoint operation already exists')
    let resolved: ResolvedTransferPath
    try {
      resolved = await resolveEndpointPath(store, request.workspaceId, request.locationId, request.relativePath, 'source')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const candidate = await resolveEndpointPath(store, request.workspaceId, request.locationId, request.relativePath, 'destination')
      const metadataPath = sourceRemovalMetadataPath(candidate.absolutePath, request.operationId)
      const metadata = await readTransferClaim(metadataPath) as SourceRemovalClaim | null
      const found = await findSourceRemovalClaim(candidate.absolutePath, request.operationId)
      if (!found) throw error
      const cleanupToken = metadata?.cleanupToken ?? found.cleanupToken
      if (cleanupToken !== found.cleanupToken) throw new Error('Workspace transfer source quarantine metadata is inconsistent')
      const claimPath = found.path
      const removed = await stat(claimPath)
      if (!removed.isFile() || (metadata && metadata.operationId !== request.operationId)) throw error
      return {
        schemaVersion: 1,
        operationId: request.operationId,
        status: metadata?.sourceConflict ? 'source-conflict' : 'already-removed',
        bytes: removed.size,
        sha256: await sha256File(claimPath),
        cleanupToken,
        ...(metadata?.sourceConflict ? { sourceConflict: metadata.sourceConflict } : {}),
      }
    }
    const before = await stat(resolved.absolutePath)
    if (!before.isFile()) throw new Error('Workspace transfer source must be a file')
    if (await findSourceRemovalClaim(resolved.absolutePath, request.operationId)) throw new Error('Workspace transfer source quarantine conflicts with a replacement source')
    const sha256 = await sha256File(resolved.absolutePath)
    const handle = await open(resolved.absolutePath, 'r')
    const cleanupToken = randomUUID()
    const session: ExportSession = { handle, path: resolved.absolutePath, size: before.size, mtimeMs: before.mtimeMs, sha256, cleanupToken }
    exports.set(key, session)
    armExportExpiration(exports, key, session, endpointSessionTtlMs)
    return { schemaVersion: 1, operationId: request.operationId, status: 'opened', bytes: before.size, sha256, cleanupToken }
  })

  server.handle(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_EXPORT_READ, async (ctx, value: unknown) => {
    const request = parseWorkspaceTransferEndpointReadV1(value)
    const key = endpointKey(ctx.clientId, request.operationId)
    const session = requireEndpointSession(exports, key)
    clearSessionExpiration(session)
    try {
      if (request.offset < 0 || request.offset > session.size) throw new Error('Workspace transfer read offset is invalid')
      const length = Math.min(request.maxBytes, session.size - request.offset)
      const bytes = new Uint8Array(length)
      const read = length ? await session.handle.read(bytes, 0, length, request.offset) : { bytesRead: 0 }
      return { schemaVersion: 1, operationId: request.operationId, offset: request.offset, bytes: bytes.subarray(0, read.bytesRead), done: request.offset + read.bytesRead >= session.size }
    } finally {
      if (exports.get(key) === session) armExportExpiration(exports, key, session, endpointSessionTtlMs)
    }
  })

  server.handle(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_EXPORT_COMPLETE, async (ctx, value: unknown) => {
    const request = parseWorkspaceTransferEndpointCompleteV1(value)
    const key = endpointKey(ctx.clientId, request.operationId)
    const session = requireEndpointSession(exports, key)
    clearSessionExpiration(session)
    let outcome: SourceRemovalOutcome = { sourceRemoved: false }
    try {
      if (request.removeIfUnchanged) {
        const completionKey = `${ctx.workspaceId ?? 'host'}\0${request.operationId}`
        const running = sourceCompletions.get(completionKey)
        if (running) {
          outcome = await running
        } else {
          const completion = removeSourcePathIfUnchanged(session, request.operationId)
          sourceCompletions.set(completionKey, completion)
          try {
            outcome = await completion
          } finally {
            if (sourceCompletions.get(completionKey) === completion) sourceCompletions.delete(completionKey)
          }
        }
      }
      return { schemaVersion: 1, operationId: request.operationId, ...outcome }
    } finally {
      exports.delete(key)
      await session.handle.close().catch(() => {})
    }
  })

  server.handle(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_EXPORT_CLEANUP, async (ctx, value: unknown) => {
    const request = parseWorkspaceTransferEndpointCleanupV1(value)
    assertAuthenticatedWorkspace(ctx.workspaceId, request.workspaceId)
    const candidate = await resolveEndpointPath(store, request.workspaceId, request.locationId, request.relativePath, 'destination')
    const metadataPath = sourceRemovalMetadataPath(candidate.absolutePath, request.operationId)
    const claim = await readTransferClaim(metadataPath)
    if (claim && (claim as { cleanupToken?: string }).cleanupToken !== request.cleanupToken) throw new Error('Workspace transfer cleanup token is invalid')
    const found = await findSourceRemovalClaim(candidate.absolutePath, request.operationId)
    if (found && found.cleanupToken !== request.cleanupToken) throw new Error('Workspace transfer cleanup token is invalid')
    const claimPath = found?.path ?? sourceRemovalClaimPath(candidate.absolutePath, request.operationId, request.cleanupToken)
    await unlink(claimPath).catch(() => {})
    await unlink(metadataPath).catch(() => {})
    return { schemaVersion: 1, operationId: request.operationId }
  })

  server.handle(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_IMPORT_OPEN, async (ctx, value: unknown) => {
    const request = parseWorkspaceTransferEndpointImportOpenV1(value)
    assertAuthenticatedWorkspace(ctx.workspaceId, request.workspaceId)
    const key = endpointKey(ctx.clientId, request.operationId)
    if (imports.has(key)) throw new Error('Workspace transfer endpoint operation already exists')
    const resolved = await resolveEndpointPath(store, request.workspaceId, request.locationId, request.relativePath, 'destination')
    const parent = await realpath(dirname(resolved.absolutePath))
    assertInsideRoot(resolved.rootPath, parent)
    const claimPath = join(parent, `.mortise-transfer-${transferOperationKey(request.operationId)}.claim`)
    const operationKey = transferOperationKey(request.operationId)
    const temporaryPath = join(parent, `.mortise-transfer-${operationKey}-${randomUUID()}.tmp`)
    const cleanupToken = randomUUID()
    const claim = { schemaVersion: 1, operationId: request.operationId, workspaceId: request.workspaceId, locationId: resolved.locationId, relativePath: resolved.relativePath, bytes: request.expectedBytes, sha256: request.expectedSha256, temporaryPath, cleanupToken }
    let existingClaim = await readTransferClaim(claimPath)
    if (existingClaim) {
      if (!sameTransferClaim(existingClaim, claim)) throw new Error(`Workspace transfer claim conflicts with operation ${request.operationId}`)
      const destinationStatus = await inspectDestination(resolved.absolutePath, request.expectedBytes, request.expectedSha256)
      if (destinationStatus === 'match') {
        return { schemaVersion: 1, operationId: request.operationId, status: 'already-published', cleanupToken: String((existingClaim as { cleanupToken?: string }).cleanupToken) }
      }
      if (destinationStatus === 'mismatch') throw new Error('Workspace transfer destination conflicts with its durable claim')
      const previousTemporaryPath = parseImportClaimTemporaryPath(
        parent,
        request.operationId,
        (existingClaim as { temporaryPath?: unknown }).temporaryPath,
      )
      if (previousTemporaryPath) {
        const claimInfo = await stat(claimPath)
        if (Date.now() - claimInfo.mtimeMs <= endpointSessionTtlMs) throw new Error('Workspace transfer endpoint operation is already staging this destination')
        const stalePath = `${claimPath}.${randomUUID()}.stale`
        await rename(claimPath, stalePath)
        const staleClaim = await readTransferClaim(stalePath)
        if (!isDeepStrictEqual(staleClaim, existingClaim)) throw new Error('Workspace transfer claim changed during stale recovery')
        await unlink(previousTemporaryPath).catch(() => {})
        await unlink(stalePath).catch(() => {})
        existingClaim = null
      } else {
        throw new Error('Workspace transfer claim is missing its staging identity')
      }
      if (!existingClaim) {
        await writeTransferClaim(claimPath, claim, true)
      } else {
        await writeTransferClaim(claimPath, claim)
      }
    } else {
      await assertMissing(resolved.absolutePath)
      const claimHandle = await open(claimPath, 'wx')
      try {
        await claimHandle.writeFile(JSON.stringify(claim))
        await claimHandle.sync()
      } finally {
        await claimHandle.close()
      }
    }
    const handle = await open(temporaryPath, 'wx+')
    const session: ImportSession = { handle, temporaryPath, claimPath, destinationPath: resolved.absolutePath, offset: 0, hash: createHash('sha256'), cleanupToken }
    imports.set(key, session)
    armImportExpiration(imports, key, session, endpointSessionTtlMs)
    return { schemaVersion: 1, operationId: request.operationId, status: 'opened', cleanupToken }
  })

  server.handle(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_IMPORT_WRITE, async (ctx, value: unknown) => {
    const request = parseWorkspaceTransferEndpointWriteV1(value)
    const key = endpointKey(ctx.clientId, request.operationId)
    const session = requireEndpointSession(imports, key)
    clearSessionExpiration(session)
    try {
      await assertImportClaimOwned(session)
      if (request.offset !== session.offset) throw new Error('Workspace transfer chunks must be written sequentially')
      if (request.bytes.byteLength) await session.handle.write(request.bytes, 0, request.bytes.byteLength, request.offset)
      session.hash.update(request.bytes)
      session.offset += request.bytes.byteLength
      await utimes(session.claimPath, new Date(), new Date())
      return { schemaVersion: 1, operationId: request.operationId, offset: session.offset }
    } finally {
      if (imports.get(key) === session) armImportExpiration(imports, key, session, endpointSessionTtlMs)
    }
  })

  server.handle(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_IMPORT_COMMIT, async (ctx, value: unknown) => {
    const request = parseWorkspaceTransferEndpointCommitV1(value)
    const key = endpointKey(ctx.clientId, request.operationId)
    const session = requireEndpointSession(imports, key)
    clearSessionExpiration(session)
    let published = false
    try {
      await assertImportClaimOwned(session)
      const digest = session.hash.digest('hex')
      if (session.offset !== request.bytes || digest !== request.sha256) throw new Error('Workspace transfer staged content does not match the expected size and checksum')
      await session.handle.sync()
      await session.handle.close()
      const stagedInfo = await stat(session.temporaryPath)
      if (stagedInfo.size !== request.bytes || await sha256File(session.temporaryPath) !== request.sha256) throw new Error('Workspace transfer staged file changed before publication')
      await assertImportClaimOwned(session)
      await link(session.temporaryPath, session.destinationPath)
      published = true
      await unlink(session.temporaryPath).catch(() => {})
      return { schemaVersion: 1, operationId: request.operationId, bytes: request.bytes, sha256: digest, cleanupToken: session.cleanupToken }
    } finally {
      imports.delete(key)
      if (!published) {
        await session.handle.close().catch(() => {})
        await unlink(session.temporaryPath).catch(() => {})
        await unlinkImportClaimIfOwned(session)
      }
    }
  })

  server.handle(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_IMPORT_CLEANUP, async (ctx, value: unknown) => {
    const request = parseWorkspaceTransferEndpointImportCleanupV1(value)
    assertAuthenticatedWorkspace(ctx.workspaceId, request.workspaceId)
    const resolved = await resolveEndpointPath(store, request.workspaceId, request.locationId, request.relativePath, 'destination')
    const parent = await realpath(dirname(resolved.absolutePath))
    const operationKey = transferOperationKey(request.operationId)
    const claimPath = join(parent, `.mortise-transfer-${operationKey}.claim`)
    const claim = await readTransferClaim(claimPath)
    if (claim && (claim as { cleanupToken?: string }).cleanupToken !== request.cleanupToken) throw new Error('Workspace transfer cleanup token is invalid')
    const temporaryPath = claim
      ? parseImportClaimTemporaryPath(parent, request.operationId, (claim as { temporaryPath?: unknown }).temporaryPath)
      : undefined
    await unlink(claimPath).catch(() => {})
    if (temporaryPath) await unlink(temporaryPath).catch(() => {})
    return { schemaVersion: 1, operationId: request.operationId }
  })

  server.handle(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_ABORT, async (ctx, value: unknown) => {
    const request = parseWorkspaceTransferEndpointAbortV1(value)
    const key = endpointKey(ctx.clientId, request.operationId)
    const exportSession = exports.get(key)
    const importSession = imports.get(key)
    exports.delete(key)
    imports.delete(key)
    if (exportSession) clearSessionExpiration(exportSession)
    if (importSession) clearSessionExpiration(importSession)
    await exportSession?.handle.close().catch(() => {})
    if (importSession) {
      await importSession.handle.close().catch(() => {})
      await unlink(importSession.temporaryPath).catch(() => {})
      await unlinkImportClaimIfOwned(importSession)
    }
  })
}

interface ExpiringEndpointSession { expiration?: ReturnType<typeof setTimeout> }
interface ExportSession extends ExpiringEndpointSession { handle: FileHandle; path: string; size: number; mtimeMs: number; sha256: string; cleanupToken: string }
interface ImportSession extends ExpiringEndpointSession { handle: FileHandle; temporaryPath: string; claimPath: string; destinationPath: string; offset: number; hash: Hash; cleanupToken: string }
async function unlinkImportClaimIfOwned(session: Pick<ImportSession, 'claimPath' | 'cleanupToken'>): Promise<void> {
  const claim = await readTransferClaim(session.claimPath)
  if ((claim as { cleanupToken?: string } | null)?.cleanupToken === session.cleanupToken) {
    await unlink(session.claimPath).catch(() => {})
  }
}
async function assertImportClaimOwned(session: Pick<ImportSession, 'claimPath' | 'cleanupToken' | 'temporaryPath'>): Promise<void> {
  const claim = await readTransferClaim(session.claimPath) as { cleanupToken?: unknown; temporaryPath?: unknown } | null
  if (claim?.cleanupToken !== session.cleanupToken || claim.temporaryPath !== session.temporaryPath) {
    throw new Error('Workspace transfer import attempt no longer owns its durable claim')
  }
}

function endpointKey(clientId: string, operationId: string): string { return `${clientId}\0${operationId}` }
function requireEndpointSession<T>(sessions: Map<string, T>, key: string): T {
  const session = sessions.get(key)
  if (!session) throw new Error('Workspace transfer endpoint operation is not open')
  return session
}
function clearSessionExpiration(session: ExpiringEndpointSession): void {
  if (session.expiration) clearTimeout(session.expiration)
  session.expiration = undefined
}
function armExportExpiration(
  sessions: Map<string, ExportSession>,
  key: string,
  session: ExportSession,
  ttlMs: number,
): void {
  clearSessionExpiration(session)
  session.expiration = setTimeout(() => {
    if (sessions.get(key) !== session) return
    sessions.delete(key)
    void session.handle.close().catch(() => {})
  }, ttlMs)
  session.expiration.unref?.()
}
function armImportExpiration(
  sessions: Map<string, ImportSession>,
  key: string,
  session: ImportSession,
  ttlMs: number,
): void {
  clearSessionExpiration(session)
  session.expiration = setTimeout(() => {
    if (sessions.get(key) !== session) return
    sessions.delete(key)
    void (async () => {
      await session.handle.close().catch(() => {})
      await unlink(session.temporaryPath).catch(() => {})
      await unlinkImportClaimIfOwned(session)
    })()
  }, ttlMs)
  session.expiration.unref?.()
}
async function removeSourcePathIfUnchanged(
  session: Pick<ExportSession, 'path' | 'size' | 'mtimeMs' | 'sha256' | 'cleanupToken'>,
  operationId: string,
): Promise<SourceRemovalOutcome> {
  const claimPath = sourceRemovalClaimPath(session.path, operationId, session.cleanupToken)
  const metadataPath = sourceRemovalMetadataPath(session.path, operationId)
  const metadata: SourceRemovalClaim = {
    schemaVersion: 1,
    operationId,
    cleanupToken: session.cleanupToken,
    bytes: session.size,
    sha256: session.sha256,
  }
  try {
    await rename(session.path, claimPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const existing = await findSourceRemovalClaim(session.path, operationId)
      if (existing) {
        const claimed = await stat(existing.path)
        if (claimed.size === session.size && await sha256File(existing.path) === session.sha256) {
          return { sourceRemoved: true, cleanupToken: existing.cleanupToken }
        }
        return { sourceRemoved: false, cleanupToken: existing.cleanupToken, sourceConflict: 'Existing source quarantine does not match the exported content' }
      }
    }
    return { sourceRemoved: false }
  }
  try {
    await writeTransferClaim(metadataPath, metadata, true)
    const claimed = await stat(claimPath)
    if (claimed.size !== session.size || claimed.mtimeMs !== session.mtimeMs || await sha256File(claimPath) !== session.sha256) {
      return await restoreQuarantinedSource(session.path, claimPath, metadataPath, 'source changed during quarantine')
    }
    return { sourceRemoved: true, cleanupToken: session.cleanupToken }
  } catch {
    return await restoreQuarantinedSource(session.path, claimPath, metadataPath, 'source quarantine validation failed')
  }
}

interface SourceRemovalClaim {
  schemaVersion: 1
  operationId: string
  cleanupToken: string
  bytes: number
  sha256: string
  sourceConflict?: string
}

interface SourceRemovalOutcome {
  sourceRemoved: boolean
  cleanupToken?: string
  sourceConflict?: string
}

async function restoreQuarantinedSource(
  sourcePath: string,
  claimPath: string,
  metadataPath: string,
  reason: string,
): Promise<SourceRemovalOutcome> {
  try {
    await link(claimPath, sourcePath)
    await unlink(claimPath)
    await unlink(metadataPath).catch(() => {})
    return { sourceRemoved: false }
  } catch {
    const sourceConflict = `${reason}; quarantine retained because restoring would overwrite another file`
    const metadata = await readTransferClaim(metadataPath) as SourceRemovalClaim | null
    if (metadata) await writeTransferClaim(metadataPath, { ...metadata, sourceConflict })
    return { sourceRemoved: false, ...(metadata?.cleanupToken ? { cleanupToken: metadata.cleanupToken } : {}), sourceConflict }
  }
}
function sourceRemovalClaimPath(sourcePath: string, operationId: string, cleanupToken: string): string {
  const claimName = `${sourceRemovalClaimPrefix(sourcePath, operationId)}${cleanupToken}.tmp`
  return join(dirname(sourcePath), claimName)
}
function sourceRemovalClaimPrefix(sourcePath: string, operationId: string): string {
  return `.${basename(sourcePath)}.mortise-transfer-delete-${transferOperationKey(operationId)}-`
}
async function findSourceRemovalClaim(sourcePath: string, operationId: string): Promise<{ path: string; cleanupToken: string } | null> {
  const prefix = sourceRemovalClaimPrefix(sourcePath, operationId)
  const matches = (await readdir(dirname(sourcePath))).filter(name => name.startsWith(prefix) && name.endsWith('.tmp'))
  if (matches.length > 1) throw new Error('Workspace transfer source has multiple quarantine claims')
  if (matches.length === 0) return null
  const cleanupToken = matches[0]!.slice(prefix.length, -'.tmp'.length)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(cleanupToken)) throw new Error('Workspace transfer source quarantine token is invalid')
  return { path: join(dirname(sourcePath), matches[0]!), cleanupToken }
}
function sourceRemovalMetadataPath(sourcePath: string, operationId: string): string {
  return join(dirname(sourcePath), `.${basename(sourcePath)}.mortise-transfer-delete-${transferOperationKey(operationId)}.json`)
}
function transferOperationKey(operationId: string): string {
  return createHash('sha256').update(operationId).digest('hex').slice(0, 32)
}
function localDestinationClaimPath(parent: string, operationId: string): string {
  return join(parent, `.mortise-transfer-${transferOperationKey(operationId)}.claim`)
}
function createDestinationClaim(request: WorkspaceTransferRequestV1, bytes: number, sha256: string) {
  return {
    schemaVersion: 1, operationId: request.operationId, workspaceId: request.workspaceId,
    locationId: request.destination.locationId, relativePath: request.destination.relativePath, bytes, sha256,
  }
}
function sameDestinationClaim(value: unknown, request: WorkspaceTransferRequestV1, bytes: number, sha256: string): boolean {
  return sameTransferClaim(value, createDestinationClaim(request, bytes, sha256))
}
async function readTransferClaim(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error('Workspace transfer claim is invalid', { cause: error })
  }
}
async function writeTransferClaim(path: string, value: unknown, exclusive = false): Promise<void> {
  const handle = await open(path, exclusive ? 'wx' : 'w')
  try {
    await handle.writeFile(JSON.stringify(value))
    await handle.sync()
  } finally {
    await handle.close()
  }
}
function sameTransferClaim(left: unknown, right: unknown): boolean {
  const fields = ['schemaVersion', 'operationId', 'workspaceId', 'locationId', 'relativePath', 'bytes', 'sha256'] as const
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  return fields.every(field => (left as Record<string, unknown>)[field] === (right as Record<string, unknown>)[field])
}

function parseImportClaimTemporaryPath(parent: string, operationId: string, value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new Error('Workspace transfer claim has an invalid staging path')
  }
  const operationKey = transferOperationKey(operationId)
  const name = basename(value)
  if (
    dirname(value) !== parent
    || relative(parent, value) !== name
    || !new RegExp(`^\\.mortise-transfer-${operationKey}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.tmp$`, 'i').test(name)
  ) {
    throw new Error('Workspace transfer claim has an invalid staging path')
  }
  return value
}
function parseSourceResolution(value: unknown): { sourceRemoved: boolean; sourceConflict?: string } {
  if (!value || typeof value !== 'object' || typeof (value as { sourceRemoved?: unknown }).sourceRemoved !== 'boolean') {
    throw new Error('Workspace transfer source resolution is invalid')
  }
  const sourceConflict = (value as { sourceConflict?: unknown }).sourceConflict
  if (sourceConflict !== undefined && (typeof sourceConflict !== 'string' || !sourceConflict || sourceConflict.length > 1024)) {
    throw new Error('Workspace transfer source conflict is invalid')
  }
  return { sourceRemoved: (value as { sourceRemoved: boolean }).sourceRemoved, ...(sourceConflict ? { sourceConflict } : {}) }
}

function parseOptionalCleanupToken(value: unknown, role: 'source' | 'destination'): string | undefined {
  if (value === undefined) return undefined
  const token = role === 'destination' && value && typeof value === 'object'
    ? (value as { destinationCleanupToken?: unknown }).destinationCleanupToken
    : value
  if (token === undefined) return undefined
  if (typeof token !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)) {
    throw new Error(`Workspace transfer ${role} cleanup token is invalid`)
  }
  return token
}

function parseTransferCleanupTokens(value: unknown): { destinationCleanupToken?: string; sourceCleanupToken?: string } {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Workspace transfer cleanup state is invalid')
  const candidate = value as Record<string, unknown>
  const keys = Object.keys(candidate)
  if (keys.some(key => key !== 'destinationCleanupToken' && key !== 'sourceCleanupToken')) throw new Error('Workspace transfer cleanup state is invalid')
  const isToken = (token: unknown): token is string => typeof token === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)
  if (candidate.destinationCleanupToken !== undefined && !isToken(candidate.destinationCleanupToken)) throw new Error('Workspace transfer destination cleanup token is invalid')
  if (candidate.sourceCleanupToken !== undefined && !isToken(candidate.sourceCleanupToken)) throw new Error('Workspace transfer source cleanup token is invalid')
  return {
    ...(candidate.destinationCleanupToken ? { destinationCleanupToken: candidate.destinationCleanupToken as string } : {}),
    ...(candidate.sourceCleanupToken ? { sourceCleanupToken: candidate.sourceCleanupToken as string } : {}),
  }
}
async function inspectDestination(path: string, bytes: number, sha256: string): Promise<'missing' | 'match' | 'mismatch'> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size !== bytes) return 'mismatch'
    return await sha256File(path) === sha256 ? 'match' : 'mismatch'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw error
  }
}
function assertAuthenticatedWorkspace(authenticated: string | null, requested: string): void {
  if (authenticated && authenticated !== requested) throw new Error(`Workspace mismatch: authenticated workspace (${authenticated}) does not match requested (${requested})`)
}

export interface WorkspaceLocalTransferRequest {
  schemaVersion?: 1
  operationId?: string
  workspaceId?: string
  source: WorkspacePathRefV1
  destination: WorkspacePathRefV1
  expectedRevision: number
  mode: 'copy' | 'move'
  expectedSha256?: string
}

export interface WorkspaceLocalTransferResult {
  workspaceId: string
  sourceLocationId: string
  destinationLocationId: string
  revision: number
  mode: 'copy' | 'move'
  sha256: string
  bytes: number
  sourceRemoved: boolean
  sourceConflict?: string
}

interface ResolvedTransferPath {
  workspaceId: string
  locationId: string
  relativePath: string
  rootPath: string
  absolutePath: string
}

/**
 * Copy or move one local file between explicitly qualified Workspace locations.
 * Remote endpoints require a runtime-owned transfer adapter and are rejected.
 */
export async function transferWorkspaceFile(
  store: WorkspaceTopologyStore,
  requestValue: WorkspaceLocalTransferRequest,
): Promise<WorkspaceLocalTransferResult> {
  const request = validateTransferRequest(requestValue)
  const workspace = requireRevision(store, request.source.workspaceId, request.expectedRevision)
  const source = await resolveTransferPath(store, request.source, 'source')
  const destination = await resolveTransferPath(store, request.destination, 'destination')
  if (source.workspaceId !== destination.workspaceId) {
    throw new Error('A Workspace transfer cannot cross Workspace identities')
  }
  if (source.absolutePath === destination.absolutePath) {
    throw new Error('Transfer source and destination are the same file')
  }

  const sourceStatsBefore = await stat(source.absolutePath)
  if (!sourceStatsBefore.isFile()) throw new Error('Workspace transfer source must be a file')
  await assertMissing(destination.absolutePath)
  const destinationParent = await realpath(dirname(destination.absolutePath))
  assertInsideRoot(destination.rootPath, destinationParent)

  const temporaryPath = join(
    destinationParent,
    `.mortise-transfer-${process.pid}-${randomUUID()}.tmp`,
  )
  let published = false
  let destinationClaimPath: string | null = null
  let destinationClaimOwned = false
  try {
    await copyFile(source.absolutePath, temporaryPath, constants.COPYFILE_EXCL)
    const temporaryStats = await stat(temporaryPath)
    const [sourceSha256, stagedSha256] = await Promise.all([
      sha256File(source.absolutePath),
      sha256File(temporaryPath),
    ])
    const sourceStatsAfter = await stat(source.absolutePath)
    if (
      sourceSha256 !== stagedSha256
      || sourceStatsBefore.size !== sourceStatsAfter.size
      || sourceStatsBefore.mtimeMs !== sourceStatsAfter.mtimeMs
    ) {
      throw new Error('Workspace transfer source changed while it was being copied')
    }
    if (request.expectedSha256 && request.expectedSha256 !== stagedSha256) {
      throw new Error(`Workspace transfer checksum mismatch: expected ${request.expectedSha256}, got ${stagedSha256}`)
    }

    const canonicalRequest = request.schemaVersion === 1 && request.operationId && request.workspaceId
      ? {
          schemaVersion: 1 as const,
          operationId: request.operationId,
          workspaceId: request.workspaceId,
          expectedRevision: request.expectedRevision,
          mode: request.mode,
          source: request.source,
          destination: request.destination,
          ...(request.expectedSha256 === undefined ? {} : { expectedSha256: request.expectedSha256 }),
        }
      : null
    if (canonicalRequest) {
      store.prepareTransfer(canonicalRequest, { bytes: temporaryStats.size, sha256: stagedSha256 })
      destinationClaimPath = localDestinationClaimPath(destinationParent, canonicalRequest.operationId)
      await writeTransferClaim(
        destinationClaimPath,
        createDestinationClaim(canonicalRequest, temporaryStats.size, stagedSha256),
        true,
      )
      destinationClaimOwned = true
    }

    const temporary = await open(temporaryPath, 'r+')
    try {
      await temporary.sync()
    } finally {
      await temporary.close()
    }
    await link(temporaryPath, destination.absolutePath)
    published = true
    await unlink(temporaryPath).catch(() => {})
    if (canonicalRequest) store.markTransferDestinationPublished(canonicalRequest)

    let sourceRemoved = false
    if (request.mode === 'move') {
      try {
        const currentSourceStats = await stat(source.absolutePath)
        const currentSourceSha256 = await sha256File(source.absolutePath)
        if (
          currentSourceSha256 !== stagedSha256
          || currentSourceStats.size !== sourceStatsAfter.size
          || currentSourceStats.mtimeMs !== sourceStatsAfter.mtimeMs
        ) {
          return transferResult(
            workspace.id,
            source.locationId,
            destination.locationId,
            request,
            stagedSha256,
            temporaryStats.size,
            false,
          )
        }
        const removal = await removeSourcePathIfUnchanged({
          path: source.absolutePath,
          size: sourceStatsAfter.size,
          mtimeMs: sourceStatsAfter.mtimeMs,
          sha256: stagedSha256,
          cleanupToken: randomUUID(),
        }, request.operationId ?? randomUUID())
        sourceRemoved = removal.sourceRemoved
        if (removal.sourceConflict) return { ...transferResult(workspace.id, source.locationId, destination.locationId, request, stagedSha256, temporaryStats.size, false), sourceConflict: removal.sourceConflict }
      } catch {
        return transferResult(
          workspace.id,
          source.locationId,
          destination.locationId,
          request,
          stagedSha256,
          temporaryStats.size,
          false,
        )
      }
    }

    return transferResult(
      workspace.id,
      source.locationId,
      destination.locationId,
      request,
      stagedSha256,
      temporaryStats.size,
      sourceRemoved,
    )
  } finally {
    if (!published) {
      await unlink(temporaryPath).catch(() => {})
      if (destinationClaimOwned && destinationClaimPath) await unlink(destinationClaimPath).catch(() => {})
    }
  }
}

function transferResult(
  workspaceId: string,
  sourceLocationId: string,
  destinationLocationId: string,
  request: WorkspaceLocalTransferRequest,
  sha256: string,
  bytes: number,
  sourceRemoved: boolean,
): WorkspaceLocalTransferResult {
  return {
    workspaceId,
    sourceLocationId,
    destinationLocationId,
    revision: request.expectedRevision,
    mode: request.mode,
    sha256,
    bytes,
    sourceRemoved,
  }
}

function validateTransferRequest(value: WorkspaceLocalTransferRequest): WorkspaceLocalTransferRequest {
  if (!value || typeof value !== 'object') throw new Error('Workspace transfer request is required')
  const source = parseWorkspacePathRefV1(value.source)
  const destination = parseWorkspacePathRefV1(value.destination)
  if (!Number.isInteger(value.expectedRevision) || value.expectedRevision < 0) {
    throw new Error('Workspace transfer expectedRevision must be a non-negative integer')
  }
  if (value.mode !== 'copy' && value.mode !== 'move') {
    throw new Error('Workspace transfer mode must be copy or move')
  }
  if (source.workspaceId !== destination.workspaceId) {
    throw new Error('A Workspace transfer cannot cross Workspace identities')
  }
  if (!source.relativePath || !destination.relativePath) {
    throw new Error('Workspace transfer paths must identify files')
  }
  if (isMortisePrivatePath(source.relativePath) || isMortisePrivatePath(destination.relativePath)) {
    throw new Error('Workspace private resources cannot be transferred')
  }
  if (value.expectedSha256 !== undefined && !/^[a-f0-9]{64}$/.test(value.expectedSha256)) {
    throw new Error('Workspace transfer expectedSha256 must be a lowercase SHA-256 digest')
  }
  return { ...value, source, destination }
}

async function resolveTransferPath(
  store: WorkspaceTopologyStore,
  ref: WorkspacePathRefV1,
  role: 'source' | 'destination',
): Promise<ResolvedTransferPath> {
  const workspace = store.get(ref.workspaceId)
  if (!workspace) throw new Error(`Workspace topology not found: ${ref.workspaceId}`)
  const location = workspace.locations.find(candidate => candidate.id === ref.locationId)
  if (!location) throw new Error(`Workspace location not found: ${ref.locationId}`)
  if (location.endpoint.kind !== 'local') {
    throw new Error(`Workspace transfer ${role} location ${ref.locationId} requires a remote transfer adapter`)
  }
  readWorkspaceMarker(location.endpoint.rootPath, workspace.id)
  const rootPath = await realpath(location.endpoint.rootPath)
  const absolutePath = join(rootPath, ...ref.relativePath.split('/'))
  assertInsideRoot(rootPath, absolutePath)
  if (role === 'source') {
    const resolvedSource = await realpath(absolutePath)
    assertInsideRoot(rootPath, resolvedSource)
    return { ...ref, rootPath, absolutePath: resolvedSource }
  }
  return { ...ref, rootPath, absolutePath }
}

async function reconcileLocalTransferJournal(
  store: WorkspaceTopologyStore,
  request: WorkspaceTransferRequestV1,
  journal: WorkspaceTransferJournalV2,
): Promise<WorkspaceTransferResultV1 | null> {
  if (journal.phase === 'aborted') throw new Error(`Workspace transfer was aborted: ${request.operationId}`)
  if (journal.phase === 'source-conflict') throw new Error('Workspace transfer source resolution conflicted')
  const destination = await resolveTransferPath(store, request.destination, 'destination')
  const destinationParent = await realpath(dirname(destination.absolutePath))
  const destinationClaim = await readTransferClaim(localDestinationClaimPath(destinationParent, request.operationId))
  const destinationStatus = await inspectDestination(destination.absolutePath, journal.bytes, journal.sha256)
  if (destinationStatus === 'missing') {
    if (journal.phase === 'prepared') {
      if (destinationClaim) throw new Error('Workspace transfer destination is still being staged')
      return null
    }
    throw new Error('Workspace transfer destination disappeared after publication')
  }
  if (!sameDestinationClaim(destinationClaim, request, journal.bytes, journal.sha256)) {
    throw new Error('Workspace transfer destination lacks its durable publication claim')
  }
  if (destinationStatus === 'mismatch') throw new Error('Workspace transfer destination conflicts with its durable journal')
  if (journal.phase === 'prepared') store.markTransferDestinationPublished(request)

  if (journal.phase === 'source-resolved') {
    const result: WorkspaceTransferResultV1 = {
      schemaVersion: 1,
      operationId: request.operationId,
      status: 'applied',
      workspaceId: request.workspaceId,
      sourceLocationId: request.source.locationId,
      destinationLocationId: request.destination.locationId,
      revision: request.expectedRevision,
      mode: request.mode,
      sha256: journal.sha256,
      bytes: journal.bytes,
      sourceRemoved: journal.phase === 'source-resolved' ? journal.sourceRemoved! : false,
    }
    const recorded = store.recordTransferResult(request, result)
    try {
      await cleanupTransferClaims(store, request, recorded)
      store.markTransferCleanupComplete(request)
    } catch {}
    return recorded
  }

  let sourceRemoved = false
  if (request.mode === 'move') {
    try {
      const source = await resolveTransferPath(store, request.source, 'source')
      const info = await stat(source.absolutePath)
      if (info.isFile() && info.size === journal.bytes && await sha256File(source.absolutePath) === journal.sha256) {
        const removal = await removeSourcePathIfUnchanged({
          path: source.absolutePath,
          size: info.size,
          mtimeMs: info.mtimeMs,
          sha256: journal.sha256,
          cleanupToken: randomUUID(),
        }, request.operationId)
        sourceRemoved = removal.sourceRemoved
        if (removal.sourceConflict) {
          store.markTransferSourceResolved(request, false, removal.sourceConflict, removal.cleanupToken)
          throw new Error('Workspace transfer source resolution conflicted')
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') sourceRemoved = true
      else throw error
    }
  }
  store.markTransferSourceResolved(request, sourceRemoved)
  const result: WorkspaceTransferResultV1 = {
    schemaVersion: 1,
    operationId: request.operationId,
    status: 'applied',
    workspaceId: request.workspaceId,
    sourceLocationId: request.source.locationId,
    destinationLocationId: request.destination.locationId,
    revision: request.expectedRevision,
    mode: request.mode,
    sha256: journal.sha256,
    bytes: journal.bytes,
    sourceRemoved,
  }
  const recorded = store.recordTransferResult(request, result)
  try {
    await cleanupTransferClaims(store, request, recorded)
    store.markTransferCleanupComplete(request)
  } catch {}
  return recorded
}

async function cleanupTransferClaims(
  store: WorkspaceTopologyStore,
  request: WorkspaceTransferRequestV1,
  result: WorkspaceTransferResultV1,
): Promise<void> {
  if (result.sourceRemoved) await cleanupSourceRemovalClaim(store, request)
  const destination = await resolveTransferPath(store, request.destination, 'destination')
  const destinationParent = await realpath(dirname(destination.absolutePath))
  await unlink(localDestinationClaimPath(destinationParent, request.operationId)).catch(() => {})
}

async function cleanupSourceRemovalClaim(
  store: WorkspaceTopologyStore,
  request: WorkspaceTransferRequestV1,
): Promise<void> {
  const source = await resolveTransferPath(store, request.source, 'destination')
  const metadataPath = sourceRemovalMetadataPath(source.absolutePath, request.operationId)
  const found = await findSourceRemovalClaim(source.absolutePath, request.operationId)
  if (found) await unlink(found.path).catch(() => {})
  await unlink(metadataPath).catch(() => {})
}

async function resolveEndpointPath(
  store: WorkspaceTopologyStore,
  workspaceId: string,
  requestedLocationId: string | undefined,
  relativePath: string,
  role: 'source' | 'destination',
): Promise<ResolvedTransferPath> {
  const workspace = store.get(workspaceId)
  if (!workspace) throw new Error(`Workspace topology not found: ${workspaceId}`)
  const locationId = requestedLocationId ?? workspace.primaryLocationId
  return resolveTransferPath(store, parseWorkspacePathRefV1({
    schemaVersion: 1,
    workspaceId,
    locationId,
    relativePath,
  }), role)
}

function requireRevision(store: WorkspaceTopologyStore, workspaceId: string, expectedRevision: number) {
  const workspace = store.get(workspaceId)
  if (!workspace) throw new Error(`Workspace topology not found: ${workspaceId}`)
  if (workspace.revision !== expectedRevision) {
    throw new WorkspaceTopologyError(
      WORKSPACE_TOPOLOGY_ERROR_CODES.STALE_REVISION,
      `Workspace revision is ${workspace.revision}, expected ${expectedRevision}`,
      {
        workspaceId,
        expectedRevision,
        actualRevision: workspace.revision,
        retryable: true,
      },
    )
  }
  return workspace
}

function assertInsideRoot(rootPath: string, candidatePath: string): void {
  const nested = relative(rootPath, candidatePath)
  if (nested === '' || (nested !== '..' && !nested.startsWith(`..${sep}`) && !isAbsolute(nested))) return
  throw new Error('Workspace transfer path escapes its location root')
}

async function assertMissing(path: string): Promise<void> {
  try {
    await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  throw new Error('Workspace transfer destination already exists')
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function isMortisePrivatePath(relativePath: string): boolean {
  return relativePath === '.mortise' || relativePath.startsWith('.mortise/')
}
