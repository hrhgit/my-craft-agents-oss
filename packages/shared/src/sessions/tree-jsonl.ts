/**
 * Tree JSONL session projection.
 *
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from 'fs';
import { dirname, join } from 'path';
import {
  SessionManager as PiSessionManager,
  setCraftSessionMetadata as setPiCraftSessionMetadata,
} from '@earendil-works/pi-coding-agent/host-facade';
import type { MessageRole } from '@craft-agent/core/types';
import type {
  CraftSessionMetadata,
  SessionComputedMetadata,
  SessionHeader,
  SessionTokenUsage,
  StoredMessage,
  StoredSession,
} from './types.ts';
import { pickCraftSessionMetadata } from './utils.ts';
import { sanitizeSessionId } from './validation.ts';
import { debug } from '../utils/debug.ts';
import { expandPath, toPortablePath } from '../utils/paths.ts';
import { atomicWriteFileSync } from '../utils/files.ts';
import { applyPlanCustomMessageToStored } from './plan-artifact-projection.ts';
import type { PlanModeStateV1 } from '@craft-agent/core/types';

/**
 * On-disk shape of Craft extension fields in Pi tree JSONL v3 header.
 *
 * Maps `id` ↔ `CraftSessionMetadata.craftId`.
 */
export type CraftMetadataOnDisk =
  Partial<Omit<CraftSessionMetadata, 'craftId'>>
  & Partial<SessionComputedMetadata>
  & {
  /** Craft session ID (on-disk 字段名是 id，对应 SessionHeader.craftId) */
  id?: string;
};

export interface TreeSessionSpawnConfig {
  connection?: string;
  model?: string;
  enabledSources?: string[];
  permissionMode?: string;
  thinkingLevel?: string;
}

