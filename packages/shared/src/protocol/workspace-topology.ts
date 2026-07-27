import { z } from 'zod'
import {
  WORKSPACE_SCHEMA_VERSION,
  type Workspace,
  type WorkspaceEndpoint,
  type WorkspaceInfo,
  type WorkspaceLocationAvailability,
  type WorkspaceLocationInfo,
  type WorkspaceLocationPermissions,
} from '@mortise/core/types'

export const WORKSPACE_MARKER_SCHEMA_VERSION = 1 as const
export const WORKSPACE_MARKER_KIND = 'mortise.workspace' as const
export const WORKSPACE_MARKER_RELATIVE_PATH = '.mortise/workspace.json' as const
export const WORKSPACE_PATH_REF_SCHEMA_VERSION = 1 as const
export const WORKSPACE_TOPOLOGY_COMMAND_SCHEMA_VERSION = 1 as const
export const WORKSPACE_TOPOLOGY_RESULT_SCHEMA_VERSION = 1 as const
export const WORKSPACE_TOPOLOGY_CHANGE_SCHEMA_VERSION = 1 as const
export const WORKSPACE_LOCATION_PROJECTION_SCHEMA_VERSION = 1 as const
export const WORKSPACE_TRANSFER_SCHEMA_VERSION = 1 as const
export const WORKSPACE_REMOTE_PRIMARY_SCHEMA_VERSION = 1 as const

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

/** Host-observed state required to produce one client-safe location projection. */
export interface WorkspaceLocationProjectionV1 {
  schemaVersion: typeof WORKSPACE_LOCATION_PROJECTION_SCHEMA_VERSION
  locationId: string
  availability: WorkspaceLocationAvailability
  permissions: WorkspaceLocationPermissions
}

export interface WorkspaceTransferRequestV1 {
  schemaVersion: typeof WORKSPACE_TRANSFER_SCHEMA_VERSION
  operationId: string
  workspaceId: string
  expectedRevision: number
  mode: 'copy' | 'move'
  source: WorkspacePathRefV1
  destination: WorkspacePathRefV1
  expectedSha256?: string
}

export interface WorkspaceTransferResultV1 {
  schemaVersion: typeof WORKSPACE_TRANSFER_SCHEMA_VERSION
  operationId: string
  status: 'applied' | 'duplicate'
  workspaceId: string
  sourceLocationId: string
  destinationLocationId: string
  revision: number
  mode: 'copy' | 'move'
  sha256: string
  bytes: number
  sourceRemoved: boolean
}

interface WorkspaceRemotePrimaryCommandBaseV1 {
  schemaVersion: typeof WORKSPACE_REMOTE_PRIMARY_SCHEMA_VERSION
  operationId: string
  workspaceId: string
  locationId: string
  displayName:
    | { source: 'derived' }
    | { source: 'custom'; name: string }
  /** Verified remote root name, distinct from the user-editable Location name. */
  remoteRootName: string
}

interface WorkspaceRemoteServerV1 {
  url: string
  credentialRef: string
  allowInsecureTls?: boolean
}

/**
 * Host-owned creation boundary for a Workspace whose first and primary
 * location is remote. It never accepts a local bootstrap root or credential material.
 */
export type WorkspaceRemotePrimaryCommandV1 =
  | (WorkspaceRemotePrimaryCommandBaseV1 & {
      operation: 'connect-existing'
      server: WorkspaceRemoteServerV1
      remoteWorkspaceId: string
    })
  | (WorkspaceRemotePrimaryCommandBaseV1 & {
      operation: 'create-and-connect'
      server: WorkspaceRemoteServerV1
    })

export interface WorkspaceRemotePrimaryResultV1 {
  schemaVersion: typeof WORKSPACE_REMOTE_PRIMARY_SCHEMA_VERSION
  operationId: string
  status: 'applied' | 'duplicate'
  workspaceId: string
  locationId: string
  remoteWorkspaceId: string
  workspace: WorkspaceInfo
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
      rootName: string
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
      rootName: string
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
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/, 'SHA-256 must be a lowercase hexadecimal digest')
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
  rootName: LocationNameSchema,
  endpoint: WorkspaceEndpointSchema,
}).strict()

const WorkspaceLocationAvailabilitySchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('available'),
    observedAt: TimestampSchema,
  }).strict(),
  z.object({
    status: z.literal('unavailable'),
    observedAt: TimestampSchema,
    reason: z.enum([
      'offline',
      'authentication-required',
      'permission-denied',
      'marker-missing',
      'marker-mismatch',
      'not-found',
      'unreachable',
      'unknown',
    ]),
  }).strict(),
  z.object({
    status: z.literal('unknown'),
    reason: z.enum(['not-observed', 'checking']),
  }).strict(),
])

const WorkspaceLocationPermissionsSchema = z.object({
  read: z.boolean(),
  write: z.boolean(),
  search: z.boolean(),
  runCommands: z.boolean(),
}).strict()

const WorkspaceLocationProjectionV1Schema = z.object({
  schemaVersion: z.literal(WORKSPACE_LOCATION_PROJECTION_SCHEMA_VERSION),
  locationId: BoundedIdSchema,
  availability: WorkspaceLocationAvailabilitySchema,
  permissions: WorkspaceLocationPermissionsSchema,
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
  rootName: LocationNameSchema,
  endpoint: z.discriminatedUnion('kind', [LocalEndpointInfoSchema, RemoteEndpointInfoSchema]),
  availability: WorkspaceLocationAvailabilitySchema,
  permissions: WorkspaceLocationPermissionsSchema,
}).strict()

const WorkspaceNameSchema = z.string().min(1).max(256)
  .refine(value => value.trim() === value, 'Workspace name must not have surrounding whitespace')

const WorkspaceDisplayMetadataSchema = {
  name: WorkspaceNameSchema,
  nameSource: z.enum(['derived', 'custom']),
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

const WorkspaceTransferRequestV1Schema = z.object({
  schemaVersion: z.literal(WORKSPACE_TRANSFER_SCHEMA_VERSION),
  operationId: OperationIdSchema,
  workspaceId: BoundedIdSchema,
  expectedRevision: RevisionSchema,
  mode: z.enum(['copy', 'move']),
  source: WorkspacePathRefV1Schema,
  destination: WorkspacePathRefV1Schema,
  expectedSha256: Sha256Schema.optional(),
}).strict().superRefine((request, context) => {
  if (request.source.workspaceId !== request.workspaceId || request.destination.workspaceId !== request.workspaceId) {
    context.addIssue({ code: 'custom', path: ['workspaceId'], message: 'Transfer path Workspace identities must match the request' })
  }
  if (!request.source.relativePath || !request.destination.relativePath) {
    context.addIssue({ code: 'custom', path: ['source'], message: 'Transfer paths must identify files' })
  }
  if (isMortisePrivatePath(request.source.relativePath) || isMortisePrivatePath(request.destination.relativePath)) {
    context.addIssue({ code: 'custom', path: ['source'], message: 'Workspace private resources cannot be transferred' })
  }
  if (
    request.source.locationId === request.destination.locationId
    && request.source.relativePath === request.destination.relativePath
  ) {
    context.addIssue({ code: 'custom', path: ['destination'], message: 'Transfer source and destination must differ' })
  }
})

const WorkspaceTransferResultV1Schema = z.object({
  schemaVersion: z.literal(WORKSPACE_TRANSFER_SCHEMA_VERSION),
  operationId: OperationIdSchema,
  status: z.enum(['applied', 'duplicate']),
  workspaceId: BoundedIdSchema,
  sourceLocationId: BoundedIdSchema,
  destinationLocationId: BoundedIdSchema,
  revision: RevisionSchema,
  mode: z.enum(['copy', 'move']),
  sha256: Sha256Schema,
  bytes: z.number().int().nonnegative(),
  sourceRemoved: z.boolean(),
}).strict().superRefine((result, context) => {
  if (result.mode === 'copy' && result.sourceRemoved) {
    context.addIssue({ code: 'custom', path: ['sourceRemoved'], message: 'A copy result cannot remove its source' })
  }
})

const WorkspaceRemoteServerV1Schema = z.object({
  url: RemoteUrlSchema,
  credentialRef: BoundedIdSchema,
  allowInsecureTls: z.boolean().optional(),
}).strict()

const WorkspaceDisplayNameRequestSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('derived') }).strict(),
  z.object({ source: z.literal('custom'), name: WorkspaceNameSchema }).strict(),
])

