/**
 * Runtime exports made available to bundled extensions.
 *
 * Keep this narrower than index.ts: the package root also exports CLI modes,
 * package management, and other cold paths that should not be parsed during
 * normal interactive startup just because extension loading is available.
 */

export { getAgentDir, VERSION } from "./config.ts";
export {
	collectEntriesForBranchSummary,
	prepareBranchEntries,
	serializeConversation,
} from "./core/compaction/index.ts";
export { createEventBus } from "./core/event-bus.ts";
// Headless UI context (for RPC / embedded modes without a TUI)
export { createHeadlessUIContext, type HeadlessUITransport } from "./core/extensions/index.ts";
export {
	defineExtensionV2,
	defineTool,
	isBashToolResult,
	isEditToolResult,
	isFindToolResult,
	isGrepToolResult,
	isLsToolResult,
	isReadToolResult,
	isToolCallEventType,
	isWebFetchToolResult,
	isWriteToolResult,
} from "./core/extensions/types.ts";
export { convertToLlm } from "./core/messages.ts";
export { DefaultResourceLoader, loadProjectContextFiles } from "./core/resource-loader.ts";
export { createAgentSession } from "./core/sdk.ts";
export {
	getLatestCompactionEntry,
	parseSessionEntries,
	SessionManager,
} from "./core/session-manager.ts";
export { SettingsManager } from "./core/settings-manager.ts";
export { createSyntheticSourceInfo } from "./core/source-info.ts";
export {
	createBashTool,
	createCodingTools,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadOnlyTools,
	createReadTool,
	createWebFetchTool,
	createWriteTool,
	withFileMutationQueue,
} from "./core/tools/index.ts";
export {
	BorderedLoader,
	CustomEditor,
	DynamicBorder,
	keyHint,
	keyText,
	rawKeyHint,
	TreeSelectorComponent,
	truncateToVisualLines,
} from "./modes/interactive/components/index.ts";
export {
	getMarkdownTheme,
	getSelectListTheme,
	getSettingsListTheme,
	highlightCode,
	initTheme,
	Theme,
} from "./modes/interactive/theme/theme.ts";
export { copyToClipboard } from "./utils/clipboard.ts";
export { parseFrontmatter, stripFrontmatter } from "./utils/frontmatter.ts";
