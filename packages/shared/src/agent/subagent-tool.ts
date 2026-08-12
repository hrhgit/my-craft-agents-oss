import { z } from 'zod';
import type { SubagentOperationResult } from './base-agent.ts';
import { createMcpTool } from '../mcp/server-factory.ts';
import { errorResponse } from './tool-result.ts';

export type SubagentFn = (input: Record<string, unknown>) => Promise<SubagentOperationResult>;

export interface SubagentToolOptions {
  getSubagentFn: () => SubagentFn | undefined;
}

export function createSubagentTool(options: SubagentToolOptions) {
  return createMcpTool(
    'subagent',
    `Delegate work to persistent private subagents owned by the current Session.

Start is the default action and requires only prompt. It returns taskId immediately. Use list to discover configured Agents and current tasks, inspect to read one task, message to steer or queue work, resume to continue an interrupted task, interrupt to stop it, and wait to wait until any specified task reaches a terminal state.

Optional start overrides replace the selected local Agent configuration for this run. forkTurns inherits only reliable user messages and final Agent replies from the current parent branch.`,
    {
      action: z.enum(['start', 'list', 'inspect', 'message', 'resume', 'interrupt', 'wait']).optional(),
      prompt: z.string().optional(),
      taskId: z.string().optional(),
      taskIds: z.array(z.string()).min(1).optional(),
      agent: z.string().optional(),
      forkTurns: z.union([z.number().int().positive(), z.literal('all')]).optional(),
      systemPrompt: z.string().optional(),
      tools: z.array(z.string()).optional(),
      model: z.string().optional(),
      thinkingLevel: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
      schema: z.record(z.string(), z.unknown()).optional(),
      timeoutMs: z.number().int().min(0).max(300_000).optional(),
    },
    async (args) => {
      const run = options.getSubagentFn();
      if (!run) return errorResponse('subagent is not available in this context.');
      try {
        const result = await run(args as Record<string, unknown>);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return errorResponse(`subagent failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );
}