function remotePrimaryCommandBase<Operation extends WorkspaceRemotePrimaryCommandV1['operation']>(operation: Operation) {
  return z.object({
    schemaVersion: z.literal(WORKSPACE_REMOTE_PRIMARY_SCHEMA_VERSION),
    operation: z.literal(operation),
    operationId: OperationIdSchema,
    workspaceId: BoundedIdSchema,
    locationId: BoundedIdSchema,
    displayName: WorkspaceDisplayNameRequestSchema,
    remoteRootName: WorkspaceNameSchema,
  }).strict()
}

const WorkspaceRemotePrimaryCommandV1Schema = z.discriminatedUnion('operation', [
  remotePrimaryCommandBase('connect-existing').extend({
    server: WorkspaceRemoteServerV1Schema,
    remoteWorkspaceId: BoundedIdSchema,
  }),
  remotePrimaryCommandBase('create-and-connect').extend({
    server: WorkspaceRemoteServerV1Schema,
  }),
])

const WorkspaceRemotePrimaryResultV1Schema = z.object({
  schemaVersion: z.literal(WORKSPACE_REMOTE_PRIMARY_SCHEMA_VERSION),
  operationId: OperationIdSchema,
  status: z.enum(['applied', 'duplicate']),
  workspaceId: BoundedIdSchema,
  locationId: BoundedIdSchema,
  remoteWorkspaceId: BoundedIdSchema,
  workspace: WorkspaceInfoV2Schema,
}).strict().superRefine((result, context) => {
  if (result.workspace.id !== result.workspaceId) {
    context.addIssue({ code: 'custom', path: ['workspace', 'id'], message: 'Created Workspace identity must match the result' })
  }
  if (result.workspace.primaryLocationId !== result.locationId) {
    context.addIssue({ code: 'custom', path: ['workspace', 'primaryLocationId'], message: 'Created location must be the primary location' })
    return
  }
  const primary = result.workspace.locations.find(location => location.id === result.locationId)
  if (!primary || primary.endpoint.kind !== 'remote') {
    context.addIssue({ code: 'custom', path: ['workspace', 'locations'], message: 'Remote-primary creation must produce a remote primary location' })
    return
  }
  if (primary.endpoint.remoteWorkspaceId !== result.remoteWorkspaceId) {
    context.addIssue({ code: 'custom', path: ['remoteWorkspaceId'], message: 'Remote Workspace identity must match the primary endpoint' })
  }
})

