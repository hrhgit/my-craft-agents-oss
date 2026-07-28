import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import {
  WORKSPACE_MARKER_KIND,
  WORKSPACE_MARKER_RELATIVE_PATH,
  WORKSPACE_MARKER_SCHEMA_VERSION,
  WORKSPACE_TOPOLOGY_ERROR_CODES,
  parseWorkspaceMarkerV1,
  type WorkspaceMarkerV1,
  type WorkspaceTopologyErrorCode,
  type WorkspaceTopologyErrorDataV1,
} from '../protocol/workspace-topology.ts'

export class WorkspaceTopologyError extends Error {
  readonly code: WorkspaceTopologyErrorCode
  readonly data: WorkspaceTopologyErrorDataV1

  constructor(
    code: WorkspaceTopologyErrorCode,
    message: string,
    input: Omit<WorkspaceTopologyErrorDataV1, 'schemaVersion' | 'code'>,
  ) {
    super(message)
    this.name = 'WorkspaceTopologyError'
    this.code = code
    this.data = { schemaVersion: 1, code, ...input }
  }
}

export function getWorkspaceMarkerPath(rootPath: string): string {
  return join(rootPath, ...WORKSPACE_MARKER_RELATIVE_PATH.split('/'))
}

export function readWorkspaceMarker(rootPath: string, workspaceId: string): WorkspaceMarkerV1 {
  const markerPath = getWorkspaceMarkerPath(rootPath)
  if (!existsSync(markerPath)) {
    throw markerError(
      WORKSPACE_TOPOLOGY_ERROR_CODES.MARKER_MISSING,
      `Workspace marker is missing at ${markerPath}`,
      workspaceId,
    )
  }
  return readMatchingMarker(markerPath, workspaceId)
}

/**
 * Adopt an unmarked local root or verify its existing membership marker.
 * A complete temporary file is linked into place so concurrent adopters never
 * observe a partially written marker and an existing marker is never replaced.
 */
export function ensureWorkspaceMarker(rootPath: string, workspaceId: string): WorkspaceMarkerV1 {
  const root = lstatSync(rootPath)
  if (!root.isDirectory()) {
    throw markerError(
      WORKSPACE_TOPOLOGY_ERROR_CODES.LOCATION_UNAVAILABLE,
      `Workspace location is not a directory: ${rootPath}`,
      workspaceId,
    )
  }

  const markerPath = getWorkspaceMarkerPath(rootPath)
  if (existsSync(markerPath)) return readMatchingMarker(markerPath, workspaceId)

  const marker: WorkspaceMarkerV1 = {
    schemaVersion: WORKSPACE_MARKER_SCHEMA_VERSION,
    kind: WORKSPACE_MARKER_KIND,
    workspaceId,
  }
  const markerDirectory = dirname(markerPath)
  mkdirSync(markerDirectory, { recursive: true })
  const temporaryPath = join(markerDirectory, `.workspace.${process.pid}.${randomUUID()}.tmp`)
  let descriptor: number | null = null
  try {
    descriptor = openSync(temporaryPath, 'wx', 0o600)
    writeFileSync(descriptor, `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = null
    try {
      linkSync(temporaryPath, markerPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  } finally {
    if (descriptor !== null) closeSync(descriptor)
    try { unlinkSync(temporaryPath) } catch { /* best-effort temporary cleanup */ }
  }
  return readMatchingMarker(markerPath, workspaceId)
}

function readMatchingMarker(markerPath: string, workspaceId: string): WorkspaceMarkerV1 {
  let marker: WorkspaceMarkerV1
  try {
    marker = parseWorkspaceMarkerV1(JSON.parse(readFileSync(markerPath, 'utf8')))
  } catch (error) {
    throw markerError(
      WORKSPACE_TOPOLOGY_ERROR_CODES.MARKER_MISMATCH,
      `Workspace marker is invalid at ${markerPath}: ${error instanceof Error ? error.message : String(error)}`,
      workspaceId,
    )
  }
  if (marker.workspaceId !== workspaceId) {
    throw markerError(
      WORKSPACE_TOPOLOGY_ERROR_CODES.MARKER_MISMATCH,
      `Workspace marker belongs to ${marker.workspaceId}, not ${workspaceId}`,
      workspaceId,
    )
  }
  return marker
}

function markerError(
  code: WorkspaceTopologyErrorCode,
  message: string,
  workspaceId: string,
): WorkspaceTopologyError {
  return new WorkspaceTopologyError(code, message, { workspaceId, retryable: false })
}
