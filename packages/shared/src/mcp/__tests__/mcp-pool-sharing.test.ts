import { describe, expect, it, mock } from 'bun:test';
import type { PoolClient } from '../client.ts';
import { McpClientPool } from '../mcp-pool.ts';

describe('McpClientPool workspace physical connections', () => {
  it('shares one physical client while preserving session pool lifetimes', async () => {
    const close = mock(async () => undefined);
    const listTools = mock(async () => [{ name: 'lookup', inputSchema: { type: 'object' as const } }]);
    const client: PoolClient = {
      close,
      listTools,
      callTool: mock(async () => ({ content: [{ type: 'text', text: 'ok' }] })),
    };
    const clientFactory = mock(() => client);
    const first = new McpClientPool({ workspaceRootPath: 'E:/repo', sessionPath: 'E:/session-a', clientFactory });
    const second = new McpClientPool({ workspaceRootPath: 'E:/repo', sessionPath: 'E:/session-b', clientFactory });
    const servers = {
      source: { type: 'http' as const, url: 'https://mcp.example.test', headers: { Authorization: 'Bearer token' } },
    };

    await first.sync(servers);
    await second.sync(servers);
    expect(clientFactory).toHaveBeenCalledTimes(1);
    expect(listTools).toHaveBeenCalledTimes(1);
    expect(first.getProxyToolDefs()).toEqual(second.getProxyToolDefs());

    await first.disconnectAll();
    expect(close).not.toHaveBeenCalled();
    await second.disconnectAll();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
