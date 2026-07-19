import type { PreparedOAuthFlow } from './oauth-flow-types.ts';

const OAUTH_RELAY_STATE_PREFIX = 'ca1.';
const OAUTH_RELAY_STATE_VERSION = 1;

export function getOAuthRelayCallbackUrl(): string {
  const value = process.env.MORTISE_OAUTH_RELAY_URL?.trim();
  if (!value) {
    throw new Error('OAuth relay is not configured. Set MORTISE_OAUTH_RELAY_URL to enable relayed OAuth flows.');
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('MORTISE_OAUTH_RELAY_URL must be an absolute HTTPS URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('MORTISE_OAUTH_RELAY_URL must use HTTPS');
  }
  return value;
}

interface OAuthRelayStateEnvelope {
  v: number;
  r: string;
  s: string;
}

export interface OAuthRelayState {
  returnTo: string;
  innerState: string;
}

function toBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4 || 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function isOAuthRelayState(value: string): boolean {
  return value.startsWith(OAUTH_RELAY_STATE_PREFIX);
}

export function encodeOAuthRelayState(returnTo: string, innerState: string): string {
  const envelope: OAuthRelayStateEnvelope = {
    v: OAUTH_RELAY_STATE_VERSION,
    r: returnTo,
    s: innerState,
  };
  return `${OAUTH_RELAY_STATE_PREFIX}${toBase64Url(JSON.stringify(envelope))}`;
}

export function decodeOAuthRelayState(value: string): OAuthRelayState {
  if (!isOAuthRelayState(value)) {
    throw new Error('State does not use the OAuth relay envelope');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64Url(value.slice(OAUTH_RELAY_STATE_PREFIX.length)));
  } catch {
    throw new Error('Invalid OAuth relay state');
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('v' in parsed) || parsed.v !== OAUTH_RELAY_STATE_VERSION ||
    !('r' in parsed) || typeof parsed.r !== 'string' || parsed.r.length === 0 ||
    !('s' in parsed) || typeof parsed.s !== 'string' || parsed.s.length === 0
  ) {
    throw new Error('Invalid OAuth relay state');
  }

  return {
    returnTo: parsed.r,
    innerState: parsed.s,
  };
}

export function wrapPreparedOAuthFlowForRelay(
  prepared: PreparedOAuthFlow,
  returnTo: string,
): PreparedOAuthFlow {
  const relayCallbackUrl = getOAuthRelayCallbackUrl();
  const authUrl = new URL(prepared.authUrl);
  authUrl.searchParams.set('redirect_uri', relayCallbackUrl);
  authUrl.searchParams.set('state', encodeOAuthRelayState(returnTo, prepared.state));

  return {
    ...prepared,
    authUrl: authUrl.toString(),
    redirectUri: relayCallbackUrl,
  };
}
