/**
 * Session Storage
 *
 * Workspace-scoped session CRUD operations.
 * Sessions are stored at ~/.pi/agent/sessions/{encoded-cwd}/{timestamp}_{sessionId}.jsonl
 * (Pi tree JSONL v3 format; legacy {workspaceRootPath}/sessions/{id}/session.jsonl
 * retained for backward compatibility).
 * Each session folder contains:
 * - session.jsonl (main data in JSONL format: line 1 = header, lines 2+ = messages)
 * - attachments/ (file attachments)
 * - plans/ (plan files for Safe Mode)
 * - data/ (transform_data tool output: JSON files for datatable/spreadsheet blocks)
 * - long_responses/ (full tool results that were summarized due to size limits)
 * - downloads/ (binary files downloaded from API sources: PDFs, images, archives, etc.)
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'fs';
import { dirname, join, basename, resolve } from 'path';
import { generateUniqueSessionId } from './slug-generator.ts';
import { toPortablePath, expandPath, isPathWithinDirectory, normalizePathForComparison } from '../utils/paths.ts';
import { atomicWriteFileSync } from '../utils/files.ts';
import { sanitizeSessionId, validateSessionId } from './validation.ts';
import { perf } from '../utils/perf.ts';
import type {
  StoredSession,
  SessionTokenUsage,
  SessionHeader,
} from './types.ts';
import type { Plan } from '../agent/plan-types.ts';
import { validateSessionStatus } from '../statuses/validation.ts';
import { debug } from '../utils/debug.ts';
import { readSessionHeader, readSessionJsonl } from './jsonl.ts';
import { sessionPersistenceQueue } from './persistence-queue.ts';
import { PI_SESSIONS_DIR, encodePiSessionCwd } from '../config/paths.ts';
import { readTreeSessionAsStoredSession, readTreeSessionHeader, readTreeSessionMetadata, writeTreeSessionCraftMetadata, writeTreeSessionCraftMetadataAsync } from './tree-jsonl.ts';
import {
  createSessionProjection as createPiSessionProjection,
  findSessionProjectionById as findPiHostSessionProjectionById,
} from '@earendil-works/pi-coding-agent/host-facade';

let sharedPiSessionsDirOverride: string | undefined;

export interface EnsureSharedPiTreeSessionFileOptions {
  lastWrittenHeaderSignature?: string;
}

/**
 * Test hook for isolating Pi session storage without mutating the real home dir.
 */
export function setSharedPiSessionsDirForTests(dir: string | undefined): void {
  sharedPiSessionsDirOverride = dir;
}

function getPiSessionsRoot(): string {
  return sharedPiSessionsDirOverride ?? PI_SESSIONS_DIR;
}

/**
 * Session storage root is ALWAYS under the Pi sessions directory now.
 * The legacy `~/.craft-agent/workspaces/{id}/sessions/` path is only read by
 * the migration tool (migration tool) and is never written to.
 */
function getSessionStorageRootPath(workspaceRootPath: string, _workingDirectory?: string): string {
  return join(getPiSessionsRoot(), encodePiSessionCwd(workspaceRootPath));
}

export function getSharedPiSidecarPathForFile(sessionFile: string, sessionId: string): string {
  const safeSessionId = sanitizeSessionId(sessionId);
  if (!safeSessionId) {
    throw new Error('Security Error: Invalid session ID - empty sanitized value');
  }
  return join(dirname(sessionFile), '.craft', safeSessionId);
}

/**
 * Build the Pi session file name (`{ISO-timestamp}_{safeId}.jsonl`).
 * Shared by `getPiNativeSessionFilePath` and the one-shot migration tool to
 * keep a single source of truth for the file-name layout.
 */
export function buildPiSessionFileName(sessionId: string, createdAt?: number): string {
  const timestampMs = typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : Date.now();
  const fileTimestamp = new Date(timestampMs).toISOString().replace(/[:.]/g, '-');
  return `${fileTimestamp}_${sanitizeSessionId(sessionId)}.jsonl`;
}

export function getPiNativeSessionFilePath(
  workspaceRootPath: string,
  sessionId: string,
  workingDirectory?: string,
  createdAt?: number,
): string {
  return join(getPiNativeSessionDir(workspaceRootPath, workingDirectory), buildPiSessionFileName(sessionId, createdAt));
}

