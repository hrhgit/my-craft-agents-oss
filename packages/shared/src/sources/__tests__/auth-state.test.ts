import { describe, expect, test } from 'bun:test';
import { sourceRequiresAuthentication } from '../auth-state.ts';
import type { FolderSourceConfig, LoadedSource } from '../types.ts';

function source(config: Partial<FolderSourceConfig>): LoadedSource {
  return {
    config: {
      id: 'test-source',
      name: 'Test Source',
      slug: 'test-source',
      enabled: true,
      provider: 'test',
      type: 'mcp',
      ...config,
    },
    guide: null,
    folderPath: '/tmp/source',
    workspaceRootPath: '/tmp/workspace',
    workspaceId: 'workspace',
  };
}

describe('source auth-state policy', () => {
  test('treats HTTP/SSE MCP without authType as auth-required', () => {
    expect(sourceRequiresAuthentication(source({
      type: 'mcp',
      mcp: { url: 'https://example.com/mcp' },
    }))).toBe(true);
  });

  test('allows explicit no-auth MCP and stdio MCP without stored auth state', () => {
    expect(sourceRequiresAuthentication(source({
      type: 'mcp',
      mcp: { url: 'https://example.com/mcp', authType: 'none' },
    }))).toBe(false);

    expect(sourceRequiresAuthentication(source({
      type: 'mcp',
      mcp: { transport: 'stdio', command: 'node' },
    }))).toBe(false);
  });

  test('keeps API authType none as public', () => {
    expect(sourceRequiresAuthentication(source({
      type: 'api',
      api: { baseUrl: 'https://api.example.com', authType: 'none' },
    }))).toBe(false);
  });
});
