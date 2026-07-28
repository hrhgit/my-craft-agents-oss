import { z } from 'zod'
import { isCanonicalWorkspaceRelativePath, isMortiseWorkspacePrivatePath } from './workspace-topology'

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/)
const Id = z.string().min(1).max(256)
const RelativePath = z.string().min(1).max(32_768)
  .refine(isCanonicalWorkspaceRelativePath, 'relativePath must be a canonical forward-slash relative path')
  .refine(value => !isMortiseWorkspacePrivatePath(value), 'Workspace private resources cannot be transferred')

export const WORKSPACE_TRANSFER_ENDPOINT_SCHEMA_VERSION = 1 as const
export const WORKSPACE_TRANSFER_CHUNK_BYTES = 256 * 1024

export interface WorkspaceTransferEndpointAccessV1 { schemaVersion: 1; operationId: string; workspaceId: string; locationId?: string }
export interface WorkspaceTransferEndpointAccessResultV1 { schemaVersion: 1; operationId: string; availability: 'available'; permissions: { read: boolean; write: boolean } }
export interface WorkspaceTransferEndpointOpenV1 { schemaVersion: 1; operationId: string; workspaceId: string; locationId?: string; relativePath: string }
export interface WorkspaceTransferEndpointImportOpenV1 extends WorkspaceTransferEndpointOpenV1 { expectedBytes: number; expectedSha256: string }
export interface WorkspaceTransferEndpointImportOpenResultV1 { schemaVersion: 1; operationId: string; status: 'opened' | 'already-published'; cleanupToken?: string }
export interface WorkspaceTransferEndpointExportInfoV1 { schemaVersion: 1; operationId: string; status: 'opened' | 'already-removed' | 'source-conflict'; bytes: number; sha256: string; cleanupToken?: string; sourceConflict?: string }
export interface WorkspaceTransferEndpointReadV1 { schemaVersion: 1; operationId: string; offset: number; maxBytes: number }
export interface WorkspaceTransferEndpointReadResultV1 { schemaVersion: 1; operationId: string; offset: number; bytes: Uint8Array; done: boolean }
export interface WorkspaceTransferEndpointCompleteV1 { schemaVersion: 1; operationId: string; removeIfUnchanged: boolean }
export interface WorkspaceTransferEndpointCompleteResultV1 { schemaVersion: 1; operationId: string; sourceRemoved: boolean; cleanupToken?: string; sourceConflict?: string }
export interface WorkspaceTransferEndpointWriteV1 { schemaVersion: 1; operationId: string; offset: number; bytes: Uint8Array }
export interface WorkspaceTransferEndpointWriteResultV1 { schemaVersion: 1; operationId: string; offset: number }
export interface WorkspaceTransferEndpointCommitV1 { schemaVersion: 1; operationId: string; bytes: number; sha256: string }
export interface WorkspaceTransferEndpointCommitResultV1 { schemaVersion: 1; operationId: string; bytes: number; sha256: string; cleanupToken: string }
export interface WorkspaceTransferEndpointAbortV1 { schemaVersion: 1; operationId: string }
export interface WorkspaceTransferEndpointCleanupV1 extends WorkspaceTransferEndpointOpenV1 { cleanupToken: string }
export interface WorkspaceTransferEndpointImportCleanupV1 extends WorkspaceTransferEndpointImportOpenV1 { cleanupToken: string }

