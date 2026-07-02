/**
 * Tree JSONL session projection.
 *
 * This understands Pi v3-style append-only session logs and projects them into
 * Craft's flat StoredSession/StoredMessage shape for existing UI surfaces.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import type { MessageRole } from '@craft-agent/core/types';
import type { SessionHeader, SessionMetadata, StoredMessage, StoredSession } from './types.ts';
import { debug } from '../utils/debug.ts';
import { expandPath, toPortablePath } from '../utils/paths.ts';

export interface TreeSessionHeader {
  type: 'session';
  version?: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
  craft?: Partial<SessionHeader>;
}

const TREE_SESSION_FILE_LOCK_STALE_MS = 30_000;
const TREE_SESSION_FILE_LOCK_RETRY_DELAY_MS = 25;
const TREE_SESSION_FILE_LOCK_RETRY_COUNT = 1_400;
const treeSessionFileLockSleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  Atomics.wait(treeSessionFileLockSleepBuffer, 0, 0, ms);
}

function acquireTreeSessionFileLock(sessionFile: string): () => void {
  const lockDir = `${sessionFile}.lock`;
  let lastError: unknown;

  for (let attempt = 1; attempt <= TREE_SESSION_FILE_LOCK_RETRY_COUNT; attempt++) {
    try {
      mkdirSync(lockDir);
      return () => {
        try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* ignore */ }
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        throw error;
      }

      try {
        const lockStat = statSync(lockDir);
        if (lockStat.mtimeMs < Date.now() - TREE_SESSION_FILE_LOCK_STALE_MS) {
          rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch (statError) {
        const statCode = (statError as NodeJS.ErrnoException).code;
        if (statCode !== 'ENOENT') {
          throw statError;
        }
      }

      if (attempt === TREE_SESSION_FILE_LOCK_RETRY_COUNT) {
        throw error;
      }
      lastError = error;
      sleepSync(TREE_SESSION_FILE_LOCK_RETRY_DELAY_MS);
    }
  }

  throw (lastError as Error) ?? new Error(`Failed to acquire tree session file lock: ${sessionFile}`);
}

interface TreeEntryBase {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}

interface TreeMessageEntry extends TreeEntryBase {
  type: 'message';
  message: TreeAgentMessage;
}

interface TreeCompactionEntry extends TreeEntryBase {
  type: 'compaction';
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
}

interface TreeBranchSummaryEntry extends TreeEntryBase {
  type: 'branch_summary';
  fromId: string;
  summary: string;
}

interface TreeCustomMessageEntry extends TreeEntryBase {
  type: 'custom_message';
  customType: string;
  content: string | TreeContentBlock[];
  display: boolean;
  details?: unknown;
}

interface TreeSessionInfoEntry extends TreeEntryBase {
  type: 'session_info';
  name?: string;
}

interface TreeLabelEntry extends TreeEntryBase {
  type: 'label';
  targetId: string;
  label?: string;
}

type TreeSessionEntry =
  | TreeMessageEntry
  | TreeCompactionEntry
  | TreeBranchSummaryEntry
  | TreeCustomMessageEntry
  | TreeSessionInfoEntry
  | TreeLabelEntry
  | TreeEntryBase;

interface TreeContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  arguments?: unknown;
  tool_use_id?: string;
  toolCallId?: string;
  toolName?: string;
  content?: unknown;
}

interface TreeAgentMessage {
  role?: string;
  content?: string | TreeContentBlock[];
  timestamp?: number;
  provider?: string;
  model?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
    cost?: {
      total?: number;
    };
  };
  toolCallId?: string;
  toolName?: string;
  command?: string;
  output?: string;
  exitCode?: number;
  cancelled?: boolean;
  truncated?: boolean;
  fullOutputPath?: string;
  excludeFromContext?: boolean;
  isError?: boolean;
  summary?: string;
  tokensBefore?: number;
  fromId?: string;
  customType?: string;
  display?: boolean;
}

interface ParsedTreeSession {
  header: TreeSessionHeader;
  entries: TreeSessionEntry[];
}

