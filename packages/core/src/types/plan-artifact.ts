/** Versioned structured plan protocol shared by Pi, persistence, and UI. */

export const PLAN_ARTIFACT_SCHEMA_VERSION = 1 as const;
export const PLAN_ARTIFACT_CUSTOM_TYPE = 'craft-plan-artifact' as const;
export const PLAN_ARTIFACT_UPDATE_CUSTOM_TYPE = 'craft-plan-artifact-update' as const;
export const PLAN_MODE_STATE_CUSTOM_TYPE = 'craft-plan-state' as const;

export type PlanArtifactState =
  | 'reviewing'
  | 'ready'
  | 'superseded'
  | 'executing'
  | 'completed'
  | 'failed';

export type PlanReviewStatus = 'not_requested' | 'pending' | 'running' | 'passed' | 'failed' | 'error';
export type PlanReviewVerdict = 'pass' | 'warning' | 'fail';
export type PlanChecklistItemStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';

export interface PlanChecklistItemV1 {
  id: string;
  title: string;
  status: PlanChecklistItemStatus;
  error?: string;
  startedAt?: number;
  completedAt?: number;
}

export interface PlanReviewV1 {
  status: PlanReviewStatus;
  body?: string;
  verdict?: PlanReviewVerdict;
  model?: string;
  error?: string;
  startedAt?: number;
  completedAt?: number;
}

export interface PlanArtifactV1 {
  schemaVersion: typeof PLAN_ARTIFACT_SCHEMA_VERSION;
  kind: 'plan';
  artifactId: string;
  revision: number;
  state: PlanArtifactState;
  review: PlanReviewV1;
  checklist: PlanChecklistItemV1[];
  models?: {
    planner?: string;
    reviewer?: string;
  };
  error?: string;
  createdAt: number;
  finalizedAt?: number;
  executionStartedAt?: number;
  completedAt?: number;
  /** Read-compatibility marker for historical role=plan messages. */
  legacy?: boolean;
}

export type PlanModePhase =
  | 'off'
  | 'planning'
  | 'discussing'
  | 'finalizing'
  | 'reviewing'
  | 'ready'
  | 'executing'
  | 'completed';

export interface PlanModeStateV1 {
  schemaVersion: typeof PLAN_ARTIFACT_SCHEMA_VERSION;
  phase: PlanModePhase;
  activeArtifactId?: string;
  error?: string;
  updatedAt: number;
}

export interface PlanArtifactMessageDetailsV1 {
  schemaVersion: typeof PLAN_ARTIFACT_SCHEMA_VERSION;
  artifact: PlanArtifactV1;
  /** Optional exact binding supplied by a host that knows the assistant message id. */
  assistantMessageId?: string;
}

export interface PlanModeStateMessageDetailsV1 {
  schemaVersion: typeof PLAN_ARTIFACT_SCHEMA_VERSION;
  state: PlanModeStateV1;
}

export interface ExtensionCommandResult {
  invoked: boolean;
  error?: string;
  /** Custom messages published before the extension command acknowledgement. */
  customMessages?: Array<{
    id?: string;
    customType: string;
    content: string;
    display: boolean;
    details?: unknown;
    timestamp?: number;
  }>;
}

