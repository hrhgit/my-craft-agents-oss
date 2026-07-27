import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { copyFile, link, lstat, open, realpath, stat, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import {
  parseWorkspacePathRefV1,
  type WorkspacePathRefV1,
} from '@mortise/shared/protocol'
import {
  readWorkspaceMarker,
  WorkspaceTopologyError,
  type WorkspaceTopologyStore,
} from '@mortise/shared/workspaces'
import { WORKSPACE_TOPOLOGY_ERROR_CODES } from '@mortise/shared/protocol'

export interface WorkspaceLocalTransferRequest {
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

    const temporary = await open(temporaryPath, 'r+')
    try {
      await temporary.sync()
    } finally {
      await temporary.close()
    }
    requireRevision(store, workspace.id, request.expectedRevision)
    await link(temporaryPath, destination.absolutePath)
    published = true
    await unlink(temporaryPath)

    let sourceRemoved = false
    if (request.mode === 'move') {
      try {
        requireRevision(store, workspace.id, request.expectedRevision)
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
        await unlink(source.absolutePath)
        sourceRemoved = true
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
    if (!published) await unlink(temporaryPath).catch(() => {})
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
