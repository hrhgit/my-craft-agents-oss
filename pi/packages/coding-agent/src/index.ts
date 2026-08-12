/** Public API for the Mortise embedded headless Agent runtime. */

export type { AgentMessage, ThinkingLevel } from "@mortise/pi-agent-core";
export { getAgentDir, getProjectConfigDir, VERSION } from "./config.ts";
export type { AgentSessionEvent } from "./core/agent-session.ts";
export { DEFAULT_COMPACTION_PROMPT } from "./core/compaction/compaction.ts";
export * from "./core/compaction/index.ts";
export * from "./core/extensions/index.ts";
export { resolveModelReference } from "./core/model-reference.ts";
export { DefaultResourceLoader, loadProjectContextFiles, type ResourceLoader } from "./core/resource-loader.ts";
export { ResourceResolver } from "./core/resource-resolver.ts";
export { getLatestCompactionEntry, parseSessionEntries } from "./core/session-manager.ts";
export { SettingsManager } from "./core/settings-manager.ts";
export { buildSystemPrompt } from "./core/system-prompt.ts";
export { parseFrontmatter, stripFrontmatter } from "./utils/frontmatter.ts";
