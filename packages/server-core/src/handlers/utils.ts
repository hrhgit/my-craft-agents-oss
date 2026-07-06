import { normalize, isAbsolute, sep } from 'path'
import { homedir, tmpdir } from 'os'
import { realpath } from 'fs/promises'
import { getWorkspaceByNameOrId, type Workspace } from '@craft-agent/shared/config'
import type { Logger, PlatformServices } from '../runtime/platform'

/**
 * Get workspace by ID or name, throwing if not found.
 * Use this when a workspace must exist for the operation to proceed.
 */
export function getWorkspaceOrThrow(workspaceId: string): Workspace {
  const workspace = getWorkspaceByNameOrId(workspaceId)
  if (!workspace) {
    throw new Error(`Workspace not found: ${workspaceId}`)
  }
  return workspace
}

/**
 * Get workspace by name or id. Returns null and logs if not found.
 * Use when the handler should return null/empty on missing workspace
 * (caller decides whether to return null, [], or a fallback object).
 */
export function getWorkspaceOrNull(
  workspaceId: string,
  log: Logger,
  tag: string,
): Workspace | null {
  const workspace = getWorkspaceByNameOrId(workspaceId)
  if (!workspace) {
    log.error(`${tag}: Workspace not found: ${workspaceId}`)
    return null
  }
  return workspace
}

/**
 * Resolve the authoritative workspaceId for an RPC handler.
 *
 * The transport layer stamps the handshake-authenticated `workspaceId` into
 * `ctx.workspaceId` (see transport/server.ts onRequest). Handlers should
 * treat that as the trusted value and only fall back to the `workspaceId`
 * passed in `args` when ctx is absent (e.g. headless callers).
 *
 * - If both are set and differ, throw — this is the workspace-bypass signal.
 * - If only ctx is set, use it.
 * - If only args is set, use it (legacy/headless path).
 * - If neither is set, returns undefined (handler should treat as global).
 */
export function resolveWorkspaceId(
  ctxWorkspaceId: string | null | undefined,
  argsWorkspaceId: string | undefined,
): string | undefined {
  if (ctxWorkspaceId && argsWorkspaceId && ctxWorkspaceId !== argsWorkspaceId) {
    throw new Error(
      `Workspace mismatch: authenticated workspace (${ctxWorkspaceId}) does not match requested (${argsWorkspaceId})`,
    )
  }
  return ctxWorkspaceId ?? argsWorkspaceId
}

/**
 * Returns true if the given absolute path matches a known sensitive file
 * pattern (SSH keys, GnuPG, AWS credentials, env files, PEM/KEY files, etc.).
 *
 * Cross-platform: matches both `/` and `\` separators via `[\\/]`.
 * Extracted from `validateFilePath` so bypass-by-design handlers can still
 * block sensitive files without enforcing workspace-container checks.
 */
export function isSensitivePath(absPath: string): boolean {
  const sensitivePatterns = [
    /\.ssh[\\/]/,
    /\.gnupg[\\/]/,
    /\.aws[\\/]credentials/,
    /\.env$/,
    /\.env\./,
    /credentials\.json$/,
    /secrets?\./i,
    /\.pem$/,
    /\.key$/,
  ]
  return sensitivePatterns.some(pattern => pattern.test(absPath))
}

export function buildBackendHostRuntimeContext(platform: PlatformServices) {
  return {
    appRootPath: platform.appRootPath,
    resourcesPath: platform.resourcesPath,
    isPackaged: platform.isPackaged,
  }
}

/**
 * Sanitizes a filename to prevent path traversal and filesystem issues.
 * Removes dangerous characters and limits length.
 *
 * Re-exported from `@craft-agent/shared/utils` so callers
 * importing from `@craft-agent/server-core/handlers` keep working.
 */
export { sanitizeFilename } from '@craft-agent/shared/utils'

/**
 * Resolve allowed directories for a workspace.
 *
 * Complete-unification semantics make the workspace root the only workspace
 * boundary. Legacy defaults.workingDirectory must not expand the permission
 * surface; users who need another folder should create/switch workspaces.
 */
export function getWorkspaceAllowedDirs(workspaceId?: string | null): string[] {
  if (!workspaceId) return []
  const workspace = getWorkspaceByNameOrId(workspaceId)
  if (!workspace) return []

  return [workspace.rootPath]
}

export interface ValidateFilePathOptions {
  allowHome?: boolean
  allowTmp?: boolean
}

/**
 * Validates that a file path is within allowed directories to prevent path traversal attacks.
 * Allowed directories: user's home directory, /tmp, and any additional dirs passed by the caller
 * (e.g. workspace root, workspace working directory).
 */
export async function validateFilePath(
  filePath: string,
  additionalAllowedDirs?: string[],
  options: ValidateFilePathOptions = {},
): Promise<string> {
  // Normalize the path to resolve . and .. components
  let normalizedPath = normalize(filePath)

  // Expand ~ to home directory
  if (normalizedPath.startsWith('~')) {
    normalizedPath = normalizedPath.replace(/^~/, homedir())
  }

  // Must be an absolute path
  if (!isAbsolute(normalizedPath)) {
    throw new Error('Only absolute file paths are allowed')
  }

  // Resolve symlinks to get the real path
  let realFilePath: string
  try {
    realFilePath = await realpath(normalizedPath)
  } catch {
    // File doesn't exist or can't be resolved - use normalized path
    realFilePath = normalizedPath
  }

  // Define allowed base directories
  const allowedDirs = [
    options.allowHome === false ? undefined : homedir(),
    options.allowTmp === false ? undefined : tmpdir(),
    ...(additionalAllowedDirs ?? []),
  ].filter((dir): dir is string => Boolean(dir))

  // Check if the real path is within an allowed directory (cross-platform)
  const isAllowed = allowedDirs.some(dir => {
    const normalizedDir = normalize(dir)
    const normalizedReal = normalize(realFilePath)
    return normalizedReal.startsWith(normalizedDir + sep) || normalizedReal === normalizedDir
  })

  if (!isAllowed) {
    throw new Error('Access denied: file path is outside allowed directories')
  }

  // Block sensitive files even within allowed directories.
  if (isSensitivePath(realFilePath)) {
    throw new Error('Access denied: cannot read sensitive files')
  }

  return realFilePath
}
