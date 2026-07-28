import { z } from 'zod'
import {
  WORKSPACE_SCHEMA_VERSION,
  type Workspace,
  type WorkspaceEndpoint,
  type WorkspaceInfo,
  type WorkspaceLocationInfo,
} from '@mortise/core/types'

export const WORKSPACE_MARKER_SCHEMA_VERSION = 1 as const
export const WORKSPACE_MARKER_KIND = 'mortise.workspace' as const
export const WORKSPACE_MARKER_RELATIVE_PATH = '.mortise/workspace.json' as const
export const WORKSPACE_PATH_REF_SCHEMA_VERSION = 1 as const
export const WORKSPACE_TOPOLOGY_COMMAND_SCHEMA_VERSION = 1 as const
export const WORKSPACE_TOPOLOGY_RESULT_SCHEMA_VERSION = 1 as const
export const WORKSPACE_TOPOLOGY_CHANGE_SCHEMA_VERSION = 1 as const

export interface WorkspaceMarkerV1 {
  schemaVersion: typeof WORKSPACE_MARKER_SCHEMA_VERSION
  kind: typeof WORKSPACE_MARKER_KIND
  workspaceId: string
}

/** A path is always qualified by both durable Workspace and location identity. */
export interface WorkspacePathRefV1 {
  schemaVersion: typeof WORKSPACE_PATH_REF_SCHEMA_VERSION
  workspaceId: string
  locationId: string
  /** Forward-slash relative path. Empty identifies the location root. */
  relativePath: string
}

interface WorkspaceTopologyCommandBaseV1 {
  schemaVersion: typeof WORKSPACE_TOPOLOGY_COMMAND_SCHEMA_VERSION
  workspaceId: string
  operationId: string
  expectedRevision: number
}

export type WorkspaceTopologyCommandV1 =
  | (WorkspaceTopologyCommandBaseV1 & {
      operation: 'attach-local'
      locationId: string
      name: string
      rootPath: string
    })
  | (WorkspaceTopologyCommandBaseV1 & {
      operation: 'attach-remote'
      locationId: string
      name: string
      url: string
      remoteWorkspaceId: string
      credentialRef: string
      allowInsecureTls?: boolean
    })
  | (WorkspaceTopologyCommandBaseV1 & {
      operation: 'detach'
      locationId: string
    })
  | (WorkspaceTopologyCommandBaseV1 & {
      operation: 'replace-endpoint'
      locationId: string
      endpoint: WorkspaceEndpoint
    })
  | (WorkspaceTopologyCommandBaseV1 & {
      operation: 'set-primary'
      locationId: string
    })
  | (WorkspaceTopologyCommandBaseV1 & {
      operation: 'rename'
      locationId: string
      name: string
    })

export type WorkspaceTopologyOperationV1 = WorkspaceTopologyCommandV1['operation']
export type WorkspaceLocationRole = 'primary' | 'attached'

export interface WorkspaceTopologyResultV1 {
  schemaVersion: typeof WORKSPACE_TOPOLOGY_RESULT_SCHEMA_VERSION
  operationId: string
  status: 'applied' | 'duplicate'
  workspace: WorkspaceInfo
}

export interface WorkspaceTopologyChangedV1 {
  schemaVersion: typeof WORKSPACE_TOPOLOGY_CHANGE_SCHEMA_VERSION
  workspaceId: string
  operationId: string
  operation: WorkspaceTopologyOperationV1
  previousRevision: number
  revision: number
  changedLocationIds: string[]
  workspace: WorkspaceInfo
}

export const WORKSPACE_TOPOLOGY_ERROR_CODES = {
  MARKER_MISSING: 'WORKSPACE_MARKER_MISSING',
  MARKER_MISMATCH: 'WORKSPACE_MARKER_MISMATCH',
  LOCATION_UNAVAILABLE: 'WORKSPACE_LOCATION_UNAVAILABLE',
  LOCATION_IN_USE: 'WORKSPACE_LOCATION_IN_USE',
  STALE_REVISION: 'WORKSPACE_STALE_REVISION',
  READ_ONLY_CAPABILITY: 'WORKSPACE_TOPOLOGY_READ_ONLY',
} as const

export type WorkspaceTopologyErrorCode =
  typeof WORKSPACE_TOPOLOGY_ERROR_CODES[keyof typeof WORKSPACE_TOPOLOGY_ERROR_CODES]

export interface WorkspaceTopologyErrorDataV1 {
  schemaVersion: 1
  code: WorkspaceTopologyErrorCode
  workspaceId: string
  locationId?: string
  expectedRevision?: number
  actualRevision?: number
  retryable: boolean
}

