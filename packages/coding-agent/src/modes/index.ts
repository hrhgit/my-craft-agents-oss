/**
 * Run modes for the coding agent.
 */

export { InteractiveMode, type InteractiveModeOptions } from "./interactive/interactive-mode.ts";
export { type PrintModeOptions, runPrintMode } from "./print-mode.ts";
export {
	type ConnectPiGlobalHostOptions,
	connectPiGlobalHost,
	type LLMQueryRequest,
	type LLMQueryResult,
	type ModelInfo,
	type PiChildSessionInfo,
	PiRuntimeHandle,
	RpcClient,
	type RpcClientEvent,
	type RpcClientEventListener,
	type RpcClientOptions,
	type RpcEventListener,
	type RpcToolExecutor,
	type RpcToolPermissionHandler,
} from "./rpc/rpc-client.ts";
export { parseRpcHostUICapabilities, type RpcModeOptions, runRpcMode } from "./rpc/rpc-mode.ts";
export {
	PI_HOST_HOOKS_MODULE_ENV,
	PI_LEGACY_FETCH_INTERCEPTOR_MODULE_ENV,
	PI_RPC_COMMANDS,
	PI_RPC_PROTOCOL_VERSION,
	PI_RPC_UI_CAPABILITIES_ENV,
	type RpcBackgroundTaskEvent,
	type RpcCapabilities,
	type RpcChildSessionInfo,
	type RpcCommand,
	type RpcCommandType,
	type RpcEnvelope,
	type RpcExtensionCommandResult,
	type RpcExtensionHostCapabilityCancel,
	type RpcExtensionHostCapabilityProgress,
	type RpcExtensionHostCapabilityRequest,
	type RpcExtensionHostCapabilityResponse,
	type RpcExtensionUIValidationDeltaV1,
	type RpcExtensionUIValidationEvent,
	type RpcHostToolDefinition,
	type RpcHostToolResult,
	type RpcHostUICapabilities,
	type RpcLLMQueryRequest,
	type RpcLLMQueryResult,
	type RpcResponse,
	type RpcRuntimeOpenOptions,
	type RpcRuntimeSummary,
	type RpcSessionState,
	type RpcToolExecuteRequest,
	type RpcToolExecuteResponse,
	type RpcToolPermissionRequest,
	type RpcToolPermissionResponse,
	type RpcToolResultContent,
} from "./rpc/rpc-types.ts";