const WorkspaceTopologyCommandV1Schema = z.discriminatedUnion('operation', [
  topologyCommandBase('attach-local').extend({
    locationId: BoundedIdSchema,
    name: LocationNameSchema,
    rootPath: AbsoluteRootPathSchema,
  }),
  topologyCommandBase('attach-remote').extend({
    locationId: BoundedIdSchema,
    name: LocationNameSchema,
    rootName: LocationNameSchema,
    url: RemoteUrlSchema,
    remoteWorkspaceId: BoundedIdSchema,
    credentialRef: BoundedIdSchema,
    allowInsecureTls: z.boolean().optional(),
  }),
  topologyCommandBase('detach').extend({ locationId: BoundedIdSchema }),
  topologyCommandBase('replace-endpoint').extend({
    locationId: BoundedIdSchema,
    rootName: LocationNameSchema,
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

export function parseWorkspaceLocationProjectionV1(value: unknown): WorkspaceLocationProjectionV1 {
  return WorkspaceLocationProjectionV1Schema.parse(value) as WorkspaceLocationProjectionV1
}

export function assertWorkspaceLocationProjectionV1(value: unknown): asserts value is WorkspaceLocationProjectionV1 {
  WorkspaceLocationProjectionV1Schema.parse(value)
}

export function parseWorkspaceTransferRequestV1(value: unknown): WorkspaceTransferRequestV1 {
  return WorkspaceTransferRequestV1Schema.parse(value) as WorkspaceTransferRequestV1
}

export function assertWorkspaceTransferRequestV1(value: unknown): asserts value is WorkspaceTransferRequestV1 {
  WorkspaceTransferRequestV1Schema.parse(value)
}

export function parseWorkspaceTransferResultV1(value: unknown): WorkspaceTransferResultV1 {
  return WorkspaceTransferResultV1Schema.parse(value) as WorkspaceTransferResultV1
}

export function assertWorkspaceTransferResultV1(value: unknown): asserts value is WorkspaceTransferResultV1 {
  WorkspaceTransferResultV1Schema.parse(value)
}

export function parseWorkspaceRemotePrimaryCommandV1(value: unknown): WorkspaceRemotePrimaryCommandV1 {
  return WorkspaceRemotePrimaryCommandV1Schema.parse(value) as WorkspaceRemotePrimaryCommandV1
}

export function assertWorkspaceRemotePrimaryCommandV1(value: unknown): asserts value is WorkspaceRemotePrimaryCommandV1 {
  WorkspaceRemotePrimaryCommandV1Schema.parse(value)
}

export function parseWorkspaceRemotePrimaryResultV1(value: unknown): WorkspaceRemotePrimaryResultV1 {
  return WorkspaceRemotePrimaryResultV1Schema.parse(value) as WorkspaceRemotePrimaryResultV1
}

export function assertWorkspaceRemotePrimaryResultV1(value: unknown): asserts value is WorkspaceRemotePrimaryResultV1 {
  WorkspaceRemotePrimaryResultV1Schema.parse(value)
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

export function redactWorkspaceInfo(
  workspace: Workspace,
  projectionValues: readonly WorkspaceLocationProjectionV1[],
): WorkspaceInfo {
  const validated = parseWorkspaceV2(workspace)
  const projections = projectionValues.map(parseWorkspaceLocationProjectionV1)
  const projectionByLocationId = new Map(projections.map(projection => [projection.locationId, projection]))
  if (projectionByLocationId.size !== projections.length) {
    throw new Error('Workspace location projections must have unique location identities')
  }
  if (
    projections.length !== validated.locations.length
    || projections.some(projection => !validated.locations.some(location => location.id === projection.locationId))
  ) {
    throw new Error('Workspace location projections must exactly cover the topology')
  }
  const locations = validated.locations.map(location => {
    const projection = projectionByLocationId.get(location.id)
    if (!projection) throw new Error(`Workspace location projection missing: ${location.id}`)
    return {
      id: location.id,
      name: location.name,
      rootName: location.rootName,
      endpoint: location.endpoint.kind === 'local'
        ? { kind: 'local' as const }
        : {
            kind: 'remote' as const,
            url: location.endpoint.url,
            remoteWorkspaceId: location.endpoint.remoteWorkspaceId,
            ...(location.endpoint.allowInsecureTls === undefined
              ? {}
              : { allowInsecureTls: location.endpoint.allowInsecureTls }),
          },
      availability: projection.availability,
      permissions: projection.permissions,
    }
  }) as [WorkspaceLocationInfo, ...WorkspaceLocationInfo[]]
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    id: validated.id,
    revision: validated.revision,
    name: validated.name,
    nameSource: validated.nameSource,
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

function isMortisePrivatePath(relativePath: string): boolean {
  return relativePath === '.mortise' || relativePath.startsWith('.mortise/')
}
