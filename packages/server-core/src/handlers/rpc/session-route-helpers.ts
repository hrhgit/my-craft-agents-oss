import { existsSync } from 'fs';
import { dirname } from 'path';
import { tryGetSessionFilePath, getSharedPiSidecarPathForFile, readPiSessionFile } from '@craft-agent/shared/sessions';

export interface SessionSearchRootInput {
  id: string;
  workingDirectory?: string;
  createdAt?: number;
}

export interface PiReadOnlySessionResolution {
  filePath: string;
  sessionDir: string | null;
  sessionFolderPath: string;
  metadata: ReturnType<typeof readPiSessionFile>;
}

/**
 * Collect session search root directories for the workspace root bucket.
 *
 * Uses tryGetSessionFilePath (no mkdir side effect) so that listing/searching
 * sessions does not create empty bucket directories under
 * ~/.pi/agent/sessions/{encoded-cwd}/ for sessions whose Pi file does not yet
 * exist. The legacy per-session workingDirectory field is accepted only for
 * DTO compatibility; storage helpers route by workspaceRootPath.
 */
export function collectSessionSearchRoots(
  workspaceRootPath: string,
  sessions: SessionSearchRootInput[],
): string[] {
  const roots = new Set<string>();

  for (const session of sessions) {
    const sessionFile = tryGetSessionFilePath(
      workspaceRootPath,
      session.id,
      session.workingDirectory,
    );
    if (!sessionFile) continue;
    const root = dirname(sessionFile);
    if (existsSync(root)) {
      roots.add(root);
    }
  }

  return Array.from(roots);
}

/**
 * Resolve a `pi-<id>` read-only session.
 *
 * Uses tryGetSessionFilePath (no mkdir side effect) so that probing for a
 * session's existence does not create its parent bucket directory.
 */
export function resolvePiReadOnlySession(
  sessionId: string,
  workspaceRootPath: string,
): PiReadOnlySessionResolution | null {
  if (!sessionId.startsWith('pi-')) return null;

  const rawSessionId = sessionId.slice(3);
  const filePath = tryGetSessionFilePath(workspaceRootPath, rawSessionId);
  if (!filePath || !existsSync(filePath)) return null;

  const metadata = readPiSessionFile(filePath, workspaceRootPath);
  const craftSessionId = metadata?.craftId && !metadata.craftId.startsWith('pi-')
    ? metadata.craftId
    : rawSessionId;
  const sessionDirCandidate = getSharedPiSidecarPathForFile(filePath, craftSessionId);
  const sessionDir = existsSync(sessionDirCandidate) ? sessionDirCandidate : null;

  return {
    filePath,
    sessionDir,
    sessionFolderPath: sessionDir ?? filePath,
    metadata,
  };
}
