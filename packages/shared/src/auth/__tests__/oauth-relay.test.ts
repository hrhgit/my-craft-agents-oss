import { beforeEach, describe, expect, it } from 'bun:test';

import {
  decodeOAuthRelayState,
  encodeOAuthRelayState,
  isOAuthRelayState,
  wrapPreparedOAuthFlowForRelay,
} from '../oauth-relay.ts';
import type { PreparedOAuthFlow } from '../oauth-flow-types.ts';

const OAUTH_RELAY_CALLBACK_URL = 'https://auth.example.com/auth/callback';

beforeEach(() => {
  process.env.MORTISE_OAUTH_RELAY_URL = OAUTH_RELAY_CALLBACK_URL;
});

describe('oauth relay state', () => {
  it('round-trips the relay callback target and inner state', () => {
    const encoded = encodeOAuthRelayState(
      'https://server.example.com/api/oauth/callback',
      'inner-state-123',
    );

    expect(isOAuthRelayState(encoded)).toBe(true);
    expect(decodeOAuthRelayState(encoded)).toEqual({
      returnTo: 'https://server.example.com/api/oauth/callback',
      innerState: 'inner-state-123',
    });
  });

  it('rejects malformed relay state', () => {
    expect(() => decodeOAuthRelayState('ca1.not-valid-base64')).toThrow('Invalid OAuth relay state');
  });
});

describe('wrapPreparedOAuthFlowForRelay', () => {
  it('keeps the inner flow state but rewrites auth URL state and redirect_uri', () => {
    const prepared: PreparedOAuthFlow = {
      authUrl: 'https://mcp.example.com/oauth/authorize?client_id=test-client&redirect_uri=https%3A%2F%2Fold.example%2Fcallback&response_type=code&state=inner-state-123',
      state: 'inner-state-123',
      codeVerifier: 'verifier',
      tokenEndpoint: 'https://mcp.example.com/oauth/token',
      clientId: 'test-client',
      clientSecret: 'test-secret',
      redirectUri: 'https://old.example/callback',
      provider: 'mcp',
    };

    const wrapped = wrapPreparedOAuthFlowForRelay(
      prepared,
      'https://server.example.com/api/oauth/callback',
    );

    expect(wrapped.state).toBe('inner-state-123');
    expect(wrapped.redirectUri).toBe(OAUTH_RELAY_CALLBACK_URL);

    const authUrl = new URL(wrapped.authUrl);
    expect(authUrl.searchParams.get('redirect_uri')).toBe(OAUTH_RELAY_CALLBACK_URL);

    const outerState = authUrl.searchParams.get('state');
    expect(outerState).toBeTruthy();
    expect(outerState).not.toBe('inner-state-123');
    expect(isOAuthRelayState(outerState!)).toBe(true);
    expect(decodeOAuthRelayState(outerState!)).toEqual({
      returnTo: 'https://server.example.com/api/oauth/callback',
      innerState: 'inner-state-123',
    });
  });
});
