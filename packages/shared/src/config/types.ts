/**
 * Config Types (Browser-safe)
 *
 * Pure type definitions for configuration.
 * Re-exports from @mortise/core for compatibility.
 */

// Re-export all config types from core (single source of truth)
export type {
  Workspace,
  McpAuthType,
  AuthType,
  OAuthCredentials,
} from '@mortise/core/types';

/** App-level network proxy configuration. */
export interface NetworkProxySettings {
  enabled: boolean;
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: string;
}

export type DeveloperKitConfigurationSource = 'automatic' | 'manual';

export interface DeveloperKitManifest {
  schemaVersion: number;
  name: string;
  version: string;
  hostVersion: string;
  uiValidationProtocolVersion: number;
  platform: string;
  arch: string;
  appId: string;
}

export interface DeveloperKitInstallation {
  rootPath: string;
  cliPath: string;
  manifest: DeveloperKitManifest;
}

export interface DeveloperKitStatus {
  state: 'not-configured' | 'ready' | 'invalid';
  source?: DeveloperKitConfigurationSource;
  configuredPath?: string;
  installation?: DeveloperKitInstallation;
  error?: string;
}
