/** Public API for the Mortise embedded headless Agent runtime. */

export { getAgentDir, getProjectConfigDir, VERSION } from "./config.ts";
export * from "./core/compaction/index.ts";
export { DEFAULT_COMPACTION_PROMPT } from "./core/compaction/compaction.ts";
export * from "./core/extensions/index.ts";
export * from "./core/index.ts";
export type { AgentSessionEvent } from "./core/agent-session.ts";
export { resolveModelReference } from "./core/model-reference.ts";
export { DefaultResourceLoader, loadProjectContextFiles, type ResourceLoader } from "./core/resource-loader.ts";
export { ResourceResolver } from "./core/resource-resolver.ts";
export { createAgentSession } from "./core/sdk.ts";
export { getLatestCompactionEntry, parseSessionEntries, SessionManager } from "./core/session-manager.ts";
export { SettingsManager } from "./core/settings-manager.ts";
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
export * from "./modes/rpc/public.ts";
export { parseFrontmatter, stripFrontmatter } from "./utils/frontmatter.ts";
