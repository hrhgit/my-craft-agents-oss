/**
 * Credential Manager
 *
 * Main interface for credential storage. Uses pi auth.json thin wrapper
 * for credential storage (cross-platform, no OS keychain prompts).
 */

import type { CredentialBackend } from './backends/types.ts';
import type { CredentialId, CredentialType, StoredCredential, CredentialHealthStatus, CredentialHealthIssue } from './types.ts';
import type { LlmAuthType, LlmProviderType } from '../agent/backend/types.ts';
import { PiCredentialStore } from './backends/secure-storage.ts';
import { debug } from '../utils/debug.ts';

export class CredentialManager {
  private backends: CredentialBackend[] = [];
  private writeBackend: CredentialBackend | null = null;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  /**
   * Explicitly initialize the credential manager.
   * This is optional - methods auto-initialize via ensureInitialized().
   * Use this for eager initialization at app startup if desired.
   */
  async initialize(): Promise<void> {
    await this.ensureInitialized();
  }

  /**
   * Internal: ensure initialization has completed.
   * Called automatically by all public methods.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }
    // Prevent race condition with concurrent initialization
    if (this.initPromise) {
      return this.initPromise;
    }

    // Clear promise on failure so initialization can be retried
    this.initPromise = this._doInitialize().catch((err) => {
      this.initPromise = null;
      throw err;
    });
    await this.initPromise;
  }

  private ensureInitializedSync(): void {
    if (this.initialized) {
      return;
    }

    // PiCredentialStore is always available and is currently the only
    // credential backend, so synchronous deletion can initialize it directly.
    const backend = new PiCredentialStore();
    this.backends = [backend];
    this.writeBackend = backend;
    this.initialized = true;
    this.initPromise = null;
    debug(`[CredentialManager] Backend available: ${backend.name} (priority ${backend.priority})`);
    debug(`[CredentialManager] Using backend: ${backend.name}`);
  }

  private async _doInitialize(): Promise<void> {
    const potentialBackends: CredentialBackend[] = [
      new PiCredentialStore(),
    ];
    const availableBackends: CredentialBackend[] = [];

    // Check which backends are available
    for (const backend of potentialBackends) {
      if (await backend.isAvailable()) {
        availableBackends.push(backend);
        debug(`[CredentialManager] Backend available: ${backend.name} (priority ${backend.priority})`);
      }
    }

    // A synchronous caller may have initialized the singleton while the async
    // availability checks above were in flight. In that case, keep the sync state
    // instead of appending duplicate backends.
    if (this.initialized) return;

    // Sort by priority (highest first)
    availableBackends.sort((a, b) => b.priority - a.priority);
    this.backends = availableBackends;

    // Use the first available backend for writing
    this.writeBackend = this.backends[0] || null;

    if (this.writeBackend) {
      debug(`[CredentialManager] Using backend: ${this.writeBackend.name}`);
    } else {
      debug(`[CredentialManager] WARNING: No backend available.`);
    }

    this.initialized = true;
  }

  /** Get the name of the active write backend */
  getActiveBackendName(): string | null {
    return this.writeBackend?.name || null;
  }

  /**
   * Get a credential by ID, trying all backends.
   * Automatically initializes if needed.
   */
  async get(id: CredentialId): Promise<StoredCredential | null> {
    await this.ensureInitialized();

    for (const backend of this.backends) {
      try {
        const cred = await backend.get(id);
        if (cred) {
          debug(`[CredentialManager] Found ${id.type} in ${backend.name}`);
          return cred;
        }
      } catch (err) {
        debug(`[CredentialManager] Error reading from ${backend.name}:`, err);
      }
    }

    return null;
  }

  /**
   * Set a credential using the write backend.
   * Automatically initializes if needed.
   */
  async set(id: CredentialId, credential: StoredCredential): Promise<void> {
    await this.ensureInitialized();

    if (!this.writeBackend) {
      throw new Error('No writable credential backend available');
    }

    await this.writeBackend.set(id, credential);
    debug(`[CredentialManager] Saved ${id.type} to ${this.writeBackend.name}`);
  }

  /**
   * Delete a credential from all backends.
   * Automatically initializes if needed.
   */
  async delete(id: CredentialId): Promise<boolean> {
    await this.ensureInitialized();

    let deleted = false;
    let firstError: unknown;
    for (const backend of this.backends) {
      try {
        if (await backend.delete(id)) {
          deleted = true;
          debug(`[CredentialManager] Deleted ${id.type} from ${backend.name}`);
        }
      } catch (err) {
        firstError ??= err;
        debug(`[CredentialManager] Error deleting from ${backend.name}:`, err);
      }
    }

    if (firstError) {
      throw firstError;
    }

    return deleted;
  }

