/**
 * Pi Backend Constants
 *
 * Shared constants used by the Pi agent and its event adapter.
 * Extracted here to avoid circular imports between pi-agent.ts and event-adapter.ts.
 */

import type { ThinkingLevel as PiThinkingLevel } from '@mortise/pi-agent-core';
import type { ThinkingLevel } from '../../thinking-levels.ts';

/**
 * Map Mortise's {@link ThinkingLevel} to Pi's `ThinkingLevel`.
 */
export const THINKING_TO_PI: Record<ThinkingLevel, PiThinkingLevel> = {
  off: 'off',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
};

/**
 * Map Pi SDK lowercase tool names to canonical display names.
 * Pi's built-in tools use lowercase names while Mortise projections use
 * PascalCase labels (for example, 'Read' and 'Bash').
 *
 * Used by PiAgent and PiEventAdapter for tool name normalization.
 */
export const PI_TOOL_NAME_MAP: Record<string, string> = {
  bash: 'Bash',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  grep: 'Grep',
  find: 'Find',
  ls: 'Ls',
  // Additional mappings for possible tool names
  multi_edit: 'MultiEdit',
  web_fetch: 'WebFetch',
  web_search: 'WebSearch',
  notebook_edit: 'NotebookEdit',
  glob: 'Glob',
  task: 'Task',
};
