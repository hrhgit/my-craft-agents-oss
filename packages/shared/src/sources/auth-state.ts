import type { FolderSourceConfig, LoadedSource, SourceConnectionStatus } from './types.ts';

/**
 * Update the auth/status runtime fields on a source config.
 * Use this instead of open-coding `isAuthenticated` mutations.
 */
export function setSourceConfigAuthState(
  config: FolderSourceConfig,
  isAuthenticated: boolean,
  connectionStatus?: SourceConnectionStatus,
  connectionError?: string,
): void {
  config.isAuthenticated = isAuthenticated;
  config.connectionStatus = connectionStatus;
  config.connectionError = connectionError;
}

/**
 * Raw auth flag accessor for code that needs the stored runtime bit rather than
 * the broader "usable" semantics for no-auth sources.
 */
export function isSourceConfigAuthenticated(config: FolderSourceConfig): boolean {
  return config.isAuthenticated === true;
}

/**
 * True when a source has an auth requirement.
 * No-auth sources and stdio MCP sources are usable without stored auth state.
 * HTTP/SSE MCP sources must opt out with authType: 'none'; missing authType is
 * treated as auth-required to match source config validation.
 */
export function sourceRequiresAuthentication(source: LoadedSource): boolean {
  if (source.config.type === 'mcp') {
    const mcp = source.config.mcp;
    if (!mcp) return false;
    if (mcp.transport === 'stdio') return false;
    return mcp.authType !== 'none';
  }

  if (source.config.type === 'api') {
    const authType = source.config.api?.authType;
    return authType !== undefined && authType !== 'none';
  }

  return false;
}

/**
 * True when a source either needs no auth or has completed auth.
 */
export function isSourceAuthenticationSatisfied(source: LoadedSource): boolean {
  return !sourceRequiresAuthentication(source) || isSourceConfigAuthenticated(source.config);
}