function findSharedPiSessionFileInDir(cwdPath: string, sessionId: string): string | null {
  if (!existsSync(cwdPath)) return null;
  const safeSessionId = sanitizeSessionId(sessionId);
  try {
    const entries = readdirSync(cwdPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const filePath = join(cwdPath, entry.name);
        if (entry.name === `${safeSessionId}.jsonl` || entry.name.endsWith(`_${safeSessionId}.jsonl`)) {
          return filePath;
        }
        // Only read the first line (header) instead of the entire file. The
        // previous implementation called readTreeSessionJsonl, which parsed
        // every entry of every .jsonl in the directory — blocking the event
        // loop for tens of seconds when the Pi sessions dir held hundreds of
        // large session files.
        const header = readTreeSessionHeader(filePath);
        if (header?.id === sessionId || header?.craft?.id === sessionId) {
          return filePath;
        }
      } else if (entry.isDirectory()) {
        // Backward compatibility for the earlier shared-storage experiment:
        // ~/.pi/agent/sessions/<cwd>/<craft-id>/session.jsonl
        const candidate = join(cwdPath, entry.name, 'session.jsonl');
        if (entry.name === safeSessionId && existsSync(candidate)) {
          return candidate;
        }
      }
    }
  } catch {
    // Ignore and fall back to another lookup path.
  }
  return null;
}

function findSharedPiSessionFile(sessionId: string, workspaceRootPath?: string, _workingDirectory?: string): string | null {
  const root = getPiSessionsRoot();
  if (!existsSync(root)) return null;

  if (workspaceRootPath) {
    const scopedDir = join(root, encodePiSessionCwd(workspaceRootPath));
    const scopedFile = findSharedPiSessionFileInDir(scopedDir, sessionId);
    if (scopedFile) return scopedFile;
    return null;
  }

  try {
    const cwdDirs = readdirSync(root, { withFileTypes: true });
    for (const cwdDir of cwdDirs) {
      if (!cwdDir.isDirectory()) continue;
      const filePath = findSharedPiSessionFileInDir(join(root, cwdDir.name), sessionId);
      if (filePath) return filePath;
    }
  } catch {
    // Ignore and fall back to the default path.
  }
  return null;
}

/**
 * List Craft session directories by scanning only the workspace root bucket.
 *
 * Complete-unification semantics require the Craft owner metadata to match the
 * workspace root. Sessions in other cwd buckets belong to the workspace rooted
 * at that cwd (or are legacy orphans until migrated).
 */
function sameWorkspacePath(a: string | undefined, b: string): boolean {
  if (!a) return false;
  try {
    return normalizePathForComparison(expandPath(a)) === normalizePathForComparison(expandPath(b));
  } catch {
    return false;
  }
}

function listCraftSessionDirs(workspaceRootPath: string): Array<{ sessionId: string; sessionDir: string; jsonlFile: string }> {
  const root = getPiSessionsRoot();
  if (!existsSync(root)) return [];
  const result: Array<{ sessionId: string; sessionDir: string; jsonlFile: string }> = [];
  const seenFiles = new Set<string>();

  const addSessionFile = (jsonlFile: string): void => {
    if (seenFiles.has(jsonlFile)) return;

    const treeHeader = readTreeSessionHeader(jsonlFile);
    let sessionId: string | undefined;
    let headerWorkspaceRootPath: string | undefined;
    if (treeHeader) {
      sessionId = treeHeader.craft?.id ?? treeHeader.id;
      headerWorkspaceRootPath = treeHeader.craft?.workspaceRootPath;
    } else {
      const header = readSessionHeader(jsonlFile);
      if (!header) return;
      sessionId = header.craftId;
      headerWorkspaceRootPath = header.workspaceRootPath;
    }

    if (!sessionId) {
      sessionId = basename(jsonlFile, '.jsonl');
    }
    if (!sameWorkspacePath(headerWorkspaceRootPath, workspaceRootPath)) {
      return;
    }
    seenFiles.add(jsonlFile);
    result.push({
      sessionId,
      sessionDir: getSharedPiSidecarPathForFile(jsonlFile, sessionId),
      jsonlFile,
    });
  };

  const scanCwdPath = (cwdPath: string): void => {
    if (!existsSync(cwdPath)) return;
    try {
      const entries = readdirSync(cwdPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          addSessionFile(join(cwdPath, entry.name));
        } else if (entry.isDirectory()) {
          // Backward compatibility for legacy Craft-managed session folders
          // stored below the Pi cwd bucket (early shared-storage experiment).
          const jsonlFile = join(cwdPath, entry.name, 'session.jsonl');
          if (existsSync(jsonlFile)) {
            addSessionFile(jsonlFile);
          }
        }
      }
    } catch {
      // Ignore malformed/unreadable Pi sessions directories.
    }
  };

  const cwdPath = join(root, encodePiSessionCwd(workspaceRootPath));
  scanCwdPath(cwdPath);
  return result;
}

// ============================================================
// Directory Utilities
// ============================================================

/**
 * Ensure sessions directory exists for a workspace
 */