const BoundedIdSchema = z.string()
  .min(1)
  .max(256)
  .refine(value => value.trim() === value, 'Identifier must not have surrounding whitespace')
const OperationIdSchema = z.string()
  .min(1)
  .max(256)
  .refine(value => value.trim().length > 0, 'operationId must not be blank')
const LocationNameSchema = z.string()
  .min(1)
  .max(128)
  .refine(value => value.trim() === value, 'Location name must not have surrounding whitespace')
const RevisionSchema = z.number().int().nonnegative()
const TimestampSchema = z.number().int().nonnegative()
const AbsoluteRootPathSchema = z.string().min(1).max(32_768)
  .refine(value => /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(value), 'rootPath must be absolute')
const RemoteUrlSchema = z.string().url().superRefine((value, context) => {
  const url = new URL(value)
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:' && url.protocol !== 'http:' && url.protocol !== 'https:') {
    context.addIssue({ code: 'custom', message: 'Remote URL must use ws, wss, http, or https' })
  }
  if (url.username || url.password || url.search || url.hash) {
    context.addIssue({ code: 'custom', message: 'Remote URL must not embed credentials, query parameters, or fragments' })
  }
})

const LocalEndpointSchema = z.object({
  kind: z.literal('local'),
  rootPath: AbsoluteRootPathSchema,
}).strict()

const RemoteEndpointSchema = z.object({
  kind: z.literal('remote'),
  url: RemoteUrlSchema,
  remoteWorkspaceId: BoundedIdSchema,
  credentialRef: BoundedIdSchema,
  allowInsecureTls: z.boolean().optional(),
}).strict()

const WorkspaceEndpointSchema = z.discriminatedUnion('kind', [
  LocalEndpointSchema,
  RemoteEndpointSchema,
])

const WorkspaceLocationSchema = z.object({
  id: BoundedIdSchema,
  name: LocationNameSchema,
  endpoint: WorkspaceEndpointSchema,
}).strict()

const LocalEndpointInfoSchema = z.object({ kind: z.literal('local') }).strict()
const RemoteEndpointInfoSchema = z.object({
  kind: z.literal('remote'),
  url: RemoteUrlSchema,
  remoteWorkspaceId: BoundedIdSchema,
  allowInsecureTls: z.boolean().optional(),
}).strict()
const WorkspaceLocationInfoSchema = z.object({
  id: BoundedIdSchema,
  name: LocationNameSchema,
  endpoint: z.discriminatedUnion('kind', [LocalEndpointInfoSchema, RemoteEndpointInfoSchema]),
}).strict()

const WorkspaceDisplayMetadataSchema = {
  name: z.string().min(1).max(256),
  slug: z.string().min(1).max(256),
  lastAccessedAt: TimestampSchema.optional(),
  iconUrl: z.string().max(32_768).optional(),
  mcpUrl: z.string().max(32_768).optional(),
  mcpAuthType: z.enum(['workspace_oauth', 'workspace_bearer', 'public']).optional(),
}

const WorkspaceV2Schema = z.object({
  schemaVersion: z.literal(WORKSPACE_SCHEMA_VERSION),
  id: BoundedIdSchema,
  revision: RevisionSchema,
  primaryLocationId: BoundedIdSchema,
  locations: z.array(WorkspaceLocationSchema).min(1),
  createdAt: TimestampSchema,
  ...WorkspaceDisplayMetadataSchema,
}).strict().superRefine((workspace, context) => {
  validateLocationSet(workspace.primaryLocationId, workspace.locations, context)
})

const WorkspaceInfoV2Schema = z.object({
  schemaVersion: z.literal(WORKSPACE_SCHEMA_VERSION),
  id: BoundedIdSchema,
  revision: RevisionSchema,
  primaryLocationId: BoundedIdSchema,
  locations: z.array(WorkspaceLocationInfoSchema).min(1),
  ...WorkspaceDisplayMetadataSchema,
}).strict().superRefine((workspace, context) => {
  validateLocationSet(workspace.primaryLocationId, workspace.locations, context)
})

function validateLocationSet(
  primaryLocationId: string,
  locations: ReadonlyArray<{ id: string; name: string }>,
  context: z.RefinementCtx,
): void {
  const ids = new Set<string>()
  const names = new Set<string>()
  for (const [index, location] of locations.entries()) {
    if (ids.has(location.id)) {
      context.addIssue({ code: 'custom', path: ['locations', index, 'id'], message: 'Location IDs must be unique' })
    }
    ids.add(location.id)
    const normalizedName = location.name.toLocaleLowerCase('en-US')
    if (names.has(normalizedName)) {
      context.addIssue({ code: 'custom', path: ['locations', index, 'name'], message: 'Location names must be unique' })
    }
    names.add(normalizedName)
  }
  if (!ids.has(primaryLocationId)) {
    context.addIssue({ code: 'custom', path: ['primaryLocationId'], message: 'Primary location must reference an existing location' })
  }
}