/** On-disk Pi tree JSONL v3 header (file 第一行). */
export interface TreeSessionHeader {
  type: 'session';
  version?: number;
  /** Pi session UUID (Pi runtime 主键). The Craft session ID is stored in `craft.id`. */
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
  /** Pi shell-spawn parent session ID, used by spawn_session/listChildSessions. */
  spawnedFrom?: string;
  spawnConfig?: TreeSessionSpawnConfig;
  craft?: CraftMetadataOnDisk;
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

interface CraftOverlayFile {
  version: 1;
  messages?: Array<Partial<StoredMessage> & { id: string }>;
  annotations?: Record<string, StoredMessage['annotations']>;
}

export interface TreeProjectionOptions {
  workspaceRootPath?: string;
  sessionFilePath?: string;
  sessionIdPrefix?: string;
  leafId?: string | null;
}

export interface TreeSessionProjectionLike {
  path?: string;
  sessionDir?: string;
  cwd?: string;
  leafId?: string | null;
  header: unknown;
  entries: unknown[];
}

export interface WriteTreeSessionCraftMetadataOptions {
  lastWrittenHeaderSignature?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function getCraftIdFromTreeHeader(
  header: TreeSessionHeader,
  sessionIdPrefix = '',
): string {
  return header.craft?.id ?? `${sessionIdPrefix}${header.id}`;
}

function getCraftHeaderMetadataSignature(craft: Partial<CraftMetadataOnDisk>): string {
  return JSON.stringify({
    name: craft.name,
    labels: craft.labels,
    isFlagged: craft.isFlagged,
    sessionStatus: craft.sessionStatus,
    permissionMode: craft.permissionMode,
    hasUnread: craft.hasUnread,
    lastReadMessageId: craft.lastReadMessageId,
  });
}

function hasExternalMetadataChange(
  previousCraft: Partial<CraftMetadataOnDisk>,
  options: WriteTreeSessionCraftMetadataOptions,
): boolean {
  return !!options.lastWrittenHeaderSignature
    && getCraftHeaderMetadataSignature(previousCraft) !== options.lastWrittenHeaderSignature;
}

function buildCraftMetadataOnDisk(
  session: StoredSession,
  previousCraft: CraftMetadataOnDisk = {},
  options: WriteTreeSessionCraftMetadataOptions = {},
): CraftMetadataOnDisk {
  const craftMetadata = {
    ...previousCraft,
    ...(pickCraftSessionMetadata(session) as Partial<CraftSessionMetadata>),
    id: session.craftId,
    workspaceRootPath: toPortablePath(session.workspaceRootPath),
    workingDirectory: toPortablePath(session.workspaceRootPath),
    lastUsedAt: session.lastUsedAt ?? Date.now(),
    messageCount: session.messages.length,
    preview: extractPreview(session.messages),
    lastMessageRole: extractLastMessageRole(session.messages),
    lastFinalMessageId: extractLastFinalMessageId(session.messages),
    tokenUsage: session.tokenUsage,
  } as CraftMetadataOnDisk & { craftId?: unknown };

  if (hasExternalMetadataChange(previousCraft, options)) {
    for (const field of [
      'name',
      'labels',
      'isFlagged',
      'sessionStatus',
      'permissionMode',
      'hasUnread',
      'lastReadMessageId',
    ] as const) {
      if (field in previousCraft) {
        (craftMetadata as Record<string, unknown>)[field] = previousCraft[field];
      } else {
        delete (craftMetadata as Record<string, unknown>)[field];
      }
    }
  }

  delete craftMetadata.craftId;
  return craftMetadata;
}

function getCraftOverlayPath(sessionFile: string, craftId: string): string {
  const safeCraftId = sanitizeSessionId(craftId) || '_invalid-session';
  return join(dirname(sessionFile), '.craft', safeCraftId, 'overlay.json');
}

function isCanonicalStoredMessage(message: StoredMessage): boolean {
  return message.type === 'user' || message.type === 'assistant' || message.type === 'tool';
}

function getCanonicalMessageKeys(message: StoredMessage): Set<string> {
  const canonicalKeys = new Set(['id', 'type', 'timestamp']);
  if (message.type !== 'user') {
    canonicalKeys.add('content');
  }
  if (message.type === 'tool') {
    canonicalKeys.add('toolName');
    canonicalKeys.add('toolUseId');
    canonicalKeys.add('toolInput');
    canonicalKeys.add('toolResult');
    canonicalKeys.add('isError');
  }
  return canonicalKeys;
}

function hasCraftOnlyMessageFields(message: StoredMessage): boolean {
  const canonicalKeys = getCanonicalMessageKeys(message);
  return Object.keys(message).some(key => !canonicalKeys.has(key));
}

function buildCraftOnlyMessagePatch(message: StoredMessage): (Partial<StoredMessage> & { id: string }) | null {
  if (!hasCraftOnlyMessageFields(message)) return null;

  const canonicalKeys = getCanonicalMessageKeys(message);
  const patch: Partial<StoredMessage> & { id: string } = { id: message.id };
  for (const key of Object.keys(message) as Array<keyof StoredMessage>) {
    if (canonicalKeys.has(key)) continue;
    patch[key] = message[key] as never;
  }

  return Object.keys(patch).length > 1 ? patch : null;
}

function buildCraftOverlay(session: StoredSession): CraftOverlayFile | null {
  const messages = session.messages.flatMap((message) => {
    if (!isCanonicalStoredMessage(message)) return [message];
    const patch = buildCraftOnlyMessagePatch(message);
    return patch ? [patch] : [];
  });
  const annotations: Record<string, StoredMessage['annotations']> = {};

  for (const message of session.messages) {
    if (message.annotations?.length) {
      annotations[message.id] = message.annotations;
    }
  }

  if (messages.length === 0 && Object.keys(annotations).length === 0) {
    return null;
  }

  return {
    version: 1,
    messages: messages.length > 0 ? messages : undefined,
    annotations: Object.keys(annotations).length > 0 ? annotations : undefined,
  };
}

export function writeCraftSessionOverlay(sessionFile: string, session: StoredSession): void {
  const overlay = buildCraftOverlay(session);
  const overlayPath = getCraftOverlayPath(sessionFile, session.craftId);
  if (!overlay) {
    if (existsSync(overlayPath)) {
      atomicWriteFileSync(overlayPath, JSON.stringify({ version: 1 }, null, 2) + '\n');
    }
    return;
  }

  const overlayDir = dirname(overlayPath);
  if (!existsSync(overlayDir)) {
    mkdirSync(overlayDir, { recursive: true });
  }
  atomicWriteFileSync(overlayPath, JSON.stringify(overlay, null, 2) + '\n');
}

function readCraftSessionOverlay(sessionFile: string, craftId: string): CraftOverlayFile | null {
  const overlayPath = getCraftOverlayPath(sessionFile, craftId);
  if (!existsSync(overlayPath)) return null;

  try {
    const parsed = JSON.parse(readFileSync(overlayPath, 'utf-8')) as unknown;
    if (!isRecord(parsed) || parsed.version !== 1) return null;
    const messages = Array.isArray(parsed.messages)
      ? parsed.messages.filter(isRecord) as unknown as StoredMessage[]
      : undefined;
    const annotations = isRecord(parsed.annotations)
      ? parsed.annotations as Record<string, StoredMessage['annotations']>
      : undefined;
    return { version: 1, messages, annotations };
  } catch (error) {
    debug('[tree-jsonl] Failed to read Craft overlay:', overlayPath, error);
    return null;
  }
}

function mergeCraftOverlayMessages(messages: StoredMessage[], overlay: CraftOverlayFile | null): StoredMessage[] {
  if (!overlay) return messages;

  const merged = messages.map(message => {
    const annotations = overlay.annotations?.[message.id];
    return annotations?.length ? { ...message, annotations } : message;
  });

  if (overlay.messages?.length) {
    const indexById = new Map(merged.map((message, index) => [message.id, index]));
    for (const overlayMessage of overlay.messages) {
      const existingIndex = indexById.get(overlayMessage.id);
      if (existingIndex === undefined) {
        if (typeof overlayMessage.type !== 'string' || typeof overlayMessage.content !== 'string') {
          continue;
        }
        indexById.set(overlayMessage.id, merged.length);
        merged.push(overlayMessage as StoredMessage);
        continue;
      }
      const existingMessage = merged[existingIndex];
      if (!existingMessage) continue;
      merged[existingIndex] = {
        ...existingMessage,
        ...overlayMessage,
      };
    }
    merged.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  }

  return merged;
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
    try {
      const buffer = Buffer.alloc(8192); // 8KB is plenty for the tree session header
      const bytesRead = readSync(fd, buffer, 0, 8192, 0);
      if (bytesRead <= 0) return null;
      const content = buffer.toString('utf-8', 0, bytesRead);
      const firstNewline = content.indexOf('\n');
      const firstLine = firstNewline > 0 ? content.slice(0, firstNewline) : content;
      if (!firstLine.trim()) return null;
      const parsed = JSON.parse(firstLine) as unknown;
      if (!isTreeSessionHeader(parsed)) return null;
      return parsed;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

export function looksLikeTreeSessionJsonl(sessionFile: string): boolean {
  try {
    if (!existsSync(sessionFile)) return false;
    const header = readTreeSessionHeader(sessionFile);
    return header !== null;
  } catch {
    return false;
  }
}

export function readTreeSessionJsonl(sessionFile: string): ParsedTreeSession | null {
  try {
    // Keep the raw first-line header reader so Craft metadata (`header.craft`)
    // is preserved. Pi's public SessionManager intentionally ignores Craft's
    // opaque header extension fields.
    const header = readTreeSessionHeader(sessionFile);
    if (!header) return null;

    // Delegate JSONL entry parsing/migration/tree indexing to Pi's public
    // SessionManager instead of reimplementing Pi's session entry parser here.
    const manager = PiSessionManager.open(sessionFile);
    const entries = manager.getEntries() as unknown as TreeSessionEntry[];

    return { header, entries };
  } catch (error) {
    debug('[tree-jsonl] Failed to read tree session via Pi SessionManager:', sessionFile, error);
    return null;
  }
}

export function writeTreeSessionCraftMetadata(
  sessionFile: string,
  session: StoredSession,
  options: WriteTreeSessionCraftMetadataOptions = {},
): boolean {
  try {
    const header = readTreeSessionHeader(sessionFile);
    if (!isTreeSessionHeader(header)) return false;

    const previousCraft = isRecord(header.craft) ? header.craft as CraftMetadataOnDisk : {};
    const craftMetadata = buildCraftMetadataOnDisk(session, previousCraft, options);

    setPiCraftSessionMetadata({
      sessionPath: sessionFile,
      sessionDir: dirname(sessionFile),
      cwdOverride: session.workspaceRootPath,
      metadata: craftMetadata,
    });
    writeCraftSessionOverlay(sessionFile, session);
    return true;
  } catch (error) {
    debug('[tree-jsonl] Failed to update tree session Craft metadata:', sessionFile, error);
    return false;
  }
}

/**
 * Async facade-compatible metadata update for persistence queue hot paths.
 */
export async function writeTreeSessionCraftMetadataAsync(
  sessionFile: string,
  session: StoredSession,
  options: WriteTreeSessionCraftMetadataOptions = {},
): Promise<boolean> {
  try {
    const header = readTreeSessionHeader(sessionFile);
    if (!isTreeSessionHeader(header)) return false;

    const previousCraft = isRecord(header.craft) ? header.craft as CraftMetadataOnDisk : {};
    const craftMetadata = buildCraftMetadataOnDisk(session, previousCraft, options);

    setPiCraftSessionMetadata({
      sessionPath: sessionFile,
      sessionDir: dirname(sessionFile),
      cwdOverride: session.workspaceRootPath,
      metadata: craftMetadata,
    });
    writeCraftSessionOverlay(sessionFile, session);
    return true;
  } catch (error) {
    debug('[tree-jsonl] Failed to update tree session Craft metadata:', sessionFile, error);
    return false;
  }
}

/**
 * Create a new Pi tree JSONL v3 session file from a StoredSession.
 *
 * Used when writing to a file that does not yet exist (e.g., bundle import).
 * Creates the Pi header + message entries, then merges Craft metadata into the
 * header's `craft` field via {@link writeTreeSessionCraftMetadata}.
 *
 * Returns true on success, false on failure.
 */
export function createNewTreeSessionFile(sessionFile: string, session: StoredSession): boolean {
  try {
    const cwd = expandPath(session.workspaceRootPath);
    const timestamp = new Date(session.createdAt || Date.now()).toISOString();
    // Pi 顶层 id 用 sdkSessionId（Pi UUID），无则退回 craftId
    const piSessionId = session.sdkSessionId || session.craftId;

    const header: TreeSessionHeader = {
      type: 'session',
      version: 3,
      id: piSessionId,
      timestamp,
      cwd,
    };

    const lines: string[] = [JSON.stringify(header)];

    let parentId: string | null = null;
    for (const msg of session.messages) {
      const entry = storedMessageToTreeEntry(msg, parentId);
      lines.push(JSON.stringify(entry));
      parentId = entry.id;
    }

    const sessionDir = dirname(sessionFile);
    if (!existsSync(sessionDir)) {
      mkdirSync(sessionDir, { recursive: true });
    }

    atomicWriteFileSync(sessionFile, lines.join('\n') + '\n');

    // Merge Craft metadata into the header's `craft` field
    writeTreeSessionCraftMetadata(sessionFile, session);
    writeCraftSessionOverlay(sessionFile, session);
    return true;
  } catch (error) {
    debug('[tree-jsonl] Failed to create new tree session file:', sessionFile, error);
    return false;
  }
}

type PiAppendMessageInput = Parameters<PiSessionManager['appendMessage']>[0];

function storedMessageToPiAppendMessage(msg: StoredMessage): PiAppendMessageInput | null {
  const timestamp = msg.timestamp ?? Date.now();

  if (msg.type === 'user' || msg.type === 'assistant') {
    return {
      role: msg.type,
      content: msg.content,
      timestamp,
    } as PiAppendMessageInput;
  }

  if (msg.type === 'tool' && msg.toolUseId && msg.toolResult !== undefined) {
    return {
      role: 'toolResult',
      toolCallId: msg.toolUseId,
      toolName: msg.toolName,
      content: [{ type: 'text', text: msg.toolResult ?? '' }],
      isError: !!msg.isError,
      timestamp,
    } as PiAppendMessageInput;
  }

  if (msg.type === 'tool' && msg.toolName && msg.toolInput !== undefined) {
    return {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: msg.toolUseId ?? msg.id,
          name: msg.toolName,
          arguments: msg.toolInput,
        },
      ],
      timestamp,
    } as PiAppendMessageInput;
  }

  return null;
}

function isTreeMessageEntry(entry: TreeSessionEntry): entry is TreeMessageEntry {
  return entry.type === 'message' && isRecord((entry as TreeMessageEntry).message);
}

function comparablePiMessage(message: TreeAgentMessage | PiAppendMessageInput): string {
  const record = message as Record<string, unknown>;
  return JSON.stringify({
    role: record.role,
    content: record.content,
    toolCallId: record.toolCallId,
    toolName: record.toolName,
    isError: record.isError,
  });
}

function piMessagesEquivalent(existing: TreeAgentMessage, expected: PiAppendMessageInput): boolean {
  return comparablePiMessage(existing) === comparablePiMessage(expected);
}

/**
 * Import canonical transcript entries through Pi's public SessionManager API.
 *
 * The caller must create the header file first (Craft is allowed to write
 * header metadata). This function appends only user/assistant/tool transcript
 * messages; UI-only messages remain in the Craft overlay. Repeated calls with
 * the same source messages are idempotent: existing matching Pi entries are
 * reused and only a missing suffix is appended.
 */
export function appendStoredMessagesViaPiSessionManager(
  sessionFile: string,
  sessionDir: string,
  cwd: string,
  messages: StoredMessage[],
): Map<string, string> {
  const manager = PiSessionManager.open(sessionFile, sessionDir, cwd);
  const idMap = new Map<string, string>();
  const appendableMessages = messages.flatMap((msg) => {
    const piMessage = storedMessageToPiAppendMessage(msg);
    return piMessage ? [{ originalId: msg.id, piMessage }] : [];
  });

  const existingMessages = (manager.getEntries() as unknown as TreeSessionEntry[]).filter(isTreeMessageEntry);
  let matchedCount = 0;
  for (; matchedCount < Math.min(existingMessages.length, appendableMessages.length); matchedCount += 1) {
    const existing = existingMessages[matchedCount]!;
    const expected = appendableMessages[matchedCount]!;
    if (!piMessagesEquivalent(existing.message, expected.piMessage)) {
      throw new Error(`Target session already contains non-matching transcript entries: ${sessionFile}`);
    }
    idMap.set(expected.originalId, existing.id);
  }

  if (existingMessages.length > appendableMessages.length) {
    debug(`[tree-jsonl] Import target already has ${existingMessages.length - appendableMessages.length} extra transcript entries; skipping duplicate append for ${sessionFile}`);
    return idMap;
  }

  for (const { originalId, piMessage } of appendableMessages.slice(matchedCount)) {
    idMap.set(originalId, manager.appendMessage(piMessage));
  }
  return idMap;
}

/**
 * Convert a StoredMessage to a Pi tree message entry.
 * Best-effort: preserves role, content, and tool fields. Messages that don't
 * map cleanly to a Pi message entry (info, status) are emitted as
 * custom_message entries so the conversation history is not lost.
 */
function storedMessageToTreeEntry(msg: StoredMessage, parentId: string | null): { type: string; id: string; parentId: string | null; timestamp: string; [key: string]: unknown } {
  const timestamp = msg.timestamp
    ? new Date(msg.timestamp).toISOString()
    : new Date().toISOString();

  // Tool result message
  if (msg.type === 'tool' && msg.toolUseId && msg.toolResult !== undefined) {
    return {
      type: 'message',
      id: msg.id,
      parentId,
      timestamp,
      message: {
        role: 'toolResult',
        toolCallId: msg.toolUseId,
        toolName: msg.toolName,
        content: msg.toolResult ?? '',
        isError: !!msg.isError,
        timestamp: msg.timestamp,
      },
    };
  }

  // Tool call message (has toolInput but no toolResult)
  if (msg.type === 'tool' && msg.toolName && msg.toolInput !== undefined) {
    return {
      type: 'message',
      id: msg.id,
      parentId,
      timestamp,
      message: {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: msg.toolUseId ?? msg.id,
            name: msg.toolName,
            arguments: msg.toolInput,
          },
        ],
        timestamp: msg.timestamp,
      },
    };
  }

