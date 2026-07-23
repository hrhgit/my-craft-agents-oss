/**
 * Sessions Module
 *
 * Public exports for workspace-scoped session management.
 *
 * Sessions are stored in Pi tree JSONL v3 format at
 * ~/.mortise/agent/sessions/{encoded-cwd}/{timestamp}_{sessionId}.jsonl.
 */

// Types
export type {
  SessionTokenUsage,
  StoredMessage,
  StoredSession,
  SessionHeader,
  PiSessionHeader,
  MortiseSessionMetadata,
  SessionComputedMetadata,
  MortiseSessionMetadataField,
  SessionComputedMetadataField,
} from './types.ts';

// Field constants
export {
  MORTISE_SESSION_METADATA_FIELDS,
  SESSION_COMPUTED_METADATA_FIELDS,
  RemovedSessionFieldError,
} from './types.ts';

// Storage functions
export {
  // Directory utilities
  ensureSessionsDir,
  ensureSessionDir,
  getSessionPath,
  getSessionFilePath,
  tryGetSessionFilePath,
  getSessionAttachmentsPath,
  getSessionPlansPath,
  getPiNativeSessionDir,
  getPiNativeSessionFilePath,
  ensureSharedPiTreeSessionFileAsync,
  ensureAttachmentsDir,
  // ID generation
  generateSessionId,
  // Session CRUD
  createSession,
  saveSession,
  loadSession,
  listSessions,
  deleteSession,
  getOrCreateLatestSession,
  // Metadata updates
  updateSessionMetadata,
  // Pending plan execution (Accept & Compact flow)
  setPendingPlanExecution,
  markCompactionComplete,
  markPendingPlanExecutionDispatched,
  clearPendingPlanExecution,
  getPendingPlanExecution,
  // Async persistence queue
  sessionPersistenceQueue,
  // Header metadata signature (for self-triggered event suppression)
  getHeaderMetadataSignature,
  // Shared Pi session storage mode
  setSharedPiSessionsDirForTests,
  // Pi-owned session projection facade
  findPiSessionProjectionById,
  getSharedPiSidecarPathForFile,
} from './storage.ts';

// JSONL helpers (for direct access if needed)
export {
  readSessionHeader,
  readSessionJsonl,
  writeSessionJsonl,
} from './jsonl.ts';

// Tree JSONL shared session projection (Pi/Mortise unified history format)
export {
  looksLikeTreeSessionJsonl,
  getMortiseIdFromTreeHeader,
  readTreeSessionJsonl,
  readTreeSessionMetadata,
  projectTreeSessionProjectionAsStoredSession,
  projectTreeSessionPlanData,
  writeTreeSessionMortiseMetadata,
  writeTreeSessionMortiseMetadataAsync,
  writeMortiseSessionOverlayAsync,
  appendPiBranchMessagesViaSessionManager,
  appendStoredMessagesViaPiSessionManager,
} from './tree-jsonl.ts';
export type { PiBranchMessageEntryInput } from './tree-jsonl.ts';
export {
  applyPlanCustomMessageToRuntime,
  applyPlanCustomMessageToStored,
  parsePlanCustomMessage,
} from './plan-artifact-projection.ts';
export type {
  PlanCustomMessageInput,
  PlanCustomMessageProjection,
} from './plan-artifact-projection.ts';

// Field utilities
export { pickMortiseSessionMetadata } from './utils.ts';

// Slug generator utilities
export {
  generateUniqueSessionId,
} from './slug-generator.ts';

// Session ID validation (security)
export {
  validateSessionId,
  sanitizeSessionId,
} from './validation.ts';

// Session bundle (export/import/dispatch)
export type {
  SessionBundle,
  BundleBranchInfo,
  DispatchMode,
} from './bundle.ts';
export {
  serializeSession,
  validateBundle,
} from './bundle.ts';
