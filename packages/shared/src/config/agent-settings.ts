import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import {
  DEFAULT_COMPACTION_PROMPT,
  parseFrontmatter,
} from '@mortise/pi-coding-agent';
import { normalizeSessionToolName } from '@mortise/session-tools-core';
import {
  getSessionHostToolDefs,
  PI_EXTENSION_OWNED_SESSION_TOOL_NAMES,
} from '../agent/backend/pi/session-tool-defs.ts';
import { getSystemPrompt } from '../prompts/system.ts';
import { atomicWriteFileSync } from '../utils/files.ts';
import { PI_AGENT_DIR } from './paths.ts';
import {
  readPiMortiseSetting,
  writePiMortiseSettingsBulk,
} from './pi-global-config.ts';

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
}

export interface AgentSettingsSnapshot {
  schemaVersion: 1;
  mainAgent: MainAgentSettings;
  subagents: SubagentDefinition[];
}

export interface MainAgentSettingsUpdate {
  schemaVersion: 1;
  systemPrompt: string | null;
  compactionPrompt: string | null;
  disabledTools: string[];
}

export interface SubagentUpsert {
  schemaVersion: 1;
  previousId?: string;
  agent: SubagentDefinition;
}

const SYSTEM_PROMPT_FILE = join(PI_AGENT_DIR, 'SYSTEM.md');
const COMPACTION_PROMPT_FILE = join(PI_AGENT_DIR, 'COMPACTION.md');
const SUBAGENTS_DIR = join(PI_AGENT_DIR, 'agents');
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
    systemPrompt: '',
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

function parseSubagentFile(filePath: string): SubagentDefinition | null {
  try {
    const content = readFileSync(filePath, 'utf8');
    const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
    if (typeof frontmatter.name !== 'string' || typeof frontmatter.description !== 'string') return null;
    const tools = typeof frontmatter.tools === 'string'
      ? frontmatter.tools.trim() === 'none'
        ? []
        : normalizeToolNames(frontmatter.tools.split(',').map((tool) => tool.trim()).filter(Boolean))
      : [];
    return {
      id: basename(filePath, extname(filePath)),
      name: frontmatter.name.trim(),
      description: frontmatter.description.trim(),
      systemPrompt: body.trim(),
      tools,
    };
  } catch {
    return null;
  }
}

export function listSubagents(): SubagentDefinition[] {
  if (!existsSync(SUBAGENTS_DIR)) return [];
  return readdirSync(SUBAGENTS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => parseSubagentFile(join(SUBAGENTS_DIR, entry.name)))
    .filter((agent): agent is SubagentDefinition => agent !== null)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function getAgentSettingsSnapshot(runtimeProfile?: AgentRuntimeProfile | null): AgentSettingsSnapshot {
  const fallback = fallbackRuntimeProfile();
  const runtime = runtimeProfile ?? fallback;
  const customSystemPrompt = readTextFile(SYSTEM_PROMPT_FILE);
  const customCompactionPrompt = readTextFile(COMPACTION_PROMPT_FILE);
  const disabledTools = new Set(normalizeToolNames(readPiMortiseSetting('disabledTools', [])));
  return {
    schemaVersion: 1,
    mainAgent: {
      systemPrompt: customSystemPrompt ?? getSystemPrompt(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'Mortise Backend',
      ),
      systemPromptSource: customSystemPrompt === null ? 'default' : 'custom',
      compactionPrompt: customCompactionPrompt ?? fallback.compactionPrompt,
      compactionPromptSource: customCompactionPrompt === null ? 'default' : 'custom',
      tools: mergeToolCatalog(runtime, disabledTools),
    },
    subagents: listSubagents(),
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
  writeOptionalTextFile(SYSTEM_PROMPT_FILE, update.systemPrompt ?? '');
  writeOptionalTextFile(COMPACTION_PROMPT_FILE, update.compactionPrompt ?? '');
  writePiMortiseSettingsBulk({ disabledTools: normalizeToolNames(update.disabledTools) });
}

function assertSubagent(agent: SubagentDefinition): void {
  if (!SUBAGENT_ID_PATTERN.test(agent.id)) throw new Error('Subagent id must be a lowercase slug');
  if (!agent.name.trim()) throw new Error('Subagent name is required');
  if (!agent.description.trim()) throw new Error('Subagent description is required');
  if (!agent.systemPrompt.trim()) throw new Error('Subagent system prompt is required');
}

function serializeSubagent(agent: SubagentDefinition): string {
  const frontmatter = [
    '---',
    `name: ${JSON.stringify(agent.name.trim())}`,
    `description: ${JSON.stringify(agent.description.trim())}`,
    `tools: ${JSON.stringify(normalizeToolNames(agent.tools).join(', ') || 'none')}`,
    '---',
  ];
  return `${frontmatter.join('\n')}\n\n${agent.systemPrompt.trim()}\n`;
}

export function upsertSubagent(update: SubagentUpsert): SubagentDefinition {
  if (update.schemaVersion !== 1) throw new Error('Unsupported subagent schema version');
  assertSubagent(update.agent);
  mkdirSync(SUBAGENTS_DIR, { recursive: true });
  const targetPath = join(SUBAGENTS_DIR, `${update.agent.id}.md`);
  if (existsSync(targetPath) && update.previousId !== update.agent.id) {
    throw new Error(`Subagent id already exists: ${update.agent.id}`);
  }
  atomicWriteFileSync(targetPath, serializeSubagent(update.agent));
  if (update.previousId && update.previousId !== update.agent.id && SUBAGENT_ID_PATTERN.test(update.previousId)) {
    rmSync(join(SUBAGENTS_DIR, `${update.previousId}.md`), { force: true });
  }
  return { ...update.agent, tools: normalizeToolNames(update.agent.tools) };
}

export function deleteSubagent(id: string): void {
  if (!SUBAGENT_ID_PATTERN.test(id)) throw new Error('Invalid subagent id');
  rmSync(join(SUBAGENTS_DIR, `${id}.md`), { force: true });
}
