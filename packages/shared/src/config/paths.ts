/**
 * Centralized path configuration for Craft Agent.
 *
 * Supports multi-instance development via CRAFT_CONFIG_DIR environment variable.
 * When running from a numbered folder (e.g., craft-tui-agent-1), the detect-instance.sh
 * script sets CRAFT_CONFIG_DIR to ~/.craft-agent-1, allowing multiple instances to run
 * simultaneously with separate configurations.
 *
 * Default (non-numbered folders): ~/.craft-agent/
 * Instance 1 (-1 suffix): ~/.craft-agent-1/
 * Instance 2 (-2 suffix): ~/.craft-agent-2/
 */

import { homedir } from 'os';
import { join } from 'path';

// Allow override via environment variable for multi-instance dev
// Falls back to default ~/.craft-agent/ for production and non-numbered dev folders
export const CONFIG_DIR = process.env.CRAFT_CONFIG_DIR || join(homedir(), '.craft-agent');

// Pi CLI global config directory (~/.pi/agent by default).
// Respects PI_CODING_AGENT_DIR to stay consistent with Pi SDK's getAgentDir().
export const PI_AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');
export const PI_MODELS_FILE = join(PI_AGENT_DIR, 'models.json');
export const PI_SETTINGS_FILE = join(PI_AGENT_DIR, 'settings.json');
export const PI_AUTH_FILE = join(PI_AGENT_DIR, 'auth.json');

// Pi skills directories (shared with Craft in full-passthrough shell mode)
/** Global Pi skills directory: ~/.pi/agent/skills/ */
export const PI_SKILLS_DIR = join(PI_AGENT_DIR, 'skills');
/** Project-level Pi skills relative directory name */
export const PI_PROJECT_SKILLS_DIR = '.pi/skills';

// Pi sessions directory (shared with Craft in full-passthrough shell mode)
/** Global Pi sessions directory: ~/.pi/agent/sessions/ */
export const PI_SESSIONS_DIR = join(PI_AGENT_DIR, 'sessions');
/** Project-level Pi sessions relative directory name */
export const PI_PROJECT_SESSIONS_DIR = '.pi/sessions';
