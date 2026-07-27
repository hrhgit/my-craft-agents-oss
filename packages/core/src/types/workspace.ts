/**
 * Workspace and authentication types.
 *
 * Workspace identity is independent from every path, endpoint, name, and
 * remote server identity. Only `Workspace.id` is a durable Workspace identity.
 */

export const WORKSPACE_SCHEMA_VERSION = 2 as const;

/** How an MCP server should be authenticated at Workspace scope. */
export type McpAuthType = 'workspace_oauth' | 'workspace_bearer' | 'public';

export interface LocalWorkspaceEndpoint {
  kind: 'local';
  /** Server-internal absolute path. Never include this field in WorkspaceInfo. */
  rootPath: string;
}

export interface RemoteWorkspaceEndpoint {
  kind: 'remote';
  url: string;
  remoteWorkspaceId: string;
  /** Opaque reference into the credential authority, never credential material. */
  credentialRef: string;
  /** Explicit opt-in for self-signed or otherwise untrusted TLS certificates. */
  allowInsecureTls?: boolean;
}

export type WorkspaceEndpoint = LocalWorkspaceEndpoint | RemoteWorkspaceEndpoint;
export type NonEmptyArray<Value> = [Value, ...Value[]];

export interface WorkspaceLocation {
  id: string;
  /** User-visible name. Names are unique within one Workspace, but are not identities. */
  name: string;
  endpoint: WorkspaceEndpoint;
}

/** Redacted endpoint projection safe to expose to clients. */
export type WorkspaceEndpointInfo =
  | { kind: 'local' }
  | {
      kind: 'remote';
      url: string;
      remoteWorkspaceId: string;
      allowInsecureTls?: boolean;
    };

/** Redacted location projection safe to expose to clients. */
export interface WorkspaceLocationInfo {
  id: string;
  name: string;
  endpoint: WorkspaceEndpointInfo;
}

interface WorkspaceDisplayMetadata {
  name: string;
  /** Display/navigation slug only. It is not a Workspace identity. */
  slug: string;
  lastAccessedAt?: number;
  iconUrl?: string;
  mcpUrl?: string;
  mcpAuthType?: McpAuthType;
}

/** Client-facing Workspace DTO with paths and credential references removed. */
export interface WorkspaceInfo extends WorkspaceDisplayMetadata {
  schemaVersion: typeof WORKSPACE_SCHEMA_VERSION;
  id: string;
  revision: number;
  primaryLocationId: string;
  locations: NonEmptyArray<WorkspaceLocationInfo>;
}

/** Canonical Workspace record used by trusted host/storage boundaries. */
export interface Workspace extends WorkspaceDisplayMetadata {
  schemaVersion: typeof WORKSPACE_SCHEMA_VERSION;
  id: string;
  revision: number;
  primaryLocationId: string;
  locations: NonEmptyArray<WorkspaceLocation>;
  createdAt: number;
}

export function getWorkspaceLocation(
  workspace: Workspace,
  locationId: string,
): WorkspaceLocation | undefined {
  return workspace.locations.find(location => location.id === locationId);
}

export function getPrimaryWorkspaceLocation(workspace: Workspace): WorkspaceLocation {
  const location = getWorkspaceLocation(workspace, workspace.primaryLocationId);
  if (!location) {
    throw new Error(`Workspace ${workspace.id} has no primary location ${workspace.primaryLocationId}`);
  }
  return location;
}

export function requireLocalWorkspaceLocationRoot(
  workspace: Workspace,
  locationId: string,
): string {
  const location = getWorkspaceLocation(workspace, locationId);
  if (!location) {
    throw new Error(`Workspace ${workspace.id} has no location ${locationId}`);
  }
  if (location.endpoint.kind !== 'local') {
    throw new Error(`Workspace location ${locationId} is remote and has no local root`);
  }
  return location.endpoint.rootPath;
}

export function requirePrimaryLocalWorkspaceRoot(workspace: Workspace): string {
  return requireLocalWorkspaceLocationRoot(workspace, workspace.primaryLocationId);
}

/**
 * Source-compatibility name for callers while they migrate to location
 * endpoints. The old token-bearing shape is intentionally not preserved.
 */
export type RemoteServerConfig = RemoteWorkspaceEndpoint;

/** Authentication type for an AI provider. */
export type AuthType = 'api_key' | 'oauth_token' | 'codex_oauth' | 'codex_api_key';

/** Credentials returned by a fresh OAuth flow before secure persistence. */
export interface OAuthCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  clientId: string;
  tokenType: string;
}

// Config stored in JSON/SQLite; credentials are stored by a credential authority.
export interface StoredConfig {
  authType?: AuthType;
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  activeSessionId: string | null;
  model?: string;
}
