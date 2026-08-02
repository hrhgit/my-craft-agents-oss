/**
 * Centralized path configuration for Mortise Agent.
 *
 * Supports alternate profiles via MORTISE_CONFIG_DIR. All normal launch modes use
 * Electron's existing ~/.mortise directory unless an explicit override is set.
 *
 * Default: ~/.mortise/
 */

import { realpathSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { expandPath } from '../utils/paths.ts';

// Allow override via environment variable for multi-instance dev
// Falls back to default ~/.mortise/ for production and non-numbered dev folders
export const CONFIG_DIR = process.env.MORTISE_CONFIG_DIR || join(homedir(), '.mortise');

/** Mortise-owned Pi runtime data. Independent Pi continues to use ~/.pi/agent. */
export function resolveMortiseAgentDir(environment: NodeJS.ProcessEnv = process.env): string {
  const explicitAgentDir = environment.MORTISE_AGENT_DIR?.trim();
  const configDir = environment.MORTISE_CONFIG_DIR || join(homedir(), '.mortise');
  return explicitAgentDir ? expandPath(explicitAgentDir) : join(configDir, 'agent');
}

export const MORTISE_AGENT_DIR = resolveMortiseAgentDir();
export const MORTISE_MODELS_FILE = join(MORTISE_AGENT_DIR, 'models.json');
export const MORTISE_SETTINGS_FILE = join(MORTISE_AGENT_DIR, 'settings.json');
export const MORTISE_AUTH_FILE = join(MORTISE_AGENT_DIR, 'auth.json');

/** Mortise global skills directory. */
export const MORTISE_SKILLS_DIR = join(MORTISE_AGENT_DIR, 'skills');

/** Canonical Mortise-owned project resource root and paths. */
export const MORTISE_PROJECT_DIR = '.mortise';
export const MORTISE_PROJECT_SETTINGS_FILE = `${MORTISE_PROJECT_DIR}/settings.json`;
export const MORTISE_PROJECT_SKILLS_DIR = `${MORTISE_PROJECT_DIR}/skills`;
export const MORTISE_PROJECT_EXTENSIONS_DIR = `${MORTISE_PROJECT_DIR}/extensions`;

/** Mortise session directory. Historical ~/.pi/agent sessions are not imported. */
export const MORTISE_SESSIONS_DIR = join(MORTISE_AGENT_DIR, 'sessions');

/**
 * Encode a cwd into the Pi sessions directory name.
 *
 * Mirrors pi session-manager.ts getDefaultSessionDirPath(). Resulting bucket:
 * `--{resolved-cwd-with-separators-as-dashes}--`.
 *
 * On Windows, the drive letter is uppercased and the rest of the path is
 * lowercased for consistent bucketing (the filesystem is case-insensitive,
 * so C:\Users\Foo and C:\users\foo resolve to the same bucket).
 *
 * On macOS, the path is lowercased for the same reason (APFS is typically
 * case-insensitive, so /Users/me/Proj and /Users/me/proj resolve to the same
 * bucket).
 *
 * Symbolic links are resolved via realpathSync so that a directory and its
 * symlink resolve to the same bucket (e.g. /path/proj and /path/symlink-to-proj
 * share one bucket). If realpathSync fails (e.g. the path does not exist yet),
 * it falls back to resolve().
 *
 * NOTE (encoding collision, F12): This algorithm replaces `/`, `\`, and `:`
 * with `-`, which can collide for paths like `C:\a-b\c` and `C:\a\b-c` (both
 * encode to `--C-a-b-c--`). This is intentional: the encoding must stay
 * consistent with Pi's algorithm (see pi session-manager.ts
 * getDefaultSessionDirPath()), otherwise Pi-created sessions would be invisible
 * to Mortise and vice versa. Mortise must NOT diverge from Pi's encoding. The
 * realpathSync normalization above reduces collisions in practice because the
 * same physical directory always yields one canonical path; the residual
 * collision risk is mitigated by relying on Pi-side cwd normalization.
 *
 * NOTE (Windows UNC paths, F28): UNC paths such as `\\server\share\dir` are
 * not specially handled. The leading `\\` becomes `--` after the leading-
 * separator strip + dash replacement, which can collide with drive-letter
 * buckets (`--C-...--`). Additionally the server/share components are not
 * upper/lower-cased uniformly with Pi. This is a known limitation: UNC paths
 * are rare in this codebase and Pi's own algorithm does not special-case them
 * either, so diverging here would break Pi/Mortise visibility symmetry. If UNC
 * support becomes a requirement, coordinate a paired change with Pi's
 * session-manager.ts getDefaultSessionDirPath().
 */
export function encodePiSessionCwd(cwd: string): string {
  const expanded = expandPath(cwd);
  let resolvedCwd: string;
  try {
    resolvedCwd = realpathSync(expanded);
  } catch {
    resolvedCwd = resolve(expanded);
  }
  const normalized = process.platform === 'win32'
    ? resolvedCwd.replace(/^([a-zA-Z]):/, (_, d) => d.toUpperCase() + ':')
                .replace(/^([A-Z]:)(.*)$/, (_, drive, rest) => drive + rest.toLocaleLowerCase('en-US'))
    : process.platform === 'darwin'
      ? resolvedCwd.toLocaleLowerCase('en-US')
      : resolvedCwd;
  return `--${normalized.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}