  deleteSync(id: CredentialId): boolean {
    this.ensureInitializedSync();

    let deleted = false;
    let firstError: unknown;
    for (const backend of this.backends) {
      if (!backend.deleteSync) {
        debug(`[CredentialManager] Backend ${backend.name} does not support synchronous delete`);
        continue;
      }

      try {
        if (backend.deleteSync(id)) {
          deleted = true;
          debug(`[CredentialManager] Deleted ${id.type} from ${backend.name}`);
        }
      } catch (err) {
        firstError ??= err;
        debug(`[CredentialManager] Error deleting from ${backend.name}:`, err);
      }
    }

    if (firstError) {
      throw firstError;
    }

    return deleted;
  }


  /**
   * List credentials matching a filter.
   * Automatically initializes if needed.
   */
  async list(filter?: Partial<CredentialId>): Promise<CredentialId[]> {
    await this.ensureInitialized();

    const seen = new Set<string>();
    const results: CredentialId[] = [];

    for (const backend of this.backends) {
      try {
        const ids = await backend.list(filter);
        for (const id of ids) {
          const key = JSON.stringify(id);
          if (!seen.has(key)) {
            seen.add(key);
            results.push(id);
          }
        }
      } catch (err) {
        debug(`[CredentialManager] Error listing from ${backend.name}:`, err);
      }
    }

    return results;
  }

  // ============================================================
  // Convenience Methods
  // ============================================================

  /** Get workspace MCP OAuth credentials */
  async getWorkspaceOAuth(workspaceId: string): Promise<{
    accessToken: string;
    tokenType?: string;
    clientId?: string;
  } | null> {
    const cred = await this.get({ type: 'workspace_oauth', workspaceId });
    if (!cred) return null;
    return {
      accessToken: cred.value,
      tokenType: cred.tokenType,
      clientId: cred.clientId,
    };
  }

  /** Set workspace MCP OAuth credentials */
  async setWorkspaceOAuth(workspaceId: string, credentials: {
    accessToken: string;
    tokenType?: string;
    clientId?: string;
  }): Promise<void> {
    await this.set(
      { type: 'workspace_oauth', workspaceId },
      {
        value: credentials.accessToken,
        tokenType: credentials.tokenType,
        clientId: credentials.clientId,
      }
    );
  }

  async getAutomationSecret(workspaceId: string, id: string): Promise<string | null> {
    const credential = await this.get({ type: 'automation_secret', workspaceId, name: id })
    return credential?.value ?? null
  }

  async setAutomationSecret(workspaceId: string, id: string, value: string): Promise<void> {
    await this.set({ type: 'automation_secret', workspaceId, name: id }, { value })
  }

  // Note: OpenAI API key methods removed - Codex uses native ChatGPT OAuth flow

  // ============================================================
  // LLM Connection Credentials
  // ============================================================

  /**
   * Get API key for an Pi provider.
   * @param providerKey - The provider key
   * @returns API key or null if not found
   */
  async getProviderApiKey(providerKey: string): Promise<string | null> {
    const cred = await this.get({ type: 'llm_api_key', providerKey });
    return cred?.value || null;
  }

  /**
   * Set API key for an Pi provider.
   * @param providerKey - The provider key
   * @param apiKey - The API key to store
   */
  async setProviderApiKey(providerKey: string, apiKey: string): Promise<void> {
    await this.set({ type: 'llm_api_key', providerKey }, { value: apiKey });
  }

  /**
   * Delete API key for an Pi provider.
   * @param providerKey - The provider key
   * @returns true if deleted, false if not found
   */
  async deleteProviderApiKey(providerKey: string): Promise<boolean> {
    return this.delete({ type: 'llm_api_key', providerKey });
  }

