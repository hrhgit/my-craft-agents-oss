/**
 * JSONL Session Storage
 *
 * Helpers for reading Pi tree JSONL sessions.
 */

import type { SessionHeader, StoredSession } from './types.ts';
import type { PermissionMode } from '../agent/mode-types.ts';
import { parsePermissionMode } from '../agent/mode-types.ts';
import { debug } from '../utils/debug.ts';
import {
  projectTreeSessionHeaderAsSessionHeader,
  readTreeSessionHeader,
  readTreeSessionAsStoredSession,
  writeTreeSessionCraftMetadata,
} from './tree-jsonl.ts';

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
 * Read only the header (first line) from a flat Pi session JSONL file.
 * Uses low-level fs to read minimal bytes for fast list loading.
 */
export function readSessionHeader(sessionFile: string): SessionHeader | null {
  try {
    const treeHeader = readTreeSessionHeader(sessionFile);
    if (!treeHeader) return null;
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
    return readTreeSessionAsStoredSession(sessionFile);
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
 * Only Pi tree JSONL v3 files are supported.
 */
export function writeSessionJsonl(sessionFile: string, session: StoredSession): void {
  if (writeTreeSessionCraftMetadata(sessionFile, session)) {
    return;
  }
  throw new Error(`Expected Pi tree JSONL session file: ${sessionFile}`);
}