const WorkspaceMarkerV1Schema = z.object({
  schemaVersion: z.literal(WORKSPACE_MARKER_SCHEMA_VERSION),
  kind: z.literal(WORKSPACE_MARKER_KIND),
  workspaceId: BoundedIdSchema,
}).strict()

const WorkspacePathRefV1Schema = z.object({
  schemaVersion: z.literal(WORKSPACE_PATH_REF_SCHEMA_VERSION),
  workspaceId: BoundedIdSchema,
  locationId: BoundedIdSchema,
  relativePath: z.string().max(32_768).refine(isCanonicalRelativePath, 'relativePath must be a canonical forward-slash relative path'),
}).strict()

const WorkspaceTopologyCommandV1Schema = z.discriminatedUnion('operation', [
  topologyCommandBase('attach-local').extend({
    locationId: BoundedIdSchema,
    name: LocationNameSchema,
    rootPath: AbsoluteRootPathSchema,
  }),
  topologyCommandBase('attach-remote').extend({
    locationId: BoundedIdSchema,
    name: LocationNameSchema,
    url: RemoteUrlSchema,
    remoteWorkspaceId: BoundedIdSchema,
    credentialRef: BoundedIdSchema,
    allowInsecureTls: z.boolean().optional(),
  }),
  topologyCommandBase('detach').extend({ locationId: BoundedIdSchema }),
  topologyCommandBase('replace-endpoint').extend({
    locationId: BoundedIdSchema,
    endpoint: WorkspaceEndpointSchema,
  }),
  topologyCommandBase('set-primary').extend({ locationId: BoundedIdSchema }),
  topologyCommandBase('rename').extend({
    locationId: BoundedIdSchema,
    name: LocationNameSchema,
  }),
])

const WorkspaceTopologyResultV1Schema = z.object({
  schemaVersion: z.literal(WORKSPACE_TOPOLOGY_RESULT_SCHEMA_VERSION),
  operationId: OperationIdSchema,
  status: z.enum(['applied', 'duplicate']),
  workspace: WorkspaceInfoV2Schema,
}).strict()

const WorkspaceTopologyChangedV1Schema = z.object({
  schemaVersion: z.literal(WORKSPACE_TOPOLOGY_CHANGE_SCHEMA_VERSION),
  workspaceId: BoundedIdSchema,
  operationId: OperationIdSchema,
  operation: z.enum(['attach-local', 'attach-remote', 'detach', 'replace-endpoint', 'set-primary', 'rename']),
  previousRevision: RevisionSchema,
  revision: RevisionSchema,
  changedLocationIds: z.array(BoundedIdSchema).min(1).refine(
    values => new Set(values).size === values.length,
    'changedLocationIds must be unique',
  ),
  workspace: WorkspaceInfoV2Schema,
}).strict().superRefine((change, context) => {
  if (change.revision !== change.previousRevision + 1) {
    context.addIssue({ code: 'custom', path: ['revision'], message: 'Topology changes must advance revision by exactly one' })
  }
  if (change.workspace.id !== change.workspaceId) {
    context.addIssue({ code: 'custom', path: ['workspace', 'id'], message: 'Changed Workspace identity must match the event' })
  }
  if (change.workspace.revision !== change.revision) {
    context.addIssue({ code: 'custom', path: ['workspace', 'revision'], message: 'Changed Workspace revision must match the event' })
  }
})

const WorkspaceTopologyErrorDataV1Schema = z.object({
  schemaVersion: z.literal(1),
  code: z.enum(WORKSPACE_TOPOLOGY_ERROR_CODES),
  workspaceId: BoundedIdSchema,
  locationId: BoundedIdSchema.optional(),
  expectedRevision: RevisionSchema.optional(),
  actualRevision: RevisionSchema.optional(),
  retryable: z.boolean(),
}).strict()

function topologyCommandBase<Operation extends WorkspaceTopologyOperationV1>(operation: Operation) {
  return z.object({
    schemaVersion: z.literal(WORKSPACE_TOPOLOGY_COMMAND_SCHEMA_VERSION),
    operation: z.literal(operation),
    workspaceId: BoundedIdSchema,
    operationId: OperationIdSchema,
    expectedRevision: RevisionSchema,
  }).strict()
}

export function parseWorkspaceV2(value: unknown): Workspace {
  return WorkspaceV2Schema.parse(value) as Workspace
}

