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

// Pi CLI global config directory (~/.pi/agent by default).
// Respects PI_CODING_AGENT_DIR to stay consistent with Pi SDK's getAgentDir().
export const PI_AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');
export const PI_MODELS_FILE = join(PI_AGENT_DIR, 'models.json');
export const PI_SETTINGS_FILE = join(PI_AGENT_DIR, 'settings.json');
export const PI_AUTH_FILE = join(PI_AGENT_DIR, 'auth.json');

// Pi skills directories (shared with Mortise in full-passthrough shell mode)
/** Global Pi skills directory: ~/.pi/agent/skills/ */
export const PI_SKILLS_DIR = join(PI_AGENT_DIR, 'skills');
/** Project-level Pi skills relative directory name */
export const PI_PROJECT_SKILLS_DIR = '.pi/skills';

// Pi sessions directory (shared with Mortise in full-passthrough shell mode)
/** Global Pi sessions directory: ~/.pi/agent/sessions/ */
export const PI_SESSIONS_DIR = join(PI_AGENT_DIR, 'sessions');
/** Project-level Pi sessions relative directory name */
export const PI_PROJECT_SESSIONS_DIR = '.pi/sessions';

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
