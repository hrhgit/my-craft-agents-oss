import { existsSync } from 'fs';
import { dirname } from 'path';
import { tryGetSessionFilePath } from '@mortise/shared/sessions';

export interface SessionSearchRootInput {
  id: string;
  createdAt?: number;
}

/**
 * JSON transport encodes an omitted positional argument as null. Normalize it
 * back to undefined before forwarding extension command text to Pi; otherwise
 * commands such as /discuss receive the literal string "null" and may treat it
 * as a user prompt.
 */
export function serializeExtensionCommandArgs(
  args: string | Record<string, unknown> | null | undefined,
): string | undefined {
  if (args == null) return undefined;
  return typeof args === 'string' ? args : JSON.stringify(args);
}

/**
 * Collect session search root directories for the stable Workspace bucket.
 *
 * Uses tryGetSessionFilePath (no mkdir side effect) so that listing/searching
 * sessions does not create empty bucket directories under
 * ~/.mortise/agent/sessions/{workspace-bucket}/ for sessions whose Pi file does not yet
 * exist. Storage helpers route only by workspaceId.
 */
export function collectSessionSearchRoots(
  workspaceId: string,
  sessions: SessionSearchRootInput[],
): string[] {
  const roots = new Set<string>();

  for (const session of sessions) {
    const sessionFile = tryGetSessionFilePath(workspaceId, session.id);
    if (!sessionFile) continue;
    const root = dirname(sessionFile);
    if (existsSync(root)) {
      roots.add(root);
    }
  }

  return Array.from(roots);
}