export function ensureSessionsDir(workspaceRootPath: string, workingDirectory?: string): string {
  const dir = getSessionStorageRootPath(workspaceRootPath, workingDirectory);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Get path to a session's directory (the .craft/{sessionId}/ sidecar dir).
 *
 * Always resolves to the sidecar directory next to the Pi
 * session JSONL file. The legacy `~/.craft-agent/workspaces/{id}/sessions/{id}/`
 * path is no longer used for new sessions.
 *
 * SECURITY: Uses sanitizeSessionId() as defense-in-depth to prevent path traversal.
 * Callers should still validate sessionId before calling this function.
 */
export function getSessionPath(workspaceRootPath: string, sessionId: string, workingDirectory?: string): string {
  // Defense-in-depth: strip any path components from sessionId
  const filePath = findSharedPiSessionFile(sessionId, workspaceRootPath, workingDirectory)
    ?? getPiNativeSessionFilePath(workspaceRootPath, sessionId, workingDirectory);
  return getSharedPiSidecarPathForFile(filePath, sessionId);
}

/**
 * Get path to a session's Pi tree JSONL file.
 *
 * Always returns a path under `~/.pi/agent/sessions/{encoded-cwd}/`.
 */
export function getSessionFilePath(workspaceRootPath: string, sessionId: string, workingDirectory?: string, createdAt?: number): string {
  const sharedPiFile = findSharedPiSessionFile(sessionId, workspaceRootPath, workingDirectory);
  if (sharedPiFile) return sharedPiFile;
  return getPiNativeSessionFilePath(workspaceRootPath, sessionId, workingDirectory, createdAt);
}

/**
 * Same as getSessionFilePath but never creates directories as a side effect.
 *
 * Returns null when no shared Pi session file is found AND the native Pi
 * session bucket directory does not exist (i.e., the path would only exist
 * after a side-effecting mkdir). Use this in read-only contexts (search,
 * listing, existence checks) to avoid creating empty bucket directories.
 */
export function tryGetSessionFilePath(workspaceRootPath: string, sessionId: string, workingDirectory?: string): string | null {
  const sharedPiFile = findSharedPiSessionFile(sessionId, workspaceRootPath, workingDirectory);
  if (sharedPiFile) return sharedPiFile;
  // Mirror getPiNativeSessionFilePath logic but without mkdir side effect.
  const dir = join(getPiSessionsRoot(), encodePiSessionCwd(workspaceRootPath));
  if (!existsSync(dir)) return null;
  return join(dir, buildPiSessionFileName(sessionId));
}

/**
 * Get the native Pi session directory for a cwd when shared Pi storage is on.
 */
export function getPiNativeSessionDir(workspaceRootPath: string, _workingDirectory?: string): string {
  const dir = join(getPiSessionsRoot(), encodePiSessionCwd(workspaceRootPath));
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Ensure Pi has a tree JSONL session projection and attach latest Craft metadata.
 *
 * Pi creates the projection/header; Craft only sends the UI metadata overlay
 * through the Pi facade and returns the projection path.
 */
export function ensureSharedPiTreeSessionFile(session: StoredSession): string {
  const sessionFile = getSessionFilePath(
    session.workspaceRootPath,
    session.craftId,
    session.workingDirectory,
    session.createdAt,
  );
  if (existsSync(sessionFile)) {
    writeTreeSessionCraftMetadata(sessionFile, session);
    return sessionFile;
  }

  const cwd = resolve(expandPath(session.workspaceRootPath));
  const projection = createPiSessionProjection({
    cwd,
    sessionDir: getPiNativeSessionDir(session.workspaceRootPath, session.workingDirectory),
    id: session.sdkSessionId || session.craftId,
  });
  const createdSessionFile = projection.path ?? sessionFile;
  writeTreeSessionCraftMetadata(createdSessionFile, session);
  return createdSessionFile;
}

/**
 * Async variant for persistence queue hot paths.
 */
export async function ensureSharedPiTreeSessionFileAsync(
  session: StoredSession,
  options: EnsureSharedPiTreeSessionFileOptions = {},
): Promise<string> {
  const sessionFile = getSessionFilePath(
    session.workspaceRootPath,
    session.craftId,
    session.workingDirectory,
    session.createdAt,
  );
  if (existsSync(sessionFile)) {
    await writeTreeSessionCraftMetadataAsync(sessionFile, session, {
      lastWrittenHeaderSignature: options.lastWrittenHeaderSignature,
    });
    return sessionFile;
  }

  const cwd = resolve(expandPath(session.workspaceRootPath));
  const projection = createPiSessionProjection({
    cwd,
    sessionDir: getPiNativeSessionDir(session.workspaceRootPath, session.workingDirectory),
    id: session.sdkSessionId || session.craftId,
  });
  const createdSessionFile = projection.path ?? sessionFile;
  await writeTreeSessionCraftMetadataAsync(createdSessionFile, session, {
    lastWrittenHeaderSignature: options.lastWrittenHeaderSignature,
  });
  return createdSessionFile;
}

/**
 * Ensure session directory exists with all subdirectories
 */
export function ensureSessionDir(workspaceRootPath: string, sessionId: string, workingDirectory?: string): string {
  const sessionDir = getSessionPath(workspaceRootPath, sessionId, workingDirectory);
  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true });
  }
  // Also create plans, attachments, long_responses, and downloads directories
  const plansDir = join(sessionDir, 'plans');
  if (!existsSync(plansDir)) {
    mkdirSync(plansDir, { recursive: true });
  }
  const attachmentsDir = join(sessionDir, 'attachments');
  if (!existsSync(attachmentsDir)) {
    mkdirSync(attachmentsDir, { recursive: true });
  }
  const longResponsesDir = join(sessionDir, 'long_responses');
  if (!existsSync(longResponsesDir)) {
    mkdirSync(longResponsesDir, { recursive: true });
  }
  // Data directory for transform_data tool output (JSON files for datatable/spreadsheet)
  const dataDir = join(sessionDir, 'data');
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
  // Downloads directory for binary files from API responses (PDFs, images, etc.)
  const downloadsDir = join(sessionDir, 'downloads');
  if (!existsSync(downloadsDir)) {
    mkdirSync(downloadsDir, { recursive: true });
  }
  return sessionDir;
}