  // User / assistant messages
  if (msg.type === 'user' || msg.type === 'assistant') {
    return {
      type: 'message',
      id: msg.id,
      parentId,
      timestamp,
      message: {
        role: msg.type,
        content: msg.content,
        timestamp: msg.timestamp,
      },
    };
  }

  // Info / status / plan / error → custom_message (preserves content)
  return {
    type: 'custom_message',
    id: msg.id,
    parentId,
    timestamp,
    customType: msg.type,
    content: msg.content,
    display: true,
    details: {
      toolName: msg.toolName,
      infoLevel: msg.infoLevel,
      statusType: msg.statusType,
      isError: msg.isError,
    },
  };
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

const LEADING_USER_DATE_CONTEXT_RE =
  /^\s*\*\*USER'S DATE AND TIME:[\s\S]*?\*\*\s*-\s*ALWAYS use this as the authoritative current date\/time\. Ignore any\s+other date information\.\s*/i;

const LEADING_CRAFT_CONTEXT_BLOCK_RE =
  /^\s*<(session_state|sources|source_issue)(?:\s[^>]*)?>[\s\S]*?<\/\1>\s*/i;

function stripLeadingCraftInjectedUserContext(content: string): string {
  let stripped = false;
  let next = content;

  for (;;) {
    const before = next;
    next = next.replace(LEADING_USER_DATE_CONTEXT_RE, () => {
      stripped = true;
      return '';
    });
    next = next.replace(LEADING_CRAFT_CONTEXT_BLOCK_RE, () => {
      stripped = true;
      return '';
    });
    if (next === before) break;
  }

  const cleaned = next.trimStart();
  return stripped && cleaned ? cleaned : content;
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
    } else if (role === 'assistant' && block.type === 'thinking' && typeof block.thinking === 'string') {
      out.push({
        id: `${entry.id}-thinking-${out.length}`,
        type: role,
        content: block.thinking,
        timestamp: ts,
        isIntermediate: true,
      });
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
    const content = textParts.join('\n');
    out.push({
      id: entry.id,
      type: role,
      content: role === 'user' ? stripLeadingCraftInjectedUserContext(content) : content,
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
      out.push({
        id: entry.id,
        type: roleRaw,
        content: roleRaw === 'user' ? stripLeadingCraftInjectedUserContext(content) : content,
        timestamp: ts,
      });
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
      customType: entry.customType,
      customDetails: entry.details,
      customDisplay: entry.display,
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
  return projectTreeSessionPlanData(entries, leafId).messages;
}

export function projectTreeSessionPlanData(
  entries: TreeSessionEntry[],
  leafId?: string | null,
): { messages: StoredMessage[]; planModeState?: PlanModeStateV1 } {
  const branch = getBranch(entries, leafId);
  const messages: StoredMessage[] = [];
  let planModeState: PlanModeStateV1 | undefined;
  for (const entry of branch) {
    if (entry.type === 'custom_message' && 'customType' in entry) {
      const result = applyPlanCustomMessageToStored(messages, {
        id: entry.id,
        customType: entry.customType,
        content: extractTextFromContent(entry.content),
        details: entry.details,
        timestamp: timestampMs(entry.timestamp),
      });
      if (result.projection.kind === 'state') {
        planModeState = result.projection.state;
        continue;
      }
      if (result.projection.kind === 'artifact') continue;
    }
    appendTreeEntryProjection(messages, entry);
  }
  return { messages, planModeState };
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

/**
 * 从 tree entries 聚合 token usage。
 *
 * Pi tree 的 assistant message 携带 usage 字段（input/output/cacheRead/cacheWrite/
 * totalTokens/cost.total），投影到 StoredMessage 时会丢失，因此必须从 entries 聚合。
 *
 * contextTokens 取最后一条带 usage 的 assistant message 的 input——
 * 这代表该 turn 的累积上下文大小，与 SessionTokenUsage.contextTokens 语义一致。
 */
function tokenUsageFromEntries(entries: TreeSessionEntry[]): SessionTokenUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let costUsd = 0;
  let contextTokens = 0;

  for (const entry of entries) {
    if (entry.type !== 'message' || !('message' in entry)) continue;
    const msg = entry.message;
    if (msg.role !== 'assistant') continue;
    const usage = msg.usage;
    if (!usage) continue;

    const input = typeof usage.input === 'number' ? usage.input : 0;
    const output = typeof usage.output === 'number' ? usage.output : 0;
    inputTokens += input;
    outputTokens += output;
    cacheReadTokens += typeof usage.cacheRead === 'number' ? usage.cacheRead : 0;
    cacheCreationTokens += typeof usage.cacheWrite === 'number' ? usage.cacheWrite : 0;
    costUsd += typeof usage.cost?.total === 'number' ? usage.cost.total : 0;
    // 最后一条 assistant 的 input 即当前上下文大小
    if (input > 0) contextTokens = input;
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    contextTokens,
    costUsd,
    cacheReadTokens: cacheReadTokens || undefined,
    cacheCreationTokens: cacheCreationTokens || undefined,
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
  return projectParsedTreeSessionAsStoredSession(parsed, sessionFile, options);
}

function projectParsedTreeSessionAsStoredSession(
  parsed: ParsedTreeSession,
  sessionFile: string,
  options: TreeProjectionOptions = {},
): StoredSession | null {
  const planProjection = projectTreeSessionPlanData(parsed.entries, options.leafId);
  const baseMessages = planProjection.messages;
  const createdAt = new Date(parsed.header.timestamp).getTime() || Date.now();
  const stat = existsSync(sessionFile) ? statSync(sessionFile) : undefined;
  const lastUsedAt = stat?.mtimeMs ?? createdAt;
  const workspaceRootPath = options.workspaceRootPath ?? parsed.header.craft?.workspaceRootPath ?? parsed.header.cwd ?? dirname(sessionFile);
  const craft = parsed.header.craft ?? {}
  // on-disk craft.id → 扁平 SessionHeader.craftId
  // 优先用 craft.id（Craft 人类可读 ID），无则退回 Pi 顶层 id + 前缀
  const craftId = getCraftIdFromTreeHeader(parsed.header, options.sessionIdPrefix ?? '');
  const messages = mergeCraftOverlayMessages(baseMessages, readCraftSessionOverlay(sessionFile, craftId));

  // Strip on-disk `id` before spreading so it doesn't leak as a phantom `id`
  // field onto SessionHeader (which declares only `craftId`). Without this,
  // tree-derived headers would carry `.id === craftId` while legacy-derived
  // headers carry no `.id`, causing silent source-dependent divergence.
  const { id: _craftIdOnDisk, ...craftRest } = craft;

  return {
    ...craftRest,
    craftId,
    // Pi 原生字段（扁平化）
    type: parsed.header.type,
    version: parsed.header.version,
    piSessionId: parsed.header.id,
    piTimestamp: parsed.header.timestamp,
    piCwd: parsed.header.cwd,
    parentSession: parsed.header.parentSession,
    // Craft 字段（从 craft 子对象取，无则用 fallback）
    workspaceRootPath: expandPath(workspaceRootPath),
    // sdkSessionId 不回退到 parsed.header.id（Pi session id）。
    // 历史上回退到 header.id 会在 craft.sdkSessionId 缺失时把 Pi id 当作 sdkSessionId，
    // 但写入端在无 sdkSessionId 时会把 header.id 写成 craftId，导致重载后 sdkSessionId 被错误
    // 设为 craftId 并自我 perpetuating。保持 undefined 让上层显式处理。
    sdkSessionId: craft.sdkSessionId,
    createdAt: craft.createdAt ?? createdAt,
    lastUsedAt: craft.lastUsedAt ?? lastUsedAt,
    lastMessageAt: craft.lastMessageAt ?? lastUsedAt,
    name: craft.name ?? latestSessionName(parsed.entries),
    workingDirectory: workspaceRootPath,
    sdkCwd: craft.sdkCwd ?? workspaceRootPath,
    messageCount: craft.messageCount ?? messages.length,
    preview: craft.preview ?? extractPreview(messages),
    lastMessageRole: craft.lastMessageRole ?? extractLastMessageRole(messages),
    lastFinalMessageId: craft.lastFinalMessageId ?? extractLastFinalMessageId(messages),
    planModeState: planProjection.planModeState ?? craft.planModeState,
    messages,
    tokenUsage: craft.tokenUsage ?? tokenUsageFromEntries(parsed.entries),
  } as StoredSession;
}

function emptySessionTokenUsage(): SessionTokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    contextTokens: 0,
    costUsd: 0,
  };
}

export function projectTreeSessionHeaderAsSessionHeader(
  header: TreeSessionHeader,
  sessionFile: string,
  options: TreeProjectionOptions = {},
): SessionHeader {
  const createdAt = new Date(header.timestamp).getTime() || Date.now();
  const stat = existsSync(sessionFile) ? statSync(sessionFile) : undefined;
  const lastUsedAt = stat?.mtimeMs ?? createdAt;
  const workspaceRootPath = options.workspaceRootPath
    ?? header.craft?.workspaceRootPath
    ?? header.cwd
    ?? dirname(sessionFile);
  const craft = header.craft ?? {};
  const craftId = getCraftIdFromTreeHeader(header, options.sessionIdPrefix ?? '');
  const { id: _craftIdOnDisk, ...craftRest } = craft;

  return {
    ...craftRest,
    craftId,
    type: header.type,
    version: header.version,
    piSessionId: header.id,
    piTimestamp: header.timestamp,
    piCwd: header.cwd,
    parentSession: header.parentSession,
    workspaceRootPath: expandPath(workspaceRootPath),
    sdkSessionId: craft.sdkSessionId,
    createdAt: craft.createdAt ?? createdAt,
    lastUsedAt: craft.lastUsedAt ?? lastUsedAt,
    lastMessageAt: craft.lastMessageAt ?? lastUsedAt,
    workingDirectory: workspaceRootPath,
    sdkCwd: craft.sdkCwd ?? workspaceRootPath,
    messageCount: craft.messageCount ?? 0,
    tokenUsage: craft.tokenUsage ?? emptySessionTokenUsage(),
  } as SessionHeader;
}

export function projectTreeSessionProjectionAsStoredSession(
  projection: TreeSessionProjectionLike,
  options: TreeProjectionOptions = {},
): StoredSession | null {
  if (!isTreeSessionHeader(projection.header)) return null;
  const entries = projection.entries.filter(isTreeEntry);
  const sessionFile = projection.path ?? options.sessionFilePath ?? '';
  return projectParsedTreeSessionAsStoredSession(
    { header: projection.header, entries },
    sessionFile,
    {
      workspaceRootPath: options.workspaceRootPath ?? projection.cwd,
      sessionFilePath: sessionFile,
      sessionIdPrefix: options.sessionIdPrefix,
      leafId: options.leafId ?? projection.leafId,
    },
  );
}

/**
 * Read session as flat SessionHeader (for list loading).
 * 合并 Pi 顶层字段和 craft 子对象为扁平 SessionHeader。
 */
export function readTreeSessionMetadata(
  sessionFile: string,
  workspaceRootPath?: string,
  sessionIdPrefix = '',
): SessionHeader | null {
  const header = readTreeSessionHeader(sessionFile);
  if (!header) return null;

  // Session list metadata is cached in the first-line `craft` object. Do not
  // open/project the full Pi message tree here: this function runs once per
  // session during server startup and large histories can otherwise delay the
  // workspace-server ready signal beyond its startup timeout.
  return projectTreeSessionHeaderAsSessionHeader(header, sessionFile, {
    workspaceRootPath: workspaceRootPath || undefined,
    sessionIdPrefix,
  });
}
