import { basename, dirname, join, normalize, isAbsolute, relative, sep } from 'path'
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
    /\.ssh[\\/]/i,
    /\.gnupg[\\/]/i,
    /\.aws[\\/]credentials/i,
    /\.env$/i,
    /\.env\./i,
    /credentials\.json$/i,
    /secrets?\./i,
    /\.pem$/i,
    /\.key$/i,
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
 * Resolves every existing path component while preserving a non-existent tail.
 * `realpath()` alone cannot protect a future file below a symlinked directory,
 * because it fails for the missing leaf and would otherwise fall back to the
 * unresolved alias.
 */
async function resolvePathBoundary(filePath: string): Promise<string> {
  const unresolvedTail: string[] = []
  let cursor = normalize(filePath)

  while (true) {
    try {
      const resolvedAncestor = await realpath(cursor)
      return unresolvedTail.length > 0
        ? normalize(join(resolvedAncestor, ...unresolvedTail.reverse()))
        : normalize(resolvedAncestor)
    } catch {
      const parent = dirname(cursor)
      if (parent === cursor) return normalize(filePath)
      unresolvedTail.push(basename(cursor))
      cursor = parent
    }
  }
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

  // Resolve the target and its nearest existing ancestor. This handles both a
  // symlink/junction workspace root and non-existent children below symlinks.
  const realFilePath = await resolvePathBoundary(normalizedPath)

  // Define allowed base directories
  const configuredAllowedDirs = [
    options.allowHome === false ? undefined : homedir(),
    options.allowTmp === false ? undefined : tmpdir(),
    ...(additionalAllowedDirs ?? []),
  ].filter((dir): dir is string => Boolean(dir))
  const allowedDirs = await Promise.all(configuredAllowedDirs.map(resolvePathBoundary))

  // Check if the real path is within an allowed directory (cross-platform)
  const isAllowed = allowedDirs.some(dir => {
    const normalizedDir = normalize(dir)
    const normalizedReal = normalize(realFilePath)
    const relativePath = relative(normalizedDir, normalizedReal)
    return relativePath === ''
      || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  })

  if (!isAllowed) {
    throw new Error('Access denied: file path is outside allowed directories')
  }

  // Block sensitive files even within allowed directories.
  if (isSensitivePath(normalizedPath) || isSensitivePath(realFilePath)) {
    throw new Error('Access denied: cannot read sensitive files')
  }

  return realFilePath
}
