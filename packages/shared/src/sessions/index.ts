/**
 * Sessions Module
 *
 * Public exports for workspace-scoped session management.
 *
 * Sessions are stored in Pi tree JSONL v3 format at
 * ~/.pi/agent/sessions/{encoded-cwd}/{timestamp}_{sessionId}.jsonl.
 * Legacy JSONL format ({workspaceRootPath}/sessions/{id}/session.jsonl) is
 * supported for backward compatibility (Line 1: SessionHeader, Lines 2+: StoredMessage).
 */

// Types
export type {
  SessionStatus,
  SessionTokenUsage,
  StoredMessage,
  StoredSession,
  SessionHeader,
  PiSessionHeader,
  CraftSessionMetadata,
  SessionComputedMetadata,
  CraftSessionMetadataField,
  SessionComputedMetadataField,
} from './types.ts';

// Field constants
export {
  CRAFT_SESSION_METADATA_FIELDS,
  SESSION_COMPUTED_METADATA_FIELDS,
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
  canUpdateSdkCwd,
  // Pending plan execution (Accept & Compact flow)
  setPendingPlanExecution,
  markCompactionComplete,
  markPendingPlanExecutionDispatched,
  clearPendingPlanExecution,
  getPendingPlanExecution,
  // Session filtering
  listActiveSessions,
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

// Tree JSONL shared session projection (Pi/Craft unified history format)
export {
  looksLikeTreeSessionJsonl,
  getCraftIdFromTreeHeader,
  readTreeSessionJsonl,
  readTreeSessionMetadata,
  projectTreeSessionProjectionAsStoredSession,
  projectTreeSessionPlanData,
  writeTreeSessionCraftMetadata,
  writeCraftSessionOverlay,
  appendStoredMessagesViaPiSessionManager,
} from './tree-jsonl.ts';
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
export { pickCraftSessionMetadata, pickSessionFields } from './utils.ts';

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
  BundleFile,
  BundleBranchInfo,
  DispatchMode,
} from './bundle.ts';
export {
  serializeSession,
  validateBundle,
  MAX_BUNDLE_SIZE_BYTES,
} from './bundle.ts';
