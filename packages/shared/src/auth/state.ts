/**
 * Unified Auth State Management
 *
 * Provides a single source of truth for authentication state:
 * - Billing configuration (api_key or oauth_token)
 * - Workspace/MCP configuration
 */

import {
  loadStoredConfig,
  getActiveWorkspace,
  type AuthType,
  type Workspace,
} from '../config/storage.ts';
import { hasPiGlobalProviderAuth, readPiGlobalApiKey, readPiGlobalCredential, readPiGlobalProviders, readPiGlobalSettings } from '../config/pi-global-config.ts';

// ============================================
// Types
// ============================================

export interface AuthState {
  /** LLM provider billing configuration */
  billing: {
    /** Configured billing type, or null if not yet configured */
    type: AuthType | null;
    /** True if we have the required credentials for the configured billing type */
    hasCredentials: boolean;
    /** LLM API key (if using api_key auth type) */
    apiKey: string | null;
    /** OAuth access token (if using oauth_token auth type) */
    oauthToken: string | null;
  };

  /** Workspace/MCP configuration */
  workspace: {
    hasWorkspace: boolean;
    active: Workspace | null;
  };
}

export interface SetupNeeds {
  /** No billing type configured → show billing picker */
  needsBillingConfig: boolean;
  /** Billing type set but missing credentials → show credential entry */
  needsCredentials: boolean;
  /** Everything complete → go straight to App */
  isFullyConfigured: boolean;
}

// ============================================
// Functions
// ============================================

/**
 * Get complete authentication state from all sources (config file + credential store)
 *
 * Uses Pi provider settings and auth.json as the source of truth.
 */
export async function getAuthState(): Promise<AuthState> {
  const config = loadStoredConfig();
  const activeWorkspace = getActiveWorkspace();
  const settings = readPiGlobalSettings();
  const providerKey = settings.defaultProvider;
  const provider = providerKey ? readPiGlobalProviders()[providerKey] : undefined;
  const credential = providerKey ? readPiGlobalCredential(providerKey) : undefined;
  const effectiveAuthType: AuthType | null = provider
    ? (credential?.type === 'oauth' ? 'oauth_token' : 'api_key')
    : null;
  const apiKey = providerKey ? readPiGlobalApiKey(providerKey) ?? null : null;
  const oauthToken = credential?.type === 'oauth' ? credential.access ?? null : null;
  const hasCredentials = !!provider && (
    hasPiGlobalProviderAuth(providerKey)
    || !!provider.baseUrl
  );

  return {
    billing: {
      type: effectiveAuthType,
      hasCredentials,
      apiKey,
      oauthToken,
    },
    workspace: {
      hasWorkspace: !!activeWorkspace,
      active: activeWorkspace,
    },
  };
}

/**
 * Derive what setup steps are needed based on current auth state
 */
export function getSetupNeeds(state: AuthState, setupDeferred?: boolean): SetupNeeds {
  // Need billing config if no billing type is set
  const needsBillingConfig = state.billing.type === null;

  // Need credentials if billing type is set but credentials are missing
  const needsCredentials = state.billing.type !== null && !state.billing.hasCredentials;

  return {
    needsBillingConfig,
    needsCredentials,
    // Fully configured if setup is complete OR user chose "Setup later"
    isFullyConfigured: (!needsBillingConfig && !needsCredentials) || !!setupDeferred,
  };
}
