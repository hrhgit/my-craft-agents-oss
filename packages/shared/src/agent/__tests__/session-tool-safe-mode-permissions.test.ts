/**
 * Regression tests for metadata-driven session tool safe-mode classification.
 */
import { describe, it, expect } from 'bun:test';
import { shouldAllowToolInMode } from '../../agent/mode-manager.ts';

describe('session tool safe-mode classification', () => {
  // send_developer_feedback intentionally omitted — it is feature-flagged via
  // FEATURE_FLAGS.developerFeedback (off by default outside dev runtimes), so
  // its safe-mode visibility depends on env state. The dedicated suite at
  // send-developer-feedback-permissions.test.ts owns that flag-aware behavior.
  it('allows read-only session tools in safe mode', () => {
    const allowedTools = [
      'browser_tool',
      'script_sandbox',
    ] as const;

    for (const toolName of allowedTools) {
      const result = shouldAllowToolInMode(toolName, {}, 'safe');
      expect(result.allowed).toBe(true);
    }
  });

  it('blocks mutating/auth session tools in safe mode', () => {
    const blockedTools = [
      'spawn_session',
      'update_user_preferences',
    ] as const;

    for (const toolName of blockedTools) {
      const result = shouldAllowToolInMode(toolName, {}, 'safe');
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toContain('Session configuration changes are blocked in');
      }
    }
  });

  it('keeps legacy prefixed names readable', () => {
    expect(shouldAllowToolInMode('mcp__session__script_sandbox', {}, 'safe').allowed).toBe(true);
    expect(shouldAllowToolInMode('mcp__session__spawn_session', {}, 'safe').allowed).toBe(false);
  });
});
