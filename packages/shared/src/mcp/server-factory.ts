import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

export type InProcessMcpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: ToolAnnotations;
  handler: (args: Record<string, unknown>, extra?: unknown) => CallToolResult | Promise<CallToolResult>;
};

export type InProcessMcpServer = McpServer;

export function createMcpTool<Args extends object = Record<string, unknown>>(
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
  handler: (args: Args, extra?: unknown) => CallToolResult | Promise<CallToolResult>,
  options?: { annotations?: ToolAnnotations },
): InProcessMcpTool {
  return {
    name,
    description,
    inputSchema,
    handler: handler as InProcessMcpTool['handler'],
    ...(options?.annotations ? { annotations: options.annotations } : {}),
  };
}

export function createInProcessMcpServer(args: {
  name: string;
  version: string;
  tools: InProcessMcpTool[];
}): InProcessMcpServer {
  const server = new McpServer({ name: args.name, version: args.version });
  const registerTool = server.registerTool.bind(server) as (
    name: string,
    config: {
      description?: string;
      inputSchema?: Record<string, unknown>;
      annotations?: ToolAnnotations;
    },
    handler: (input: Record<string, unknown>, extra: unknown) => CallToolResult | Promise<CallToolResult>,
  ) => unknown;

  for (const tool of args.tools) {
    registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
      },
      async (input: Record<string, unknown>, extra: unknown) => tool.handler(input, extra),
    );
  }

  return server;
}
