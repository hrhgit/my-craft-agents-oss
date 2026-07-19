import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { CoordinationResource, WorkspaceIdentity } from './types.ts'
import { COORDINATION_SCHEMA_VERSION } from './types.ts'

function platformPathKey(value: string): string {
  const normalized = value.replace(/\\/g, '/')
  return process.platform === 'win32' || process.platform === 'darwin'
    ? normalized.toLocaleLowerCase('en-US')
    : normalized
}

export function canonicalizeWorkspaceRoot(workspaceRoot: string): string {
  if (!workspaceRoot.trim()) throw new TypeError('workspaceRoot must not be empty')
  const absolute = resolve(workspaceRoot)
  let canonical: string
  try {
    canonical = realpathSync.native(absolute)
  } catch {
    canonical = absolute
  }
  return platformPathKey(canonical)
}

export function createWorkspaceIdentity(workspaceRoot: string, workspaceId?: string): WorkspaceIdentity {
  const canonicalRoot = canonicalizeWorkspaceRoot(workspaceRoot)
  const workspaceKey = createHash('sha256').update(canonicalRoot).digest('hex')
  return {
    schemaVersion: COORDINATION_SCHEMA_VERSION,
    workspaceKey,
    canonicalRoot,
    ...(workspaceId?.trim() ? { workspaceId: workspaceId.trim() } : {}),
  }
}

export function normalizeCoordinationResource(
  workspace: WorkspaceIdentity,
  input: { kind: 'file'; path: string } | { kind: 'logical'; name: string },
): CoordinationResource {
  if (input.kind === 'logical') {
    const name = input.name.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLocaleLowerCase('en-US')
    if (!name) throw new TypeError('Logical resource name must not be empty')
    return { kind: 'logical', name, resourceKey: `logical:${name}` }
  }

  if (!input.path.trim()) throw new TypeError('File resource path must not be empty')
  const root = resolve(workspace.canonicalRoot)
  const requested = isAbsolute(input.path) ? resolve(input.path) : resolve(root, input.path)
  let canonicalTarget: string
  try {
    canonicalTarget = realpathSync.native(requested)
  } catch {
    canonicalTarget = requested
  }
  const relativePath = relative(root, canonicalTarget)
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`File resource is outside the workspace: ${input.path}`)
  }
  const normalizedRelative = platformPathKey(relativePath || '.')
  return {
    kind: 'file',
    relativePath: normalizedRelative,
    resourceKey: `file:${normalizedRelative}`,
  }
}