const ARTIFACT_STATES = new Set<PlanArtifactState>(['reviewing', 'ready', 'superseded', 'executing', 'completed', 'failed']);
const REVIEW_STATUSES = new Set<PlanReviewStatus>(['not_requested', 'pending', 'running', 'passed', 'failed', 'error']);
const REVIEW_VERDICTS = new Set<PlanReviewVerdict>(['pass', 'warning', 'fail']);
const CHECKLIST_STATUSES = new Set<PlanChecklistItemStatus>(['pending', 'in_progress', 'completed', 'failed', 'skipped']);
const PLAN_PHASES = new Set<PlanModePhase>(['off', 'planning', 'discussing', 'finalizing', 'reviewing', 'ready', 'executing', 'completed']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isOptionalTimestamp(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

function isPlanReview(value: unknown): value is PlanReviewV1 {
  if (!isRecord(value) || typeof value.status !== 'string' || !REVIEW_STATUSES.has(value.status as PlanReviewStatus)) return false;
  if (!isOptionalString(value.body) || !isOptionalString(value.model) || !isOptionalString(value.error)) return false;
  if (value.verdict !== undefined && (typeof value.verdict !== 'string' || !REVIEW_VERDICTS.has(value.verdict as PlanReviewVerdict))) return false;
  return isOptionalTimestamp(value.startedAt) && isOptionalTimestamp(value.completedAt);
}

function isChecklistItem(value: unknown): value is PlanChecklistItemV1 {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id.length === 0) return false;
  if (typeof value.title !== 'string' || value.title.trim().length === 0) return false;
  if (typeof value.status !== 'string' || !CHECKLIST_STATUSES.has(value.status as PlanChecklistItemStatus)) return false;
  return isOptionalString(value.error) && isOptionalTimestamp(value.startedAt) && isOptionalTimestamp(value.completedAt);
}

export function isPlanArtifactV1(value: unknown): value is PlanArtifactV1 {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== PLAN_ARTIFACT_SCHEMA_VERSION || value.kind !== 'plan') return false;
  if (typeof value.artifactId !== 'string' || value.artifactId.trim().length === 0) return false;
  if (!Number.isInteger(value.revision) || (value.revision as number) < 1) return false;
  if (typeof value.state !== 'string' || !ARTIFACT_STATES.has(value.state as PlanArtifactState)) return false;
  if (!isPlanReview(value.review) || !Array.isArray(value.checklist) || !value.checklist.every(isChecklistItem)) return false;
  if (!isOptionalString(value.error) || !isOptionalTimestamp(value.createdAt) || value.createdAt === undefined) return false;
  if (!isOptionalTimestamp(value.finalizedAt) || !isOptionalTimestamp(value.executionStartedAt) || !isOptionalTimestamp(value.completedAt)) return false;
  if (value.legacy !== undefined && typeof value.legacy !== 'boolean') return false;
  if (value.models !== undefined) {
    if (!isRecord(value.models) || !isOptionalString(value.models.planner) || !isOptionalString(value.models.reviewer)) return false;
  }
  return true;
}

export function isPlanModeStateV1(value: unknown): value is PlanModeStateV1 {
  if (!isRecord(value) || value.schemaVersion !== PLAN_ARTIFACT_SCHEMA_VERSION) return false;
  if (typeof value.phase !== 'string' || !PLAN_PHASES.has(value.phase as PlanModePhase)) return false;
  return isOptionalString(value.activeArtifactId)
    && isOptionalString(value.error)
    && typeof value.updatedAt === 'number'
    && Number.isFinite(value.updatedAt)
    && value.updatedAt >= 0;
}

export function parsePlanArtifactMessageDetails(value: unknown): PlanArtifactMessageDetailsV1 | null {
  if (!isRecord(value) || value.schemaVersion !== PLAN_ARTIFACT_SCHEMA_VERSION || !isPlanArtifactV1(value.artifact)) return null;
  if (!isOptionalString(value.assistantMessageId)) return null;
  return value as unknown as PlanArtifactMessageDetailsV1;
}

export function parsePlanModeStateMessageDetails(value: unknown): PlanModeStateMessageDetailsV1 | null {
  if (!isRecord(value) || value.schemaVersion !== PLAN_ARTIFACT_SCHEMA_VERSION || !isPlanModeStateV1(value.state)) return null;
  return value as unknown as PlanModeStateMessageDetailsV1;
}

export function createLegacyPlanArtifact(messageId: string, timestamp: number): PlanArtifactV1 {
  return {
    schemaVersion: PLAN_ARTIFACT_SCHEMA_VERSION,
    kind: 'plan',
    artifactId: `legacy-${messageId}`,
    revision: 1,
    state: 'superseded',
    review: { status: 'not_requested' },
    checklist: [],
    createdAt: timestamp,
    finalizedAt: timestamp,
    legacy: true,
  };
}