export function assertWorkspaceV2(value: unknown): asserts value is Workspace {
  WorkspaceV2Schema.parse(value)
}

export function parseWorkspaceInfoV2(value: unknown): WorkspaceInfo {
  return WorkspaceInfoV2Schema.parse(value) as WorkspaceInfo
}

export function assertWorkspaceInfoV2(value: unknown): asserts value is WorkspaceInfo {
  WorkspaceInfoV2Schema.parse(value)
}

export function parseWorkspaceMarkerV1(value: unknown): WorkspaceMarkerV1 {
  return WorkspaceMarkerV1Schema.parse(value)
}

export function assertWorkspaceMarkerV1(value: unknown): asserts value is WorkspaceMarkerV1 {
  WorkspaceMarkerV1Schema.parse(value)
}

export function parseWorkspacePathRefV1(value: unknown): WorkspacePathRefV1 {
  return WorkspacePathRefV1Schema.parse(value)
}

export function assertWorkspacePathRefV1(value: unknown): asserts value is WorkspacePathRefV1 {
  WorkspacePathRefV1Schema.parse(value)
}

export function parseWorkspaceTopologyCommandV1(value: unknown): WorkspaceTopologyCommandV1 {
  return WorkspaceTopologyCommandV1Schema.parse(value) as WorkspaceTopologyCommandV1
}

export function assertWorkspaceTopologyCommandV1(value: unknown): asserts value is WorkspaceTopologyCommandV1 {
  WorkspaceTopologyCommandV1Schema.parse(value)
}

export function parseWorkspaceTopologyResultV1(value: unknown): WorkspaceTopologyResultV1 {
  return WorkspaceTopologyResultV1Schema.parse(value) as WorkspaceTopologyResultV1
}

export function assertWorkspaceTopologyResultV1(value: unknown): asserts value is WorkspaceTopologyResultV1 {
  WorkspaceTopologyResultV1Schema.parse(value)
}

export function parseWorkspaceTopologyChangedV1(value: unknown): WorkspaceTopologyChangedV1 {
  return WorkspaceTopologyChangedV1Schema.parse(value) as WorkspaceTopologyChangedV1
}

export function assertWorkspaceTopologyChangedV1(value: unknown): asserts value is WorkspaceTopologyChangedV1 {
  WorkspaceTopologyChangedV1Schema.parse(value)
}

export function parseWorkspaceTopologyErrorDataV1(value: unknown): WorkspaceTopologyErrorDataV1 {
  return WorkspaceTopologyErrorDataV1Schema.parse(value) as WorkspaceTopologyErrorDataV1
}

export function assertWorkspaceTopologyErrorDataV1(value: unknown): asserts value is WorkspaceTopologyErrorDataV1 {
  WorkspaceTopologyErrorDataV1Schema.parse(value)
}

export function redactWorkspaceInfo(workspace: Workspace): WorkspaceInfo {
  const validated = parseWorkspaceV2(workspace)
  const locations = validated.locations.map(location => ({
    id: location.id,
    name: location.name,
    endpoint: location.endpoint.kind === 'local'
      ? { kind: 'local' }
      : {
          kind: 'remote',
          url: location.endpoint.url,
          remoteWorkspaceId: location.endpoint.remoteWorkspaceId,
          ...(location.endpoint.allowInsecureTls === undefined
            ? {}
            : { allowInsecureTls: location.endpoint.allowInsecureTls }),
        },
  })) as [WorkspaceLocationInfo, ...WorkspaceLocationInfo[]]
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    id: validated.id,
    revision: validated.revision,
    name: validated.name,
    slug: validated.slug,
    primaryLocationId: validated.primaryLocationId,
    locations,
    ...(validated.lastAccessedAt === undefined ? {} : { lastAccessedAt: validated.lastAccessedAt }),
    ...(validated.iconUrl === undefined ? {} : { iconUrl: validated.iconUrl }),
    ...(validated.mcpUrl === undefined ? {} : { mcpUrl: validated.mcpUrl }),
    ...(validated.mcpAuthType === undefined ? {} : { mcpAuthType: validated.mcpAuthType }),
  }
}

/** Location role is a projection, never independently stored or accepted. */
export function getWorkspaceLocationRole(
  workspace: Pick<Workspace | WorkspaceInfo, 'primaryLocationId'>,
  locationId: string,
): WorkspaceLocationRole {
  return workspace.primaryLocationId === locationId ? 'primary' : 'attached'
}

function isCanonicalRelativePath(value: string): boolean {
  if (value.includes('\\') || value.includes('\0') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false
  return value === '' || value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
}
