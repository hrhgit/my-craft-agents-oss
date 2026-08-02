import type { WorkspaceInfo } from '@mortise/core/types'
import { parseWorkspaceInfoV2 } from './workspace-topology'

export const WORKSPACE_CREATION_SCHEMA_VERSION = 1 as const

export interface WorkspaceCreationLocationV1 {
  rootPath: string
}

export interface WorkspaceCreationRequestV1 {
  schemaVersion: typeof WORKSPACE_CREATION_SCHEMA_VERSION
  name?: string
  locations: WorkspaceCreationLocationV1[]
  primaryLocationIndex?: number
}

export interface WorkspaceCreationResultV1 {
  schemaVersion: typeof WORKSPACE_CREATION_SCHEMA_VERSION
  action: 'created' | 'reconnected'
  workspace: WorkspaceInfo
}

export function parseWorkspaceCreationRequestV1(value: unknown): WorkspaceCreationRequestV1 {
  const candidate = exactObject(value, ['schemaVersion', 'name', 'locations', 'primaryLocationIndex'])
  if (candidate.schemaVersion !== WORKSPACE_CREATION_SCHEMA_VERSION) {
    throw new TypeError('Unsupported Workspace creation schema version')
  }
  if (candidate.name !== undefined && typeof candidate.name !== 'string') {
    throw new TypeError('Workspace name must be a string')
  }
  if (!Array.isArray(candidate.locations)) {
    throw new TypeError('Workspace creation locations must be an array')
  }

  const locations = candidate.locations.map((value) => {
    const location = exactObject(value, ['rootPath'])
    if (typeof location.rootPath !== 'string' || !location.rootPath.trim()) {
      throw new TypeError('Workspace location path is required')
    }
    return { rootPath: location.rootPath }
  })

  let primaryLocationIndex: number | undefined
  if (candidate.primaryLocationIndex !== undefined) {
    if (!Number.isInteger(candidate.primaryLocationIndex)) {
      throw new TypeError('Primary Workspace location index must be an integer')
    }
    primaryLocationIndex = candidate.primaryLocationIndex as number
  }
  if (locations.length === 0 && primaryLocationIndex !== undefined) {
    throw new TypeError('A generated Workspace location cannot reference a selected primary')
  }
  if (locations.length > 0) {
    primaryLocationIndex ??= 0
    if (primaryLocationIndex < 0 || primaryLocationIndex >= locations.length) {
      throw new TypeError('Primary Workspace location index is out of range')
    }
  }

  return {
    schemaVersion: WORKSPACE_CREATION_SCHEMA_VERSION,
    ...(candidate.name !== undefined ? { name: candidate.name } : {}),
    locations,
    ...(primaryLocationIndex !== undefined ? { primaryLocationIndex } : {}),
  }
}

export function parseWorkspaceCreationResultV1(value: unknown): WorkspaceCreationResultV1 {
  const candidate = exactObject(value, ['schemaVersion', 'action', 'workspace'])
  if (candidate.schemaVersion !== WORKSPACE_CREATION_SCHEMA_VERSION) {
    throw new TypeError('Unsupported Workspace creation result schema version')
  }
  if (candidate.action !== 'created' && candidate.action !== 'reconnected') {
    throw new TypeError('Workspace creation action is invalid')
  }
  return {
    schemaVersion: WORKSPACE_CREATION_SCHEMA_VERSION,
    action: candidate.action,
    workspace: parseWorkspaceInfoV2(candidate.workspace),
  }
}

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Workspace creation value must be an object')
  }
  const candidate = value as Record<string, unknown>
  const allowed = new Set(keys)
  if (Object.keys(candidate).some(key => !allowed.has(key))) {
    throw new TypeError('Workspace creation value contains unknown fields')
  }
  return candidate
}
