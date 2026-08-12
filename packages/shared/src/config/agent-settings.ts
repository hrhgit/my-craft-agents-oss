import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import {
  buildSystemPrompt,
  DEFAULT_COMPACTION_PROMPT,
  parseFrontmatter,
} from '@mortise/pi-coding-agent';
import { createAllToolDefinitions } from '@mortise/pi-coding-agent/internal/host-facade';
import { normalizeSessionToolName } from '@mortise/session-tools-core';
import {
  getSessionHostToolDefs,
  PI_EXTENSION_OWNED_SESSION_TOOL_NAMES,
} from '../agent/backend/pi/session-tool-defs.ts';
import { atomicWriteFileSync } from '../utils/files.ts';
import { MORTISE_PROJECT_DIR } from './paths.ts';
import {
  getPiAgentDir,
  getPiExtensionCatalog,
  readPiMortiseSetting,
  writePiMortiseSettingsBulk,
} from './pi-global-config.ts';
import type { PiExtensionCatalogEntry } from './pi-extension-settings.ts';

export interface AgentToolDescriptor {
  name: string;
  description: string;
  source: 'builtin' | 'extension' | 'host';
  enabled: boolean;
}

export interface AgentRuntimeProfile {
  systemPrompt: string;
  compactionPrompt: string;
  activeTools: string[];
  tools: Array<Omit<AgentToolDescriptor, 'enabled'>>;
}

export interface MainAgentSettings {
  systemPrompt: string;
  systemPromptSource: 'default' | 'custom';
  compactionPrompt: string;
  compactionPromptSource: 'default' | 'custom';
  tools: AgentToolDescriptor[];
}

export interface SubagentDefinition {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  /** Semantic model reference. Omitted means current session model. */
  model?: string;
  thinkingLevel?: import('../agent/thinking-levels.ts').ThinkingLevel;
}

export type SubagentTemplate = SubagentDefinition & (
  | { source: 'global' | 'workspace'; editable: true; path: string }
  | { source: 'extension'; editable: false; extensionId: string }
);

export interface SubagentConfigDiagnostic {
  path: string;
  message: string;
}

export interface SubagentConfigResult {
  agents: SubagentTemplate[];
  diagnostics: SubagentConfigDiagnostic[];
}

export interface AgentSettingsSnapshot {
  schemaVersion: 1;
  mainAgent: MainAgentSettings;
}

export interface MainAgentSettingsUpdate {
  schemaVersion: 1;
  systemPrompt: string | null;
  compactionPrompt: string | null;
  disabledTools: string[];
}

const PI_AGENT_DIR = getPiAgentDir();
const SYSTEM_PROMPT_FILE = join(PI_AGENT_DIR, 'SYSTEM.md');
const COMPACTION_PROMPT_FILE = join(PI_AGENT_DIR, 'COMPACTION.md');
const SUBAGENT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const BUILTIN_TOOL_DESCRIPTIONS: Record<string, string> = {
  read: 'Read file contents',
  pwsh: 'Run PowerShell commands',
  bash: 'Run shell commands',
  edit: 'Apply precise edits to files',
  write: 'Create or replace files',
  web_fetch: 'Fetch content from a URL',
  grep: 'Search file contents',
  find: 'Find files by path pattern',
  ls: 'List directory contents',
};

function readTextFile(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
}

function writeOptionalTextFile(path: string, value: string): void {
  const normalized = value.trim();
  if (!normalized) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(PI_AGENT_DIR, { recursive: true });
  atomicWriteFileSync(path, `${normalized}\n`);
}

function normalizeToolNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim())
      .map((name) => normalizeSessionToolName(name) ?? name),
  )];
}

export function getPiNativeSystemPrompt(cwd = process.cwd()): string {
  const definitions = createAllToolDefinitions(cwd);
  const selectedTools = Object.keys(definitions);
  const toolSnippets = Object.fromEntries(
    Object.entries(definitions)
      .filter(([, definition]) => Boolean(definition.promptSnippet))
      .map(([name, definition]) => [name, definition.promptSnippet!]),
  );
  const promptGuidelines = Object.values(definitions).flatMap((definition) => definition.promptGuidelines ?? []);
  return buildSystemPrompt({ cwd, selectedTools, toolSnippets, promptGuidelines });
}

