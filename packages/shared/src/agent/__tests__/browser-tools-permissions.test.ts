/**
 * Tests for browser tool permission handling across permission modes.
 *
 * browser_tool should be allowed in safe/Explore mode because it is
 * an interactive browsing operation and does not mutate local files/system state.
 */
import { describe, it, expect } from 'bun:test';
import { shouldAllowToolInMode } from '../../agent/mode-manager.ts';

describe('browser tools permission mode handling', () => {
  it('allows browser_tool in safe mode', () => {
    expect(shouldAllowToolInMode('browser_tool', {}, 'safe').allowed).toBe(true);
  });

  it('allows browser_tool in ask mode without requiring permission', () => {
    const result = shouldAllowToolInMode('browser_tool', {}, 'ask');
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.requiresPermission).toBeFalsy();
    }
  });

  it('allows browser_tool in allow-all mode', () => {
    expect(shouldAllowToolInMode('browser_tool', {}, 'allow-all').allowed).toBe(true);
  });
});
