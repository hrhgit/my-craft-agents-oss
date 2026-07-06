/**
 * Tests for AbortReason enum values.
 */
import { describe, it, expect } from 'bun:test';
import { AbortReason } from '../session-lifecycle.ts';

describe('AbortReason enum', () => {
  it('should have expected values', () => {
    expect(AbortReason.UserStop as string).toBe('user_stop');
    expect(AbortReason.PlanSubmitted as string).toBe('plan_submitted');
    expect(AbortReason.AuthRequest as string).toBe('auth_request');
    expect(AbortReason.Redirect as string).toBe('redirect');
    expect(AbortReason.SourceActivated as string).toBe('source_activated');
  });
});
