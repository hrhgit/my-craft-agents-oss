/**
 * Session Bundle — Serialization Format for Session Export/Import
 *
 * A SessionBundle is the portable representation of a session directory,
 * used for transferring sessions between workspaces (same-server or cross-server).
 *
 * This is the foundation for session dispatch (move/fork), backup, and sharing.
 */

import { existsSync } from 'fs'
import type { SessionHeader, StoredMessage } from './types.ts'
import type { StoredSession } from './types.ts'
import { readSessionJsonl, readSessionHeader } from './jsonl.ts'
import { getSessionPath, getSessionFilePath } from './storage.ts'
import { isValidSessionId } from './validation.ts'
import { debug } from '../utils/debug.ts'
import {
  type BundleFile,
  MAX_BUNDLE_SIZE_BYTES,
  collectDirectoryFiles,
} from '../utils/bundle-files.ts'

// Re-export BundleFile and MAX_BUNDLE_SIZE_BYTES for backward compatibility
export { type BundleFile, MAX_BUNDLE_SIZE_BYTES } from '../utils/bundle-files.ts'

/**
 * Directories to skip when collecting session files for export.
 * tmp/ is regenerable; dotfiles are typically internal state.
 */
const SKIP_DIRS = new Set(['tmp'])

/**
 * Files to skip when collecting session files for export.
 * session.jsonl is in the bundle as structured data.
 */
const SKIP_SESSION_FILES = new Set(['session.jsonl', 'session.jsonl.tmp'])

/**
 * Dispatch mode determines how the imported session relates to the original.
 */
export type DispatchMode = 'move' | 'fork'

/**
 * Branch info for fork operations.
 * Enables SDK-level conversation branching on the target server,
 * so the forked session has full context from the original.
 */
export interface BundleBranchInfo {
  /** SDK session ID to branch from */
  sdkSessionId: string
  /** SDK turn ID (branch point) */
  sdkTurnId: string
  /** Working directory for SDK session storage */
  sdkCwd: string
}

/**
 * Serialized representation of a session directory.
 * JSON envelope format — sessions are typically small (text + a few attachments).
 */
export interface SessionBundle {
  /** Bundle format version */
  version: 1
  /** Session data (header metadata + full message history) */
  session: {
    /** Session metadata (id, name, timestamps, config) */
    header: SessionHeader
    /** Full message history */
    messages: StoredMessage[]
  }
  /** All files from the session directory (attachments, plans, data, downloads, etc.) */
  files: BundleFile[]
  /** Branch info for fork operations (populated by the exporter when forking) */
  branchInfo?: BundleBranchInfo
}

/**
 * Serialize a session directory into a SessionBundle.
 *
 * Reads the session JSONL and all associated files (attachments, plans, data, downloads).
 * Skips tmp/ directory and dotfiles. Validates total size against MAX_BUNDLE_SIZE_BYTES.
 *
 * @param workspaceRootPath - Root path of the workspace containing the session
 * @param sessionId - ID of the session to serialize
 * @returns SessionBundle or null if session doesn't exist or exceeds size limit
 */
export function serializeSession(
  workspaceRootPath: string,
  sessionId: string,
): SessionBundle | null {
  const sessionDir = getSessionPath(workspaceRootPath, sessionId)
  const sessionFile = getSessionFilePath(workspaceRootPath, sessionId)

  if (!existsSync(sessionFile)) {
    debug('[bundle] Session file not found:', sessionFile)
    return null
  }

  // Read and parse session JSONL
  const stored = readSessionJsonl(sessionFile)
  if (!stored) {
    debug('[bundle] Failed to parse session JSONL:', sessionFile)
    return null
  }

  // Collect all files from session directory (except session.jsonl and tmp/)
  const files = collectDirectoryFiles(sessionDir, {
    skipDirs: SKIP_DIRS,
    skipFiles: SKIP_SESSION_FILES,
  })

  // Validate total bundle size
  const totalSize = files.reduce((sum, f) => sum + f.size, 0)
  if (totalSize > MAX_BUNDLE_SIZE_BYTES) {
    debug(`[bundle] Session exceeds max bundle size: ${totalSize} bytes > ${MAX_BUNDLE_SIZE_BYTES} bytes`)
    return null
  }

  // Read the session header via readSessionHeader, which correctly handles
  // both Pi tree JSONL v3 format (extracts the `mortise` extension from the Pi
  // header) and the legacy Mortise JSONL format (reads the first line directly).
  const header = readSessionHeader(sessionFile)
  if (!header) {
    debug('[bundle] Failed to read session header:', sessionFile)
    return null
  }

  return {
    version: 1,
    session: {
      header,
      messages: stored.messages,
    },
    files,
  }
}

/**
 * Validate a SessionBundle structure.
 * Checks version, required fields, and basic integrity.
 */
export function validateBundle(bundle: unknown): bundle is SessionBundle {
  if (!bundle || typeof bundle !== 'object') return false
  const b = bundle as Record<string, unknown>

  if (b.version !== 1) return false
  if (!b.session || typeof b.session !== 'object') return false

  const session = b.session as Record<string, unknown>
  if (!session.header || typeof session.header !== 'object') return false
  if (!Array.isArray(session.messages)) return false

  const header = session.header as Record<string, unknown>
  // 接受 mortiseId（新格式）或 id（旧 bundle 格式）
  if (typeof header.mortiseId !== 'string' && typeof header.id !== 'string') return false
  if (typeof header.mortiseId === 'string' && !isValidSessionId(header.mortiseId)) return false
  if (typeof header.id === 'string' && !isValidSessionId(header.id)) return false
  if (typeof header.createdAt !== 'number') return false

  if (!Array.isArray(b.files)) return false

  return true
}
