/**
 * @mortise/shared
 *
 * Shared business logic for Mortise Agent.
 * Used by the Electron app.
 *
 * Import specific modules via subpath exports:
 *   import { MortiseAgent } from '@mortise/shared/agent';
 *   import { loadStoredConfig } from '@mortise/shared/config';
 *   import { getCredentialManager } from '@mortise/shared/credentials';
 *   import { MortiseMcpClient } from '@mortise/shared/mcp';
 *   import { debug } from '@mortise/shared/utils';
 *   import { loadSource, createSource, getSourceCredentialManager } from '@mortise/shared/sources';
 *   import { createWorkspace, loadWorkspace } from '@mortise/shared/workspaces';
 *
 * Available modules:
 *   - agent: MortiseAgent SDK wrapper, plan tools
 *   - auth: OAuth, token management, auth state
 *   - clients: Mortise API client
 *   - config: Storage, models, preferences
 *   - credentials: Pi auth.json-backed credential storage
 *   - mcp: MCP client, connection validation
 *   - prompts: System prompt generation
 *   - sources: Workspace-scoped source management (MCP, API, local)
 *   - utils: Debug logging, file handling, summarization
 *   - validation: URL validation
 *   - version: Version and installation management
 *   - workspaces: Workspace management (top-level organizational unit)
 */

// Export branding (standalone, no dependencies)
export * from './branding.ts';
