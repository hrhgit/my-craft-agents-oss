/** Tests the generic OAuth session deeplink helpers exported by the auth barrel. */
import { describe, it, expect } from 'bun:test';

describe('auth barrel exports', () => {
  it('exports OAuthSessionContext type from auth/index.ts', async () => {
    // Dynamic import to test the barrel export path
    const authModule = await import('../index.ts');
    // buildOAuthDeeplinkUrl is a runtime export; OAuthSessionContext is a type (compile-time only)
    expect(typeof authModule.buildOAuthDeeplinkUrl).toBe('function');
  });

  it('exports buildOAuthDeeplinkUrl that works correctly from barrel', async () => {
    const { buildOAuthDeeplinkUrl } = await import('../index.ts');
    const result = buildOAuthDeeplinkUrl({
      sessionId: 'test-123',
      deeplinkScheme: 'mortise',
    });
    expect(result).toBe('mortise://allSessions/session/test-123');
  });

  it('buildOAuthDeeplinkUrl returns undefined for incomplete context from barrel', async () => {
    const { buildOAuthDeeplinkUrl } = await import('../index.ts');
    expect(buildOAuthDeeplinkUrl(undefined)).toBeUndefined();
    expect(buildOAuthDeeplinkUrl({})).toBeUndefined();
    expect(buildOAuthDeeplinkUrl({ sessionId: 'x' })).toBeUndefined();
    expect(buildOAuthDeeplinkUrl({ deeplinkScheme: 'x' })).toBeUndefined();
  });
});
