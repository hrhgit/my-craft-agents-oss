/**
 * JSONL Session Storage
 *
 * Helpers for reading/writing sessions in JSONL format.
 * Format: Line 1 = SessionHeader, Lines 2+ = StoredMessage (one per line)
 */

import { openSync, readSync, closeSync, readFileSync, existsSync } from 'fs';
import { dirname } from 'path';
import type { SessionHeader, StoredSession, StoredMessage, SessionTokenUsage } from './types.ts';
import type { PermissionMode } from '../agent/mode-types.ts';
import { parsePermissionMode } from '../agent/mode-types.ts';
import { expandPath, normalizePath } from '../utils/paths.ts';
import { debug } from '../utils/debug.ts';
import { safeJsonParse } from '../utils/files.ts';
import { pickCraftSessionMetadata } from './utils.ts';
import {
  looksLikeTreeSessionJsonl,
  projectTreeSessionHeaderAsSessionHeader,
  readTreeSessionHeader,
  readTreeSessionAsStoredSession,
  writeTreeSessionCraftMetadata,
  createNewTreeSessionFile,
} from './tree-jsonl.ts';

/**
 * 将 legacy 文件第一行（含 id 字段）转换为扁平 SessionHeader。
 * legacy 文件无 Pi 字段，piSessionId/piTimestamp/piCwd 等设为 undefined。
 */
function headerFromLegacyLine(line: string, sessionDir: string): SessionHeader | null {
  const parsed = safeJsonParse(expandSessionPath(line, sessionDir)) as Record<string, unknown> & { id?: string };
  if (!parsed || typeof parsed !== 'object') return null;
  // legacy id → craftId
  const { id: legacyId, ...rest } = parsed;
  const header = { ...rest, craftId: legacyId } as unknown as SessionHeader;
  return normalizeHeaderPermissionModes(header);
}

// ============================================================
// Session Path Portability
// ============================================================

const SESSION_PATH_TOKEN = '{{SESSION_PATH}}';

/**
 * Expand the portable session path token back to an absolute path.
 * Applied before JSON.parse so all path references resolve correctly at runtime.
 */
export function expandSessionPath(jsonLine: string, sessionDir: string): string {
  if (!jsonLine.includes(SESSION_PATH_TOKEN)) return jsonLine;
  return jsonLine.replaceAll(SESSION_PATH_TOKEN, normalizePath(sessionDir));
}

function normalizePermissionMode(value: unknown): PermissionMode | undefined {
  if (typeof value !== 'string') return undefined;
  return parsePermissionMode(value) ?? undefined;
}

function normalizeHeaderPermissionModes<T extends SessionHeader>(header: T): T {
  const permissionMode = normalizePermissionMode(header.permissionMode);
  const previousPermissionMode = normalizePermissionMode(header.previousPermissionMode);

  if (permissionMode) {
    header.permissionMode = permissionMode;
  } else {
    delete (header as Partial<SessionHeader>).permissionMode;
  }

  if (previousPermissionMode) {
    header.previousPermissionMode = previousPermissionMode;
  } else {
    delete (header as Partial<SessionHeader>).previousPermissionMode;
  }

  return header;
}

/**
 * Read only the header (first line) from a session.jsonl file.
 * Uses low-level fs to read minimal bytes for fast list loading.
 */