/**
 * Get the attachments directory for a session
 */
export function getSessionAttachmentsPath(workspaceRootPath: string, sessionId: string): string {
  return join(getSessionPath(workspaceRootPath, sessionId), 'attachments');
}

/**
 * Get the plans directory for a session
 */
export function getSessionPlansPath(workspaceRootPath: string, sessionId: string): string {
  return join(getSessionPath(workspaceRootPath, sessionId), 'plans');
}

/**
 * Get the data directory for a session (transform_data tool output)
 */
export function getSessionDataPath(workspaceRootPath: string, sessionId: string): string {
  return join(getSessionPath(workspaceRootPath, sessionId), 'data');
}

/**
 * Get the downloads directory for a session (binary files from API responses)
 */
export function getSessionDownloadsPath(workspaceRootPath: string, sessionId: string): string {
  return join(getSessionPath(workspaceRootPath, sessionId), 'downloads');
}

// ============================================================
// Session ID Generation
// ============================================================

/**
 * Get existing session IDs for collision detection
 */
function getExistingSessionIds(workspaceRootPath: string): Set<string> {
  return new Set(listCraftSessionDirs(workspaceRootPath).map(entry => entry.sessionId));
}

/**
 * Generate a human-readable session ID
 * Format: YYMMDD-adjective-noun (e.g., 260111-swift-river)
 */
export function generateSessionId(workspaceRootPath: string): string {
  const existingIds = getExistingSessionIds(workspaceRootPath);
  return generateUniqueSessionId(existingIds);
}

// ============================================================
// Session CRUD
// ============================================================

/**
 * Create a new session for a workspace
 */
export async function createSession(
  workspaceRootPath: string,
  options?: {
    name?: string;
    workingDirectory?: string;
    permissionMode?: SessionHeader['permissionMode'];
    enabledSourceSlugs?: string[];
    model?: string;
    llmConnection?: string;
    hidden?: boolean;
    sessionStatus?: SessionHeader['sessionStatus'];
    labels?: string[];
    isFlagged?: boolean;
  }
): Promise<SessionHeader> {
  ensureSessionsDir(workspaceRootPath);

  const now = Date.now();
  const sessionId = generateSessionId(workspaceRootPath);

  // Create session directory with all subdirectories (plans, attachments)
  ensureSessionDir(workspaceRootPath, sessionId);

  // Complete-unification semantics: workspace root is the only execution cwd
  // and the only session bucket owner.
  const workingDirectory = workspaceRootPath;
  const sdkCwd = workspaceRootPath;

  const session: SessionHeader = {
    craftId: sessionId,
    workspaceRootPath,
    conversationFormat: 'pi-projection-v1',
    name: options?.name,
    createdAt: now,
    lastUsedAt: now,
    workingDirectory,
    sdkCwd,
    permissionMode: options?.permissionMode,
    enabledSourceSlugs: options?.enabledSourceSlugs,
    model: options?.model,
    llmConnection: options?.llmConnection,
    hidden: options?.hidden,
    sessionStatus: options?.sessionStatus,
    labels: options?.labels,
    isFlagged: options?.isFlagged,
  };

  // Save empty session
  const storedSession: StoredSession = {
    ...session,
    messages: [],
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      contextTokens: 0,
      costUsd: 0,
    },
  };
  await saveSession(storedSession);

  return session;
}

/**
 * Save session immediately using the persistence queue.
 * Enqueues the session and flushes to ensure immediate write.
 *
 * This unified approach ensures all session writes go through the same
 * async code path, which is more reliable on Windows.
 *
 * Writes in JSONL format: line 1 = header, lines 2+ = messages
 */
export async function saveSession(session: StoredSession): Promise<void> {
  sessionPersistenceQueue.enqueue(session);
  await sessionPersistenceQueue.flush(session.craftId);
}

/**
 * Queue session for async persistence with debouncing.
 * Multiple rapid calls are coalesced into a single write.
 * Use this during active sessions to avoid blocking the main thread.
 */
