/**
 * Core modules shared between all run modes.
 */

export {
	AgentSession,
	type AgentSessionConfig,
	type AgentSessionEvent,
	type AgentSessionEventListener,
	type ModelCycleResult,
	type PromptOptions,
	type SessionStats,
} from "./agent-session.ts";
export {
	AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	type CreateAgentSessionRuntimeResult,
	createAgentSessionRuntime,
} from "./agent-session-runtime.ts";
export {
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	type CreateAgentSessionFromServicesOptions,
	type CreateAgentSessionServicesOptions,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./agent-session-services.ts";
export { type BashExecutorOptions, type BashResult, executeBashWithOperations } from "./bash-executor.ts";
export type { CompactionResult } from "./compaction/index.ts";
export { createEventBus, type EventBus, type EventBusController } from "./event-bus.ts";
// Extensions system
export {
	type AgentEndEvent,
	type AgentStartEvent,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	type BeforeAgentStartEvent,
	type BeforeAgentStartEventResult,
	type BuildSystemPromptOptions,
	type ContextEvent,
	defineTool,
	discoverAndLoadExtensions,
	type ExecOptions,
	type ExecResult,
	type Extension,
	type ExtensionAPI,
	type ExtensionCapabilitiesContext,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ExtensionError,
	type ExtensionEvent,
	type ExtensionFactory,
	type ExtensionFlag,
	type ExtensionHandler,
	type ExtensionInteractionAnswerV1,
	type ExtensionInteractionCancelReasonV1,
	type ExtensionInteractionFieldV1,
	type ExtensionInteractionRequestV1,
	type ExtensionInteractionResponseV1,
	ExtensionRunner,
	type ExtensionShortcut,
	type ExtensionUIAction,
	type ExtensionUICapabilities,
	type ExtensionUIContext,
	type ExtensionUIContribution,
	type ExtensionUIIconName,
	type ExtensionUINode,
	type ExtensionUISurface,
	type HostCapabilityError,
	type HostCapabilityInvokeOptions,
	type HostCapabilityResult,
	type LoadExtensionsResult,
	type MessageRenderer,
	type RegisteredCommand,
	type SessionBeforeCompactEvent,
	type SessionBeforeForkEvent,
	type SessionBeforeSwitchEvent,
	type SessionBeforeTreeEvent,
	type SessionCompactEvent,
	type SessionReadyEvent,
	type SessionShutdownEvent,
	type SessionStartEvent,
	type SessionTreeEvent,
	type ToolCallEvent,
	type ToolCallEventResult,
	type ToolDefinition,
	type ToolRenderResultOptions,
	type ToolResultEvent,
	type TurnEndEvent,
	type TurnStartEvent,
	type WebFetchToolCallEvent,
	type WebFetchToolResultEvent,
	type WorkingIndicatorOptions,
} from "./extensions/index.ts";
export {
	type GlobalBackgroundTaskContext,
	GlobalBackgroundTaskCoordinator,
	type GlobalBackgroundTaskEventListener,
	type GlobalBackgroundTaskHandler,
	type GlobalBackgroundTaskRequest,
	type GlobalBackgroundTaskSnapshot,
	type GlobalBackgroundTaskStatus,
	getProcessGlobalBackgroundTaskCoordinator,
} from "./global-background-tasks.ts";
export {
	createPiGlobalHost,
	PiGlobalHost,
	type PiGlobalHostOptions,
	type PiGlobalHostRuntimeOpenOptions,
	type PiGlobalHostRuntimeSnapshot,
} from "./global-host.ts";
export {
	getPiGlobalHostStatePath,
	type PiGlobalHostState,
	readPiGlobalHostState,
} from "./global-host-state.ts";
export {
	type ActiveSessionInput,
	type ActiveSessionOwnerKind,
	type ActiveSessionRecord,
	type ActiveSessionStatus,
	SessionActivityRegistry,
	type WorkspaceHistoryRecord,
} from "./session-activity-registry.ts";
export { createSyntheticSourceInfo } from "./source-info.ts";