const Base = z.object({ schemaVersion: z.literal(1), operationId: Id }).strict()
const CleanupToken = z.string().uuid()
const EndpointAccess = Base.extend({ workspaceId: Id, locationId: Id.optional() }).strict()
const EndpointAccessResult = Base.extend({ availability: z.literal('available'), permissions: z.object({ read: z.boolean(), write: z.boolean() }).strict() }).strict()
const EndpointOpen = Base.extend({ workspaceId: Id, locationId: Id.optional(), relativePath: RelativePath }).strict()
const EndpointImportOpen = EndpointOpen.extend({ expectedBytes: z.number().int().nonnegative(), expectedSha256: Sha256 }).strict()
const EndpointImportOpenResult = Base.extend({ status: z.enum(['opened', 'already-published']), cleanupToken: CleanupToken }).strict()
const EndpointRead = Base.extend({ offset: z.number().int().nonnegative(), maxBytes: z.number().int().positive().max(WORKSPACE_TRANSFER_CHUNK_BYTES) }).strict()
const EndpointExportInfo = Base.extend({ status: z.enum(['opened', 'already-removed', 'source-conflict']), bytes: z.number().int().nonnegative(), sha256: Sha256, cleanupToken: CleanupToken.optional(), sourceConflict: z.string().min(1).max(1024).optional() }).strict().superRefine((value, context) => {
  if (value.status !== 'opened' && !value.cleanupToken) context.addIssue({ code: 'custom', path: ['cleanupToken'], message: 'Durable export outcomes require a cleanup token' })
  if (value.status === 'source-conflict' && !value.sourceConflict) context.addIssue({ code: 'custom', path: ['sourceConflict'], message: 'Source conflicts require a reason' })
  if (value.status !== 'source-conflict' && value.sourceConflict) context.addIssue({ code: 'custom', path: ['sourceConflict'], message: `${value.status} exports cannot contain a source conflict` })
})
const EndpointReadResult = Base.extend({
  offset: z.number().int().nonnegative(),
  bytes: z.instanceof(Uint8Array).refine(value => value.byteLength <= WORKSPACE_TRANSFER_CHUNK_BYTES),
  done: z.boolean(),
}).strict()
const EndpointComplete = Base.extend({ removeIfUnchanged: z.boolean() }).strict()
const EndpointCompleteResult = Base.extend({ sourceRemoved: z.boolean(), cleanupToken: CleanupToken.optional(), sourceConflict: z.string().min(1).max(1024).optional() }).strict().superRefine((value, context) => {
  if ((value.sourceRemoved || value.sourceConflict) && !value.cleanupToken) context.addIssue({ code: 'custom', path: ['cleanupToken'], message: 'Durable export outcomes require a cleanup token' })
  if (value.sourceRemoved && value.sourceConflict) context.addIssue({ code: 'custom', path: ['sourceConflict'], message: 'A removed source cannot also conflict' })
})
const EndpointWrite = Base.extend({ offset: z.number().int().nonnegative(), bytes: z.instanceof(Uint8Array).refine(value => value.byteLength <= WORKSPACE_TRANSFER_CHUNK_BYTES) }).strict()
const EndpointWriteResult = Base.extend({ offset: z.number().int().nonnegative() }).strict()
const EndpointCommit = Base.extend({ bytes: z.number().int().nonnegative(), sha256: Sha256 }).strict()
const EndpointCommitResult = EndpointCommit.extend({ cleanupToken: CleanupToken }).strict()
const EndpointCleanup = EndpointOpen.extend({ cleanupToken: CleanupToken }).strict()
const EndpointImportCleanup = EndpointImportOpen.extend({ cleanupToken: CleanupToken }).strict()

export const parseWorkspaceTransferEndpointAccessV1 = (value: unknown): WorkspaceTransferEndpointAccessV1 => EndpointAccess.parse(value)
export const parseWorkspaceTransferEndpointAccessResultV1 = (value: unknown): WorkspaceTransferEndpointAccessResultV1 => EndpointAccessResult.parse(value)
export const parseWorkspaceTransferEndpointOpenV1 = (value: unknown): WorkspaceTransferEndpointOpenV1 => EndpointOpen.parse(value)
export const parseWorkspaceTransferEndpointImportOpenV1 = (value: unknown): WorkspaceTransferEndpointImportOpenV1 => EndpointImportOpen.parse(value)
export const parseWorkspaceTransferEndpointImportOpenResultV1 = (value: unknown): WorkspaceTransferEndpointImportOpenResultV1 => EndpointImportOpenResult.parse(value)
export const parseWorkspaceTransferEndpointBaseV1 = (value: unknown): WorkspaceTransferEndpointAbortV1 => Base.parse(value)
export const parseWorkspaceTransferEndpointExportInfoV1 = (value: unknown): WorkspaceTransferEndpointExportInfoV1 => EndpointExportInfo.parse(value)
export const parseWorkspaceTransferEndpointReadV1 = (value: unknown): WorkspaceTransferEndpointReadV1 => EndpointRead.parse(value)
export const parseWorkspaceTransferEndpointReadResultV1 = (value: unknown): WorkspaceTransferEndpointReadResultV1 => EndpointReadResult.parse(value)
export const parseWorkspaceTransferEndpointCompleteV1 = (value: unknown): WorkspaceTransferEndpointCompleteV1 => EndpointComplete.parse(value)
export const parseWorkspaceTransferEndpointCompleteResultV1 = (value: unknown): WorkspaceTransferEndpointCompleteResultV1 => EndpointCompleteResult.parse(value)
export const parseWorkspaceTransferEndpointWriteV1 = (value: unknown): WorkspaceTransferEndpointWriteV1 => EndpointWrite.parse(value)
export const parseWorkspaceTransferEndpointWriteResultV1 = (value: unknown): WorkspaceTransferEndpointWriteResultV1 => EndpointWriteResult.parse(value)
export const parseWorkspaceTransferEndpointCommitV1 = (value: unknown): WorkspaceTransferEndpointCommitV1 => EndpointCommit.parse(value)
export const parseWorkspaceTransferEndpointCommitResultV1 = (value: unknown): WorkspaceTransferEndpointCommitResultV1 => EndpointCommitResult.parse(value)
export const parseWorkspaceTransferEndpointAbortV1 = parseWorkspaceTransferEndpointBaseV1
export const parseWorkspaceTransferEndpointCleanupV1 = (value: unknown): WorkspaceTransferEndpointCleanupV1 => EndpointCleanup.parse(value)
export const parseWorkspaceTransferEndpointImportCleanupV1 = (value: unknown): WorkspaceTransferEndpointImportCleanupV1 => EndpointImportCleanup.parse(value)