export { sessionPersistenceQueue, getHeaderMetadataSignature } from './persistence-queue.js'

/**
 * Load session by ID
 * Loads session from folder structure in JSONL format.
 */
export function loadSession(workspaceRootPath: string, sessionId: string): StoredSession | null {
  const end = perf.start('session.loadSession', { sessionId });

  const jsonlPath = getSessionFilePath(workspaceRootPath, sessionId);
  if (existsSync(jsonlPath)) {
    const session = readSessionJsonl(jsonlPath);
    if (session) {
      end();
      return session;
    }
  }

  end();
  return null;
}

/**
 * List sessions for a workspace
 * Lists sessions from folder structure.
 *
 * Uses JSONL header for fast loading (only reads first line of each file).
 *
 * Sessions are aggregated by the workspace's cwd —
 * {@link listCraftSessionDirs} already restricts the scan to the matching
 * `~/.pi/agent/sessions/{encoded-cwd}/` bucket, so every session found here
 * belongs to this workspace's cwd view by construction (no per-header
 * workspaceRootPath filtering needed). Multiple workspaces pointing at the
 * same cwd see the same list.
 */
export function listSessions(workspaceRootPath: string): SessionHeader[] {
  const span = perf.span('session.listSessions');
  const sessionDirs = listCraftSessionDirs(workspaceRootPath);
  span.mark('readdir');
  const sessions: SessionHeader[] = [];

  for (const { jsonlFile, sessionDir } of sessionDirs) {
    // Clean up orphaned .tmp files from crashed atomic writes.
    // These are harmless but waste disk space.
    const tmpFile = jsonlFile + '.tmp';
    if (existsSync(tmpFile)) {
      try { unlinkSync(tmpFile); } catch { /* ignore */ }
    }

    if (existsSync(jsonlFile)) {
      const header = readSessionHeader(jsonlFile);
      if (header) {
        const metadata = headerToMetadata(header, workspaceRootPath, sessionDir);
        if (metadata) sessions.push(metadata);
      }
    }
  }
  span.mark('parsed');
  span.setMetadata('count', sessions.length);

  // Sort by lastUsedAt descending (most recent first)
  const sorted = sessions.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  span.end();
  return sorted;
}

export async function findPiSessionProjectionById(
  workspaceRootPath: string,
  sessionId: string,
): Promise<Awaited<ReturnType<typeof findPiHostSessionProjectionById>> | null> {
  return findPiHostSessionProjectionById({
    cwd: resolve(expandPath(workspaceRootPath)),
    sessionId,
    sessionDir: getSessionStorageRootPath(workspaceRootPath),
  });
}

/**
 * Enrich SessionHeader with UI-only metadata (planCount) and validate fields.
 * Used for fast session list loading from JSONL format.
 */
function headerToMetadata(
  header: SessionHeader,
  workspaceRootPath: string,
  sessionDir?: string,
): SessionHeader | null {
  try {
    // Migration: accept old 'todoState' field from pre-rename session files
    const rawStatus = header.sessionStatus ?? (header as unknown as { todoState?: string }).todoState;
    // Validate sessionStatus against workspace status config
    const validatedStatus = validateSessionStatus(workspaceRootPath, rawStatus);

    // Count plan files for this session
    // listCraftSessionDirs already resolved the sidecar directory. Reusing it
    // avoids rescanning the whole workspace bucket once per session.
    const planCount = listPlanFilesInDirectory(
      sessionDir ? join(sessionDir, 'plans') : getSessionPlansPath(workspaceRootPath, header.craftId),
    ).length;

    const workingDir = workspaceRootPath;
    const sdkCwd = header.sdkCwd ? expandPath(header.sdkCwd) : workspaceRootPath;

    return {
      ...header,
      workspaceRootPath,
      sessionStatus: validatedStatus,
      planCount: planCount > 0 ? planCount : undefined,
      workingDirectory: workingDir,
      sdkCwd,
    } as SessionHeader;
  } catch (error) {
    debug(`[sessions] Failed to convert header to metadata for session "${header?.craftId}" in ${workspaceRootPath}:`, error);
    return null;
  }
}

/**
 * Delete a session and its associated files
 * Deletes session folder and all associated files
 */