export function readSessionHeader(sessionFile: string): SessionHeader | null {
  try {
    const treeHeader = readTreeSessionHeader(sessionFile);
    if (treeHeader) {
      const metadata = projectTreeSessionHeaderAsSessionHeader(treeHeader, sessionFile);
      return normalizeHeaderPermissionModes({
        ...metadata,
        tokenUsage: metadata.tokenUsage ?? {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          contextTokens: 0,
          costUsd: 0,
        },
      });
    }

    const fd = openSync(sessionFile, 'r');
    try {
      const buffer = Buffer.alloc(8192); // 8KB is plenty for metadata header
      const bytesRead = readSync(fd, buffer, 0, 8192, 0);
      const content = buffer.toString('utf-8', 0, bytesRead);
      const firstNewline = content.indexOf('\n');
      const firstLine = firstNewline > 0 ? content.slice(0, firstNewline) : content;

      // legacy 文件第一行含 id 字段（Craft ID），转换为扁平 SessionHeader
      return headerFromLegacyLine(firstLine, dirname(sessionFile));
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    debug('[jsonl] Failed to read session header:', sessionFile, error);
    return null;
  }
}

/**
 * Read full session from JSONL file.
 * Parses header and all message lines.
 */
export function readSessionJsonl(sessionFile: string): StoredSession | null {
  try {
    if (looksLikeTreeSessionJsonl(sessionFile)) {
      return readTreeSessionAsStoredSession(sessionFile);
    }

    const content = readFileSync(sessionFile, 'utf-8');
    const lines = content.split('\n').filter(Boolean);

    const firstLine = lines[0];
    if (!firstLine) return null;

    const sessionDir = dirname(sessionFile);
    // legacy 文件第一行含 id 字段（Craft ID），转换为扁平 SessionHeader
    const header = headerFromLegacyLine(firstLine, sessionDir);
    if (!header) return null;
    // Parse messages resiliently: skip lines that fail to parse (e.g. truncated by crash)
    // rather than losing the entire session's messages.
    // Expand session path tokens before parsing so embedded paths resolve correctly.
    const expandedMessageLines = lines.slice(1).map(line => expandSessionPath(line, sessionDir));
    const messages = parseMessagesResilient(expandedMessageLines);

    // Migration: For sessions created before sdkCwd was added, use workingDirectory as fallback.
    // This is correct because the old code used workingDirectory for SDK's cwd parameter.
    const workingDir = header.workingDirectory ? expandPath(header.workingDirectory) : undefined;
    const sdkCwd = header.sdkCwd ? expandPath(header.sdkCwd) : workingDir;

    return {
      ...pickCraftSessionMetadata(header),
      // Path expansion for portable paths
      workspaceRootPath: expandPath(header.workspaceRootPath),
      workingDirectory: workingDir,
      sdkCwd,
      // Runtime fields
      messages,
      tokenUsage: header.tokenUsage,
    } as StoredSession;
  } catch (error) {
    debug('[jsonl] Failed to read session:', sessionFile, error);
    return null;
  }
}

/**
 * Write session to JSONL format using atomic write (write-to-temp-then-rename).
 * Prevents file corruption if the process crashes mid-write: either the old
 * file remains intact or the new file is fully written. Never a partial file.
 *
 * 强制升级策略（不兼容旧格式写入）：
 * - 已存在的 tree JSONL v3 文件 → 只更新 header 的 craft metadata
 * - 新文件或 legacy 格式文件 → 创建/覆盖为 tree JSONL v3 格式
 *
 * legacy 读取分支（readSessionHeader 等）仍保留，以便读取尚未升级的旧文件；
 * 旧文件在被写入时自动升级为 tree 格式。
 */
export function writeSessionJsonl(sessionFile: string, session: StoredSession): void {
  // 已存在且为 tree 格式 → 只更新 craft metadata
  if (looksLikeTreeSessionJsonl(sessionFile)) {
    if (writeTreeSessionCraftMetadata(sessionFile, session)) {
      return;
    }
    throw new Error(`Failed to update tree session Craft metadata: ${sessionFile}`);
  }

  // 新文件或 legacy 文件 → 强制创建/覆盖为 tree JSONL v3 格式
  if (createNewTreeSessionFile(sessionFile, session)) {
    return;
  }

  throw new Error(`Failed to create tree session file: ${sessionFile}`);
}

/**
 * Parse message lines resiliently: skip lines that fail JSON.parse
 * (e.g. truncated by a crash mid-write) rather than losing all messages.
 */
function parseMessagesResilient(lines: string[]): StoredMessage[] {
  const messages: StoredMessage[] = [];
  for (const line of lines) {
    try {
      messages.push(JSON.parse(line) as StoredMessage);
    } catch {
      // Corrupted/truncated line (likely from a crash during write).
      // Skip it and continue — losing one message is better than losing all.
      debug('[jsonl] Skipping corrupted message line (truncated?):', line.substring(0, 100));
    }
  }
  return messages;
}