  /**
   * Get OAuth token for an Pi provider.
   * @param providerKey - The provider key
   * @returns OAuth credentials or null if not found
   */
  async getProviderOAuth(providerKey: string): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    /** OIDC id_token (used by OpenAI/Codex) */
    idToken?: string;
  } | null> {
    const cred = await this.get({ type: 'llm_oauth', providerKey });
    if (!cred) return null;
    return {
      accessToken: cred.value,
      refreshToken: cred.refreshToken,
      expiresAt: cred.expiresAt,
      idToken: cred.idToken,
    };
  }

  /**
   * Set OAuth token for an Pi provider.
   * @param providerKey - The provider key
   * @param credentials - OAuth credentials to store
   */
  async setProviderOAuth(providerKey: string, credentials: {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    /** OIDC id_token (used by OpenAI/Codex) */
    idToken?: string;
  }): Promise<void> {
    await this.set({ type: 'llm_oauth', providerKey }, {
      value: credentials.accessToken,
      refreshToken: credentials.refreshToken,
      expiresAt: credentials.expiresAt,
      idToken: credentials.idToken,
    });
  }

  /**
   * Delete all credentials for an Pi provider.
   * @param providerKey - The provider key
   */
  async deleteProviderCredentials(providerKey: string): Promise<void> {
    await this.delete({ type: 'llm_api_key', providerKey });
    await this.delete({ type: 'llm_oauth', providerKey });
    await this.delete({ type: 'llm_iam', providerKey });
    await this.delete({ type: 'llm_service_account', providerKey });
  }

  // ============================================================
  // IAM Credentials (AWS Bedrock)
  // ============================================================

  /**
   * Get IAM credentials for an Pi provider.
   * @param providerKey - The provider key
   * @returns IAM credentials or null if not found
   */
  async getProviderIamCredentials(providerKey: string): Promise<{
    accessKeyId: string;
    secretAccessKey: string;
    region?: string;
    sessionToken?: string;
  } | null> {
    const cred = await this.get({ type: 'llm_iam', providerKey });
    if (!cred || !cred.awsAccessKeyId) return null;
    return {
      accessKeyId: cred.awsAccessKeyId,
      secretAccessKey: cred.value, // Secret key stored in value field
      region: cred.awsRegion,
      sessionToken: cred.awsSessionToken,
    };
  }

  /**
   * Set IAM credentials for an Pi provider.
   * @param providerKey - The provider key
   * @param credentials - IAM credentials to store
   */
  async setProviderIamCredentials(providerKey: string, credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    region?: string;
    sessionToken?: string;
  }): Promise<void> {
    await this.set({ type: 'llm_iam', providerKey }, {
      value: credentials.secretAccessKey, // Primary secret in value field
      awsAccessKeyId: credentials.accessKeyId,
      awsRegion: credentials.region,
      awsSessionToken: credentials.sessionToken,
    });
  }

  // ============================================================
  // Service Account Credentials (GCP Vertex)
  // ============================================================

  /**
   * Get service account credentials for an Pi provider.
   * @param providerKey - The provider key
   * @returns Service account JSON and metadata or null if not found
   */
  async getProviderServiceAccount(providerKey: string): Promise<{
    serviceAccountJson: string;
    projectId?: string;
    region?: string;
    email?: string;
  } | null> {
    const cred = await this.get({ type: 'llm_service_account', providerKey });
    if (!cred) return null;
    return {
      serviceAccountJson: cred.value, // Full JSON stored in value field
      projectId: cred.gcpProjectId,
      region: cred.gcpRegion,
      email: cred.serviceAccountEmail,
    };
  }

  /**
   * Set service account credentials for an Pi provider.
   * @param providerKey - The provider key
   * @param credentials - Service account credentials to store
   */
  async setProviderServiceAccount(providerKey: string, credentials: {
    serviceAccountJson: string;
    projectId?: string;
    region?: string;
    email?: string;
  }): Promise<void> {
    await this.set({ type: 'llm_service_account', providerKey }, {
      value: credentials.serviceAccountJson, // Full JSON in value field
      gcpProjectId: credentials.projectId,
      gcpRegion: credentials.region,
      serviceAccountEmail: credentials.email,
    });
  }

  // ============================================================
  // Unified Credential Checking
  // ============================================================

  /**
   * Check if an Pi provider has valid credentials.
   * Uses the new LlmAuthType system - routes by auth mechanism.
   *
   * @param providerKey - The provider key
   * @param authType - The auth type to check
   * @param providerType - Optional provider type for OAuth routing
   * @returns true if credentials exist and are valid
   */
  async hasProviderCredentials(
    providerKey: string,
    authType: LlmAuthType,
    providerType?: LlmProviderType
  ): Promise<boolean> {
    switch (authType) {
      // No credentials needed
      case 'none':
      case 'environment':
        return true;

      // API key variants - all use the same storage
      case 'api_key':
      case 'api_key_with_endpoint':
      case 'bearer_token':
        return this.hasProviderApiKeyCredential(providerKey);

      // OAuth - browser flow
      case 'oauth':
        return this.hasProviderOAuthCredential(providerKey, providerType);

      // AWS IAM credentials
      case 'iam_credentials':
        return this.hasProviderIamCredential(providerKey);

      // GCP service account
      case 'service_account_file':
        return this.hasProviderServiceAccountCredential(providerKey);

      default:
        // Exhaustive check - TypeScript will error if we miss a case
        const _exhaustive: never = authType;
        return false;
    }
  }

  /**
   * Check if connection has valid API key credential.
   * @internal
   */
  private async hasProviderApiKeyCredential(providerKey: string): Promise<boolean> {
    const apiKey = await this.getProviderApiKey(providerKey);
    return !!apiKey;
  }

  /**
   * Check if connection has valid OAuth credential.
   * @internal
   */
  private async hasProviderOAuthCredential(
    providerKey: string,
    providerType?: LlmProviderType
  ): Promise<boolean> {
    const oauth = await this.getProviderOAuth(providerKey);
    if (!oauth) return false;

    // Check if expired
    if (oauth.expiresAt && this.isExpired({ value: oauth.accessToken, expiresAt: oauth.expiresAt })) {
      return !!oauth.refreshToken; // Can refresh
    }
    return true;
  }

  /**
   * Check if connection has valid IAM credential.
   * @internal
   */
  private async hasProviderIamCredential(providerKey: string): Promise<boolean> {
    const cred = await this.getProviderIamCredentials(providerKey);
    return !!cred?.accessKeyId && !!cred?.secretAccessKey;
  }

  /**
   * Check if connection has valid service account credential.
   * @internal
   */
  private async hasProviderServiceAccountCredential(providerKey: string): Promise<boolean> {
    const cred = await this.getProviderServiceAccount(providerKey);
    return !!cred?.serviceAccountJson;
  }

  /**
   * Check if a credential is expired (with 5-minute buffer).
   *
   * If expiresAt is not set:
   * - OAuth tokens (have refreshToken): treated as expired to force refresh attempt
   * - API keys (no refreshToken): treated as never expiring
   *
   * This prevents OAuth tokens from being treated as valid forever when
   * the provider doesn't return expires_in in the token response.
   */
  isExpired(credential: StoredCredential): boolean {
    if (credential.expiresAt) {
      // Consider expired if within 5 minutes of expiry
      return Date.now() > credential.expiresAt - 5 * 60 * 1000;
    }

    // No expiresAt set - behavior depends on credential type
    if (credential.refreshToken) {
      // OAuth token without expiry - treat as expired to force refresh
      // This is safer than assuming it's valid forever
      debug('[CredentialManager] OAuth token missing expiresAt - treating as expired');
      return true;
    }

    // API key without expiry - these typically don't expire
    return false;
  }

  // ============================================================
  // Health Check
  // ============================================================

  /**
   * Check the health of the credential store.
   *
   * This validates:
   * 1. The credential file (pi auth.json) can be read and parsed (if it exists)
   * 2. The default Pi provider has valid credentials
   *
   * Note: credentials are stored as plaintext JSON in ~/.pi/agent/auth.json
   * (0600 permissions). There is no decryption step; the former
   * `decryption_failed` branch (machine migration detection) is no longer
   * reachable and has been removed.
   *
   * Use this on app startup to detect issues before users hit cryptic errors.
   *
   * @returns Health status with any issues found
   */
  async checkHealth(): Promise<CredentialHealthStatus> {
    const issues: CredentialHealthIssue[] = [];

    try {
      await this.ensureInitialized();

      // 1. Try to list credentials - this triggers parsing of pi auth.json.
      // If the file is corrupted or can't be parsed, this will throw.
      await this.list({});

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const lowerMsg = errorMsg.toLowerCase();

      // Credentials are now plaintext JSON (no encryption), so only parse/read
      // failures are possible. The former `decryption_failed` branch checked for
      // 'decrypt'/'cipher'/'authentication tag' keywords which can no longer
      // occur after the migration to pi auth.json.
      if (lowerMsg.includes('json') || lowerMsg.includes('parse') || lowerMsg.includes('unexpected')) {
        issues.push({
          type: 'file_corrupted',
          message: 'Credential file is corrupted. Please re-authenticate.',
          error: errorMsg,
        });
      } else {
        // Unknown error - treat as corruption
        issues.push({
          type: 'file_corrupted',
          message: 'Failed to read credentials. Please re-authenticate.',
          error: errorMsg,
        });
      }

      return { healthy: false, issues };
    }

    // 2. Check if the default Pi provider has credentials.
    // Import lazily to avoid circular dependency
    try {
      const { hasPiGlobalProviderAuth, readPiGlobalProviders, readPiGlobalSettings } = await import('../config/pi-global-config.ts');
      const settings = readPiGlobalSettings();
      const providerKey = settings.defaultProvider;
      const provider = providerKey ? readPiGlobalProviders()[providerKey] : undefined;

      if (providerKey && provider && !provider.baseUrl && !hasPiGlobalProviderAuth(providerKey)) {
        issues.push({
          type: 'no_default_credentials',
          message: `No credentials found for default provider "${providerKey}".`,
        });
      }
    } catch (configError) {
      // Config not yet initialized - skip this check
      debug('[CredentialManager] Skipping default provider check - config not available');
    }

    return {
      healthy: issues.length === 0,
      issues,
    };
  }
}

// Singleton instance
let manager: CredentialManager | null = null;

export function getCredentialManager(): CredentialManager {
  if (!manager) {
    manager = new CredentialManager();
  }
  return manager;
}
