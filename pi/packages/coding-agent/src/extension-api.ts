/** Runtime API exposed to Mortise extensions. */

export type { AgentMessage } from "@mortise/pi-agent-core";
export { getAgentDir, VERSION } from "./config.ts";
export {
	collectEntriesForBranchSummary,
	prepareBranchEntries,
	serializeConversation,
} from "./core/compaction/index.ts";
export { createEventBus } from "./core/event-bus.ts";
export {
	createHeadlessUIContext,
	defineExtensionV2,
	defineTool,
	type HeadlessUITransport,
	isBashToolResult,
	isEditToolResult,
	isFindToolResult,
	isGrepToolResult,
	isLsToolResult,
	isReadToolResult,
	isToolCallEventType,
	isWebFetchToolResult,
	isWriteToolResult,
} from "./core/extensions/index.ts";
export * from "./core/extensions/types.ts";
export { convertToLlm } from "./core/messages.ts";
export { resolveModelReference } from "./core/model-reference.ts";
export { DefaultResourceLoader, loadProjectContextFiles } from "./core/resource-loader.ts";
export { getLatestCompactionEntry, parseSessionEntries } from "./core/session-manager.ts";
export { SettingsManager } from "./core/settings-manager.ts";
export { createSyntheticSourceInfo } from "./core/source-info.ts";
export { parseFrontmatter, stripFrontmatter } from "./utils/frontmatter.ts";
