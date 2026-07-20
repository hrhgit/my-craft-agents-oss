/**
 * Spawn Session Tool (spawn_session)
 *
 * Session-scoped tool that enables the main agent to create independent sessions
 * with a configurable provider, model, and initial prompt.
 *
 * Task 11: spawn_session is now a thin wrapper. When the backend implements
 * spawnChildSession (PiAgent), the onSpawnSession callback delegates to pi's
 * session tree — pi creates the child session file (header + spawnedFrom +
 * spawnConfig + optional initial prompt/name) and mortise no longer instantiates
 * its own SessionManager or writes session files. The SubagentPanel lists these
 * children via listChildSessions(spawnedFrom filter). Backends without
 * spawnChildSession fall back to independent mortise session creation (deprecated).
 *
 * Two modes:
 * - help=true: Returns available providers and models
 * - Default: Creates a session and sends the prompt (fire-and-forget)
 */

import { z } from 'zod';
import type { SpawnSessionResult, SpawnSessionHelpResult } from './base-agent.ts';
import { createMcpTool } from '../mcp/server-factory.ts';
import { errorResponse } from './tool-result.ts';

export type SpawnSessionFn = (input: Record<string, unknown>) => Promise<SpawnSessionResult | SpawnSessionHelpResult>;

interface SpawnSessionToolArgs {
  help?: boolean;
  prompt?: string;
  name?: string;
  provider?: string;
  model?: string;
  permissionMode?: 'safe' | 'ask' | 'allow-all';
  thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  workingDirectory?: string;
  attachments?: Array<{ path: string; name?: string }>;
}

export interface SpawnSessionToolOptions {
  sessionId: string;
  /**
   * Lazy resolver for the spawn session callback.
   * Called at execution time to get the current callback from the session registry.
   */
  getSpawnSessionFn: () => SpawnSessionFn | undefined;
}

export function createSpawnSessionTool(options: SpawnSessionToolOptions) {
  return createMcpTool<SpawnSessionToolArgs>(
    'spawn_session',
    `Create a new session that runs independently with its own prompt, provider, and model.

Use this to delegate tasks to parallel sessions — research, analysis, drafts, or any work that benefits from separate context.

Call with help=true first to discover available providers and models.
When spawning, the 'prompt' parameter is required.

Optional overrides: provider, model, permissionMode, and thinkingLevel. Omitted AI fields inherit from the spawning session or the global default; workspace-scoped fields retain their workspace defaults. workingDirectory is accepted only for backward compatibility and is ignored; create or switch workspace to use another folder.

thinkingLevel is silently ignored on non-reasoning models (e.g. gpt-4o, gemini-2.5-flash) — the SDK drops the reasoning param rather than erroring.

The spawned session appears in the session list and runs fire-and-forget.
Only use 'attachments' for existing file paths on disk — the tool reads them automatically.`,
    {
      help: z.boolean().optional()
        .describe('If true, returns available providers and models instead of creating a session'),
      prompt: z.string().optional()
        .describe('Instructions for the new session (required when not in help mode)'),
      name: z.string().optional()
        .describe('Session name'),
      provider: z.string().optional()
        .describe('Pi provider key (e.g., "anthropic", "openai")'),
      model: z.string().optional()
        .describe('Model ID override'),
      permissionMode: z.enum(['safe', 'ask', 'allow-all']).optional()
        .describe('Permission mode for the new session'),
      thinkingLevel: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']).optional()
        .describe('Reasoning level for the new session. Silently ignored on non-reasoning models (e.g. gpt-4o, gemini-2.5-flash). Omit to inherit the global default.'),
      workingDirectory: z.string().optional()
        .describe('Deprecated and ignored. New sessions run from the workspace root; create or switch workspace to use another folder.'),
      attachments: z.array(z.object({
        path: z.string().describe('Absolute file path on disk'),
        name: z.string().optional().describe('Display name (defaults to file basename)'),
      })).optional()
        .describe('Files to include with the prompt'),
    },
    async (args) => {
      const spawnFn = options.getSpawnSessionFn();
      if (!spawnFn) {
        return errorResponse('spawn_session is not available in this context.');
      }

      try {
        const result = await spawnFn(args as Record<string, unknown>);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        if (error instanceof Error) {
          return errorResponse(`spawn_session failed: ${error.message}`);
        }
        throw error;
      }
    }
  );
}