function fallbackRuntimeProfile(): AgentRuntimeProfile {
  const shellTool = process.platform === 'win32' ? 'pwsh' : 'bash';
  const builtinNames = ['read', shellTool, 'edit', 'write', 'grep', 'find', 'ls', 'web_fetch'];
  const hostTools = getSessionHostToolDefs().map((tool) => ({
    name: tool.name,
    description: tool.description,
    source: PI_EXTENSION_OWNED_SESSION_TOOL_NAMES.has(tool.name) ? 'extension' as const : 'host' as const,
  }));
  const tools = [
    ...builtinNames.map((name) => ({
      name,
      description: BUILTIN_TOOL_DESCRIPTIONS[name] ?? name,
      source: 'builtin' as const,
    })),
    ...hostTools,
  ];
  return {
    systemPrompt: getPiNativeSystemPrompt(),
    compactionPrompt: DEFAULT_COMPACTION_PROMPT,
    activeTools: tools.map((tool) => tool.name),
    tools,
  };
}

function mergeToolCatalog(runtime: AgentRuntimeProfile, disabledTools: Set<string>): AgentToolDescriptor[] {
  const catalog = new Map(runtime.tools.map((tool) => [tool.name, tool]));
  for (const name of disabledTools) {
    if (!catalog.has(name)) {
      catalog.set(name, { name, description: name, source: 'host' });
    }
  }
  return [...catalog.values()]
    .map((tool) => ({ ...tool, enabled: !disabledTools.has(tool.name) }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function parseSubagentFile(filePath: string): { agent?: SubagentDefinition; diagnostic?: SubagentConfigDiagnostic } {
  try {
    const content = readFileSync(filePath, 'utf8');
    const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
    const id = basename(filePath, extname(filePath));
    if (!SUBAGENT_ID_PATTERN.test(id)) return { diagnostic: { path: filePath, message: 'Agent file name must be a lowercase slug' } };
    if (
      typeof frontmatter.name !== 'string'
      || !frontmatter.name.trim()
      || frontmatter.name.length > 16_000
      || typeof frontmatter.description !== 'string'
      || !frontmatter.description.trim()
      || frontmatter.description.length > 16_000
      || !Object.hasOwn(frontmatter, 'tools')
      || !body.trim()
      || body.length > 16_000
    ) return { diagnostic: { path: filePath, message: 'Agent requires name, description, tools, and a non-empty system prompt' } };
    const tools = typeof frontmatter.tools === 'string'
      ? frontmatter.tools.trim() === 'none'
        ? []
        : normalizeToolNames(frontmatter.tools.split(',').map((tool) => tool.trim()).filter(Boolean))
      : normalizeToolNames(frontmatter.tools);
    const thinkingLevel = typeof frontmatter.thinkingLevel === 'string'
      && ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(frontmatter.thinkingLevel)
      ? frontmatter.thinkingLevel as import('../agent/thinking-levels.ts').ThinkingLevel
      : undefined;
    return { agent: {
      id,
      name: frontmatter.name.trim(),
      description: frontmatter.description.trim(),
      systemPrompt: body.trim(),
      tools,
      ...(typeof frontmatter.model === 'string' && frontmatter.model.trim() ? { model: frontmatter.model.trim() } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
    } };
  } catch (error) {
    return { diagnostic: { path: filePath, message: error instanceof Error ? error.message : String(error) } };
  }
}

function readSubagentDirectory(dir: string, source: 'global' | 'workspace'): SubagentConfigResult {
  if (!existsSync(dir)) return { agents: [], diagnostics: [] };
  const agents: SubagentTemplate[] = [];
  const diagnostics: SubagentConfigDiagnostic[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const path = join(dir, entry.name);
    const parsed = parseSubagentFile(path);
    if (parsed.agent) agents.push({ ...parsed.agent, source, editable: true, path });
    if (parsed.diagnostic) diagnostics.push(parsed.diagnostic);
  }
  return { agents, diagnostics };
}

export function normalizeSubagentTemplates(
  globalTemplates: SubagentTemplate[],
  workspaceTemplates: SubagentTemplate[],
  extensionCatalog: PiExtensionCatalogEntry[],
): SubagentTemplate[] {
  const templates = new Map(globalTemplates.map(template => [template.id, template]));
  for (const template of workspaceTemplates) templates.set(template.id, template);

  for (const extension of extensionCatalog) {
    if (!extension.loadable || extension.manifestStatus === 'blocked') continue;
    for (const template of extension.manifest?.subagents ?? []) {
      const namespaced = {
        ...template,
        id: `${extension.id}:${template.id}`,
        tools: normalizeToolNames(template.tools),
        source: 'extension',
        editable: false,
        extensionId: extension.id,
      } satisfies SubagentTemplate;
      templates.set(namespaced.id, namespaced);
    }
  }

  return [...templates.values()].sort((left, right) =>
    left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

export async function listSubagentTemplates(
  options: { cwd?: string; agentDir?: string } = {},
): Promise<SubagentTemplate[]> {
  return (await resolveSubagentConfigs(options)).agents;
}

export async function resolveSubagentConfigs(
  options: { cwd?: string; agentDir?: string } = {},
): Promise<SubagentConfigResult> {
  const globalDir = join(options.agentDir ?? getPiAgentDir(), 'agents');
  const workspaceDir = join(options.cwd ?? process.cwd(), MORTISE_PROJECT_DIR, 'agents');
  const global = readSubagentDirectory(globalDir, 'global');
  const workspace = readSubagentDirectory(workspaceDir, 'workspace');
  const catalog = await getPiExtensionCatalog(options);
  return {
    agents: normalizeSubagentTemplates(global.agents, workspace.agents, catalog.extensions),
    diagnostics: [...global.diagnostics, ...workspace.diagnostics],
  };
}

export async function getAgentSettingsSnapshot(
  runtimeProfile?: AgentRuntimeProfile | null,
  options: { cwd?: string; agentDir?: string } = {},
): Promise<AgentSettingsSnapshot> {
  const fallback = fallbackRuntimeProfile();
  const runtime = runtimeProfile ?? fallback;
  const customSystemPrompt = readTextFile(SYSTEM_PROMPT_FILE);
  const customCompactionPrompt = readTextFile(COMPACTION_PROMPT_FILE);
  const disabledTools = new Set(normalizeToolNames(readPiMortiseSetting('disabledTools', [])));
  return {
    schemaVersion: 1,
    mainAgent: {
      systemPrompt: customSystemPrompt ?? (runtime.systemPrompt.trim() || fallback.systemPrompt),
      systemPromptSource: customSystemPrompt === null ? 'default' : 'custom',
      compactionPrompt: customCompactionPrompt ?? fallback.compactionPrompt,
      compactionPromptSource: customCompactionPrompt === null ? 'default' : 'custom',
      tools: mergeToolCatalog(runtime, disabledTools),
    },
  };
}

export function getDisabledAgentTools(): string[] {
  return normalizeToolNames(readPiMortiseSetting('disabledTools', []));
}

export function getCustomSystemPrompt(): string | undefined {
  return readTextFile(SYSTEM_PROMPT_FILE) ?? undefined;
}

export function resolveMainAgentSystemPrompt(defaultPrompt: string): string {
  return getCustomSystemPrompt() ?? defaultPrompt;
}

export function getCustomCompactionPrompt(): string | undefined {
  return readTextFile(COMPACTION_PROMPT_FILE) ?? undefined;
}

export function updateMainAgentSettings(update: MainAgentSettingsUpdate): void {
  if (update.schemaVersion !== 1) throw new Error('Unsupported agent settings schema version');
  // Reset means restore Pi's native prompt as the Mortise-managed base. Keep it
  // in SYSTEM.md so the runtime always uses the same host override path.
  writeOptionalTextFile(SYSTEM_PROMPT_FILE, update.systemPrompt ?? getPiNativeSystemPrompt());
  writeOptionalTextFile(COMPACTION_PROMPT_FILE, update.compactionPrompt ?? '');
  writePiMortiseSettingsBulk({ disabledTools: normalizeToolNames(update.disabledTools) });
}
