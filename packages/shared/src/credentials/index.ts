/**
 * Credential Storage Module
 *
 * Provides credential storage via a thin wrapper over pi auth.json
 * (~/.pi/agent/auth.json, plaintext JSON with 0600 permissions).
 *
 * Usage:
 *   import { getCredentialManager } from './credentials';
 *
 *   const manager = getCredentialManager();
 *
 *   // Get/set Pi provider API key
 *   const apiKey = await manager.getProviderApiKey(providerKey);
 *   await manager.setProviderApiKey(providerKey, 'sk-...');
 *
 *   // Get/set workspace OAuth
 *   const oauth = await manager.getWorkspaceOAuth(workspaceId);
 *   await manager.setWorkspaceOAuth(workspaceId, { accessToken, refreshToken, ... });
 *
 *   // Get/set agent MCP/API credentials
 *   const mcpCreds = await manager.getMcpOAuth(wsId, agentId, serverName);
 *   const apiKey = await manager.getApiKeyForAgent(wsId, agentId, apiName);
 */

export { CredentialManager, getCredentialManager } from './manager.ts';
export type { CredentialId, CredentialType, StoredCredential } from './types.ts';
export { credentialIdToAccount, accountToCredentialId } from './types.ts';
export type { CredentialBackend } from './backends/types.ts';
export { PiCredentialStore, SecureStorageBackend, clearAllCraftCredentials } from './backends/secure-storage.ts';