export async function deleteSession(workspaceRootPath: string, sessionId: string): Promise<boolean> {
  validateSessionId(sessionId);

  // Cancel any pending persistence write so it cannot resurrect the session
  // file (or its craft metadata) after we delete it on disk below.
  // Awaiting cancel() also waits for any in-progress write to finish, so the
  // write cannot recreate the deleted files (or their craft metadata sidecar).
  await sessionPersistenceQueue.cancel(sessionId, { preventFutureEnqueue: true });

  try {
    // 1. Delete the Pi tree JSONL session file (the authoritative transcript)
    const sessionFile = getSessionFilePath(workspaceRootPath, sessionId);
    if (existsSync(sessionFile)) {
      try { rmSync(sessionFile); } catch { /* ignore */ }
    }

    // 2. Delete the sidecar directory (.craft/{sessionId}/ with attachments, plans, etc.)
    const sessionDir = getSessionPath(workspaceRootPath, sessionId);
    if (existsSync(sessionDir)) {
      rmSync(sessionDir, { recursive: true });
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Get or create the latest session for a workspace
 * Uses listActiveSessions to exclude archived sessions
 */
export async function getOrCreateLatestSession(workspaceRootPath: string): Promise<SessionHeader> {
  const sessions = listActiveSessions(workspaceRootPath);
  if (sessions.length > 0 && sessions[0]) {
    const latest = sessions[0];
    return {
      craftId: latest.craftId,
      sdkSessionId: latest.sdkSessionId,
      workspaceRootPath: latest.workspaceRootPath,
      name: latest.name,
      createdAt: latest.createdAt,
      lastUsedAt: latest.lastUsedAt,
    };
  }
  return createSession(workspaceRootPath);
}

// ============================================================
// Session Metadata Updates
// ============================================================

/**
 * Check if sdkCwd can be safely updated for a session.
 *
 * sdkCwd is normally immutable because the SDK stores session transcripts at
 * ~/.claude/projects/{cwd-slugified}/. However, it's safe to update sdkCwd if
 * no SDK interaction has occurred yet (no transcripts to preserve).
 *
 * @returns true if sdkCwd can be updated (no messages and no SDK session ID)
 */
export function canUpdateSdkCwd(session: StoredSession): boolean {
  // Safe to update if:
  // 1. No messages have been sent yet (no conversation to preserve)
  // 2. No SDK session ID (no transcript exists at the sdkCwd path)
  return session.messages.length === 0 && !session.sdkSessionId;
}

/**
 * Update session metadata
 */
export async function updateSessionMetadata(
  workspaceRootPath: string,
  sessionId: string,
  updates: Partial<Pick<SessionHeader,
    | 'isFlagged'
    | 'name'
    | 'sessionStatus'
    | 'labels'
    | 'lastReadMessageId'
    | 'hasUnread'
    | 'enabledSourceSlugs'
    | 'workingDirectory'
    | 'sdkCwd'
    | 'permissionMode'
    | 'sharedUrl'
    | 'sharedId'
    | 'model'
    | 'llmConnection'
    | 'isArchived'
    | 'archivedAt'
  >>
): Promise<void> {
  const session = loadSession(workspaceRootPath, sessionId);
  if (!session) return;

  if (updates.isFlagged !== undefined) session.isFlagged = updates.isFlagged;
  if (updates.name !== undefined) session.name = updates.name;
  if (updates.sessionStatus !== undefined) session.sessionStatus = updates.sessionStatus;
  if (updates.labels !== undefined) session.labels = updates.labels;
  if (updates.enabledSourceSlugs !== undefined) session.enabledSourceSlugs = updates.enabledSourceSlugs;
  if (updates.workingDirectory !== undefined) session.workingDirectory = workspaceRootPath;
  if (updates.sdkCwd !== undefined) session.sdkCwd = updates.sdkCwd;
  if (updates.permissionMode !== undefined) session.permissionMode = updates.permissionMode;
  if ('lastReadMessageId' in updates) session.lastReadMessageId = updates.lastReadMessageId;
  if ('hasUnread' in updates) session.hasUnread = updates.hasUnread;
  if ('sharedUrl' in updates) session.sharedUrl = updates.sharedUrl;
  if ('sharedId' in updates) session.sharedId = updates.sharedId;
  if (updates.model !== undefined) session.model = updates.model;
  if (updates.llmConnection !== undefined) session.llmConnection = updates.llmConnection;
  if (updates.isArchived !== undefined) session.isArchived = updates.isArchived;
  if ('archivedAt' in updates) session.archivedAt = updates.archivedAt;

  await saveSession(session);
}

// ============================================================
// Pending Plan Execution (Accept & Compact flow)
// ============================================================

/**
 * Set pending plan execution state.
 * Called when user clicks "Accept & Compact" - stores the plan path
 * so it can be executed after compaction, even if the page reloads.
 */
export async function setPendingPlanExecution(
  workspaceRootPath: string,
  sessionId: string,
  target: string | { planPath?: string; artifactId?: string },
  draftInputSnapshot?: string,
): Promise<void> {
  const session = loadSession(workspaceRootPath, sessionId);
  if (!session) return;

  const normalizedTarget = typeof target === 'string' ? { planPath: target } : target;
  if (!normalizedTarget.planPath && !normalizedTarget.artifactId) {
    throw new Error('Pending plan execution requires planPath or artifactId');
  }
  session.pendingPlanExecution = {
    ...normalizedTarget,
    draftInputSnapshot,
    awaitingCompaction: true,
    executionDispatched: false,
  };
  await saveSession(session);
}

/**
 * Mark compaction as complete for pending plan execution.
 * Called when compaction_complete event fires - sets awaitingCompaction to false
 * so reload recovery knows compaction finished and can trigger execution.
 */
export async function markCompactionComplete(
  workspaceRootPath: string,
  sessionId: string
): Promise<void> {
  const session = loadSession(workspaceRootPath, sessionId);
  if (!session?.pendingPlanExecution) return;

  session.pendingPlanExecution.awaitingCompaction = false;
  await saveSession(session);
}

/**
 * Mark pending plan execution as already dispatched from the UI.
 * This prevents reload recovery from sending the same approval message twice
 * if cleanup fails after the send has already been kicked off.
 */
export async function markPendingPlanExecutionDispatched(
  workspaceRootPath: string,
  sessionId: string
): Promise<void> {
  const session = loadSession(workspaceRootPath, sessionId);
  if (!session?.pendingPlanExecution) return;

  session.pendingPlanExecution.executionDispatched = true;
  await saveSession(session);
}

/**
 * Clear pending plan execution state.
 * Called after plan execution is sent, on new user message, or when
 * the pending execution is no longer relevant.
 */
export async function clearPendingPlanExecution(
  workspaceRootPath: string,
  sessionId: string
): Promise<void> {
  const session = loadSession(workspaceRootPath, sessionId);
  if (!session) return;

  delete session.pendingPlanExecution;
  await saveSession(session);
}

/**
 * Get pending plan execution state for a session.
 * Used on reload to check if we need to resume plan execution.
 */
export function getPendingPlanExecution(
  workspaceRootPath: string,
  sessionId: string
): { planPath?: string; artifactId?: string; draftInputSnapshot?: string; awaitingCompaction: boolean; executionDispatched: boolean } | null {
  const session = loadSession(workspaceRootPath, sessionId);
  if (!session?.pendingPlanExecution) return null;
  return {
    ...session.pendingPlanExecution,
    executionDispatched: session.pendingPlanExecution.executionDispatched === true,
  };
}

// ============================================================
// Session Filtering
// ============================================================

/**
 * List active (non-archived) sessions
 */
export function listActiveSessions(workspaceRootPath: string): SessionHeader[] {
  return listSessions(workspaceRootPath).filter(s => s.isArchived !== true);
}

// ============================================================
// Plan Storage (Session-Scoped)
// ============================================================

/**
 * Slugify a string for file names
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[/\\:*?"<>|]/g, '')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .trim();
}

/**
 * Generate a unique, readable file name for a plan
 */
function generatePlanFileName(plan: Plan, plansDir: string): string {
  let name = plan.title || plan.context?.substring(0, 50) || 'untitled';
  let slug = slugify(name);

  if (slug.length > 40) {
    slug = slug.substring(0, 40).replace(/-$/, '');
  }

  const date = new Date().toISOString().split('T')[0];
  const baseName = `${date}-${slug}`;

  let fileName = baseName;
  let counter = 2;

  while (existsSync(join(plansDir, `${fileName}.md`))) {
    fileName = `${baseName}-${counter}`;
    counter++;
  }

  return fileName;
}

/**
 * Ensure the plans directory exists
 */
function ensurePlansDir(workspaceRootPath: string, sessionId: string): string {
  const plansDir = getSessionPlansPath(workspaceRootPath, sessionId);
  if (!existsSync(plansDir)) {
    mkdirSync(plansDir, { recursive: true });
  }
  return plansDir;
}

/**
 * Format a plan as markdown
 */
export function formatPlanAsMarkdown(plan: Plan): string {
  const lines: string[] = [];

  lines.push(`# ${plan.title}`);
  lines.push('');
  lines.push(`**Status:** ${plan.state}`);
  lines.push(`**Created:** ${new Date(plan.createdAt).toISOString()}`);
  if (plan.updatedAt !== plan.createdAt) {
    lines.push(`**Updated:** ${new Date(plan.updatedAt).toISOString()}`);
  }
  lines.push('');

  if (plan.context) {
    lines.push('## Summary');
    lines.push('');
    lines.push(plan.context);
    lines.push('');
  }

  lines.push('## Steps');
  lines.push('');
  for (const step of plan.steps) {
    const checkbox = step.status === 'completed' ? '[x]' : '[ ]';
    const status = step.status === 'in_progress' ? ' *(in progress)*' : '';
    lines.push(`- ${checkbox} ${step.description}${status}`);
    if (step.details) {
      lines.push(`  - Tools: ${step.details}`);
    }
  }
  lines.push('');

  if (plan.refinementHistory && plan.refinementHistory.length > 0) {
    lines.push('## Refinement History');
    lines.push('');
    for (const entry of plan.refinementHistory) {
      lines.push(`### Round ${entry.round}`);
      lines.push(`**Feedback:** ${entry.feedback}`);
      if (entry.questions && entry.questions.length > 0) {
        lines.push(`**Questions:** ${entry.questions.join(', ')}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Parse a markdown plan file back to a Plan object
 */
export function parsePlanFromMarkdown(content: string, planId: string): Plan | null {
  try {
    const lines = content.split('\n');

    const titleLine = lines.find(l => l.startsWith('# '));
    const title = titleLine ? titleLine.substring(2).trim() : 'Untitled Plan';

    const statusLine = lines.find(l => l.startsWith('**Status:**'));
    const stateStr = statusLine ? statusLine.replace('**Status:**', '').trim() : 'ready';
    const state = (['creating', 'refining', 'ready', 'executing', 'completed', 'cancelled'].includes(stateStr)
      ? stateStr
      : 'ready') as Plan['state'];

    const summaryIdx = lines.findIndex(l => l === '## Summary');
    const stepsIdx = lines.findIndex(l => l === '## Steps');
    let context = '';
    if (summaryIdx !== -1 && stepsIdx !== -1) {
      context = lines.slice(summaryIdx + 2, stepsIdx).join('\n').trim();
    }

    const steps: Plan['steps'] = [];
    if (stepsIdx !== -1) {
      for (let i = stepsIdx + 2; i < lines.length; i++) {
        const line = lines[i];
        if (!line || line.startsWith('##')) break;
        if (line.startsWith('- [')) {
          const isCompleted = line.startsWith('- [x]');
          const isInProgress = line.includes('*(in progress)*');
          const description = line
            .replace(/^- \[[ x]\] /, '')
            .replace(' *(in progress)*', '')
            .trim();
          steps.push({
            id: `step-${steps.length + 1}`,
            description,
            status: isCompleted ? 'completed' : isInProgress ? 'in_progress' : 'pending',
          });
        }
      }
    }

    return {
      id: planId,
      title,
      state,
      context,
      steps,
      refinementRound: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  } catch {
    return null;
  }
}

/**
 * Validate a plan file name and resolve its safe path within plansDir.
 * Rejects path separators and any path that escapes plansDir.
 * Throws on path traversal attempts.
 */
function resolvePlanFilePath(plansDir: string, fileName: string): string {
  const safeName = basename(fileName);
  if (safeName !== fileName) {
    throw new Error('Invalid plan file name: path separators not allowed');
  }
  const filePath = join(plansDir, `${safeName}.md`);
  const resolved = resolve(filePath);
  if (!isPathWithinDirectory(resolved, plansDir)) {
    throw new Error('Path traversal detected');
  }
  return filePath;
}

/**
 * Save a plan to a markdown file
 */
export function savePlanToFile(
  workspaceRootPath: string,
  sessionId: string,
  plan: Plan,
  fileName?: string
): string {
  const plansDir = ensurePlansDir(workspaceRootPath, sessionId);
  const name = fileName || generatePlanFileName(plan, plansDir);
  const filePath = resolvePlanFilePath(plansDir, name);
  const content = formatPlanAsMarkdown(plan);

  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

/**
 * Load a plan from a markdown file by name
 */
export function loadPlanFromFile(
  workspaceRootPath: string,
  sessionId: string,
  fileName: string
): Plan | null {
  const plansDir = getSessionPlansPath(workspaceRootPath, sessionId);
  const filePath = resolvePlanFilePath(plansDir, fileName);
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    return parsePlanFromMarkdown(content, fileName);
  } catch {
    return null;
  }
}

/**
 * List all plan files in a session
 */
export function listPlanFiles(
  workspaceRootPath: string,
  sessionId: string
): Array<{ name: string; path: string; modifiedAt: number }> {
  return listPlanFilesInDirectory(getSessionPlansPath(workspaceRootPath, sessionId));
}

function listPlanFilesInDirectory(
  plansDir: string,
): Array<{ name: string; path: string; modifiedAt: number }> {
  if (!existsSync(plansDir)) {
    return [];
  }

  try {
    const files = readdirSync(plansDir)
      .filter(f => f.endsWith('.md'))
      .map(f => {
        const filePath = join(plansDir, f);
        const stats = existsSync(filePath) ? statSync(filePath) : null;
        return {
          name: f.replace('.md', ''),
          path: filePath,
          modifiedAt: stats?.mtimeMs || 0,
        };
      })
      .sort((a, b) => b.modifiedAt - a.modifiedAt);

    return files;
  } catch {
    return [];
  }
}

/**
 * Delete a plan file
 */
export function deletePlanFile(
  workspaceRootPath: string,
  sessionId: string,
  fileName: string
): boolean {
  const plansDir = getSessionPlansPath(workspaceRootPath, sessionId);
  const filePath = resolvePlanFilePath(plansDir, fileName);
  if (existsSync(filePath)) {
    unlinkSync(filePath);
    return true;
  }
  return false;
}

// ============================================================
// Attachments Directory
// ============================================================

/**
 * Ensure attachments directory exists
 */
export function ensureAttachmentsDir(workspaceRootPath: string, sessionId: string): string {
  const dir = getSessionAttachmentsPath(workspaceRootPath, sessionId);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}
