/**
 * Spawn Session Tool (spawn_session)
 *
 * Session-scoped tool that enables the main agent to create persistent child tasks
 * with a configurable provider, model, and initial prompt.
 *
 * The core runtime owns child execution and persistence. Child tasks are stored
 * beneath their parent Session sidecar and never become ordinary Sessions.
 *
 * Two modes:
 * - help=true: Returns available providers and models
 * - Default: Creates a child task and sends the prompt
 */

import { z } from 'zod';
import type { SpawnSessionOperationResult, SpawnSessionHelpResult } from './base-agent.ts';
import { createMcpTool } from '../mcp/server-factory.ts';
import { errorResponse } from './tool-result.ts';

export type SpawnSessionFn = (input: Record<string, unknown>) => Promise<SpawnSessionOperationResult | SpawnSessionHelpResult>;

interface SpawnSessionToolArgs {
  help?: boolean;
  action?: 'spawn' | 'list' | 'inspect' | 'message' | 'resume' | 'interrupt';
  prompt?: string;
  sessionId?: string;
  template?: string;
  background?: boolean;
  name?: string;
  provider?: string;
  model?: string;
  thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
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

Use this to delegate temporary child tasks, inspect their state and output, send follow-up messages, resume interrupted work without adding a fake user message, or interrupt a running child task.

Call with help=true first to discover available providers and models.
When spawning, the 'prompt' parameter is required.

Optional overrides: provider, model, and thinkingLevel. Omitted AI fields inherit from the spawning session or the global default.

thinkingLevel is silently ignored on non-reasoning models (e.g. gpt-4o, gemini-2.5-flash) — the SDK drops the reasoning param rather than erroring.

Child tasks stay attached to the parent Session and never appear in the ordinary Session list. Foreground execution returns the final text; set background=true to return immediately.
Attachments pass existing absolute file paths to the child task. The selected template must include the read tool so the child can read their contents.`,
    {
      help: z.boolean().optional()
        .describe('If true, returns available providers and models instead of creating a session'),
      action: z.enum(['spawn', 'list', 'inspect', 'message', 'resume', 'interrupt']).optional()
        .describe('Child-task operation (default: spawn)'),
      prompt: z.string().optional()
        .describe('Instructions for spawn, or a real follow-up message for message'),
      sessionId: z.string().optional()
        .describe('Child task ID for inspect, message, resume, or interrupt'),
      template: z.string().optional()
        .describe('Configured child-task template ID'),
      background: z.boolean().optional()
        .describe('Run asynchronously and return the persistent child task ID immediately'),
      name: z.string().optional()
        .describe('Session name'),
      provider: z.string().optional()
        .describe('Pi provider key (e.g., "anthropic", "openai")'),
      model: z.string().optional()
        .describe('Model ID override'),
      thinkingLevel: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional()
        .describe('Reasoning level for the new session. Silently ignored on non-reasoning models (e.g. gpt-4o, gemini-2.5-flash). Omit to inherit the global default.'),
      attachments: z.array(z.object({
        path: z.string().describe('Absolute file path on disk'),
        name: z.string().optional().describe('Display name (defaults to file basename)'),
      })).optional()
        .describe('Existing absolute file paths the child can read with its read tool'),
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
