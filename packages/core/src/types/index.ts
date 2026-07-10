/**
 * Re-export all types from @craft-agent/core
 */

// Workspace and config types
export type {
  WorkspaceInfo,
  Workspace,
  RemoteServerConfig,
  McpAuthType,
  AuthType,
  OAuthCredentials,
  StoredConfig,
} from './workspace.ts';

// Session types
export type {
  Session,
  StoredSession,
  SessionMetadata,
} from './session.ts';

// Message types
export type {
  MessageRole,
  ToolStatus,
  ToolDisplayMeta,
  AttachmentType,
  MessageAttachment,
  StoredAttachment,
  ContentBadge,
  AnnotationAuthor,
  AnnotationBody,
  AnnotationIntent,
  AnnotationStatus,
  AnnotationBlockType,
  AnnotationSelector,
  AnnotationTarget,
  AnnotationV1,
  Message,
  StoredMessage,
  TokenUsage,
  AgentEventUsage,
  RecoveryAction,
  ErrorCode,
  TypedError,
  PermissionRequest,
  AgentEvent,
  // Auth-related types
  CredentialInputMode,
  AuthRequestType,
  AuthStatus,
} from './message.ts';
export { generateMessageId } from './message.ts';

export type {
  PlanArtifactState,
  PlanReviewStatus,
  PlanReviewVerdict,
  PlanChecklistItemStatus,
  PlanChecklistItemV1,
  PlanReviewV1,
  PlanArtifactV1,
  PlanModePhase,
  PlanModeStateV1,
  PlanArtifactMessageDetailsV1,
  PlanModeStateMessageDetailsV1,
  ExtensionCommandResult,
} from './plan-artifact.ts';
export {
  PLAN_ARTIFACT_SCHEMA_VERSION,
  PLAN_ARTIFACT_CUSTOM_TYPE,
  PLAN_ARTIFACT_UPDATE_CUSTOM_TYPE,
  PLAN_MODE_STATE_CUSTOM_TYPE,
  isPlanArtifactV1,
  isPlanModeStateV1,
  parsePlanArtifactMessageDetails,
  parsePlanModeStateMessageDetails,
  createLegacyPlanArtifact,
} from './plan-artifact.ts';

// Message persistence mappers
export { messageToStored, storedToMessage } from './message-mapper.ts';

// Server types (headless operations)
export type {
  ServerStatus,
  ServerHealth,
  SessionProcessingStatus,
  ActiveSessionInfo,
} from './server.ts';