export interface TreeProjectionOptions {
  workspaceRootPath?: string;
  sessionFilePath?: string;
  sessionIdPrefix?: string;
  leafId?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function isTreeSessionHeader(value: unknown): value is TreeSessionHeader {
  return isRecord(value)
    && value.type === 'session'
    && typeof value.id === 'string'
    && typeof value.timestamp === 'string'
    && typeof value.cwd === 'string';
}

/**
 * Read only the header (first line) from a tree session JSONL file.
 *
 * Unlike {@link readTreeSessionJsonl}, this reads at most 8KB and avoids
 * parsing the (potentially huge) message body. It is intended for sessionId
 * lookup scenarios (e.g. findSharedPiSessionFileInDir) that only need the
 * header's `id` / `craft.id` fields.
 */
export function readTreeSessionHeader(sessionFile: string): TreeSessionHeader | null {
  try {
    const fd = openSync(sessionFile, 'r');
    const buffer = Buffer.alloc(8192); // 8KB is plenty for the tree session header
    const bytesRead = readSync(fd, buffer, 0, 8192, 0);
    closeSync(fd);
    if (bytesRead <= 0) return null;
    const content = buffer.toString('utf-8', 0, bytesRead);
    const firstNewline = content.indexOf('\n');
    const firstLine = firstNewline > 0 ? content.slice(0, firstNewline) : content;
    if (!firstLine.trim()) return null;
    const parsed = JSON.parse(firstLine) as unknown;
    if (!isTreeSessionHeader(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function looksLikeTreeSessionJsonl(sessionFile: string): boolean {
  try {
    if (!existsSync(sessionFile)) return false;
    const content = readFileSync(sessionFile, 'utf-8');
    const firstLine = content.split('\n').find(line => line.trim().length > 0);
    if (!firstLine) return false;
    return isTreeSessionHeader(JSON.parse(firstLine));
  } catch {
    return false;
  }
}

export function readTreeSessionJsonl(sessionFile: string): ParsedTreeSession | null {
  try {
    const content = readFileSync(sessionFile, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    if (lines.length === 0) return null;

    const header = JSON.parse(lines[0]!) as unknown;
    if (!isTreeSessionHeader(header)) return null;

    const entries: TreeSessionEntry[] = [];
    for (const line of lines.slice(1)) {
      try {
        const parsed = JSON.parse(line) as unknown;
        if (isTreeEntry(parsed)) entries.push(parsed);
      } catch {
        debug('[tree-jsonl] Skipping malformed tree session line:', line.substring(0, 100));
      }
    }

    return { header, entries };
  } catch (error) {
    debug('[tree-jsonl] Failed to read tree session:', sessionFile, error);
    return null;
  }
}

export function writeTreeSessionCraftMetadata(sessionFile: string, session: StoredSession): boolean {
  const release = acquireTreeSessionFileLock(sessionFile);
  try {
    const content = readFileSync(sessionFile, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    if (lines.length === 0) return false;

    const header = JSON.parse(lines[0]!) as unknown;
    if (!isTreeSessionHeader(header)) return false;

    const previousCraft = isRecord(header.craft) ? header.craft as Partial<SessionHeader> : {};
    const craftMetadata: Partial<SessionHeader> = {
      ...previousCraft,
      id: session.id,
      sdkSessionId: session.sdkSessionId,
      name: session.name,
      createdAt: session.createdAt,
      lastMessageAt: session.lastMessageAt,
      isFlagged: session.isFlagged,
      permissionMode: session.permissionMode,
      previousPermissionMode: session.previousPermissionMode,
      sessionStatus: session.sessionStatus,
      labels: session.labels,
      lastReadMessageId: session.lastReadMessageId,
      hasUnread: session.hasUnread,
      enabledSourceSlugs: session.enabledSourceSlugs,
      workingDirectory: session.workingDirectory,
      sdkCwd: session.sdkCwd,
      sharedUrl: session.sharedUrl,
      sharedId: session.sharedId,
      model: session.model,
      llmConnection: session.llmConnection,
      connectionLocked: session.connectionLocked,
      thinkingLevel: session.thinkingLevel,
      pendingPlanExecution: session.pendingPlanExecution,
      hidden: session.hidden,
      isArchived: session.isArchived,
      archivedAt: session.archivedAt,
      branchFromMessageId: session.branchFromMessageId,
      branchFromSdkSessionId: session.branchFromSdkSessionId,
      branchFromSessionPath: session.branchFromSessionPath,
      branchFromPiSessionFile: session.branchFromPiSessionFile,
      branchFromSdkCwd: session.branchFromSdkCwd,
      branchFromSdkTurnId: session.branchFromSdkTurnId,
      transferredSessionSummary: session.transferredSessionSummary,
      transferredSessionSummaryApplied: session.transferredSessionSummaryApplied,
      triggeredBy: session.triggeredBy,
      workspaceRootPath: toPortablePath(session.workspaceRootPath),
      lastUsedAt: Date.now(),
      messageCount: session.messages.length,
      preview: extractPreview(session.messages),
      lastMessageRole: extractLastMessageRole(session.messages),
      lastFinalMessageId: extractLastFinalMessageId(session.messages),
      tokenUsage: session.tokenUsage,
    };

    const updatedHeader: TreeSessionHeader = {
      ...header,
      craft: craftMetadata,
    };

    const tmpFile = sessionFile + '.tmp';
    writeFileSync(tmpFile, [JSON.stringify(updatedHeader), ...lines.slice(1)].join('\n') + '\n');
    try { unlinkSync(sessionFile); } catch { /* ignore */ }
    renameSync(tmpFile, sessionFile);
    return true;
  } catch (error) {
    debug('[tree-jsonl] Failed to update tree session Craft metadata:', sessionFile, error);
    return false;
  } finally {
    release();
  }
}

function isTreeEntry(value: unknown): value is TreeSessionEntry {
  return isRecord(value)
    && typeof value.type === 'string'
    && typeof value.id === 'string'
    && (typeof value.parentId === 'string' || value.parentId === null)
    && typeof value.timestamp === 'string';
}

function timestampMs(entryTimestamp: string, messageTimestamp?: number): number {
  if (typeof messageTimestamp === 'number' && Number.isFinite(messageTimestamp)) {
    return messageTimestamp;
  }
  const parsed = new Date(entryTimestamp).getTime();
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function stringifyUnknown(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .map(block => {
      if (!isRecord(block)) return '';
      if (block.type === 'text' && typeof block.text === 'string') return block.text;
      if (block.type === 'thinking' && typeof block.thinking === 'string') return block.thinking;
      if (block.type === 'image') return '[image]';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function normalizeToolInput(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function toolResultText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return extractTextFromContent(value);
  return stringifyUnknown(value);
}

function appendContentBlockMessages(
  out: StoredMessage[],
  entry: TreeEntryBase,
  role: MessageRole,
  content: TreeContentBlock[],
  messageTimestamp?: number,
): void {
  const textParts: string[] = [];
  const ts = timestampMs(entry.timestamp, messageTimestamp);

  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      textParts.push(block.text);
    } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
      textParts.push(block.thinking);
    } else if (block.type === 'toolCall' || block.type === 'tool_use') {
      const toolUseId = typeof block.id === 'string' ? block.id : `${entry.id}-tool-${out.length}`;
      const toolInput = block.type === 'toolCall' ? block.arguments : block.input;
      out.push({
        id: `${entry.id}-tool-${toolUseId}`,
        type: 'tool',
        content: '',
        timestamp: ts,
        toolName: typeof block.name === 'string' ? block.name : undefined,
        toolUseId,
        toolInput: normalizeToolInput(toolInput),
        toolStatus: 'completed',
      });
    } else if (block.type === 'tool_result') {
      const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : `${entry.id}-result-${out.length}`;
      const result = toolResultText(block.content);
      out.push({
        id: `${entry.id}-result-${toolUseId}`,
        type: 'tool',
        content: '',
        timestamp: ts,
        toolUseId,
        toolResult: result,
        toolStatus: 'completed',
      });
    } else if (block.type === 'image') {
      textParts.push('[image]');
    }
  }

  if (textParts.length > 0) {
    out.push({
      id: entry.id,
      type: role,
      content: textParts.join('\n'),
      timestamp: ts,
    });
  }
}

function appendAgentMessage(out: StoredMessage[], entry: TreeMessageEntry): void {
  const message = entry.message;
  const roleRaw = message.role;
  const ts = timestampMs(entry.timestamp, message.timestamp);

  if (roleRaw === 'user' || roleRaw === 'assistant') {
    const content = message.content;
    if (typeof content === 'string') {
      out.push({ id: entry.id, type: roleRaw, content, timestamp: ts });
    } else if (Array.isArray(content)) {
      appendContentBlockMessages(out, entry, roleRaw, content, message.timestamp);
    }
    return;
  }

  if (roleRaw === 'toolResult') {
    out.push({
      id: entry.id,
      type: 'tool',
      content: '',
      timestamp: ts,
      toolName: typeof message.toolName === 'string' ? message.toolName : undefined,
      toolUseId: typeof message.toolCallId === 'string' ? message.toolCallId : undefined,
      toolResult: toolResultText(message.content),
      toolStatus: message.isError ? 'error' : 'completed',
      isError: !!message.isError,
    });
    return;
  }

  if (roleRaw === 'bashExecution') {
    const result = [
      typeof message.output === 'string' ? message.output : '',
      message.cancelled ? '\n(command cancelled)' : '',
      typeof message.exitCode === 'number' && message.exitCode !== 0 ? `\nCommand exited with code ${message.exitCode}` : '',
      message.truncated && message.fullOutputPath ? `\n[Output truncated. Full output: ${message.fullOutputPath}]` : '',
    ].join('').trim();
    out.push({
      id: entry.id,
      type: 'tool',
      content: '',
      timestamp: ts,
      toolName: 'bash',
      toolUseId: entry.id,
      toolInput: typeof message.command === 'string' ? { command: message.command } : undefined,
      toolResult: result,
      toolStatus: typeof message.exitCode === 'number' && message.exitCode !== 0 ? 'error' : 'completed',
      isError: typeof message.exitCode === 'number' && message.exitCode !== 0,
    });
    return;
  }

  if (roleRaw === 'custom') {
    if (message.display === false) return;
    out.push({
      id: entry.id,
      type: 'info',
      content: extractTextFromContent(message.content),
      timestamp: ts,
      infoLevel: 'info',
    });
    return;
  }

  if (roleRaw === 'branchSummary') {
    out.push({
      id: entry.id,
      type: 'info',
      content: typeof message.summary === 'string' ? message.summary : '',
      timestamp: ts,
      infoLevel: 'info',
    });
    return;
  }

  if (roleRaw === 'compactionSummary') {
    out.push({
      id: entry.id,
      type: 'status',
      content: typeof message.summary === 'string' ? message.summary : '',
      timestamp: ts,
      statusType: 'compaction_complete',
    });
  }
}

function buildEntryMap(entries: TreeSessionEntry[]): Map<string, TreeSessionEntry> {
  const byId = new Map<string, TreeSessionEntry>();
  for (const entry of entries) byId.set(entry.id, entry);
  return byId;
}

function resolveLeaf(entries: TreeSessionEntry[], byId: Map<string, TreeSessionEntry>, leafId?: string | null): TreeSessionEntry | undefined {
  if (leafId === null) return undefined;
  if (leafId && byId.has(leafId)) return byId.get(leafId);
  return entries[entries.length - 1];
}

function getBranch(entries: TreeSessionEntry[], leafId?: string | null): TreeSessionEntry[] {
  const byId = buildEntryMap(entries);
  const leaf = resolveLeaf(entries, byId, leafId);
  if (!leaf) return [];

  const path: TreeSessionEntry[] = [];
  const seen = new Set<string>();
  let current: TreeSessionEntry | undefined = leaf;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path;
}

function appendTreeEntryProjection(out: StoredMessage[], entry: TreeSessionEntry): void {
  if (entry.type === 'message' && 'message' in entry) {
    appendAgentMessage(out, entry);
  } else if (entry.type === 'custom_message' && 'content' in entry) {
    if (entry.display === false) return;
    out.push({
      id: entry.id,
      type: 'info',
      content: extractTextFromContent(entry.content),
      timestamp: timestampMs(entry.timestamp),
      infoLevel: 'info',
    });
  } else if (entry.type === 'branch_summary' && 'summary' in entry) {
    out.push({
      id: entry.id,
      type: 'info',
      content: entry.summary,
      timestamp: timestampMs(entry.timestamp),
      infoLevel: 'info',
    });
  } else if (entry.type === 'compaction' && 'summary' in entry) {
    out.push({
      id: entry.id,
      type: 'status',
      content: entry.summary,
      timestamp: timestampMs(entry.timestamp),
      statusType: 'compaction_complete',
    });
  }
}

export function projectTreeSessionMessages(entries: TreeSessionEntry[], leafId?: string | null): StoredMessage[] {
  const branch = getBranch(entries, leafId);
  const messages: StoredMessage[] = [];
  for (const entry of branch) {
    appendTreeEntryProjection(messages, entry);
  }
  return messages;
}

function latestSessionName(entries: TreeSessionEntry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type === 'session_info' && 'name' in entry) {
      const name = typeof entry.name === 'string' ? entry.name.trim() : '';
      return name || undefined;
    }
  }
  return undefined;
}

function tokenUsageFromMessages(messages: StoredMessage[]) {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    contextTokens: 0,
    costUsd: 0,
  };
}

function extractPreview(messages: StoredMessage[]): string | undefined {
  const firstUser = messages.find(message => message.type === 'user');
  if (!firstUser?.content) return undefined;
  const preview = firstUser.content.replace(/\s+/g, ' ').trim().slice(0, 150);
  return preview || undefined;
}

function extractLastMessageRole(messages: StoredMessage[]): SessionHeader['lastMessageRole'] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const role = messages[i]?.type;
    if (role === 'user' || role === 'assistant' || role === 'plan' || role === 'tool' || role === 'error') {
      return role;
    }
  }
  return undefined;
}

function extractLastFinalMessageId(messages: StoredMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.type === 'assistant' && !msg.isIntermediate) return msg.id;
  }
  return undefined;
}

export function readTreeSessionAsStoredSession(
  sessionFile: string,
  options: TreeProjectionOptions = {},
): StoredSession | null {
  const parsed = readTreeSessionJsonl(sessionFile);
  if (!parsed) return null;

  const messages = projectTreeSessionMessages(parsed.entries, options.leafId);
  const createdAt = new Date(parsed.header.timestamp).getTime() || Date.now();
  const stat = existsSync(sessionFile) ? statSync(sessionFile) : undefined;
  const lastUsedAt = stat?.mtimeMs ?? createdAt;
  const workspaceRootPath = options.workspaceRootPath ?? parsed.header.craft?.workspaceRootPath ?? parsed.header.cwd ?? dirname(sessionFile);
  const id = `${options.sessionIdPrefix ?? ''}${parsed.header.id}`;
  const craft = parsed.header.craft ?? {};

  return {
    ...craft,
    id,
    workspaceRootPath: expandPath(workspaceRootPath),
    sdkSessionId: craft.sdkSessionId ?? parsed.header.id,
    createdAt: craft.createdAt ?? createdAt,
    lastUsedAt: craft.lastUsedAt ?? lastUsedAt,
    lastMessageAt: craft.lastMessageAt ?? lastUsedAt,
    name: craft.name ?? latestSessionName(parsed.entries),
    workingDirectory: craft.workingDirectory ?? parsed.header.cwd,
    sdkCwd: craft.sdkCwd ?? parsed.header.cwd,
    messages,
    tokenUsage: craft.tokenUsage ?? tokenUsageFromMessages(messages),
  } as StoredSession;
}

export function readTreeSessionMetadata(
  sessionFile: string,
  workspaceRootPath?: string,
  sessionIdPrefix = '',
): SessionMetadata | null {
  const stored = readTreeSessionAsStoredSession(sessionFile, {
    workspaceRootPath: workspaceRootPath || undefined,
    sessionIdPrefix,
  });
  if (!stored) return null;

  return {
    id: stored.id,
    workspaceRootPath: stored.workspaceRootPath,
    name: stored.name,
    createdAt: stored.createdAt,
    lastUsedAt: stored.lastUsedAt,
    lastMessageAt: stored.lastMessageAt,
    messageCount: stored.messages.length,
    preview: extractPreview(stored.messages),
    sdkSessionId: stored.sdkSessionId,
    workingDirectory: stored.workingDirectory,
    sdkCwd: stored.sdkCwd,
    lastMessageRole: extractLastMessageRole(stored.messages),
    lastFinalMessageId: extractLastFinalMessageId(stored.messages),
    tokenUsage: stored.tokenUsage,
    labels: stored.labels,
    sessionStatus: stored.sessionStatus,
    isFlagged: stored.isFlagged,
    hidden: stored.hidden,
    isArchived: stored.isArchived,
    archivedAt: stored.archivedAt,
    branchFromMessageId: stored.branchFromMessageId,
    branchFromSdkSessionId: stored.branchFromSdkSessionId,
    branchFromSessionPath: stored.branchFromSessionPath,
    branchFromPiSessionFile: stored.branchFromPiSessionFile,
    branchFromSdkCwd: stored.branchFromSdkCwd,
    branchFromSdkTurnId: stored.branchFromSdkTurnId,
  };
}
